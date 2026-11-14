//! 读源 profile 的 Cookies SQLite 并转换为 CDP `Network.CookieParam`。

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};

use super::crypto::CookieDecryptor;
use super::discovery::SourceProfile;
use super::keys::KeyProvider;
use super::{CookieFilter, ImportReport, SkipReason, SkippedCookies};

/// Chromium 时间基准（1601-01-01）与 Unix epoch 的秒差。
const CHROMIUM_EPOCH_OFFSET_SECS: i64 = 11_644_473_600;

/// Chromium 时间戳（自 1601 起的微秒）→ Unix 秒（浮点，CDP TimeSinceEpoch）。
pub(crate) fn chromium_time_to_unix(micros: i64) -> f64 {
    micros as f64 / 1_000_000.0 - CHROMIUM_EPOCH_OFFSET_SECS as f64
}

/// Chromium `CookieSameSite`：-1 未指定、0 None、1 Lax、2 Strict。
pub(crate) fn same_site_to_cdp(value: i64) -> Option<&'static str> {
    match value {
        0 => Some("None"),
        1 => Some("Lax"),
        2 => Some("Strict"),
        _ => None,
    }
}

fn priority_to_cdp(value: i64) -> &'static str {
    match value {
        0 => "Low",
        2 => "High",
        _ => "Medium",
    }
}

/// Cookies 表的一行（列在旧版 schema 里可能缺失，取缺省值）。
#[derive(Clone, Debug, Default)]
pub(crate) struct CookieRow {
    pub host_key: String,
    pub top_frame_site_key: String,
    pub name: String,
    pub value: String,
    pub encrypted_value: Vec<u8>,
    pub path: String,
    pub expires_utc: i64,
    pub is_secure: bool,
    pub is_httponly: bool,
    pub has_expires: bool,
    pub is_persistent: bool,
    pub priority: i64,
    pub samesite: i64,
    pub has_cross_site_ancestor: bool,
}

/// 读取并解密源 profile 的 cookies。数据库先整体复制到私有临时目录（含
/// -wal/-journal），源文件只读一次，不加锁也不改动。
pub fn read_cookies(
    profile: &SourceProfile,
    keys: &dyn KeyProvider,
    filter: &CookieFilter,
) -> Result<ImportReport, String> {
    let source = profile.cookies_db_path().ok_or_else(|| {
        format!(
            "{} 的 profile「{}」没有 Cookies 数据库",
            profile.browser.display_name(),
            profile.display_name
        )
    })?;
    let snapshot = copy_db_snapshot(&source)?;
    let conn = open_snapshot(&snapshot.path().join("Cookies"))?;
    let db_version = read_db_version(&conn);
    let rows = query_rows(&conn)?;
    let decryptor = CookieDecryptor::new(profile, keys, db_version);
    let now = unix_now();

    let mut report = ImportReport::default();
    let mut skipped: BTreeMap<SkipReason, usize> = BTreeMap::new();
    for row in rows.into_iter().filter(|row| filter.matches(&row.host_key)) {
        report.total += 1;
        match row_to_cookie_param(&row, &decryptor, now) {
            Ok(cookie) => report.cookies.push(cookie),
            Err(reason) => *skipped.entry(reason).or_default() += 1,
        }
    }
    report.skipped = skipped
        .into_iter()
        .map(|(reason, count)| SkippedCookies { reason, count })
        .collect();
    report.key_error = decryptor.key_error();
    Ok(report)
}

fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 把 `Cookies`（及 -wal/-journal 旁路文件）复制进新建的临时目录（0700）。
/// 运行中的浏览器持有数据库锁；读副本既避开锁冲突，也保证绝不改写源库。
pub(crate) fn copy_db_snapshot(source: &Path) -> Result<tempfile::TempDir, String> {
    let dir = tempfile::Builder::new()
        .prefix("liveagent-cookie-import-")
        .tempdir()
        .map_err(|e| format!("创建临时目录失败：{e}"))?;
    std::fs::copy(source, dir.path().join("Cookies")).map_err(|e| {
        format!("复制 Cookies 数据库失败（若浏览器独占锁定了文件，请先退出浏览器再试）：{e}")
    })?;
    for suffix in ["-wal", "-journal"] {
        let mut side = source.as_os_str().to_owned();
        side.push(suffix);
        let side = Path::new(&side);
        if side.is_file() {
            std::fs::copy(side, dir.path().join(format!("Cookies{suffix}")))
                .map_err(|e| format!("复制 Cookies{suffix} 失败：{e}"))?;
        }
    }
    Ok(dir)
}

/// 打开私有副本。用读写模式而非只读：副本带 -wal/-journal 时 SQLite 需要
/// 回放/回滚并创建 -shm，只读连接在这种情况下会读不到未 checkpoint 的数据。
/// 源库从不被打开。
fn open_snapshot(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开 Cookies 数据库副本失败：{e}"))
}

fn read_db_version(conn: &Connection) -> i64 {
    conn.query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
        let value: rusqlite::types::Value = row.get(0)?;
        Ok(match value {
            rusqlite::types::Value::Integer(v) => v,
            rusqlite::types::Value::Text(text) => text.trim().parse().unwrap_or(0),
            _ => 0,
        })
    })
    .unwrap_or(0)
}

