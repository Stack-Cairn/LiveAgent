use rusqlite::Connection;
use semver::{Version, VersionReq};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use super::db::{
    clear_failure, get_plugin, list_plugins, open_db, package_path, plugins_root, read_all_configs,
    read_all_grants, read_all_scope_enabled, read_effective_config, record_failure, replace_grants,
    set_enabled, uninstall_plugin, update_config, upsert_plugin, StoredPlugin,
};
use super::manifest::{
    read_prompt_content, validate_config_against_schema, validate_value_against_schema,
    DEFAULT_PROMPT_SECTION_POSITION, PLUGIN_API_VERSION, PROMPT_SECTION_POSITIONS,
};
use super::package::prepare_plugin_package;
use super::runtime::invoke_runtime;
use super::types::{
    PluginConfigUpdate, PluginHookDispatchRequest, PluginHookDispatchResult, PluginInstallOptions,
    PluginInventoryItem, PluginInvocationRequest, PluginInvocationResult, PluginLifecyclePhase,
    PluginRuntimeScope, PluginSnapshotHook, PluginSnapshotPromptSection, PluginSnapshotTool,
    PluginTurnSnapshot,
};

const CORE_CAPABILITIES: &[(&str, &str)] = &[
    ("liveagent.agent.tools", "1.0.0"),
    ("liveagent.agent.prompt-sections", "1.0.0"),
    ("liveagent.agent.hooks", "1.0.0"),
    ("liveagent.ui.settings", "1.0.0"),
];

pub fn install(
    source_path: &str,
    options: PluginInstallOptions,
) -> Result<PluginInventoryItem, String> {
    let root = plugins_root()?;
    let prepared = prepare_plugin_package(Path::new(source_path), &root, &options)?;
    validate_granted_permissions(&prepared.manifest.permissions, &options.granted_permissions)?;
    let mut connection = open_db()?;
    upsert_plugin(
        &mut connection,
        &prepared.manifest,
        &prepared.package_hash,
        &prepared.trust_level,
        &options.granted_permissions,
    )?;
    drop(connection);
    inventory(None)?
        .into_iter()
        .find(|item| item.id == prepared.manifest.id)
        .ok_or_else(|| "插件安装完成后未出现在 Inventory 中".to_string())
}

pub fn inventory(workspace: Option<&str>) -> Result<Vec<PluginInventoryItem>, String> {
    inventory_with(&open_db()?, workspace)
}

