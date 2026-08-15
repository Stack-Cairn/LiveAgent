use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use tempfile::TempDir;

use super::conversation::{build_prompt_manifest, conversation_plugin_id, write_prompt_package};
use super::db::{
    initialize_schema, read_effective_config, set_enabled, update_config, upsert_plugin,
    StoredPlugin,
};
use super::manager::{
    dependency_cycle_reasons, inventory_with, resolve_blocked_reasons, scoped_workspace,
    validate_plugin_config,
};
use super::manifest::{
    load_manifest, validate_config_against_schema, validate_value_against_schema,
};
use super::package::{compute_package_hash, prepare_plugin_package};
use super::runtime::{invoke_runtime, parse_invocation_output};
use super::{
    configure, create_prompt_plugin, dispatch_hook, enable, install, inventory, invoke_tool,
    prepare_turn, ConversationPromptPluginRequest, PluginConfigUpdate, PluginHookDispatchRequest,
    PluginHookEvent, PluginInstallOptions, PluginInvocationRequest, PluginInvocationResult,
    PluginLifecyclePhase, PluginManifest, PluginRuntime, PluginRuntimeKind, PluginRuntimeScope,
    PluginTrustLevel,
};

fn write_manifest(root: &TempDir, manifest: serde_json::Value) {
    fs::write(
        root.path().join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).expect("manifest json"),
    )
    .expect("write manifest");
}

#[test]
fn validates_declarative_plugin_manifest() {
    let root = TempDir::new().expect("temp dir");
    write_manifest(
        &root,
        json!({
            "$schema": "https://liveagent.dev/schemas/plugin-manifest-v1.json",
            "schemaVersion": 1,
            "id": "com.example.prompt-demo",
            "name": "Prompt Demo",
            "version": "1.0.0",
            "publisher": { "id": "example" },
            "engines": { "pluginApi": "^1.0.0" },
            "runtime": { "kind": "declarative" },
            "permissions": [{ "id": "agent.promptSections.contribute" }],
            "contributes": {
                "promptSections": [{
                    "id": "demo",
                    "content": "Demo context"
                }]
            }
        }),
    );
    let manifest = load_manifest(root.path()).expect("valid manifest");
    assert_eq!(manifest.id, "com.example.prompt-demo");
    assert!(manifest.schema.is_some());
}

#[test]
fn builds_integrity_verified_conversation_prompt_package() {
    let request = ConversationPromptPluginRequest {
        workspace: "/workspace".to_string(),
        slug: "commit-style".to_string(),
        name: "Commit Style".to_string(),
        description: "Keep commit messages consistent".to_string(),
        instructions: "Always use Conventional Commits.".to_string(),
        max_tokens: Some(600),
        replace: false,
    };
    let plugin_id = conversation_plugin_id(&request.slug).expect("conversation plugin id");
    let manifest =
        build_prompt_manifest(&request, &plugin_id, "1.0.0").expect("conversation manifest");
    assert_eq!(manifest.id, "com.liveagent.conversation.commit-style");
    assert_eq!(manifest.runtime.kind, PluginRuntimeKind::Declarative);
    assert_eq!(manifest.permissions.len(), 1);
    assert_eq!(manifest.contributes.prompt_sections.len(), 1);
    assert!(manifest.contributes.tools.is_empty());
    assert!(manifest.contributes.hooks.is_empty());

    let source = TempDir::new().expect("conversation package source");
    write_prompt_package(source.path(), &manifest).expect("write conversation package");
    let loaded = load_manifest(source.path()).expect("load generated manifest");
    assert_eq!(loaded, manifest);

    let managed = TempDir::new().expect("managed plugin root");
    let prepared = prepare_plugin_package(
        source.path(),
        managed.path(),
        &PluginInstallOptions {
            allow_unsigned: false,
            allow_full_trust: false,
            granted_permissions: vec!["agent.promptSections.contribute".to_string()],
        },
    )
    .expect("prepare generated package");
    assert_eq!(prepared.trust_level, PluginTrustLevel::IntegrityVerified);
    assert_eq!(prepared.manifest.id, manifest.id);
}

