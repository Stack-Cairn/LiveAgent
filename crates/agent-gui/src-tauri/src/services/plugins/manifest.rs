use regex::Regex;
use semver::{Version, VersionReq};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

use super::types::{PluginManifest, PluginRuntimeKind};

pub const PLUGIN_API_VERSION: &str = "1.0.0";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const SUPPORTED_PERMISSION_IDS: &[&str] = &[
    "agent.tools.register",
    "agent.promptSections.contribute",
    "agent.hooks.observe",
    "process.fullTrust",
];
/// Prompt Section 注入位置的完整词表，同时是排序键的真源（见 manager::prompt_position_rank）。
/// 未声明时按 `agent-context` 处理；安装期拒绝表外取值，避免 Manifest 写了一个
/// 宿主根本不认识、最终静默落到默认档位的字符串。
pub const PROMPT_SECTION_POSITIONS: &[&str] = &[
    "system-leading",
    "workspace-context",
    "agent-context",
    "system-trailing",
];
/// `agent-context` 在词表中的下标，同时是未声明 position 时的默认档位。
pub const DEFAULT_PROMPT_SECTION_POSITION: &str = "agent-context";
/// 编译后的 JSON Schema 校验器缓存上限；超过直接整表清空。
const MAX_CACHED_VALIDATORS: usize = 128;

/// 反向域名格式，同时用于 plugin id 与 capability id。
static DOMAIN_ID_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])?$").expect("static regex")
});
static MODEL_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$").expect("static regex"));
static CONTRIBUTION_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$").expect("static regex"));

pub fn load_manifest(root: &Path) -> Result<PluginManifest, String> {
    let path = root.join("manifest.json");
    let metadata =
        fs::metadata(&path).map_err(|error| format!("插件包缺少 manifest.json：{error}"))?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err("manifest.json 超过 1 MiB 限制".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("读取 manifest.json 失败：{error}"))?;
    let manifest: PluginManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析 manifest.json 失败：{error}"))?;
    validate_manifest(root, &manifest)?;
    Ok(manifest)
}