/// Inventory 的实现体：调用方已经持有连接时（工具调用、Hook 派发）复用同一条，
/// 避免每次都重开数据库。所有作用域数据一次性批量读出，不再按插件 N 次查询。
pub(super) fn inventory_with(
    connection: &Connection,
    workspace: Option<&str>,
) -> Result<Vec<PluginInventoryItem>, String> {
    let plugins = list_plugins(connection)?;
    // Workspace 路径只在这里规范化一次：canonicalize 是系统调用，按插件重复解析
    // 会让 Inventory 开销随插件数线性放大。
    let workspace_key = workspace.map(super::db::workspace_key).transpose()?;
    let grants = read_all_grants(connection)?;
    let global_configs = read_all_configs(connection, "")?;
    let (scoped_enabled, scoped_configs) = match workspace_key.as_deref() {
        Some(key) => (
            read_all_scope_enabled(connection, key)?,
            read_all_configs(connection, key)?,
        ),
        None => (HashMap::new(), HashMap::new()),
    };
    let mut enabled = HashMap::with_capacity(plugins.len());
    let mut configs = HashMap::with_capacity(plugins.len());
    for plugin in &plugins {
        let id = &plugin.manifest.id;
        // application 作用域忽略 Workspace 覆盖，读写统一落在全局行上。
        let scoped = workspace_key.is_some()
            && plugin.manifest.runtime.scope == PluginRuntimeScope::Workspace;
        enabled.insert(
            id.clone(),
            if scoped {
                scoped_enabled
                    .get(id)
                    .copied()
                    .unwrap_or(plugin.global_enabled)
            } else {
                plugin.global_enabled
            },
        );
        let config = scoped
            .then(|| scoped_configs.get(id).cloned())
            .flatten()
            .or_else(|| {
                let (value, revision) = global_configs.get(id).cloned()?;
                // Workspace 作用域继承全局配置时 revision 归零，保存会新建 workspace 行。
                Some(if scoped {
                    (value, 0)
                } else {
                    (value, revision)
                })
            })
            .unwrap_or_else(|| (Value::Object(serde_json::Map::new()), 0));
        configs.insert(id.clone(), config);
    }
    let config_errors = plugins
        .iter()
        .filter_map(|plugin| {
            let config = &configs.get(&plugin.manifest.id)?.0;
            validate_plugin_config(plugin, config)
                .err()
                .map(|error| (plugin.manifest.id.clone(), format!("插件配置无效：{error}")))
        })
        .collect::<HashMap<_, _>>();
    let blocked = resolve_blocked_reasons(&plugins, &enabled, &grants, &config_errors)?;
    plugins
        .into_iter()
        .map(|plugin| {
            let plugin_enabled = enabled.get(&plugin.manifest.id).copied().unwrap_or(false);
            let plugin_grants = grants.get(&plugin.manifest.id).cloned().unwrap_or_default();
            let (config, config_revision) = configs
                .get(&plugin.manifest.id)
                .cloned()
                .ok_or_else(|| format!("插件配置未加载：{}", plugin.manifest.id))?;
            let blocked_reason = if plugin_enabled {
                blocked.get(&plugin.manifest.id).cloned().flatten()
            } else {
                None
            };
            let phase = if !plugin_enabled {
                PluginLifecyclePhase::Disabled
            } else if blocked_reason.is_some() {
                PluginLifecyclePhase::Blocked
            } else if plugin.last_error.is_some() {
                PluginLifecyclePhase::Failed
            } else {
                PluginLifecyclePhase::Active
            };
            Ok(PluginInventoryItem {
                id: plugin.manifest.id,
                name: plugin.manifest.name,
                version: plugin.manifest.version,
                description: plugin.manifest.description,
                publisher: plugin.manifest.publisher,
                package_hash: plugin.package_hash,
                generation: plugin.generation,
                runtime: plugin.manifest.runtime,
                permissions: plugin.manifest.permissions,
                granted_permissions: plugin_grants,
                contributes: plugin.manifest.contributes,
                enabled: plugin_enabled,
                phase,
                trust_level: plugin.trust_level,
                blocked_reason,
                last_error: plugin.last_error,
                installed_at: plugin.installed_at,
                updated_at: plugin.updated_at,
                config,
                config_revision,
            })
        })
        .collect()
}

pub fn enable(plugin_id: &str, workspace: Option<&str>, enabled: bool) -> Result<i64, String> {
    let mut connection = open_db()?;
    let plugin = get_plugin(&connection, plugin_id)?;
    let workspace = scoped_workspace(&plugin, workspace);
    set_enabled(&mut connection, plugin_id, workspace, enabled)
}

pub fn grant(plugin_id: &str, permissions: Vec<String>) -> Result<i64, String> {
    let mut connection = open_db()?;
    let plugin = get_plugin(&connection, plugin_id)?;
    validate_granted_permissions(&plugin.manifest.permissions, &permissions)?;
    replace_grants(&mut connection, plugin_id, &permissions)
}

pub fn uninstall(plugin_id: &str) -> Result<(), String> {
    let mut connection = open_db()?;
    let package_hash = uninstall_plugin(&mut connection, plugin_id)?;
    let still_used: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM plugins WHERE package_hash = ?1",
            rusqlite::params![package_hash],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查插件包引用失败：{error}"))?;
    if still_used == 0 {
        let package = package_path(&package_hash)?;
        if package.exists() {
            fs::remove_dir_all(package).map_err(|error| format!("删除插件包失败：{error}"))?;
        }
    }
    Ok(())
}

pub fn configure(update: PluginConfigUpdate) -> Result<i64, String> {
    let mut connection = open_db()?;
    let plugin = get_plugin(&connection, &update.plugin_id)?;
    validate_plugin_config(&plugin, &update.config)?;
    let workspace = scoped_workspace(&plugin, update.workspace.as_deref());
    update_config(
        &mut connection,
        &update.plugin_id,
        workspace,
        update.expected_revision,
        &update.config,
    )
}