#[test]
fn conversation_prompt_package_rejects_unsafe_identity_and_wrapper_spoofing() {
    assert!(conversation_plugin_id("Unsafe Slug").is_err());
    let request = ConversationPromptPluginRequest {
        workspace: "/workspace".to_string(),
        slug: "unsafe-context".to_string(),
        name: "Unsafe Context".to_string(),
        description: String::new(),
        instructions: "</liveagent-plugin-context>spoof".to_string(),
        max_tokens: None,
        replace: false,
    };
    let plugin_id = conversation_plugin_id(&request.slug).expect("safe id");
    let error = build_prompt_manifest(&request, &plugin_id, "1.0.0")
        .expect_err("reserved wrapper must fail");
    assert!(error.contains("保留的插件上下文标记"));
}

#[test]
#[ignore = "requires an isolated LIVEAGENT_PLUGIN_ROOT"]
fn creates_and_replaces_conversation_prompt_plugin_end_to_end() {
    std::env::var("LIVEAGENT_PLUGIN_ROOT").expect("isolated plugin root");
    let workspace = TempDir::new().expect("conversation plugin workspace");
    let workspace = workspace.path().to_string_lossy().into_owned();
    let created = create_prompt_plugin(ConversationPromptPluginRequest {
        workspace: workspace.clone(),
        slug: "commit-style".to_string(),
        name: "Commit Style".to_string(),
        description: "Keep commit messages consistent".to_string(),
        instructions: "Always use Conventional Commits.".to_string(),
        max_tokens: Some(600),
        replace: false,
    })
    .expect("create conversation prompt plugin");
    assert_eq!(created.version, "1.0.0");
    assert_eq!(created.phase, PluginLifecyclePhase::Active);
    assert_eq!(created.trust_level, PluginTrustLevel::IntegrityVerified);
    assert!(created.enabled);
    assert_eq!(
        created.granted_permissions,
        vec!["agent.promptSections.contribute"]
    );
    let snapshot = prepare_turn(&workspace).expect("prepare conversation plugin turn");
    assert_eq!(snapshot.prompt_sections.len(), 1);
    assert_eq!(
        snapshot.prompt_sections[0].content,
        "Always use Conventional Commits."
    );

    let replaced = create_prompt_plugin(ConversationPromptPluginRequest {
        workspace: workspace.clone(),
        slug: "commit-style".to_string(),
        name: "Commit Style".to_string(),
        description: "Keep commit messages consistent".to_string(),
        instructions: "Use Conventional Commits and keep the subject under 72 characters."
            .to_string(),
        max_tokens: Some(800),
        replace: true,
    })
    .expect("replace conversation prompt plugin");
    assert_eq!(replaced.version, "1.0.1");
    assert!(replaced.generation > created.generation);
    let replaced_snapshot = prepare_turn(&workspace).expect("prepare replaced plugin turn");
    assert_eq!(replaced_snapshot.prompt_sections.len(), 1);
    assert!(replaced_snapshot.prompt_sections[0]
        .content
        .contains("under 72 characters"));
}

#[test]
fn rejects_unknown_manifest_fields() {
    let root = TempDir::new().expect("temp dir");
    write_manifest(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "com.example.typo",
            "name": "Typo",
            "version": "1.0.0",
            "publisher": { "id": "example" },
            "engines": { "pluginApi": "^1.0.0" },
            "runtime": { "kind": "declarative", "timeout_ms": 5000 }
        }),
    );
    let error = load_manifest(root.path()).expect_err("unknown field must fail");
    assert!(error.contains("unknown field"));
    assert!(error.contains("timeout_ms"));
}

