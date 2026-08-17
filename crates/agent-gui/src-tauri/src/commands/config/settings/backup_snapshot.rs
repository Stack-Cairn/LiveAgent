// 配置备份快照：采集 / 校验 / 应用。
//
// 载体刻意选用「按域聚合的 JSON」而非整库 SQL dump —— 后者会把不可信的 SQL
// 交给 SQLite 执行（ATTACH DATABASE 可在任意可写路径落文件），且大库导入时
// 逐行 INSERT 会冻结 UI。本模块只搬运 providers / mcp / system 三张表的
// payload，skills 启用态由前端提供（它存在 webview localStorage，后端不可见）。

/// 载体格式版本。manifest 结构本身变更时递增。
pub(crate) const BACKUP_PROTOCOL_VERSION: u32 = 1;
/// 配置域 schema 版本。各域 payload 结构不兼容演进时递增。
pub(crate) const BACKUP_SCHEMA_VERSION: u32 = 1;

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
    pub skills: usize,
}

/// 一份完整的配置快照。字段全部可选：某域为空表示导出侧没有该配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshot {
    #[serde(default)]
    pub providers: Option<Value>,
    #[serde(default)]
    pub mcp: Option<Value>,
    #[serde(default)]
    pub system: Option<Value>,
    /// { enabled: bool, selected: string[] }，由前端从 localStorage 提供。
    #[serde(default)]
    pub skills: Option<Value>,
}

/// 导入预览：解析并校验成功但尚未写库，供确认对话框展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportPreview {
    pub path: String,
    pub manifest: BackupManifest,
}

/// 导入/下载完成后的结果。skills 需回传前端写入 localStorage。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupApplyOutcome {
    pub applied: BackupDomainCounts,
    pub skills: Option<Value>,
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

fn count_skills(value: Option<&Value>) -> usize {
    value
        .and_then(|skills| skills.get("selected"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

pub(crate) fn snapshot_domain_counts(snapshot: &BackupSnapshot) -> BackupDomainCounts {
    BackupDomainCounts {
        providers: count_domain(snapshot.providers.as_ref()),
        mcp: count_mcp_servers(snapshot.mcp.as_ref()),
        system: count_domain(snapshot.system.as_ref()),
        skills: count_skills(snapshot.skills.as_ref()),
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

/// 采集当前配置。skills 由调用方（前端）传入，后端不自行读取。
///
/// 注意：同步配置（WebDAV 地址/凭据）刻意存放在独立表 `backup_sync_settings`
/// 而不在这三张表里 —— 它是设备级的，若随快照流转会让 A 机器的凭据覆盖
/// B 机器，形成循环。
pub(crate) fn collect_backup_snapshot(
    conn: &Connection,
    skills: Option<Value>,
) -> Result<BackupSnapshot, String> {
    Ok(BackupSnapshot {
        providers: load_providers(conn)?,
        mcp: load_mcp(conn)?,
        system: load_system(conn)?,
        skills,
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
    if let Some(skills) = &snapshot.skills {
        if !skills.is_object() {
            return Err("备份内容 skills 必须是对象".to_string());
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
    // skills 存在前端，自动备份取不到；此处只备份后端可见的三域。
    let snapshot = collect_backup_snapshot(conn, None)?;
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

/// 整域覆盖写入（纯写库，不做备份、不刷代理）。
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
    if let Some(system) = snapshot.system.clone() {
        save_system(conn, system)?;
    }
    Ok(())
}

/// 应用一份快照：校验 → 备份当前配置 → 写库 → 刷新代理状态。
///
/// 返回的 skills 交由前端写回 localStorage —— 后端无法直接操作 webview 存储。
pub(crate) fn apply_backup_snapshot(
    conn: &mut Connection,
    snapshot: BackupSnapshot,
) -> Result<BackupApplyOutcome, String> {
    validate_backup_snapshot(&snapshot)?;
    let applied = snapshot_domain_counts(&snapshot);
    let backup_path = backup_current_config(conn)?;

    apply_backup_snapshot_to_db(conn, &snapshot)?;
    if snapshot.system.is_some() {
        // 代理配置可能变化，立即刷新全局状态，避免需要重启才生效。
        refresh_system_proxy_state(conn)?;
    }

    Ok(BackupApplyOutcome {
        applied,
        skills: snapshot.skills,
        backup_path,
    })
}
