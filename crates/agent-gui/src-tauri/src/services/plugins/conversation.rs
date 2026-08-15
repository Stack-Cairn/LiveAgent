use semver::Version;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use super::db::workspace_key;
use super::manager::{enable, install, inventory};
use super::manifest::DEFAULT_PROMPT_SECTION_POSITION;
use super::types::{
    ConversationPromptPluginRequest, PluginContributions, PluginDependencies, PluginEngines,
    PluginInstallOptions, PluginInventoryItem, PluginManifest, PluginPermissionRequest,
    PluginPromptSectionContribution, PluginProvides, PluginPublisher, PluginRuntime,
    PluginRuntimeKind, PluginRuntimeScope,
};

const CONVERSATION_PLUGIN_ID_PREFIX: &str = "com.liveagent.conversation.";
const CONVERSATION_PLUGIN_PUBLISHER_ID: &str = "liveagent-conversation";
const PROMPT_PERMISSION: &str = "agent.promptSections.contribute";
const DEFAULT_MAX_TOKENS: u32 = 1_200;
const MAX_MAX_TOKENS: u32 = 4_000;
const MAX_INSTRUCTIONS_CHARS: usize = 12_000;

pub fn create_prompt_plugin(
    request: ConversationPromptPluginRequest,
) -> Result<PluginInventoryItem, String> {
    let workspace = workspace_key(&request.workspace)?;
    let plugin_id = conversation_plugin_id(&request.slug)?;
    let existing = inventory(Some(&workspace))?
        .into_iter()
        .find(|item| item.id == plugin_id);
    if let Some(item) = existing.as_ref() {
        if !request.replace {
            return Err(format!(
                "对话插件已存在：{}；只有用户明确要求替换时才能设置 replace=true",
                item.id
            ));
        }
        if item.publisher.id != CONVERSATION_PLUGIN_PUBLISHER_ID
            || item.runtime.kind != PluginRuntimeKind::Declarative
        {
            return Err(format!("拒绝替换非对话式声明插件：{}", item.id));
        }
    }
    let version = next_version(existing.as_ref().map(|item| item.version.as_str()))?;
    let manifest = build_prompt_manifest(&request, &plugin_id, &version)?;
    let source = tempfile::Builder::new()
        .prefix("liveagent-conversation-plugin-")
        .tempdir()
        .map_err(|error| format!("创建对话插件临时目录失败：{error}"))?;
    write_prompt_package(source.path(), &manifest)?;
    install(
        source
            .path()
            .to_str()
            .ok_or_else(|| "对话插件临时路径不是有效 UTF-8".to_string())?,
        PluginInstallOptions {
            allow_unsigned: false,
            allow_full_trust: false,
            granted_permissions: vec![PROMPT_PERMISSION.to_string()],
        },
    )?;
    enable(&plugin_id, Some(&workspace), true)?;
    inventory(Some(&workspace))?
        .into_iter()
        .find(|item| item.id == plugin_id)
        .ok_or_else(|| "对话插件创建后未出现在 Inventory 中".to_string())
}

pub(super) fn conversation_plugin_id(slug: &str) -> Result<String, String> {
    let slug = slug.trim();
    if slug.is_empty() || slug.len() > 48 {
        return Err("PluginCreate.slug 必须为 1 到 48 个字符".to_string());
    }
    if !slug.split('-').all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    }) {
        return Err("PluginCreate.slug 只能包含小写字母、数字和分隔单词的连字符".to_string());
    }
    Ok(format!("{CONVERSATION_PLUGIN_ID_PREFIX}{slug}"))
}

fn next_version(existing: Option<&str>) -> Result<String, String> {
    let Some(existing) = existing else {
        return Ok("1.0.0".to_string());
    };
    let mut version = Version::parse(existing)
        .map_err(|error| format!("现有对话插件版本不是有效 SemVer：{error}"))?;
    version.patch = version
        .patch
        .checked_add(1)
        .ok_or_else(|| "对话插件 patch 版本已溢出".to_string())?;
    version.pre = semver::Prerelease::EMPTY;
    version.build = semver::BuildMetadata::EMPTY;
    Ok(version.to_string())
}