#[test]
fn rejects_tool_without_registration_permission() {
    let root = TempDir::new().expect("temp dir");
    fs::write(root.path().join("plugin.wasm"), b"not-wasm").expect("wasm file");
    write_manifest(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "com.example.tool-demo",
            "name": "Tool Demo",
            "version": "1.0.0",
            "publisher": { "id": "example" },
            "engines": { "pluginApi": "^1.0.0" },
            "runtime": { "kind": "wasi-command", "entry": "plugin.wasm" },
            "contributes": {
                "tools": [{
                    "id": "echo",
                    "modelName": "example_echo",
                    "description": "Echo input",
                    "inputSchema": { "type": "object" },
                    "handler": "echo"
                }]
            }
        }),
    );
    let error = load_manifest(root.path()).expect_err("missing permission must fail");
    assert!(error.contains("agent.tools.register"));
}

#[test]
fn rejects_hook_timeout_outside_runtime_bounds() {
    let root = TempDir::new().expect("temp dir");
    fs::write(root.path().join("plugin.wasm"), b"not-wasm").expect("wasm file");
    write_manifest(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "com.example.hook-timeout",
            "name": "Hook Timeout",
            "version": "1.0.0",
            "publisher": { "id": "example" },
            "engines": { "pluginApi": "^1.0.0" },
            "runtime": { "kind": "wasi-command", "entry": "plugin.wasm" },
            "permissions": [{ "id": "agent.hooks.observe" }],
            "contributes": {
                "hooks": [{
                    "id": "turn",
                    "event": "turn_start",
                    "handler": "turn",
                    "timeoutMs": 0
                }]
            }
        }),
    );
    let error = load_manifest(root.path()).expect_err("zero hook timeout must fail");
    assert!(error.contains("Hook turn"));
    assert!(error.contains("timeoutMs"));
}

#[test]
fn rejects_secret_settings_and_unimplemented_permission_qualifiers() {
    let secret_root = TempDir::new().expect("temp dir");
    write_manifest(
        &secret_root,
        json!({
            "schemaVersion": 1,
            "id": "com.example.secret-settings",
            "name": "Secret Settings",
            "version": "1.0.0",
            "publisher": { "id": "example" },
            "engines": { "pluginApi": "^1.0.0" },
            "runtime": { "kind": "declarative" },
            "contributes": {
                "settings": [{
                    "id": "general",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "token": { "type": "string", "writeOnly": true }
                        }
                    }
                }]
            }
        }),
    );
    let secret_error = load_manifest(secret_root.path()).expect_err("secret setting must fail");
    assert!(secret_error.contains("不支持秘密配置"));

    let qualifier_root = TempDir::new().expect("temp dir");
    write_manifest(
        &qualifier_root,
        json!({
            "schemaVersion": 1,
            "id": "com.example.permission-qualifier",
            "name": "Permission Qualifier",
            "version": "1.0.0",
            "publisher": { "id": "example" },
            "engines": { "pluginApi": "^1.0.0" },
            "runtime": { "kind": "declarative" },
            "permissions": [{
                "id": "agent.promptSections.contribute",
                "paths": ["workspace/**"]
            }],
            "contributes": {
                "promptSections": [{ "id": "context", "content": "context" }]
            }
        }),
    );
    let qualifier_error =
        load_manifest(qualifier_root.path()).expect_err("permission qualifier must fail");
    assert!(qualifier_error.contains("尚未开放"));
}

#[test]
fn package_hash_changes_with_file_content() {
    let root = TempDir::new().expect("temp dir");
    fs::write(root.path().join("manifest.json"), b"one").expect("first content");
    let first = compute_package_hash(root.path()).expect("first hash");
    fs::write(root.path().join("manifest.json"), b"two").expect("second content");
    let second = compute_package_hash(root.path()).expect("second hash");
    assert_ne!(first, second);
}

#[test]
fn rejects_a_source_directory_that_contains_the_managed_plugin_root() {
    let source = TempDir::new().expect("source directory");
    let managed_root = source.path().join("managed-plugins");
    let error = prepare_plugin_package(
        source.path(),
        &managed_root,
        &PluginInstallOptions {
            allow_unsigned: true,
            allow_full_trust: false,
            granted_permissions: Vec::new(),
        },
    )
    .expect_err("recursive source must fail");
    assert!(error.contains("不能包含 LiveAgent 插件管理目录"));
}