pub fn validate_manifest(root: &Path, manifest: &PluginManifest) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err(format!(
            "不支持的插件 schemaVersion {}，当前仅支持 1",
            manifest.schema_version
        ));
    }

    if !DOMAIN_ID_PATTERN.is_match(manifest.id.trim()) || !manifest.id.contains('.') {
        return Err("插件 id 必须是小写反向域名格式".to_string());
    }
    if manifest.name.trim().is_empty() || manifest.name.chars().count() > 120 {
        return Err("插件 name 不能为空且不能超过 120 个字符".to_string());
    }
    Version::parse(manifest.version.trim())
        .map_err(|error| format!("插件 version 不是有效 SemVer：{error}"))?;
    if manifest.publisher.id.trim().is_empty() {
        return Err("插件 publisher.id 不能为空".to_string());
    }
    if manifest.publisher.key_id.is_some() {
        return Err(
            "publisher.keyId 需要 Marketplace Trust Store，Plugin API v1 尚未支持".to_string(),
        );
    }

    validate_engine_requirement(
        "LiveAgent",
        manifest.engines.liveagent.as_deref(),
        crate::app_version(),
    )?;
    validate_engine_requirement(
        "Plugin API",
        manifest.engines.plugin_api.as_deref(),
        PLUGIN_API_VERSION,
    )?;

    match manifest.runtime.kind {
        PluginRuntimeKind::WasiCommand => {
            let entry = manifest
                .runtime
                .entry
                .as_deref()
                .ok_or_else(|| "wasi-command runtime 必须声明 entry".to_string())?;
            resolve_package_file(root, entry)?;
        }
        PluginRuntimeKind::Process => {
            if manifest
                .runtime
                .command
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                return Err("process runtime 必须声明 command".to_string());
            }
            if let Some(entry) = manifest.runtime.entry.as_deref() {
                resolve_package_file(root, entry)?;
            }
            if !manifest
                .permissions
                .iter()
                .any(|permission| permission.id == "process.fullTrust")
            {
                return Err("process runtime 必须申请 process.fullTrust 权限".to_string());
            }
        }
        PluginRuntimeKind::Declarative => {
            if !manifest.contributes.tools.is_empty() || !manifest.contributes.hooks.is_empty() {
                return Err("declarative runtime 不能声明 tools 或 hooks".to_string());
            }
        }
    }

    if manifest.runtime.timeout_ms == 0 || manifest.runtime.timeout_ms > 10 * 60_000 {
        return Err("runtime.timeoutMs 必须在 1 到 600000 之间".to_string());
    }
    if manifest.runtime.fuel == 0 || manifest.runtime.fuel > 1_000_000_000 {
        return Err("runtime.fuel 必须在 1 到 1000000000 之间".to_string());
    }

    let mut contribution_ids = HashSet::new();
    let mut model_names = HashSet::new();
    for tool in &manifest.contributes.tools {
        validate_contribution_id(&tool.id, &mut contribution_ids)?;
        if !MODEL_NAME_PATTERN.is_match(&tool.model_name) {
            return Err(format!("工具 {} 的 modelName 格式无效", tool.id));
        }
        if !model_names.insert(tool.model_name.to_ascii_lowercase()) {
            return Err(format!("工具 modelName 重复：{}", tool.model_name));
        }
        if tool.description.trim().is_empty() {
            return Err(format!("工具 {} 的 description 不能为空", tool.id));
        }
        if tool.input_schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(format!(
                "工具 {} 的 inputSchema 顶层 type 必须是 object",
                tool.id
            ));
        }
        validate_json_schema(
            &tool.input_schema,
            &format!("工具 {} 的 inputSchema", tool.id),
        )?;
        if let Some(schema) = tool.output_schema.as_ref() {
            if !schema.is_object() {
                return Err(format!(
                    "工具 {} 的 outputSchema 必须是 JSON object",
                    tool.id
                ));
            }
            validate_json_schema(schema, &format!("工具 {} 的 outputSchema", tool.id))?;
        }
        if tool.handler.trim().is_empty() {
            return Err(format!("工具 {} 的 handler 不能为空", tool.id));
        }
    }

    for prompt in &manifest.contributes.prompt_sections {
        validate_contribution_id(&prompt.id, &mut contribution_ids)?;
        match (prompt.content.as_deref(), prompt.source.as_deref()) {
            (Some(content), None) if !content.trim().is_empty() => {}
            (None, Some(source)) => {
                read_prompt_content(root, None, Some(source))?;
            }
            _ => {
                return Err(format!(
                    "Prompt Section {} 必须且只能声明 content 或 source",
                    prompt.id
                ));
            }
        }
        if prompt.max_tokens.unwrap_or(1) == 0 || prompt.max_tokens.unwrap_or(1) > 16_000 {
            return Err(format!(
                "Prompt Section {} 的 maxTokens 超出限制",
                prompt.id
            ));
        }
        if let Some(position) = prompt.position.as_deref() {
            if !PROMPT_SECTION_POSITIONS.contains(&position) {
                return Err(format!(
                    "Prompt Section {} 的 position {position} 无效，支持的取值为：{}",
                    prompt.id,
                    PROMPT_SECTION_POSITIONS.join(", ")
                ));
            }
        }
    }

    for hook in &manifest.contributes.hooks {
        validate_contribution_id(&hook.id, &mut contribution_ids)?;
        if !hook.observe_only {
            return Err(format!("Hook {} 当前仅支持 observeOnly=true", hook.id));
        }
        if hook.handler.trim().is_empty() {
            return Err(format!("Hook {} 的 handler 不能为空", hook.id));
        }
        if hook.timeout_ms == 0 || hook.timeout_ms > 10 * 60_000 {
            return Err(format!(
                "Hook {} 的 timeoutMs 必须在 1 到 600000 之间",
                hook.id
            ));
        }
    }

    for settings in &manifest.contributes.settings {
        validate_contribution_id(&settings.id, &mut contribution_ids)?;
        if settings.schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(format!(
                "Settings {} 的 schema 顶层 type 必须是 object",
                settings.id
            ));
        }
        validate_json_schema(
            &settings.schema,
            &format!("Settings {} 的 schema", settings.id),
        )?;
        reject_secret_settings_schema(&settings.schema, &settings.id, "$")?;
    }

    let mut permission_ids = HashSet::new();
    for permission in &manifest.permissions {
        if permission.id.trim().is_empty() {
            return Err("权限 id 不能为空".to_string());
        }
        if !SUPPORTED_PERMISSION_IDS.contains(&permission.id.as_str()) {
            return Err(format!(
                "当前 Plugin API 不支持权限 {}，支持的权限为：{}",
                permission.id,
                SUPPORTED_PERMISSION_IDS.join(", ")
            ));
        }
        if !permission.paths.is_empty()
            || !permission.origins.is_empty()
            || !permission.keys.is_empty()
        {
            return Err(format!(
                "权限 {} 的 paths/origins/keys 限定符在 Plugin API v1 尚未开放",
                permission.id
            ));
        }
        if !permission_ids.insert(permission.id.as_str()) {
            return Err(format!("权限重复：{}", permission.id));
        }
    }

    for (plugin_id, requirement) in &manifest.requires.plugins {
        if !DOMAIN_ID_PATTERN.is_match(plugin_id) || !plugin_id.contains('.') {
            return Err(format!("依赖插件 id 格式无效：{plugin_id}"));
        }
        VersionReq::parse(requirement)
            .map_err(|error| format!("依赖插件 {plugin_id} 的版本范围无效：{error}"))?;
    }
    for (capability, requirement) in &manifest.requires.capabilities {
        validate_capability_id(capability)?;
        VersionReq::parse(requirement)
            .map_err(|error| format!("Capability {capability} 的版本范围无效：{error}"))?;
    }
    for (capability, version) in &manifest.provides.capabilities {
        validate_capability_id(capability)?;
        Version::parse(version)
            .map_err(|error| format!("Capability {capability} 的版本无效：{error}"))?;
    }

    if !manifest.contributes.tools.is_empty() && !permission_ids.contains("agent.tools.register") {
        return Err("声明 tools 时必须申请 agent.tools.register 权限".to_string());
    }
    if !manifest.contributes.prompt_sections.is_empty()
        && !permission_ids.contains("agent.promptSections.contribute")
    {
        return Err(
            "声明 promptSections 时必须申请 agent.promptSections.contribute 权限".to_string(),
        );
    }
    if !manifest.contributes.hooks.is_empty() && !permission_ids.contains("agent.hooks.observe") {
        return Err("声明 hooks 时必须申请 agent.hooks.observe 权限".to_string());
    }

    Ok(())
}

