//! MCP OAuth token 存储（docs/design/mcp-oauth.md §3）。
//!
//! 凭据纪律：token/client_secret 只进 OS keystore（keyring v3），keyring 不可用
//! 时降级 `~/.liveagent/mcp-oauth-tokens.json`（0600 明文，诊断标注 `file`）——
//! 永不进 settings/SQLite，Gateway 同步与 WebDAV 备份天然不含凭据。
//! Keychain IPC 有毫秒级开销，故挂进程内缓存：只在 miss/授权/刷新/清除时碰后端。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const KEYRING_SERVICE: &str = "LiveAgent MCP OAuth";
const FILE_STORE_NAME: &str = "mcp-oauth-tokens.json";

/// 距过期不足该窗口即视作「将过期」，请求前主动刷新。
pub const EXPIRY_SKEW_MS: u64 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenRecord {
    pub version: u32,
    /// 规范化后的 MCP server URL；与当前配置不符即视为无 token（防 audience 串用）。
    pub server_url: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_endpoint: Option<String>,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// RFC 7591 注册返回值："none" | "client_secret_post" | "client_secret_basic"。
    #[serde(default)]
    pub token_endpoint_auth_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// RFC 8707 resource 参数值（规范化 server URL）。
    pub resource: String,
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// 0 = 服务端未声明过期时间（不主动刷新，仅被动 401 刷新）。
    #[serde(default)]
    pub expires_at_ms: u64,
}

impl TokenRecord {
    pub fn is_expiring(&self, now_ms: u64) -> bool {
        self.expires_at_ms != 0 && now_ms.saturating_add(EXPIRY_SKEW_MS) >= self.expires_at_ms
    }

    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.expires_at_ms != 0 && now_ms >= self.expires_at_ms
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- 进程内缓存 ----

#[derive(Clone)]
enum CacheSlot {
    Present(Box<TokenRecord>),
    Absent,
}

fn cache() -> &'static Mutex<HashMap<String, CacheSlot>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheSlot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// 诊断用：最近一次实际命中的后端。0=未知 1=keychain 2=file。
static LAST_BACKEND: AtomicU8 = AtomicU8::new(0);

pub fn storage_label() -> &'static str {
    match LAST_BACKEND.load(Ordering::Relaxed) {
        1 => "keychain",
        2 => "file",
        _ => "unknown",
    }
}

// ---- keyring 后端 ----

fn keyring_entry(server_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, server_id)
        .map_err(|e| format!("创建 keyring 条目失败：{e}"))
}

/// Ok(Some)=命中 Ok(None)=确认无条目 Err=后端不可用（触发文件降级）。
fn keyring_load(server_id: &str) -> Result<Option<TokenRecord>, String> {
    let entry = keyring_entry(server_id)?;
    match entry.get_password() {
        Ok(raw) => {
            let record: TokenRecord = serde_json::from_str(&raw)
                .map_err(|e| format!("解析 keychain 内 MCP OAuth 记录失败：{e}"))?;
            Ok(Some(record))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取 keychain 失败：{e}")),
    }
}

// ---- 文件降级后端 ----

fn file_store_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    Ok(dir.join(FILE_STORE_NAME))
}

fn load_file_map_at(path: &PathBuf) -> HashMap<String, TokenRecord> {
    let Ok(raw) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_file_map_at(path: &PathBuf, map: &HashMap<String, TokenRecord>) -> Result<(), String> {
    if map.is_empty() {
        // 空表直接移除文件，避免留下空壳。
        let _ = fs::remove_file(path);
        return Ok(());
    }
    let payload = serde_json::to_string(map).map_err(|e| format!("序列化 token 文件失败：{e}"))?;
    fs::write(path, payload).map_err(|e| format!("写入 token 文件失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置 token 文件权限失败：{e}"))?;
    }
    Ok(())
}

// ---- 公共 API ----

pub fn load(server_id: &str) -> Option<TokenRecord> {
    let id = server_id.trim();
    if id.is_empty() {
        return None;
    }
    if let Ok(cached) = cache().lock() {
        match cached.get(id) {
            Some(CacheSlot::Present(record)) => return Some((**record).clone()),
            Some(CacheSlot::Absent) => return None,
            None => {}
        }
    }

    let loaded = match keyring_load(id) {
        Ok(Some(record)) => {
            LAST_BACKEND.store(1, Ordering::Relaxed);
            Some(record)
        }
        Ok(None) => None,
        Err(_) => {
            // keyring 后端不可用（Linux 无 secret-service / headless）：读文件降级。
            let record = file_store_path()
                .ok()
                .and_then(|path| load_file_map_at(&path).remove(id));
            if record.is_some() {
                LAST_BACKEND.store(2, Ordering::Relaxed);
            }
            record
        }
    };

    if let Ok(mut cached) = cache().lock() {
        cached.insert(
            id.to_string(),
            match &loaded {
                Some(record) => CacheSlot::Present(Box::new(record.clone())),
                None => CacheSlot::Absent,
            },
        );
    }
    loaded
}

