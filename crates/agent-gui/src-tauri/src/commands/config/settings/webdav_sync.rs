// WebDAV 同步编排：设置存取 + 上传/下载命令。
//
// 分层：本文件只做编排与校验，所有 HTTP 细节在 `services/webdav.rs`。
// 快照的采集/校验/应用复用 `backup_snapshot.rs`，与本地导入导出同一套代码路径。

/// 远端布局的版本目录。协议或 schema 不兼容演进时换目录，
/// 让新旧版本客户端各读各的，而不是互相写坏同一份文件。
const WEBDAV_LAYOUT_DIR: &str = "v1";
/// manifest 体积上限：它只有几百字节，1 MiB 已是极宽松的上界。
const WEBDAV_MANIFEST_MAX_BYTES: usize = 1024 * 1024;
/// config 体积上限，与本地导入的上限保持一致。
const WEBDAV_CONFIG_MAX_BYTES: usize = 16 * 1024 * 1024;
const WEBDAV_MANIFEST_FILENAME: &str = "manifest.json";
const WEBDAV_CONFIG_FILENAME: &str = "config.json";
const WEBDAV_DEFAULT_PROFILE: &str = "default";
const WEBDAV_DEFAULT_REMOTE_DIR: &str = "liveagent";

/// 同步配置。
///
/// 存于独立表 `backup_sync_settings`，**不进配置快照** —— 它是设备级的，
/// 若随快照流转会让 A 机器的凭据覆盖 B 机器，形成循环。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// 远端根目录，相对于 url。
    #[serde(default = "default_backup_remote_dir")]
    pub remote_dir: String,
    /// 同一账号下的多套配置隔离（如 work / personal）。
    #[serde(default = "default_backup_profile")]
    pub profile: String,
    /// 自动同步开关（**仅自动上传，不会自动下载**）。
    #[serde(default)]
    pub auto_sync: bool,
    /// 最近一次同步成功的时间（毫秒）。
    #[serde(default)]
    pub last_sync_at: Option<i64>,
}

fn default_backup_remote_dir() -> String {
    WEBDAV_DEFAULT_REMOTE_DIR.to_string()
}

fn default_backup_profile() -> String {
    WEBDAV_DEFAULT_PROFILE.to_string()
}

impl Default for BackupSyncConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: String::new(),
            password: String::new(),
            remote_dir: default_backup_remote_dir(),
            profile: default_backup_profile(),
            auto_sync: false,
            last_sync_at: None,
        }
    }
}

/// 保存请求。password 与 passwordTouched 分离是为了让 UI 能展示掩码占位符
/// 而不必把真密码回传前端 —— 用户没动密码框时，后端沿用库里的旧值。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfigRequest {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub password_touched: bool,
    #[serde(default = "default_backup_remote_dir")]
    pub remote_dir: String,
    #[serde(default = "default_backup_profile")]
    pub profile: String,
    #[serde(default)]
    pub auto_sync: bool,
}

/// 回传前端的配置视图：**不含密码**，只告知是否已设置。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSyncConfigView {
    pub url: String,
    pub username: String,
    pub has_password: bool,
    pub remote_dir: String,
    pub profile: String,
    pub auto_sync: bool,
    pub last_sync_at: Option<i64>,
}

/// 远端备份的摘要，供上传/下载前的确认对话框展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRemoteInfo {
    pub manifest: BackupManifest,
    pub size: usize,
    pub sha256: String,
}

/// 远端 manifest：在导出 manifest 的基础上多带 config.json 的大小与摘要，
/// 用于下载后校验完整性（PUT 可能被中断，留下截断的 config.json）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRemoteManifest {
    #[serde(flatten)]
    manifest: BackupManifest,
    #[serde(default)]
    size: usize,
    #[serde(default)]
    sha256: String,
}

impl From<BackupSyncConfig> for BackupSyncConfigView {
    fn from(config: BackupSyncConfig) -> Self {
        Self {
            url: config.url,
            username: config.username,
            has_password: !config.password.is_empty(),
            remote_dir: config.remote_dir,
            profile: config.profile,
            auto_sync: config.auto_sync,
            last_sync_at: config.last_sync_at,
        }
    }
}

