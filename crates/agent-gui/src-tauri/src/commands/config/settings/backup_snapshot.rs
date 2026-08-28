// 配置备份快照：采集 / 校验 / 应用。
//
// 载体刻意选用「按域聚合的 JSON」而非整库 SQL dump —— 后者会把不可信的 SQL
// 交给 SQLite 执行（ATTACH DATABASE 可在任意可写路径落文件），且大库导入时
// 逐行 INSERT 会冻结 UI。本模块搬运 providers / mcp / system / agents /
// model_failover / stt 六个域的 payload；system 域只带可移植偏好，
// workdir、工作区路径、系统代理这类设备本地态不进快照（见
// SYSTEM_PORTABLE_BACKUP_KEYS）。

/// 载体格式版本。manifest 结构本身变更时递增。
pub(crate) const BACKUP_PROTOCOL_VERSION: u32 = 1;
/// 配置域 schema 版本。各域 payload 结构不兼容演进时递增。
///
/// v2：移除 skills 域（只同步启用开关没有意义，技能本体在磁盘上）；
/// 新增 agents / modelFailover / stt 三域；system 域收窄为可移植偏好。
/// v1 备份仍可导入：skills 字段被忽略，system 里的设备本地键被过滤。
pub(crate) const BACKUP_SCHEMA_VERSION: u32 = 2;

/// system 域中随快照流转的可移植偏好。
///
/// 白名单之外的 system 键（workdir、workspaceProjects 及其衍生键、systemProxy）
/// 是设备本地态：绝对路径在另一台机器上多半不存在，代理配置是每台机器 /
/// 每个网络环境各自的。采集时过滤、应用时只覆盖这些键，其余保持本机原值。
const SYSTEM_PORTABLE_BACKUP_KEYS: &[&str] = &[
    SYSTEM_EXECUTION_MODE_KEY,
    SYSTEM_TOOL_POLICIES_KEY,
    SYSTEM_COMMAND_SAFETY_MODE_KEY,
    SYSTEM_BROWSER_AUTOMATION_MODE_KEY,
    SYSTEM_CUA_ALLOW_SELF_TARGETING_KEY,
];

/// 导出文件中内联 manifest 的字段名。
const BACKUP_MANIFEST_FIELD: &str = "_manifest";
/// 导入文件大小上限，防止畸形/超大输入耗尽内存。
const BACKUP_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// 本地备份保留份数。
const BACKUP_RETENTION: usize = 10;
const BACKUP_DIRNAME: &str = "backups";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub protocol_version: u32,
    pub schema_version: u32,
    pub snapshot_id: String,
    /// RFC3339 UTC 时间戳。
    pub created_at: String,
    pub device_name: String,
    pub app_version: String,
    /// 预留：首版恒为 "none"，后续引入端到端加密时改此字段而不破坏格式。
    #[serde(default = "default_backup_encryption")]
    pub encryption: String,
    /// 各域条目数，仅供 UI 展示摘要，不参与校验。
    #[serde(default)]
    pub domains: BackupDomainCounts,
}

fn default_backup_encryption() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDomainCounts {
    #[serde(default)]
    pub providers: usize,
    #[serde(default)]
    pub mcp: usize,
    #[serde(default)]
    pub system: usize,
    #[serde(default)]
    pub agents: usize,
    #[serde(default)]
    pub model_failover: usize,
    #[serde(default)]
    pub stt: usize,
}

/// 一份完整的配置快照。字段全部可选：某域为空表示导出侧没有该配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshot {
    #[serde(default)]
    pub providers: Option<Value>,
    #[serde(default)]
    pub mcp: Option<Value>,
    /// 仅含 SYSTEM_PORTABLE_BACKUP_KEYS 白名单键。
    #[serde(default)]
    pub system: Option<Value>,
    /// 提示词模板数组，形状与 settings_save_agents payload 一致。
    #[serde(default)]
    pub agents: Option<Value>,
    /// 模型故障转移配置对象，按服务商类型分组。
    #[serde(default)]
    pub model_failover: Option<Value>,
    /// STT 配置对象（原文，含密钥 —— 与 providers 域的明文策略一致）。
    #[serde(default)]
    pub stt: Option<Value>,
}

/// 导入预览：解析并校验成功但尚未写库，供确认对话框展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportPreview {
    pub path: String,
    pub manifest: BackupManifest,
}