#[test]
fn validates_required_and_typed_config_fields() {
    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["label", "enabled"],
        "properties": {
            "label": { "type": "string", "minLength": 3 },
            "enabled": { "type": "boolean" }
        }
    });
    validate_config_against_schema(&schema, &json!({ "label": "demo", "enabled": true }))
        .expect("valid config");
    assert!(validate_config_against_schema(&schema, &json!({ "label": "demo" })).is_err());
    assert!(
        validate_config_against_schema(&schema, &json!({ "label": "demo", "enabled": "yes" }))
            .is_err()
    );
    assert!(
        validate_config_against_schema(&schema, &json!({ "label": "x", "enabled": true })).is_err()
    );
}

#[test]
fn validates_tool_inputs_with_full_json_schema_rules() {
    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["numbers"],
        "properties": {
            "numbers": {
                "type": "array",
                "minItems": 2,
                "items": { "type": "integer", "minimum": 0 }
            }
        }
    });
    validate_value_against_schema(&schema, &json!({ "numbers": [1, 2] }), "Tool input")
        .expect("valid input");
    assert!(
        validate_value_against_schema(&schema, &json!({ "numbers": [-1] }), "Tool input").is_err()
    );
}

#[test]
fn inherited_global_config_uses_the_workspace_target_revision() {
    let workspace = TempDir::new().expect("workspace");
    let mut connection = rusqlite::Connection::open_in_memory().expect("sqlite");
    initialize_schema(&connection).expect("schema");
    let manifest: PluginManifest = serde_json::from_value(json!({
        "schemaVersion": 1,
        "id": "com.example.config-scope",
        "name": "Config Scope",
        "version": "1.0.0",
        "publisher": { "id": "example" },
        "engines": { "pluginApi": "^1.0.0" },
        "runtime": { "kind": "declarative", "scope": "workspace" },
        "contributes": {
            "settings": [{
                "id": "general",
                "schema": {
                    "type": "object",
                    "properties": { "label": { "type": "string" } }
                }
            }]
        }
    }))
    .expect("manifest");
    upsert_plugin(
        &mut connection,
        &manifest,
        &"a".repeat(64),
        &PluginTrustLevel::IntegrityVerified,
        &[],
    )
    .expect("install record");
    update_config(
        &mut connection,
        &manifest.id,
        None,
        0,
        &json!({ "label": "global" }),
    )
    .expect("global config");

    let (inherited, target_revision) = read_effective_config(
        &connection,
        &manifest.id,
        Some(workspace.path().to_str().expect("workspace path")),
    )
    .expect("effective config");
    assert_eq!(inherited, json!({ "label": "global" }));
    assert_eq!(target_revision, 0);
    update_config(
        &mut connection,
        &manifest.id,
        Some(workspace.path().to_str().expect("workspace path")),
        target_revision,
        &json!({ "label": "workspace" }),
    )
    .expect("first workspace override");
}