pub fn resolve_package_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err("插件文件路径必须是非空相对路径".to_string());
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!("插件文件路径越界：{}", relative.display()));
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("解析插件根目录失败：{error}"))?;
    let target = root.join(relative);
    let target = target
        .canonicalize()
        .map_err(|error| format!("插件文件不存在 {}：{error}", relative.display()))?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err(format!("插件文件路径无效：{}", relative.display()));
    }
    Ok(target)
}

pub fn read_prompt_content(
    root: &Path,
    content: Option<&str>,
    source: Option<&str>,
) -> Result<String, String> {
    if let Some(content) = content {
        return Ok(content.to_string());
    }
    let source = source.ok_or_else(|| "Prompt Section 缺少内容".to_string())?;
    let path = resolve_package_file(root, source)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("读取 Prompt 文件失败：{error}"))?;
    if metadata.len() > 512 * 1024 {
        return Err("单个 Prompt Section 文件不能超过 512 KiB".to_string());
    }
    fs::read_to_string(path).map_err(|error| format!("读取 Prompt 文件失败：{error}"))
}

fn validate_contribution_id(id: &str, seen: &mut HashSet<String>) -> Result<(), String> {
    if !CONTRIBUTION_ID_PATTERN.is_match(id) {
        return Err(format!("Contribution id 格式无效：{id}"));
    }
    if !seen.insert(id.to_ascii_lowercase()) {
        return Err(format!("Contribution id 重复：{id}"));
    }
    Ok(())
}