pub fn prepare_turn(workspace: &str) -> Result<PluginTurnSnapshot, String> {
    let connection = open_db()?;
    let inventory = inventory_with(&connection, Some(workspace))?;
    let mut tools = Vec::new();
    let mut prompt_sections = Vec::new();
    let mut hooks = Vec::new();
    'plugins: for item in inventory
        .into_iter()
        .filter(|item| is_runnable_phase(&item.phase))
    {
        let root = package_path(&item.package_hash)?;
        let mut item_prompt_sections = Vec::new();
        for contribution in &item.contributes.prompt_sections {
            let content = match read_prompt_content(
                &root,
                contribution.content.as_deref(),
                contribution.source.as_deref(),
            ) {
                Ok(content) => content,
                Err(error) => {
                    record_failure(&connection, &item.id, &error)?;
                    continue 'plugins;
                }
            };
            item_prompt_sections.push(PluginSnapshotPromptSection {
                plugin_id: item.id.clone(),
                plugin_version: item.version.clone(),
                package_hash: item.package_hash.clone(),
                generation: item.generation,
                id: contribution.id.clone(),
                content,
                position: contribution.position.clone(),
                max_tokens: Some(contribution.max_tokens.unwrap_or(2_000)),
            });
        }
        tools.extend(
            item.contributes
                .tools
                .into_iter()
                .map(|contribution| PluginSnapshotTool {
                    plugin_id: item.id.clone(),
                    plugin_version: item.version.clone(),
                    package_hash: item.package_hash.clone(),
                    generation: item.generation,
                    contribution,
                }),
        );
        prompt_sections.extend(item_prompt_sections);
        for contribution in item.contributes.hooks {
            hooks.push(PluginSnapshotHook {
                plugin_id: item.id.clone(),
                plugin_version: item.version.clone(),
                package_hash: item.package_hash.clone(),
                generation: item.generation,
                contribution,
            });
        }
    }
    tools.sort_by(|left, right| {
        left.plugin_id
            .cmp(&right.plugin_id)
            .then_with(|| left.contribution.id.cmp(&right.contribution.id))
    });
    prompt_sections.sort_by(|left, right| {
        prompt_position_rank(left.position.as_deref())
            .cmp(&prompt_position_rank(right.position.as_deref()))
            .then_with(|| left.plugin_id.cmp(&right.plugin_id))
            .then_with(|| left.id.cmp(&right.id))
    });
    hooks.sort_by(|left, right| {
        left.plugin_id
            .cmp(&right.plugin_id)
            .then_with(|| left.contribution.id.cmp(&right.contribution.id))
    });
    let workspace = super::db::workspace_key(workspace)?;
    let revision_payload = serde_json::json!({
        "workspace": workspace,
        "tools": tools,
        "promptSections": prompt_sections,
        "hooks": hooks,
    });
    let revision_digest = Sha256::digest(
        serde_json::to_vec(&revision_payload)
            .map_err(|error| format!("序列化插件 Turn Snapshot 失败：{error}"))?,
    );
    let revision = revision_digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(PluginTurnSnapshot {
        revision,
        workspace,
        tools,
        prompt_sections,
        hooks,
    })
}