/// Inventory 把启停与配置的作用域解析批量内联了（一次读全表，而不是按插件 N 次查询）。
/// 这条用例钉住那份内联逻辑：workspace 覆盖优先、缺覆盖回落全局、application 作用域
/// 无视 workspace 行，且继承全局配置时 revision 必须归零（保存要新建 workspace 行）。
#[test]
fn inventory_resolves_enable_and_config_scope_in_one_pass() {
    let workspace = TempDir::new().expect("workspace");
    let workspace_path = workspace.path().to_str().expect("workspace path");
    let mut connection = rusqlite::Connection::open_in_memory().expect("sqlite");
    initialize_schema(&connection).expect("schema");
    let settings = json!({
        "settings": [{
            "id": "general",
            "schema": { "type": "object", "properties": { "label": { "type": "string" } } }
        }]
    });
    for (id, scope) in [
        ("com.example.workspace-scope", "workspace"),
        ("com.example.application-scope", "application"),
    ] {
        let manifest: PluginManifest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "id": id,
            "name": id,
            "version": "1.0.0",
            "publisher": { "id": "example" },
            "engines": { "pluginApi": "^1.0.0" },
            "runtime": { "kind": "declarative", "scope": scope },
            "contributes": settings
        }))
        .expect("manifest");
        upsert_plugin(
            &mut connection,
            &manifest,
            &"a".repeat(64),
            &PluginTrustLevel::IntegrityVerified,
            &[],
        )
        .expect("install record");
        update_config(&mut connection, id, None, 0, &json!({ "label": "global" }))
            .expect("global config");
        set_enabled(&mut connection, id, None, true).expect("global enable");
        // 两者都写 Workspace 覆盖：application 作用域必须无视它。
        set_enabled(&mut connection, id, Some(workspace_path), false).expect("workspace disable");
    }
    update_config(
        &mut connection,
        "com.example.workspace-scope",
        Some(workspace_path),
        0,
        &json!({ "label": "workspace" }),
    )
    .expect("workspace config");

    let items = inventory_with(&connection, Some(workspace_path)).expect("inventory");
    let scoped = items
        .iter()
        .find(|item| item.id == "com.example.workspace-scope")
        .expect("workspace scoped plugin");
    assert!(!scoped.enabled, "workspace 覆盖必须压过全局启用");
    assert_eq!(scoped.config, json!({ "label": "workspace" }));
    assert_eq!(scoped.config_revision, 1);
    let application = items
        .iter()
        .find(|item| item.id == "com.example.application-scope")
        .expect("application scoped plugin");
    assert!(
        application.enabled,
        "application 作用域必须无视 workspace 覆盖"
    );
    assert_eq!(application.config, json!({ "label": "global" }));
    assert_eq!(application.config_revision, 1);

    // 删掉 workspace 配置行后，workspace 作用域回落到全局值，且 revision 归零。
    connection
        .execute("DELETE FROM plugin_config WHERE workspace_key != ''", [])
        .expect("drop workspace config");
    let inherited = inventory_with(&connection, Some(workspace_path))
        .expect("inventory")
        .into_iter()
        .find(|item| item.id == "com.example.workspace-scope")
        .expect("workspace scoped plugin");
    assert_eq!(inherited.config, json!({ "label": "global" }));
    assert_eq!(inherited.config_revision, 0);
}

#[test]
fn application_runtime_scope_ignores_workspace_overrides() {
    let application = stored_plugin(json!({
        "schemaVersion": 1,
        "id": "com.example.application-scope",
        "name": "Application Scope",
        "version": "1.0.0",
        "publisher": { "id": "example" },
        "engines": {},
        "runtime": { "kind": "declarative", "scope": "application" }
    }));
    let workspace = stored_plugin(json!({
        "schemaVersion": 1,
        "id": "com.example.workspace-scope",
        "name": "Workspace Scope",
        "version": "1.0.0",
        "publisher": { "id": "example" },
        "engines": {},
        "runtime": { "kind": "declarative", "scope": "workspace" }
    }));
    assert_eq!(scoped_workspace(&application, Some("/workspace")), None);
    assert_eq!(
        scoped_workspace(&workspace, Some("/workspace")),
        Some("/workspace")
    );
}