fn query_rows(conn: &Connection) -> Result<Vec<CookieRow>, String> {
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(cookies)")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| format!("读取 cookies 表结构失败：{e}"))?;
    if columns.is_empty() {
        return Err("Cookies 数据库缺少 cookies 表".to_string());
    }
    let has = |name: &str| columns.iter().any(|column| column == name);
    // 列名兼容：很早的 schema 用 secure/httponly，且没有 top_frame_site_key 等列。
    let pick = |preferred: &str, legacy: Option<&str>, default: &str| -> String {
        if has(preferred) {
            preferred.to_string()
        } else if let Some(legacy) = legacy.filter(|legacy| has(legacy)) {
            legacy.to_string()
        } else {
            default.to_string()
        }
    };
    let sql = format!(
        "SELECT host_key, {top_frame}, name, {value}, {encrypted}, path, expires_utc, \
         {secure}, {httponly}, {has_expires}, {persistent}, {priority}, {samesite}, {cross_site} \
         FROM cookies",
        top_frame = pick("top_frame_site_key", None, "''"),
        value = pick("value", None, "''"),
        encrypted = pick("encrypted_value", None, "X''"),
        secure = pick("is_secure", Some("secure"), "0"),
        httponly = pick("is_httponly", Some("httponly"), "0"),
        has_expires = pick("has_expires", None, "1"),
        persistent = pick("is_persistent", Some("persistent"), "1"),
        priority = pick("priority", None, "1"),
        samesite = pick("samesite", None, "-1"),
        cross_site = pick("has_cross_site_ancestor", None, "0"),
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("查询 cookies 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CookieRow {
                host_key: row.get(0)?,
                top_frame_site_key: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                name: row.get(2)?,
                value: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                encrypted_value: row.get::<_, Option<Vec<u8>>>(4)?.unwrap_or_default(),
                path: row.get(5)?,
                expires_utc: row.get(6)?,
                is_secure: row.get::<_, i64>(7)? != 0,
                is_httponly: row.get::<_, i64>(8)? != 0,
                has_expires: row.get::<_, i64>(9)? != 0,
                is_persistent: row.get::<_, i64>(10)? != 0,
                priority: row.get(11)?,
                samesite: row.get(12)?,
                has_cross_site_ancestor: row.get::<_, i64>(13)? != 0,
            })
        })
        .map_err(|e| format!("查询 cookies 失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取 cookie 行失败：{e}"))
}

/// 一行 → CDP `Network.CookieParam`。
/// - 域 cookie（host_key 以 `.` 开头）带 `domain`；host-only cookie 只给 `url`，
///   否则 CDP 会把它升格为域 cookie、扩大作用域；
/// - 会话 cookie 不带 `expires`；已过期的持久 cookie 跳过；
/// - SameSite=None 但非 Secure 的组合会被 Chrome 拒收，降级为不指定；
/// - 分区 cookie（CHIPS）带 `partitionKey`。
pub(crate) fn row_to_cookie_param(
    row: &CookieRow,
    decryptor: &CookieDecryptor<'_>,
    now_unix: f64,
) -> Result<Value, SkipReason> {
    let session = !row.has_expires || !row.is_persistent;
    let expires = (!session).then(|| chromium_time_to_unix(row.expires_utc));
    if expires.is_some_and(|expires| expires <= now_unix) {
        return Err(SkipReason::Expired);
    }
    let value = if row.encrypted_value.is_empty() {
        row.value.clone()
    } else {
        decryptor.decrypt(&row.host_key, &row.encrypted_value)?
    };
    Ok(build_cookie_param(row, value, expires))
}

pub(crate) fn build_cookie_param(row: &CookieRow, value: String, expires: Option<f64>) -> Value {
    let path = if row.path.is_empty() { "/" } else { &row.path };
    let mut cookie = Map::new();
    cookie.insert("name".into(), json!(row.name));
    cookie.insert("value".into(), json!(value));
    if row.host_key.starts_with('.') {
        cookie.insert("domain".into(), json!(row.host_key));
    } else {
        let scheme = if row.is_secure { "https" } else { "http" };
        cookie.insert(
            "url".into(),
            json!(format!("{scheme}://{}{path}", row.host_key)),
        );
    }
    cookie.insert("path".into(), json!(path));
    cookie.insert("secure".into(), json!(row.is_secure));
    cookie.insert("httpOnly".into(), json!(row.is_httponly));
    if let Some(same_site) = same_site_to_cdp(row.samesite) {
        if same_site != "None" || row.is_secure {
            cookie.insert("sameSite".into(), json!(same_site));
        }
    }
    if let Some(expires) = expires {
        cookie.insert("expires".into(), json!(expires));
    }
    cookie.insert("priority".into(), json!(priority_to_cdp(row.priority)));
    if !row.top_frame_site_key.is_empty() {
        cookie.insert(
            "partitionKey".into(),
            json!({
                "topLevelSite": row.top_frame_site_key,
                "hasCrossSiteAncestor": row.has_cross_site_ancestor,
            }),
        );
    }
    Value::Object(cookie)
}