/// 导入/下载完成后的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupApplyOutcome {
    pub applied: BackupDomainCounts,
    /// 应用前生成的本地备份文件路径。
    pub backup_path: Option<String>,
}

fn backup_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?.join(BACKUP_DIRNAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    Ok(dir)
}

fn backup_device_name() -> String {
    hostname_label().unwrap_or_else(|| "unknown-device".to_string())
}

fn hostname_label() -> Option<String> {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// manifest 的 `createdAt`：RFC3339 UTC，固定 `Z` 后缀。
///
/// 用 chrono（已是直接依赖）而不是自己算日历，与 `services/memory/schema.rs`
/// 的既有做法一致。`to_rfc3339()` 会输出 `+00:00`，这里显式指定格式保持 `Z`。
fn rfc3339_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn count_domain(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        Some(Value::Object(map)) => map.len(),
        _ => 0,
    }
}

fn count_mcp_servers(value: Option<&Value>) -> usize {
    value
        .and_then(|mcp| mcp.get("servers"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn count_stt_providers(value: Option<&Value>) -> usize {
    value
        .and_then(|stt| stt.get("providers"))
        .and_then(Value::as_object)
        .map(Map::len)
        .unwrap_or(0)
}

pub(crate) fn snapshot_domain_counts(snapshot: &BackupSnapshot) -> BackupDomainCounts {
    BackupDomainCounts {
        providers: count_domain(snapshot.providers.as_ref()),
        mcp: count_mcp_servers(snapshot.mcp.as_ref()),
        system: count_domain(snapshot.system.as_ref()),
        agents: count_domain(snapshot.agents.as_ref()),
        model_failover: count_domain(snapshot.model_failover.as_ref()),
        stt: count_stt_providers(snapshot.stt.as_ref()),
    }
}

pub(crate) fn build_backup_manifest(snapshot: &BackupSnapshot) -> BackupManifest {
    BackupManifest {
        protocol_version: BACKUP_PROTOCOL_VERSION,
        schema_version: BACKUP_SCHEMA_VERSION,
        snapshot_id: Uuid::new_v4().to_string(),
        created_at: rfc3339_now(),
        device_name: backup_device_name(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        encryption: default_backup_encryption(),
        domains: snapshot_domain_counts(snapshot),
    }
}

/// 从完整 system 配置中筛出可移植偏好；全部缺失时返回 None。
fn portable_system_subset(system: Option<Value>) -> Option<Value> {
    let map = match system {
        Some(Value::Object(map)) => map,
        _ => return None,
    };
    let portable: Map<String, Value> = map
        .into_iter()
        .filter(|(key, _)| SYSTEM_PORTABLE_BACKUP_KEYS.contains(&key.as_str()))
        .collect();
    if portable.is_empty() {
        None
    } else {
        Some(Value::Object(portable))
    }
}

/// 采集当前配置。六个域全部来自 SQLite，不需要前端参与。
///
/// 注意：同步配置（WebDAV 地址/凭据）刻意存放在独立表 `backup_sync_settings`
/// 而不在这些表里 —— 它是设备级的，若随快照流转会让 A 机器的凭据覆盖
/// B 机器，形成循环。
pub(crate) fn collect_backup_snapshot(conn: &Connection) -> Result<BackupSnapshot, String> {
    Ok(BackupSnapshot {
        providers: load_providers(conn)?,
        mcp: load_mcp(conn)?,
        system: portable_system_subset(load_system(conn)?),
        agents: load_agents(conn)?,
        model_failover: load_model_failover(conn)?,
        stt: load_stt_raw(conn)?,
    })
}

/// 校验 manifest 的版本兼容性。高于当前支持的版本一律拒绝，
/// 避免把读不懂的数据当成「空配置」写入而静默清库。
pub(crate) fn validate_backup_manifest(manifest: &BackupManifest) -> Result<(), String> {
    if manifest.protocol_version > BACKUP_PROTOCOL_VERSION {
        return Err(format!(
            "备份文件格式版本 {} 高于当前支持的 {BACKUP_PROTOCOL_VERSION}，请升级应用后重试",
            manifest.protocol_version
        ));
    }
    if manifest.schema_version > BACKUP_SCHEMA_VERSION {
        return Err(format!(
            "备份文件配置版本 {} 高于当前支持的 {BACKUP_SCHEMA_VERSION}，请升级应用后重试",
            manifest.schema_version
        ));
    }
    if manifest.encryption != "none" {
        return Err(format!(
            "暂不支持的加密方式：{}",
            manifest.encryption
        ));
    }
    Ok(())
}

/// 结构校验：各域必须是预期的 JSON 形状，拒绝畸形输入。
pub(crate) fn validate_backup_snapshot(snapshot: &BackupSnapshot) -> Result<(), String> {
    if let Some(providers) = &snapshot.providers {
        if !providers.is_array() {
            return Err("备份内容 providers 必须是数组".to_string());
        }
    }
    if let Some(mcp) = &snapshot.mcp {
        let mcp = mcp
            .as_object()
            .ok_or_else(|| "备份内容 mcp 必须是对象".to_string())?;
        if let Some(servers) = mcp.get("servers") {
            if !servers.is_array() {
                return Err("备份内容 mcp.servers 必须是数组".to_string());
            }
        }
        if let Some(selected) = mcp.get("selected") {
            if !selected.is_array() {
                return Err("备份内容 mcp.selected 必须是数组".to_string());
            }
        }
    }
    if let Some(system) = &snapshot.system {
        if !system.is_object() {
            return Err("备份内容 system 必须是对象".to_string());
        }
    }
    if let Some(agents) = &snapshot.agents {
        if !agents.is_array() {
            return Err("备份内容 agents 必须是数组".to_string());
        }
    }
    if let Some(model_failover) = &snapshot.model_failover {
        if !model_failover.is_object() {
            return Err("备份内容 modelFailover 必须是对象".to_string());
        }
    }
    if let Some(stt) = &snapshot.stt {
        if !stt.is_object() {
            return Err("备份内容 stt 必须是对象".to_string());
        }
    }
    Ok(())
}

/// 序列化为导出文件内容：快照 + 内联 manifest，单文件自包含。
pub(crate) fn serialize_backup_document(
    snapshot: &BackupSnapshot,
    manifest: &BackupManifest,
) -> Result<String, String> {
    let mut document = match serde_json::to_value(snapshot)
        .map_err(|e| format!("序列化备份内容失败：{e}"))?
    {
        Value::Object(map) => map,
        _ => return Err("序列化备份内容失败：预期对象".to_string()),
    };
    document.insert(
        BACKUP_MANIFEST_FIELD.to_string(),
        serde_json::to_value(manifest).map_err(|e| format!("序列化备份元信息失败：{e}"))?,
    );
    serde_json::to_string_pretty(&Value::Object(document))
        .map_err(|e| format!("序列化备份文件失败：{e}"))
}

/// 解析导出文件内容，返回 (快照, manifest)。已完成版本与结构校验。
///
/// v1 文件中的 skills 字段在反序列化时被 serde 忽略。
pub(crate) fn parse_backup_document(raw: &str) -> Result<(BackupSnapshot, BackupManifest), String> {
    let mut document = expect_object(
        parse_json(raw, "备份文件")?,
        "备份文件",
    )?;
    let manifest_value = document
        .remove(BACKUP_MANIFEST_FIELD)
        .ok_or_else(|| "备份文件缺少元信息，可能不是 LiveAgent 导出的配置".to_string())?;
    let manifest = serde_json::from_value::<BackupManifest>(manifest_value)
        .map_err(|e| format!("解析备份元信息失败：{e}"))?;
    validate_backup_manifest(&manifest)?;

    let snapshot = serde_json::from_value::<BackupSnapshot>(Value::Object(document))
        .map_err(|e| format!("解析备份内容失败：{e}"))?;
    validate_backup_snapshot(&snapshot)?;
    Ok((snapshot, manifest))
}

/// 读取备份文件，带大小上限（不可信输入）。
pub(crate) fn read_backup_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    if metadata.len() > BACKUP_MAX_FILE_BYTES {
        return Err(format!(
            "备份文件过大（{} 字节），上限为 {BACKUP_MAX_FILE_BYTES} 字节",
            metadata.len()
        ));
    }
    fs::read_to_string(path).map_err(|e| format!("读取备份文件失败：{e}"))
}

/// 应用前把当前配置备份到 ~/.liveagent/backups/，保留最近 BACKUP_RETENTION 份。
pub(crate) fn backup_current_config(conn: &Connection) -> Result<Option<String>, String> {
    let snapshot = collect_backup_snapshot(conn)?;
    let manifest = build_backup_manifest(&snapshot);
    let document = serialize_backup_document(&snapshot, &manifest)?;

    let dir = backup_dir()?;
    let filename = format!("config-{}.json", now_ms());
    let path = dir.join(filename);
    fs::write(&path, document).map_err(|e| format!("写入备份文件失败：{e}"))?;
    prune_backups(&dir)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn prune_backups(dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取备份目录失败：{e}"))?;
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("config-") && name.ends_with(".json"))
        })
        .collect();
    if files.len() <= BACKUP_RETENTION {
        return Ok(());
    }
    // 文件名内嵌毫秒时间戳，字典序即时间序。
    files.sort();
    for path in files.iter().take(files.len() - BACKUP_RETENTION) {
        // 清理失败不应阻断主流程。
        let _ = fs::remove_file(path);
    }
    Ok(())
}

/// 把快照中的可移植 system 键叠加到本机现有 system 配置上。
///
/// 不能直接拿快照 system 调 save_system —— 后者按固定白名单 DELETE 整表重建，
/// 缺失的键会被填成默认值，本机的 workdir / 工作区 / 代理会被默认值顶掉。
/// 只叠加白名单键还顺带过滤了 v1 备份里混入的设备本地键。
fn merge_portable_system(conn: &Connection, snapshot_system: &Value) -> Result<Value, String> {
    let mut merged = match load_system(conn)? {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if let Some(snapshot_map) = snapshot_system.as_object() {
        for key in SYSTEM_PORTABLE_BACKUP_KEYS {
            if let Some(value) = snapshot_map.get(*key) {
                merged.insert((*key).to_string(), value.clone());
            }
        }
    }
    Ok(Value::Object(merged))
}

/// 整域覆盖写入（纯写库，不做备份）。system 域为「可移植键叠加」而非整域覆盖。
///
/// 各域复用既有的 `save_*`，它们各自开事务 —— 无法合并成一个跨域事务
/// （`save_*` 都要求 `&mut Connection`，rusqlite 的 Transaction 无法嵌套）。
/// 因此中途失败理论上会留下半套配置。防线是调用方：写库前已完成完整校验
/// （畸形输入一行都不会写），且写库前已生成本地备份可回退。
pub(crate) fn apply_backup_snapshot_to_db(
    conn: &mut Connection,
    snapshot: &BackupSnapshot,
) -> Result<(), String> {
    if let Some(providers) = snapshot.providers.clone() {
        save_providers(conn, providers)?;
    }
    if let Some(mcp) = snapshot.mcp.clone() {
        save_mcp(conn, mcp)?;
    }
    if let Some(system) = &snapshot.system {
        let merged = merge_portable_system(conn, system)?;
        save_system(conn, merged)?;
    }
    if let Some(agents) = snapshot.agents.clone() {
        save_agents(conn, agents)?;
    }
    if let Some(model_failover) = snapshot.model_failover.clone() {
        save_model_failover(conn, model_failover)?;
    }
    if let Some(stt) = snapshot.stt.clone() {
        // 源设备可能处于「已清空密钥」等刻意不完整的状态，这份数据当初已被
        // 源侧 save_stt 接受过，应用侧不应再按「用户正在提交表单」的标准复验。
        let mut stt_payload = expect_object(stt, "备份内容 stt")?;
        stt_payload.insert("allowIncomplete".to_string(), Value::Bool(true));
        save_stt(conn, Value::Object(stt_payload))?;
    }
    Ok(())
}

/// 应用一份快照：校验 → 备份当前配置 → 写库。
///
/// system 域只叠加可移植键，systemProxy 不会被快照改动，因此无需刷新代理状态。
pub(crate) fn apply_backup_snapshot(
    conn: &mut Connection,
    snapshot: BackupSnapshot,
) -> Result<BackupApplyOutcome, String> {
    validate_backup_snapshot(&snapshot)?;
    let applied = snapshot_domain_counts(&snapshot);
    let backup_path = backup_current_config(conn)?;

    apply_backup_snapshot_to_db(conn, &snapshot)?;

    Ok(BackupApplyOutcome {
        applied,
        backup_path,
    })
}