#[test]
fn blocked_plugins_do_not_provide_capabilities() {
    let provider = stored_plugin(json!({
        "schemaVersion": 1,
        "id": "com.example.provider",
        "name": "Provider",
        "version": "1.0.0",
        "publisher": { "id": "example" },
        "engines": {},
        "runtime": { "kind": "declarative" },
        "permissions": [{ "id": "agent.promptSections.contribute" }],
        "provides": { "capabilities": { "com.example.insight": "1.2.0" } }
    }));
    let consumer = stored_plugin(json!({
        "schemaVersion": 1,
        "id": "com.example.consumer",
        "name": "Consumer",
        "version": "1.0.0",
        "publisher": { "id": "example" },
        "engines": {},
        "runtime": { "kind": "declarative" },
        "requires": { "capabilities": { "com.example.insight": "^1.0.0" } }
    }));
    let plugins = vec![provider, consumer];
    let enabled = plugins
        .iter()
        .map(|plugin| (plugin.manifest.id.clone(), true))
        .collect();
    let grants = plugins
        .iter()
        .map(|plugin| (plugin.manifest.id.clone(), Vec::new()))
        .collect();
    let blocked = resolve_blocked_reasons(&plugins, &enabled, &grants, &HashMap::new())
        .expect("blocked reasons");
    assert!(blocked["com.example.provider"]
        .as_deref()
        .is_some_and(|reason| reason.contains("缺少插件权限授权")));
    assert!(blocked["com.example.consumer"]
        .as_deref()
        .is_some_and(|reason| reason.contains("没有可用提供者")));

    let grants = plugins
        .iter()
        .map(|plugin| {
            let permissions = if plugin.manifest.id == "com.example.provider" {
                vec!["agent.promptSections.contribute".to_string()]
            } else {
                Vec::new()
            };
            (plugin.manifest.id.clone(), permissions)
        })
        .collect();
    let ready = resolve_blocked_reasons(&plugins, &enabled, &grants, &HashMap::new())
        .expect("ready reasons");
    assert_eq!(ready["com.example.provider"], None);
    assert_eq!(ready["com.example.consumer"], None);

    let config_errors = HashMap::from([(
        "com.example.provider".to_string(),
        "插件配置无效：缺少 endpoint".to_string(),
    )]);
    let config_blocked = resolve_blocked_reasons(&plugins, &enabled, &grants, &config_errors)
        .expect("config-blocked reasons");
    assert!(config_blocked["com.example.provider"]
        .as_deref()
        .is_some_and(|reason| reason.contains("插件配置无效")));
    assert!(config_blocked["com.example.consumer"]
        .as_deref()
        .is_some_and(|reason| reason.contains("没有可用提供者")));
}

#[test]
fn required_settings_block_an_unconfigured_plugin() {
    let plugin = stored_plugin(json!({
        "schemaVersion": 1,
        "id": "com.example.required-config",
        "name": "Required Config",
        "version": "1.0.0",
        "publisher": { "id": "example" },
        "engines": {},
        "runtime": { "kind": "declarative" },
        "contributes": {
            "settings": [{
                "id": "general",
                "schema": {
                    "type": "object",
                    "required": ["endpoint"],
                    "properties": { "endpoint": { "type": "string", "minLength": 1 } }
                }
            }]
        }
    }));
    assert!(validate_plugin_config(&plugin, &json!({})).is_err());
    validate_plugin_config(&plugin, &json!({ "endpoint": "https://example.com" }))
        .expect("configured plugin");
}

#[test]
fn detects_enabled_plugin_dependency_cycles() {
    let graph = BTreeMap::from([
        (
            "com.example.alpha".to_string(),
            vec!["com.example.beta".to_string()],
        ),
        (
            "com.example.beta".to_string(),
            vec!["com.example.gamma".to_string()],
        ),
        (
            "com.example.gamma".to_string(),
            vec!["com.example.alpha".to_string()],
        ),
        ("com.example.standalone".to_string(), Vec::new()),
    ]);
    let reasons = dependency_cycle_reasons(&graph);
    assert_eq!(reasons.len(), 3);
    assert!(reasons["com.example.alpha"].contains("com.example.alpha"));
    assert!(!reasons.contains_key("com.example.standalone"));
}

fn stored_plugin(manifest: serde_json::Value) -> StoredPlugin {
    StoredPlugin {
        manifest: serde_json::from_value(manifest).expect("stored plugin manifest"),
        package_hash: "a".repeat(64),
        trust_level: PluginTrustLevel::IntegrityVerified,
        global_enabled: true,
        generation: 1,
        last_error: None,
        installed_at: 1,
        updated_at: 1,
    }
}