/// 串行化所有远端读写。
///
/// 上传是「PUT config → PUT manifest」两步，并发执行会让两个文件来自不同快照，
/// 下载侧的 sha256 校验就会失败。
fn backup_sync_mutex() -> &'static tokio::sync::Mutex<()> {
    static MUTEX: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    MUTEX.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn normalize_backup_sync_config(mut config: BackupSyncConfig) -> BackupSyncConfig {
    config.url = config.url.trim().trim_end_matches('/').to_string();
    config.username = config.username.trim().to_string();
    config.remote_dir = config
        .remote_dir
        .trim()
        .trim_matches('/')
        .trim()
        .to_string();
    if config.remote_dir.is_empty() {
        config.remote_dir = default_backup_remote_dir();
    }
    config.profile = config.profile.trim().trim_matches('/').trim().to_string();
    if config.profile.is_empty() {
        config.profile = default_backup_profile();
    }
    config
}

pub(crate) fn load_backup_sync_config(conn: &Connection) -> Result<BackupSyncConfig, String> {
    let payload_json = conn
        .query_row(
            &format!(
                "SELECT payload_json FROM {BACKUP_SYNC_SETTINGS_TABLE} WHERE config_id = 'default'"
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {BACKUP_SYNC_SETTINGS_TABLE} 失败：{e}"))?;

    let Some(raw) = payload_json else {
        return Ok(BackupSyncConfig::default());
    };
    let value = parse_json(&raw, BACKUP_SYNC_SETTINGS_TABLE)?;
    let config = serde_json::from_value::<BackupSyncConfig>(value)
        .map_err(|e| format!("解析同步配置失败：{e}"))?;
    Ok(normalize_backup_sync_config(config))
}

fn persist_backup_sync_config(
    conn: &Connection,
    config: &BackupSyncConfig,
) -> Result<(), String> {
    let payload = serde_json::to_value(config)
        .map_err(|e| format!("序列化 {BACKUP_SYNC_SETTINGS_TABLE} 失败：{e}"))?;
    conn.execute(
        &format!(
            "INSERT INTO {BACKUP_SYNC_SETTINGS_TABLE} (config_id, payload_json, updated_at)
             VALUES ('default', ?1, ?2)
             ON CONFLICT(config_id) DO UPDATE SET
               payload_json = excluded.payload_json,
               updated_at = excluded.updated_at"
        ),
        params![
            serialize_json(&payload, BACKUP_SYNC_SETTINGS_TABLE)?,
            now_ms()
        ],
    )
    .map_err(|e| format!("写入 {BACKUP_SYNC_SETTINGS_TABLE} 失败：{e}"))?;
    Ok(())
}

/// 把保存请求解析成完整配置：密码未被触碰时回填库中旧值。
///
/// 这是 cc-switch 踩过的真实坑 —— UI 给密码框填掩码占位符后原样提交，
/// 会把占位符当成新密码写库，用户下次同步就认证失败。
pub(crate) fn resolve_backup_sync_config(
    request: BackupSyncConfigRequest,
    persisted: &BackupSyncConfig,
) -> BackupSyncConfig {
    let password = if request.password_touched {
        request.password
    } else {
        persisted.password.clone()
    };
    normalize_backup_sync_config(BackupSyncConfig {
        url: request.url,
        username: request.username,
        password,
        remote_dir: request.remote_dir,
        profile: request.profile,
        auto_sync: request.auto_sync,
        // 保存配置不改变同步时间。
        last_sync_at: persisted.last_sync_at,
    })
}

/// 远端目录的分段：`{remote_dir}/v1/{profile}/`。
///
/// 版本段夹在中间而不是最外层，这样用户在 WebDAV 客户端里看到的是一个
/// 干净的 `liveagent/` 顶层目录，内部再按版本和 profile 分。
fn backup_remote_segments(config: &BackupSyncConfig) -> Vec<&str> {
    vec![
        config.remote_dir.as_str(),
        WEBDAV_LAYOUT_DIR,
        config.profile.as_str(),
    ]
}

fn backup_remote_file_segments<'a>(config: &'a BackupSyncConfig, filename: &'a str) -> Vec<&'a str> {
    let mut segments = backup_remote_segments(config);
    segments.push(filename);
    segments
}

fn backup_sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn backup_credentials(config: &BackupSyncConfig) -> Result<crate::services::webdav::WebdavCredentials, String> {
    if config.url.is_empty() {
        return Err("请先填写 WebDAV 服务器地址".to_string());
    }
    if config.username.is_empty() {
        return Err("请先填写 WebDAV 用户名".to_string());
    }
    if config.password.is_empty() {
        return Err("请先填写 WebDAV 密码".to_string());
    }
    Ok(crate::services::webdav::WebdavCredentials {
        base_url: config.url.clone(),
        username: config.username.clone(),
        password: config.password.clone(),
    })
}

/// 校验下载到的 config 与 manifest 声明的大小/摘要一致。
///
/// PUT 可能被中断，留下截断的 config.json；没有这道校验就会把残缺配置
/// 当成合法快照写进本地库。
pub(crate) fn verify_backup_payload(
    body: &[u8],
    expected_size: usize,
    expected_sha256: &str,
) -> Result<(), String> {
    if expected_size > 0 && body.len() != expected_size {
        return Err(format!(
            "远端配置大小校验失败：期望 {expected_size} 字节，实际 {} 字节。远端文件可能未上传完整，请从源设备重新上传",
            body.len()
        ));
    }
    if !expected_sha256.is_empty() {
        let actual = backup_sha256_hex(body);
        if !actual.eq_ignore_ascii_case(expected_sha256) {
            return Err(
                "远端配置校验和不匹配，文件可能已损坏，请从源设备重新上传".to_string()
            );
        }
    }
    Ok(())
}

fn load_backup_sync_config_from_db() -> Result<BackupSyncConfig, String> {
    let conn = open_db()?;
    load_backup_sync_config(&conn)
}

fn touch_backup_last_sync_at() -> Result<i64, String> {
    let timestamp = now_ms() as i64;
    let conn = open_db()?;
    let mut config = load_backup_sync_config(&conn)?;
    config.last_sync_at = Some(timestamp);
    persist_backup_sync_config(&conn, &config)?;
    Ok(timestamp)
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn settings_backup_load_sync_config() -> Result<BackupSyncConfigView, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(load_backup_sync_config_from_db()?.into()))
        .await
        .map_err(|e| format!("settings_backup_load_sync_config join 失败：{e}"))?
}

#[tauri::command]
pub async fn settings_backup_save_sync_config(
    config: BackupSyncConfigRequest,
) -> Result<BackupSyncConfigView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        let persisted = load_backup_sync_config(&conn)?;
        let resolved = resolve_backup_sync_config(config, &persisted);
        persist_backup_sync_config(&conn, &resolved)?;
        Ok(resolved.into())
    })
    .await
    .map_err(|e| format!("settings_backup_save_sync_config join 失败：{e}"))?
}