pub(super) fn build_prompt_manifest(
    request: &ConversationPromptPluginRequest,
    plugin_id: &str,
    version: &str,
) -> Result<PluginManifest, String> {
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("PluginCreate.name 必须为 1 到 80 个字符".to_string());
    }
    let description = request.description.trim();
    if description.chars().count() > 500 {
        return Err("PluginCreate.description 不能超过 500 个字符".to_string());
    }
    let instructions = request.instructions.trim();
    if instructions.is_empty() || instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
        return Err(format!(
            "PluginCreate.instructions 必须为 1 到 {MAX_INSTRUCTIONS_CHARS} 个字符"
        ));
    }
    let normalized_instructions = instructions.to_ascii_lowercase();
    if normalized_instructions.contains("<liveagent-plugin-context")
        || normalized_instructions.contains("</liveagent-plugin-context")
        || instructions.contains('\0')
    {
        return Err("PluginCreate.instructions 包含保留的插件上下文标记或控制字符".to_string());
    }
    let max_tokens = request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    if max_tokens == 0 || max_tokens > MAX_MAX_TOKENS {
        return Err(format!(
            "PluginCreate.maxTokens 必须在 1 到 {MAX_MAX_TOKENS} 之间"
        ));
    }
    Ok(PluginManifest {
        schema: None,
        schema_version: 1,
        id: plugin_id.to_string(),
        name: name.to_string(),
        version: version.to_string(),
        description: description.to_string(),
        publisher: PluginPublisher {
            id: CONVERSATION_PLUGIN_PUBLISHER_ID.to_string(),
            name: "LiveAgent Conversation Builder".to_string(),
            key_id: None,
        },
        engines: PluginEngines {
            liveagent: None,
            plugin_api: Some("^1.0.0".to_string()),
        },
        runtime: PluginRuntime {
            kind: PluginRuntimeKind::Declarative,
            entry: None,
            command: None,
            args: Vec::new(),
            scope: PluginRuntimeScope::Workspace,
            timeout_ms: 30_000,
            fuel: 50_000_000,
        },
        permissions: vec![PluginPermissionRequest {
            id: PROMPT_PERMISSION.to_string(),
            paths: Vec::new(),
            origins: Vec::new(),
            keys: Vec::new(),
        }],
        requires: PluginDependencies::default(),
        provides: PluginProvides::default(),
        contributes: PluginContributions {
            tools: Vec::new(),
            prompt_sections: vec![PluginPromptSectionContribution {
                id: "instructions".to_string(),
                content: Some(instructions.to_string()),
                source: None,
                position: Some(DEFAULT_PROMPT_SECTION_POSITION.to_string()),
                max_tokens: Some(max_tokens),
            }],
            hooks: Vec::new(),
            settings: Vec::new(),
        },
    })
}

pub(super) fn write_prompt_package(root: &Path, manifest: &PluginManifest) -> Result<(), String> {
    let mut manifest_bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("序列化对话插件 Manifest 失败：{error}"))?;
    manifest_bytes.push(b'\n');
    fs::write(root.join("manifest.json"), &manifest_bytes)
        .map_err(|error| format!("写入对话插件 Manifest 失败：{error}"))?;
    let manifest_hash = hex_digest(Sha256::digest(&manifest_bytes).as_slice());
    let integrity = json!({
        "algorithm": "sha256",
        "files": BTreeMap::from([("manifest.json", manifest_hash)])
    });
    let mut integrity_bytes = serde_json::to_vec_pretty(&integrity)
        .map_err(|error| format!("序列化对话插件完整性清单失败：{error}"))?;
    integrity_bytes.push(b'\n');
    fs::write(root.join("integrity.json"), integrity_bytes)
        .map_err(|error| format!("写入对话插件完整性清单失败：{error}"))
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