pub fn save(server_id: &str, record: &TokenRecord) -> Result<(), String> {
    let id = server_id.trim();
    if id.is_empty() {
        return Err("server_id 不能为空".to_string());
    }

    let keyring_result = keyring_entry(id).and_then(|entry| {
        let payload =
            serde_json::to_string(record).map_err(|e| format!("序列化 OAuth 记录失败：{e}"))?;
        entry
            .set_password(&payload)
            .map_err(|e| format!("写入 keychain 失败：{e}"))
    });

    match keyring_result {
        Ok(()) => {
            LAST_BACKEND.store(1, Ordering::Relaxed);
            // keyring 写入成功后清理文件降级副本，防止后续读取到陈旧记录。
            if let Ok(path) = file_store_path() {
                let mut map = load_file_map_at(&path);
                if map.remove(id).is_some() {
                    let _ = save_file_map_at(&path, &map);
                }
            }
        }
        Err(keyring_error) => {
            let path = file_store_path()
                .map_err(|e| format!("{keyring_error}；文件降级也失败：{e}"))?;
            let mut map = load_file_map_at(&path);
            map.insert(id.to_string(), record.clone());
            save_file_map_at(&path, &map)
                .map_err(|e| format!("{keyring_error}；文件降级也失败：{e}"))?;
            LAST_BACKEND.store(2, Ordering::Relaxed);
        }
    }

    if let Ok(mut cached) = cache().lock() {
        cached.insert(id.to_string(), CacheSlot::Present(Box::new(record.clone())));
    }
    Ok(())
}

/// 删除条目（keyring 与文件降级都清）；条目不存在不算错误。
pub fn delete(server_id: &str) -> Result<(), String> {
    let id = server_id.trim();
    if id.is_empty() {
        return Err("server_id 不能为空".to_string());
    }

    let mut errors: Vec<String> = Vec::new();
    match keyring_entry(id) {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => errors.push(format!("删除 keychain 条目失败：{e}")),
        },
        Err(e) => errors.push(e),
    }
    if let Ok(path) = file_store_path() {
        let mut map = load_file_map_at(&path);
        if map.remove(id).is_some() {
            if let Err(e) = save_file_map_at(&path, &map) {
                errors.push(e);
            }
        }
    }

    if let Ok(mut cached) = cache().lock() {
        cached.insert(id.to_string(), CacheSlot::Absent);
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record() -> TokenRecord {
        TokenRecord {
            version: 1,
            server_url: "https://mcp.example.com/mcp".to_string(),
            issuer: "https://auth.example.com".to_string(),
            authorization_endpoint: "https://auth.example.com/authorize".to_string(),
            token_endpoint: "https://auth.example.com/token".to_string(),
            registration_endpoint: Some("https://auth.example.com/register".to_string()),
            client_id: "client-1".to_string(),
            client_secret: None,
            token_endpoint_auth_method: "none".to_string(),
            scope: Some("mcp.read mcp.write".to_string()),
            resource: "https://mcp.example.com/mcp".to_string(),
            access_token: "at-1".to_string(),
            refresh_token: Some("rt-1".to_string()),
            expires_at_ms: 1_000_000,
        }
    }

    #[test]
    fn file_map_roundtrip_preserves_record() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(FILE_STORE_NAME);
        let mut map = HashMap::new();
        map.insert("srv".to_string(), sample_record());
        save_file_map_at(&path, &map).expect("save");
        let loaded = load_file_map_at(&path);
        assert_eq!(loaded.get("srv"), Some(&sample_record()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "token 文件必须是 0600");
        }
    }

    #[test]
    fn empty_file_map_removes_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(FILE_STORE_NAME);
        let mut map = HashMap::new();
        map.insert("srv".to_string(), sample_record());
        save_file_map_at(&path, &map).expect("save");
        assert!(path.exists());
        save_file_map_at(&path, &HashMap::new()).expect("save empty");
        assert!(!path.exists());
    }

    #[test]
    fn expiry_windows_honor_skew_and_unknown_expiry() {
        let mut record = sample_record();
        record.expires_at_ms = 0;
        assert!(!record.is_expiring(u64::MAX - EXPIRY_SKEW_MS));
        assert!(!record.is_expired(u64::MAX));

        record.expires_at_ms = 100_000;
        assert!(!record.is_expiring(100_000 - EXPIRY_SKEW_MS - 1));
        assert!(record.is_expiring(100_000 - EXPIRY_SKEW_MS));
        assert!(!record.is_expired(99_999));
        assert!(record.is_expired(100_000));
    }

    #[test]
    fn record_serde_skips_absent_optionals() {
        let mut record = sample_record();
        record.client_secret = None;
        record.refresh_token = None;
        record.registration_endpoint = None;
        record.scope = None;
        let json = serde_json::to_string(&record).expect("serialize");
        assert!(!json.contains("client_secret"));
        assert!(!json.contains("refresh_token"));
        let back: TokenRecord = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, record);
    }
}