/// 测试连接。用库里已保存的配置，因此前端须先保存再测试。
#[tauri::command]
pub async fn settings_backup_test_sync_connection() -> Result<(), String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("settings_backup_test_sync_connection join 失败：{e}"))??;
    let creds = backup_credentials(&config)?;
    crate::services::webdav::test_connection(&creds).await
}

/// 拉取远端摘要。远端还没有备份时返回 None。
#[tauri::command]
pub async fn settings_backup_fetch_remote_info() -> Result<Option<BackupRemoteInfo>, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("settings_backup_fetch_remote_info join 失败：{e}"))??;
    let creds = backup_credentials(&config)?;
    let _guard = backup_sync_mutex().lock().await;

    let segments = backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME);
    let Some(body) = crate::services::webdav::get_bytes(
        &creds,
        &segments,
        WEBDAV_MANIFEST_MAX_BYTES,
        "远端备份元信息",
    )
    .await?
    else {
        return Ok(None);
    };

    let remote = parse_backup_remote_manifest(&body)?;
    Ok(Some(BackupRemoteInfo {
        manifest: remote.manifest,
        size: remote.size,
        sha256: remote.sha256,
    }))
}

pub(crate) fn parse_backup_remote_manifest(body: &[u8]) -> Result<BackupRemoteManifest, String> {
    let text = std::str::from_utf8(body)
        .map_err(|_| "远端备份元信息不是合法的 UTF-8 文本".to_string())?;
    let remote = serde_json::from_str::<BackupRemoteManifest>(text)
        .map_err(|e| format!("解析远端备份元信息失败：{e}"))?;
    validate_backup_manifest(&remote.manifest)?;
    Ok(remote)
}