pub fn invoke_tool(
    workspace: &str,
    plugin_id: &str,
    model_name: &str,
    generation: i64,
    arguments: Value,
) -> Result<PluginInvocationResult, String> {
    let connection = open_db()?;
    let plugin = get_plugin(&connection, plugin_id)?;
    // generation 是最便宜也最关键的一道 fencing：安装、启停、授权、配置任一变化都会
    // 推进它，携带旧 generation 的快照调用必须先被拒掉，再谈其余状态。
    if plugin.generation != generation {
        return Err(format!(
            "插件 generation 已变化，调用为 {generation}，当前为 {}",
            plugin.generation
        ));
    }
    // phase 已经覆盖禁用、缺授权、配置非法与依赖不可用，无需再逐项重复查询一遍。
    let item = inventory_with(&connection, Some(workspace))?
        .into_iter()
        .find(|item| item.id == plugin_id)
        .ok_or_else(|| format!("插件未安装：{plugin_id}"))?;
    if !is_runnable_phase(&item.phase) {
        return Err(unavailable_reason(&item));
    }
    let scoped_workspace = scoped_workspace(&plugin, Some(workspace));
    let tool = plugin
        .manifest
        .contributes
        .tools
        .iter()
        .find(|tool| tool.model_name == model_name)
        .ok_or_else(|| format!("插件未声明工具：{model_name}"))?;
    validate_value_against_schema(
        &tool.input_schema,
        &arguments,
        &format!("插件工具 {plugin_id}/{model_name} 的输入"),
    )?;
    let (config, _) = read_effective_config(&connection, plugin_id, scoped_workspace)?;
    let output_schema = tool.output_schema.clone();
    let request = PluginInvocationRequest {
        protocol_version: 1,
        plugin_id: plugin.manifest.id.clone(),
        plugin_version: plugin.manifest.version.clone(),
        package_hash: plugin.package_hash.clone(),
        generation: plugin.generation,
        contribution_id: tool.id.clone(),
        handler: tool.handler.clone(),
        arguments,
        workspace: super::db::workspace_key(workspace)?,
        config,
    };
    drop(connection);
    let root = package_path(&plugin.package_hash)?;
    match invoke_runtime(&root, &plugin.manifest.runtime, &request) {
        Ok(result) => {
            let connection = open_db()?;
            if !result.is_error {
                if let Some(schema) = output_schema.as_ref() {
                    if let Err(error) = validate_value_against_schema(
                        schema,
                        &result.details,
                        &format!("插件工具 {plugin_id}/{model_name} 的输出"),
                    ) {
                        let error = format!("插件工具输出不符合 outputSchema：{error}");
                        record_failure(&connection, plugin_id, &error)?;
                        return Err(error);
                    }
                }
            }
            clear_failure(&connection, plugin_id)?;
            Ok(result)
        }
        Err(error) => {
            let connection = open_db()?;
            record_failure(&connection, plugin_id, &error)?;
            Err(error)
        }
    }
}

pub fn dispatch_hook(
    request: PluginHookDispatchRequest,
) -> Result<Vec<PluginHookDispatchResult>, String> {
    if request.snapshot_revision.trim().is_empty() {
        return Err("插件 Hook 请求缺少 Turn Snapshot revision".to_string());
    }
    let connection = open_db()?;
    let runnable = inventory_with(&connection, Some(&request.workspace))?
        .into_iter()
        .filter(|item| is_runnable_phase(&item.phase))
        .map(|item| (item.id.clone(), item))
        .collect::<HashMap<_, _>>();
    // 同一插件可以注册多个 Hook，Manifest 只需按插件读一次。
    let stored = list_plugins(&connection)?
        .into_iter()
        .map(|plugin| (plugin.manifest.id.clone(), plugin))
        .collect::<HashMap<_, _>>();
    let mut results = Vec::new();
    let mut plugin_failures = HashMap::<String, Vec<String>>::new();
    let mut dispatched_plugins = HashSet::new();
    for snapshot_hook in request
        .hooks
        .iter()
        .filter(|hook| hook.contribution.event == request.event)
    {
        let plugin_id = snapshot_hook.plugin_id.clone();
        dispatched_plugins.insert(plugin_id.clone());
        let result = (|| {
            let plugin = stored
                .get(&plugin_id)
                .ok_or_else(|| format!("插件未安装：{plugin_id}"))?;
            let Some(item) = runnable.get(&plugin_id) else {
                return Err(format!("插件当前不可运行：{plugin_id}"));
            };
            if item.generation != snapshot_hook.generation
                || item.version != snapshot_hook.plugin_version
                || item.package_hash != snapshot_hook.package_hash
            {
                return Err(format!(
                    "插件 Hook 快照已过期：{plugin_id}/{}",
                    snapshot_hook.contribution.id
                ));
            }
            let hook = plugin
                .manifest
                .contributes
                .hooks
                .iter()
                .find(|hook| hook.id == snapshot_hook.contribution.id)
                .ok_or_else(|| {
                    format!(
                        "插件未声明 Hook：{plugin_id}/{}",
                        snapshot_hook.contribution.id
                    )
                })?;
            if hook != &snapshot_hook.contribution {
                return Err(format!(
                    "插件 Hook 定义与 Turn Snapshot 不一致：{plugin_id}/{}",
                    hook.id
                ));
            }
            let workspace = scoped_workspace(plugin, Some(&request.workspace));
            let (config, _) = read_effective_config(&connection, &plugin_id, workspace)?;
            let invocation = PluginInvocationRequest {
                protocol_version: 1,
                plugin_id: plugin.manifest.id.clone(),
                plugin_version: plugin.manifest.version.clone(),
                package_hash: plugin.package_hash.clone(),
                generation: snapshot_hook.generation,
                contribution_id: hook.id.clone(),
                handler: hook.handler.clone(),
                arguments: request.payload.clone(),
                workspace: super::db::workspace_key(&request.workspace)?,
                config,
            };
            let root = package_path(&plugin.package_hash)?;
            let mut runtime = plugin.manifest.runtime.clone();
            runtime.timeout_ms = hook.timeout_ms;
            invoke_runtime(&root, &runtime, &invocation).map(|_| ())
        })();
        let error = result.err();
        if let Some(error) = &error {
            plugin_failures
                .entry(plugin_id.clone())
                .or_default()
                .push(format!("Hook {}: {error}", snapshot_hook.contribution.id));
        }
        results.push(PluginHookDispatchResult {
            plugin_id,
            hook_id: snapshot_hook.contribution.id.clone(),
            success: error.is_none(),
            error,
        });
    }
    for plugin_id in dispatched_plugins {
        if let Some(failures) = plugin_failures.get(&plugin_id) {
            record_failure(&connection, &plugin_id, &failures.join("\n"))?;
        } else {
            clear_failure(&connection, &plugin_id)?;
        }
    }
    Ok(results)
}