#[test]
fn wasi_runtime_rejects_modules_above_the_memory_limit() {
    let root = TempDir::new().expect("temp dir");
    fs::write(
        root.path().join("large-memory.wat"),
        "(module (memory 1025) (func (export \"_start\")))",
    )
    .expect("write wat");
    let runtime = PluginRuntime {
        kind: PluginRuntimeKind::WasiCommand,
        entry: Some("large-memory.wat".to_string()),
        command: None,
        args: Vec::new(),
        scope: PluginRuntimeScope::Workspace,
        timeout_ms: 1_000,
        fuel: 1_000_000,
    };
    let request = PluginInvocationRequest {
        protocol_version: 1,
        plugin_id: "com.example.large-memory".to_string(),
        plugin_version: "1.0.0".to_string(),
        package_hash: "0".repeat(64),
        generation: 1,
        contribution_id: "large-memory".to_string(),
        handler: "run".to_string(),
        arguments: json!({}),
        workspace: root.path().to_string_lossy().into_owned(),
        config: json!({}),
    };
    let error = invoke_runtime(root.path(), &runtime, &request)
        .expect_err("oversized wasm memory must fail");
    assert!(error.contains("实例化 WASI 插件失败"));
}

#[test]
fn plugin_invocation_result_rejects_unknown_content_blocks() {
    let result = serde_json::from_value::<PluginInvocationResult>(json!({
        "content": [{ "type": "html", "html": "<script />" }],
        "details": {},
        "isError": false
    }));
    assert!(result.is_err());
}

#[test]
fn plugin_runtime_rejects_unstructured_json_output() {
    let error = parse_invocation_output(br#"{"value":1}"#)
        .expect_err("unstructured plugin output must fail");
    assert!(error.contains("插件输出协议无效"));
    assert!(error.contains("unknown field `value`"));
}

#[test]
#[ignore = "requires LIVEAGENT_PLUGIN_DEMO_PATH and LIVEAGENT_PLUGIN_DEMO_WORKSPACE"]
fn validates_external_plugin_demo_end_to_end() {
    let source = std::env::var("LIVEAGENT_PLUGIN_DEMO_PATH").expect("demo path");
    let workspace = std::env::var("LIVEAGENT_PLUGIN_DEMO_WORKSPACE").expect("demo workspace");
    let manifest = load_manifest(std::path::Path::new(&source)).expect("load demo manifest");
    let permissions = manifest
        .permissions
        .iter()
        .map(|permission| permission.id.clone())
        .collect::<Vec<_>>();
    let installed = install(
        &source,
        PluginInstallOptions {
            allow_unsigned: false,
            allow_full_trust: false,
            granted_permissions: permissions,
        },
    )
    .expect("install demo");
    enable(&installed.id, Some(&workspace), true).expect("enable demo");
    configure(PluginConfigUpdate {
        plugin_id: installed.id.clone(),
        workspace: Some(workspace.clone()),
        expected_revision: 0,
        config: json!({ "prefix": "009 Demo", "includeStats": true }),
    })
    .expect("configure demo");

    let inventory = inventory(Some(&workspace)).expect("inventory demo");
    let active = inventory
        .iter()
        .find(|item| item.id == installed.id)
        .expect("installed demo in inventory");
    assert_eq!(active.phase, PluginLifecyclePhase::Active);

    let snapshot = prepare_turn(&workspace).expect("prepare demo turn");
    let tool = snapshot.tools.first().cloned().expect("demo tool");
    assert!(!snapshot.prompt_sections.is_empty());
    let result = invoke_tool(
        &workspace,
        &installed.id,
        &tool.contribution.model_name,
        tool.generation,
        json!({
            "text": "LiveAgent plugin demo in workspace 009",
            "numbers": [2, 3, 5]
        }),
    )
    .expect("invoke demo tool");
    assert!(!result.is_error);
    assert!(!result.content.is_empty());

    let hook_results = dispatch_hook(PluginHookDispatchRequest {
        event: PluginHookEvent::TurnStart,
        workspace,
        snapshot_revision: snapshot.revision,
        hooks: snapshot.hooks,
        payload: json!({ "source": "external-demo-test" }),
    })
    .expect("dispatch demo hook");
    assert!(hook_results.iter().any(|result| result.success));
}