/// 上传：采集 → 建目录 → **先 PUT config 再 PUT manifest**。
///
/// 顺序是有意的。manifest 是「这份备份可用」的信号，最后写入，
/// 中途失败时远端留下的是旧 manifest + 新 config，下载侧的 sha256 校验
/// 会拦下这个不一致，而不会当成合法数据应用。
#[tauri::command]
pub async fn settings_backup_upload(skills: Option<Value>) -> Result<i64, String> {
    let (config, document) = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        let config = load_backup_sync_config(&conn)?;
        let snapshot = collect_backup_snapshot(&conn, skills)?;
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest)?;
        Ok::<_, String>((config, (document, manifest)))
    })
    .await
    .map_err(|e| format!("settings_backup_upload join 失败：{e}"))??;
    let (document, manifest) = document;

    let creds = backup_credentials(&config)?;
    let _guard = backup_sync_mutex().lock().await;

    let body = document.into_bytes();
    let remote_manifest = BackupRemoteManifest {
        manifest,
        size: body.len(),
        sha256: backup_sha256_hex(&body),
    };
    let manifest_body = serde_json::to_vec_pretty(&remote_manifest)
        .map_err(|e| format!("序列化远端备份元信息失败：{e}"))?;

    crate::services::webdav::ensure_remote_dirs(&creds, &backup_remote_segments(&config)).await?;
    crate::services::webdav::put_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
        body,
        "application/json",
    )
    .await?;
    crate::services::webdav::put_bytes(
        &creds,
        &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
        manifest_body,
        "application/json",
    )
    .await?;

    tauri::async_runtime::spawn_blocking(touch_backup_last_sync_at)
        .await
        .map_err(|e| format!("settings_backup_upload join 失败：{e}"))?
}

/// 下载：拉 manifest → 拉 config → 校验 size+sha256 → 应用快照。
#[tauri::command]
pub async fn settings_backup_download() -> Result<BackupApplyOutcome, String> {
    let config = tauri::async_runtime::spawn_blocking(load_backup_sync_config_from_db)
        .await
        .map_err(|e| format!("settings_backup_download join 失败：{e}"))??;
    let creds = backup_credentials(&config)?;

    let (document, remote) = {
        let _guard = backup_sync_mutex().lock().await;

        let Some(manifest_body) = crate::services::webdav::get_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
            WEBDAV_MANIFEST_MAX_BYTES,
            "远端备份元信息",
        )
        .await?
        else {
            return Err("远端还没有备份，请先在任一设备上传一次".to_string());
        };
        let remote = parse_backup_remote_manifest(&manifest_body)?;

        let Some(body) = crate::services::webdav::get_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
            WEBDAV_CONFIG_MAX_BYTES,
            "远端配置",
        )
        .await?
        else {
            return Err(
                "远端元信息存在但配置文件缺失，请从源设备重新上传一次".to_string()
            );
        };
        verify_backup_payload(&body, remote.size, &remote.sha256)?;
        let document = String::from_utf8(body)
            .map_err(|_| "远端配置不是合法的 UTF-8 文本".to_string())?;
        (document, remote)
    };
    // manifest 已在 parse 时校验过版本，这里只是显式保留引用语义。
    let _ = &remote.manifest;

    tauri::async_runtime::spawn_blocking(move || {
        let (snapshot, _) = parse_backup_document(&document)?;
        let mut conn = open_db()?;
        let outcome = apply_backup_snapshot(&mut conn, snapshot)?;
        touch_backup_last_sync_at()?;
        Ok(outcome)
    })
    .await
    .map_err(|e| format!("settings_backup_download join 失败：{e}"))?
}