pub(super) fn scoped_workspace<'a>(
    plugin: &StoredPlugin,
    workspace: Option<&'a str>,
) -> Option<&'a str> {
    match plugin.manifest.runtime.scope {
        PluginRuntimeScope::Application => None,
        PluginRuntimeScope::Workspace => workspace,
    }
}

fn is_runnable_phase(phase: &PluginLifecyclePhase) -> bool {
    matches!(
        phase,
        PluginLifecyclePhase::Active | PluginLifecyclePhase::Failed
    )
}

/// 不可运行时给出面向用户的原因。`failed` 仍算可运行（下一次成功调用即可恢复），
/// 因此这里只会遇到 disabled / blocked。
fn unavailable_reason(item: &PluginInventoryItem) -> String {
    item.blocked_reason
        .clone()
        .or_else(|| item.last_error.clone())
        .unwrap_or_else(|| match item.phase {
            PluginLifecyclePhase::Disabled => format!("插件已禁用：{}", item.id),
            _ => format!("插件当前不可用：{}", item.id),
        })
}

pub(super) fn resolve_blocked_reasons(
    plugins: &[StoredPlugin],
    enabled: &HashMap<String, bool>,
    grants: &HashMap<String, Vec<String>>,
    config_errors: &HashMap<String, String>,
) -> Result<HashMap<String, Option<String>>, String> {
    let by_id = plugins
        .iter()
        .map(|plugin| (plugin.manifest.id.as_str(), plugin))
        .collect::<HashMap<_, _>>();
    let core = CORE_CAPABILITIES
        .iter()
        .map(|(id, version)| ((*id).to_string(), (*version).to_string()))
        .collect::<BTreeMap<_, _>>();
    let dependency_graph = plugins
        .iter()
        .filter(|plugin| enabled.get(&plugin.manifest.id).copied().unwrap_or(false))
        .map(|plugin| {
            (
                plugin.manifest.id.clone(),
                plugin
                    .manifest
                    .requires
                    .plugins
                    .keys()
                    .filter(|dependency| enabled.get(*dependency).copied().unwrap_or(false))
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let dependency_cycles = dependency_cycle_reasons(&dependency_graph);
    let mut available = HashSet::new();
    loop {
        let mut changed = false;
        for plugin in plugins {
            let plugin_id = &plugin.manifest.id;
            if available.contains(plugin_id)
                || !enabled.get(plugin_id).copied().unwrap_or(false)
                || dependency_cycles.contains_key(plugin_id)
                || config_errors.contains_key(plugin_id)
                || missing_permission_reason(
                    plugin,
                    grants.get(plugin_id).map(Vec::as_slice).unwrap_or_default(),
                )
                .is_some()
            {
                continue;
            }
            let plugin_dependencies_ready =
                plugin
                    .manifest
                    .requires
                    .plugins
                    .iter()
                    .all(|(required_id, required_version)| {
                        let Some(dependency) = by_id.get(required_id.as_str()) else {
                            return false;
                        };
                        enabled.get(required_id).copied().unwrap_or(false)
                            && version_matches(required_version, &dependency.manifest.version)
                                .unwrap_or(false)
                            && available.contains(required_id)
                    });
            if !plugin_dependencies_ready {
                continue;
            }
            let capabilities_ready =
                plugin
                    .manifest
                    .requires
                    .capabilities
                    .iter()
                    .all(|(capability, requirement)| {
                        core.get(capability).is_some_and(|version| {
                            version_matches(requirement, version).unwrap_or(false)
                        }) || plugins.iter().any(|provider| {
                            available.contains(&provider.manifest.id)
                                && provider
                                    .manifest
                                    .provides
                                    .capabilities
                                    .get(capability)
                                    .is_some_and(|version| {
                                        version_matches(requirement, version).unwrap_or(false)
                                    })
                        })
                    });
            if capabilities_ready {
                changed |= available.insert(plugin_id.clone());
            }
        }
        if !changed {
            break;
        }
    }
    let mut reasons = HashMap::new();
    for plugin in plugins {
        let plugin_id = &plugin.manifest.id;
        if !enabled.get(plugin_id).copied().unwrap_or(false) || available.contains(plugin_id) {
            reasons.insert(plugin_id.clone(), None);
            continue;
        }
        let mut reason = dependency_cycles.get(plugin_id).cloned().or_else(|| {
            missing_permission_reason(
                plugin,
                grants.get(plugin_id).map(Vec::as_slice).unwrap_or_default(),
            )
        });
        if reason.is_none() {
            reason = config_errors.get(plugin_id).cloned();
        }
        for (required_id, required_version) in &plugin.manifest.requires.plugins {
            if reason.is_some() {
                break;
            }
            let Some(dependency) = by_id.get(required_id.as_str()) else {
                reason = Some(format!("缺少依赖插件 {required_id} {required_version}"));
                break;
            };
            if !enabled.get(required_id).copied().unwrap_or(false) {
                reason = Some(format!("依赖插件 {required_id} 未启用"));
                break;
            }
            if !version_matches(required_version, &dependency.manifest.version)? {
                reason = Some(format!(
                    "依赖插件 {required_id} 需要 {required_version}，当前为 {}",
                    dependency.manifest.version
                ));
                break;
            }
            if !available.contains(required_id) {
                reason = Some(format!("依赖插件 {required_id} 当前被阻止"));
                break;
            }
        }
        if reason.is_none() {
            for (capability, requirement) in &plugin.manifest.requires.capabilities {
                let matching_core = core
                    .get(capability)
                    .is_some_and(|version| version_matches(requirement, version).unwrap_or(false));
                let matching_provider = plugins.iter().any(|provider| {
                    available.contains(&provider.manifest.id)
                        && provider
                            .manifest
                            .provides
                            .capabilities
                            .get(capability)
                            .is_some_and(|version| {
                                version_matches(requirement, version).unwrap_or(false)
                            })
                });
                if !matching_core && !matching_provider {
                    reason = Some(format!(
                        "Capability {capability} {requirement} 没有可用提供者（可能存在依赖环）"
                    ));
                    break;
                }
            }
        }
        reasons.insert(plugin_id.clone(), reason);
    }
    Ok(reasons)
}

pub(super) fn dependency_cycle_reasons(
    graph: &BTreeMap<String, Vec<String>>,
) -> HashMap<String, String> {
    fn visit(
        node: &str,
        graph: &BTreeMap<String, Vec<String>>,
        states: &mut HashMap<String, u8>,
        stack: &mut Vec<String>,
        reasons: &mut HashMap<String, String>,
    ) {
        match states.get(node).copied() {
            Some(1) => {
                if let Some(start) = stack.iter().position(|candidate| candidate == node) {
                    let mut cycle = stack[start..].to_vec();
                    cycle.push(node.to_string());
                    let reason = format!("插件依赖形成循环：{}", cycle.join(" -> "));
                    for member in &stack[start..] {
                        reasons
                            .entry(member.clone())
                            .or_insert_with(|| reason.clone());
                    }
                }
                return;
            }
            Some(2) => return,
            _ => {}
        }
        states.insert(node.to_string(), 1);
        stack.push(node.to_string());
        if let Some(dependencies) = graph.get(node) {
            for dependency in dependencies {
                if graph.contains_key(dependency) {
                    visit(dependency, graph, states, stack, reasons);
                }
            }
        }
        stack.pop();
        states.insert(node.to_string(), 2);
    }

    let mut states = HashMap::new();
    let mut stack = Vec::new();
    let mut reasons = HashMap::new();
    for node in graph.keys() {
        visit(node, graph, &mut states, &mut stack, &mut reasons);
    }
    reasons
}

fn missing_permission_reason(plugin: &StoredPlugin, grants: &[String]) -> Option<String> {
    let grants = grants.iter().map(String::as_str).collect::<HashSet<_>>();
    let missing = plugin
        .manifest
        .permissions
        .iter()
        .filter(|permission| !grants.contains(permission.id.as_str()))
        .map(|permission| permission.id.clone())
        .collect::<Vec<_>>();
    (!missing.is_empty()).then(|| format!("缺少插件权限授权：{}", missing.join(", ")))
}

fn validate_granted_permissions(
    requested: &[super::types::PluginPermissionRequest],
    granted: &[String],
) -> Result<(), String> {
    let requested = requested
        .iter()
        .map(|permission| permission.id.as_str())
        .collect::<HashSet<_>>();
    for permission in granted {
        if !requested.contains(permission.as_str()) {
            return Err(format!("不能授予 Manifest 未申请的权限：{permission}"));
        }
    }
    Ok(())
}

pub(super) fn validate_plugin_config(plugin: &StoredPlugin, config: &Value) -> Result<(), String> {
    if plugin.manifest.contributes.settings.is_empty() {
        return if config.as_object().is_some_and(|object| object.is_empty()) {
            Ok(())
        } else {
            Err("该插件没有声明可配置项".to_string())
        };
    }
    if plugin.manifest.contributes.settings.len() == 1 {
        return validate_config_against_schema(
            &plugin.manifest.contributes.settings[0].schema,
            config,
        );
    }
    let object = config
        .as_object()
        .ok_or_else(|| "多 Section 插件配置必须是 JSON object".to_string())?;
    for settings in &plugin.manifest.contributes.settings {
        let value = object
            .get(&settings.id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        validate_config_against_schema(&settings.schema, &value)?;
    }
    Ok(())
}

fn version_matches(requirement: &str, version: &str) -> Result<bool, String> {
    let requirement = VersionReq::parse(requirement)
        .map_err(|error| format!("依赖版本范围无效 {requirement}：{error}"))?;
    let version =
        Version::parse(version).map_err(|error| format!("依赖版本无效 {version}：{error}"))?;
    Ok(requirement.matches(&version))
}

/// 词表真源见 manifest::PROMPT_SECTION_POSITIONS，安装期已拒绝表外取值；
/// 未声明 position 时按 `agent-context` 排序。
fn prompt_position_rank(position: Option<&str>) -> usize {
    let position = position.unwrap_or(DEFAULT_PROMPT_SECTION_POSITION);
    PROMPT_SECTION_POSITIONS
        .iter()
        .position(|candidate| *candidate == position)
        .unwrap_or(PROMPT_SECTION_POSITIONS.len())
}

pub fn plugin_api_version() -> &'static str {
    PLUGIN_API_VERSION
}