fn validate_engine_requirement(
    label: &str,
    requirement: Option<&str>,
    current: &str,
) -> Result<(), String> {
    let Some(requirement) = requirement.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let requirement = VersionReq::parse(requirement)
        .map_err(|error| format!("{label} engines 范围无效：{error}"))?;
    let current = normalize_runtime_version(current)
        .ok_or_else(|| format!("无法解析当前 {label} 版本：{current}"))?;
    if !requirement.matches(&current) {
        return Err(format!(
            "插件要求 {label} {requirement}，当前版本为 {current}"
        ));
    }
    Ok(())
}

fn normalize_runtime_version(value: &str) -> Option<Version> {
    Version::parse(value)
        .or_else(|_| Version::parse(value.trim_start_matches('v')))
        .ok()
        .map(|mut version| {
            version.pre = semver::Prerelease::EMPTY;
            version.build = semver::BuildMetadata::EMPTY;
            version
        })
}

pub fn validate_config_against_schema(schema: &Value, config: &Value) -> Result<(), String> {
    validate_value_against_schema(schema, config, "插件配置")
}

pub fn validate_value_against_schema(
    schema: &Value,
    value: &Value,
    label: &str,
) -> Result<(), String> {
    let validator = build_json_schema_validator(schema, label)?;
    let errors = validator
        .iter_errors(value)
        .take(5)
        .map(|error| {
            let path = error.instance_path().to_string();
            if path.is_empty() {
                error.to_string()
            } else {
                format!("{path}: {error}")
            }
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("{label}不符合 JSON Schema：{}", errors.join("；")))
    }
}

fn validate_json_schema(schema: &Value, label: &str) -> Result<(), String> {
    build_json_schema_validator(schema, label).map(|_| ())
}

/// 编译 Draft 2020-12 校验器并按 Schema 文本缓存。工具输入/输出与插件配置在每次
/// 调用、每次 Inventory 读取时都要校验，而编译一份 Schema 远贵于校验本身；缓存键
/// 用序列化文本而非哈希，避免碰撞导致拿错校验器。编译失败不入缓存。
fn build_json_schema_validator(
    schema: &Value,
    label: &str,
) -> Result<Arc<jsonschema::Validator>, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<jsonschema::Validator>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = serde_json::to_string(schema).ok();
    if let Some(key) = key.as_deref() {
        if let Ok(cache) = cache.lock() {
            if let Some(validator) = cache.get(key) {
                return Ok(validator.clone());
            }
        }
    }
    let validator = Arc::new(
        jsonschema::draft202012::options()
            .build(schema)
            .map_err(|error| format!("{label} 不是有效的 Draft 2020-12 JSON Schema：{error}"))?,
    );
    if let Some(key) = key {
        if let Ok(mut cache) = cache.lock() {
            if cache.len() >= MAX_CACHED_VALIDATORS {
                cache.clear();
            }
            cache.insert(key, validator.clone());
        }
    }
    Ok(validator)
}

fn reject_secret_settings_schema(
    schema: &Value,
    settings_id: &str,
    path: &str,
) -> Result<(), String> {
    match schema {
        Value::Object(object) => {
            let is_secret = object.get("writeOnly").and_then(Value::as_bool) == Some(true)
                || object.get("format").and_then(Value::as_str) == Some("password")
                || object.get("x-liveagent-secret").and_then(Value::as_bool) == Some(true);
            if is_secret {
                return Err(format!(
                    "Settings {settings_id} 在 {path} 声明了 Secret 字段；Plugin API v1 不支持秘密配置，请改用非敏感配置"
                ));
            }
            for (key, value) in object {
                reject_secret_settings_schema(value, settings_id, &format!("{path}/{key}"))?;
            }
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                reject_secret_settings_schema(value, settings_id, &format!("{path}/{index}"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_capability_id(capability: &str) -> Result<(), String> {
    if !DOMAIN_ID_PATTERN.is_match(capability) || !capability.contains('.') {
        return Err(format!("Capability id 格式无效：{capability}"));
    }
    Ok(())
}
