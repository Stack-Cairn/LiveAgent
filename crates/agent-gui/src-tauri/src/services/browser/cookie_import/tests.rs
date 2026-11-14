//! 全部基于临时目录里自建的 fixture profile（Chromium schema 的 Cookies 库、
//! 用已知测试密码自行加密的值）；密钥经假 KeyProvider 注入，不触碰任何真实
//! 浏览器 profile、钥匙串或 DPAPI。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aes::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
use aes_gcm::aead::{Aead, KeyInit};
use async_trait::async_trait;
use base64::Engine;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::apply::{IN_APP_BROWSER_NOT_RUNNING, SET_COOKIES_BATCH};
use super::crypto::{pbkdf2_sha1_16, CBC_IV, LINUX_V10_PASSWORD, SALT};
use super::discovery::{browser_roots, list_source_profiles_in};
use super::reader::{chromium_time_to_unix, copy_db_snapshot, same_site_to_cdp};
use super::*;

const TEST_MAC_PASSWORD: &[u8] = b"test-safe-storage-password";
const TEST_LINUX_V11_PASSWORD: &[u8] = b"test-secret-service-password";
const TEST_WINDOWS_KEY: [u8; 32] = [7u8; 32];

/// 2100-01-01 的 Chromium 时间戳（足够远的未来）。
fn far_future_chromium() -> i64 {
    (4_102_444_800 + 11_644_473_600) * 1_000_000
}

/// 2000-01-01 的 Chromium 时间戳（已过期）。
fn past_chromium() -> i64 {
    (946_684_800 + 11_644_473_600) * 1_000_000
}

// ---------- 假密钥 / 假 CDP ----------

#[derive(Default)]
struct FakeKeys {
    password: Option<Vec<u8>>,
    password_error: Option<String>,
    password_calls: Mutex<usize>,
}

impl FakeKeys {
    fn with_password(password: &[u8]) -> Self {
        Self {
            password: Some(password.to_vec()),
            ..Self::default()
        }
    }
}

impl KeyProvider for FakeKeys {
    fn safe_storage_password(&self, _browser: BrowserKind) -> Result<Option<Vec<u8>>, String> {
        *self.password_calls.lock().unwrap() += 1;
        match &self.password_error {
            Some(error) => Err(error.clone()),
            None => Ok(self.password.clone()),
        }
    }

    /// 假 DPAPI：按位取反（fixture 里的 "wrapped key" 就是真实 key 取反）。
    fn dpapi_unprotect(&self, blob: &[u8]) -> Result<Vec<u8>, String> {
        Ok(blob.iter().map(|byte| !byte).collect())
    }
}

#[derive(Default)]
struct FakeCdp {
    calls: Mutex<Vec<(String, Value)>>,
    /// 包含该名字 cookie 的任何 setCookies 调用都报错（模拟 Chrome 整批拒收）。
    reject_name: Option<String>,
}

#[async_trait]
impl CdpCaller for FakeCdp {
    async fn call_browser(&self, method: &str, params: Value) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_string(), params.clone()));
        if let Some(reject) = &self.reject_name {
            let hit = params["cookies"]
                .as_array()
                .unwrap()
                .iter()
                .any(|cookie| cookie["name"] == json!(reject));
            if hit {
                return Err("CDP 错误：Invalid cookie fields".to_string());
            }
        }
        Ok(json!({}))
    }
}

struct FakeTarget(Option<Arc<FakeCdp>>);

#[async_trait]
impl ImportTarget for FakeTarget {
    async fn cdp_caller(&self) -> Result<Arc<dyn CdpCaller>, String> {
        match &self.0 {
            Some(cdp) => Ok(cdp.clone() as Arc<dyn CdpCaller>),
            None => Err(IN_APP_BROWSER_NOT_RUNNING.to_string()),
        }
    }
}

// ---------- fixture 构造 ----------

fn mac_encrypt(plaintext: &[u8]) -> Vec<u8> {
    cbc_encrypt(
        &pbkdf2_sha1_16(TEST_MAC_PASSWORD, SALT, 1003),
        b"v10",
        plaintext,
    )
}

fn cbc_encrypt(key: &[u8; 16], prefix: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let mut buf = vec![0u8; plaintext.len() + 16];
    buf[..plaintext.len()].copy_from_slice(plaintext);
    let ct = cbc::Encryptor::<aes::Aes128>::new_from_slices(key, &CBC_IV)
        .unwrap()
        .encrypt_padded::<Pkcs7>(&mut buf, plaintext.len())
        .unwrap()
        .to_vec();
    [prefix, &ct].concat()
}

fn gcm_encrypt(prefix: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let nonce_bytes = [3u8; 12];
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&TEST_WINDOWS_KEY).unwrap();
    let nonce = aes_gcm::Nonce::try_from(&nonce_bytes[..]).unwrap();
    let ct = cipher.encrypt(&nonce, plaintext).unwrap();
    [prefix, &nonce_bytes, &ct].concat()
}

fn with_host_hash(host_key: &str, value: &str) -> Vec<u8> {
    [
        Sha256::digest(host_key.as_bytes()).as_slice(),
        value.as_bytes(),
    ]
    .concat()
}

#[derive(Clone)]
struct FixtureCookie {
    host_key: &'static str,
    name: &'static str,
    value: &'static str,
    encrypted: Vec<u8>,
    path: &'static str,
    expires_utc: i64,
    secure: bool,
    httponly: bool,
    persistent: bool,
    samesite: i64,
    top_frame_site_key: &'static str,
}

impl FixtureCookie {
    fn encrypted(host_key: &'static str, name: &'static str, encrypted: Vec<u8>) -> Self {
        Self {
            host_key,
            name,
            value: "",
            encrypted,
            path: "/",
            expires_utc: far_future_chromium(),
            secure: true,
            httponly: true,
            persistent: true,
            samesite: 1,
            top_frame_site_key: "",
        }
    }

    fn plain(host_key: &'static str, name: &'static str, value: &'static str) -> Self {
        Self {
            value,
            ..Self::encrypted(host_key, name, Vec::new())
        }
    }
}

/// Chromium 当前版本的 cookies/meta schema。
fn create_cookies_db(path: &Path, version: i64, cookies: &[FixtureCookie]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
         CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL,
           top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
           encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,
           is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
           last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL,
           is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL,
           source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL,
           last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
           has_cross_site_ancestor INTEGER NOT NULL);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('version', ?1)",
        params![version.to_string()],
    )
    .unwrap();
    for (index, cookie) in cookies.iter().enumerate() {
        insert_cookie(&conn, index as i64, cookie);
    }
}

fn insert_cookie(conn: &Connection, creation: i64, cookie: &FixtureCookie) {
    conn.execute(
        "INSERT INTO cookies VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?11, 1, ?12, 2, 443, 0, 0, ?13)",
        params![
            creation,
            cookie.host_key,
            cookie.top_frame_site_key,
            cookie.name,
            cookie.value,
            cookie.encrypted,
            cookie.path,
            if cookie.persistent { cookie.expires_utc } else { 0 },
            cookie.secure as i64,
            cookie.httponly as i64,
            cookie.persistent as i64,
            cookie.samesite,
            (!cookie.top_frame_site_key.is_empty()) as i64,
        ],
    )
    .unwrap();
}

fn profile_at(user_data_dir: &Path, crypto: CookieCrypto) -> SourceProfile {
    SourceProfile {
        browser: BrowserKind::Chrome,
        browser_name: "Google Chrome".to_string(),
        profile_dir: "Default".to_string(),
        display_name: "Person 1".to_string(),
        user_data_dir: user_data_dir.to_path_buf(),
        crypto,
    }
}

fn find<'a>(report: &'a ImportReport, name: &str) -> &'a Value {
    report
        .cookies
        .iter()
        .find(|cookie| cookie["name"] == json!(name))
        .unwrap_or_else(|| panic!("cookie {name} missing"))
}

fn skipped(report: &ImportReport, reason: SkipReason) -> usize {
    report
        .skipped
        .iter()
        .find(|group| group.reason == reason)
        .map_or(0, |group| group.count)
}

// ---------- 测试 ----------

#[test]
fn pbkdf2_matches_rfc6070_vectors() {
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(
        hex(&pbkdf2_sha1_16(b"password", b"salt", 1)),
        "0c60c80f961f0e71f3a9b524af601206"
    );
    assert_eq!(
        hex(&pbkdf2_sha1_16(b"password", b"salt", 2)),
        "ea6c014dc72d6f8ccd1ed92ace1d41f0"
    );
    assert_eq!(
        hex(&pbkdf2_sha1_16(b"password", b"salt", 4096)),
        "4b007901b765489abead49d926f721d0"
    );
}

#[test]
fn macos_v10_decrypts_legacy_db_without_hash_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    create_cookies_db(
        &tmp.path().join("Default/Network/Cookies"),
        23,
        &[
            FixtureCookie::encrypted(".example.com", "sid", mac_encrypt(b"secret-session")),
            FixtureCookie::plain("plain.example.com", "plain", "visible"),
        ],
    );
    let keys = FakeKeys::with_password(TEST_MAC_PASSWORD);
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::MacOs),
        &keys,
        &CookieFilter::default(),
    )
    .unwrap();
    assert_eq!(report.total, 2);
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(find(&report, "sid")["value"], json!("secret-session"));
    assert_eq!(find(&report, "plain")["value"], json!("visible"));
    assert_eq!(
        *keys.password_calls.lock().unwrap(),
        1,
        "key fetched once and cached"
    );
}

#[test]
fn macos_v10_strips_sha256_host_prefix_for_db_version_24() {
    let tmp = tempfile::tempdir().unwrap();
    let host = ".github.com";
    create_cookies_db(
        &tmp.path().join("Default/Cookies"),
        24,
        &[FixtureCookie::encrypted(
            host,
            "user_session",
            mac_encrypt(&with_host_hash(host, "abc123")),
        )],
    );
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::MacOs),
        &FakeKeys::with_password(TEST_MAC_PASSWORD),
        &CookieFilter::default(),
    )
    .unwrap();
    assert_eq!(find(&report, "user_session")["value"], json!("abc123"));
}

#[test]
fn macos_missing_or_denied_key_skips_with_key_unavailable() {
    let tmp = tempfile::tempdir().unwrap();
    create_cookies_db(
        &tmp.path().join("Default/Cookies"),
        24,
        &[
            FixtureCookie::encrypted(".a.com", "x", mac_encrypt(b"1")),
            FixtureCookie::encrypted(".a.com", "y", mac_encrypt(b"2")),
        ],
    );
    let denied = FakeKeys {
        password_error: Some("user denied".to_string()),
        ..FakeKeys::default()
    };
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::MacOs),
        &denied,
        &CookieFilter::default(),
    )
    .unwrap();
    assert_eq!(skipped(&report, SkipReason::KeyUnavailable), 2);
    assert_eq!(report.key_error.as_deref(), Some("user denied"));
    assert_eq!(
        *denied.password_calls.lock().unwrap(),
        1,
        "no re-prompt per cookie"
    );

    // 错误密码：padding/UTF-8 校验失败 → decryptFailed。
    let wrong = FakeKeys::with_password(b"wrong");
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::MacOs),
        &wrong,
        &CookieFilter::default(),
    )
    .unwrap();
    assert_eq!(report.cookies.len(), 0);
    assert_eq!(skipped(&report, SkipReason::DecryptFailed), 2);
}

#[test]
fn linux_v10_peanuts_and_v11_secret_service_and_empty_fallback() {
    let tmp = tempfile::tempdir().unwrap();
    let v10_key = pbkdf2_sha1_16(LINUX_V10_PASSWORD, SALT, 1);
    let v11_key = pbkdf2_sha1_16(TEST_LINUX_V11_PASSWORD, SALT, 1);
    let empty_key = pbkdf2_sha1_16(b"", SALT, 1);
    create_cookies_db(
        &tmp.path().join("Default/Cookies"),
        24,
        &[
            FixtureCookie::encrypted(
                ".a.com",
                "v10",
                cbc_encrypt(&v10_key, b"v10", &with_host_hash(".a.com", "peanut-value")),
            ),
            FixtureCookie::encrypted(
                ".b.com",
                "v11",
                cbc_encrypt(&v11_key, b"v11", &with_host_hash(".b.com", "keyring-value")),
            ),
            FixtureCookie::encrypted(
                ".c.com",
                "v11empty",
                cbc_encrypt(
                    &empty_key,
                    b"v11",
                    &with_host_hash(".c.com", "empty-pw-value"),
                ),
            ),
        ],
    );
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::Linux),
        &FakeKeys::with_password(TEST_LINUX_V11_PASSWORD),
        &CookieFilter::default(),
    )
    .unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(find(&report, "v10")["value"], json!("peanut-value"));
    assert_eq!(find(&report, "v11")["value"], json!("keyring-value"));
    assert_eq!(find(&report, "v11empty")["value"], json!("empty-pw-value"));

    // 无 secret service：v10 与空密码 v11 仍可解，keyring v11 解不开。
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::Linux),
        &FakeKeys::default(),
        &CookieFilter::default(),
    )
    .unwrap();
    assert_eq!(report.cookies.len(), 2);
    assert_eq!(skipped(&report, SkipReason::DecryptFailed), 1);
    assert_eq!(report.key_error, None);
}

fn write_windows_local_state(user_data_dir: &Path) {
    // fake DPAPI = 按位取反，所以 wrapped key = !TEST_WINDOWS_KEY。
    let wrapped: Vec<u8> = TEST_WINDOWS_KEY.iter().map(|byte| !byte).collect();
    let encoded =
        base64::engine::general_purpose::STANDARD.encode([b"DPAPI", &wrapped[..]].concat());
    std::fs::write(
        user_data_dir.join("Local State"),
        json!({ "os_crypt": { "encrypted_key": encoded } }).to_string(),
    )
    .unwrap();
}

#[test]
fn windows_aes_gcm_decrypts_and_v20_is_reported_as_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path()).unwrap();
    write_windows_local_state(tmp.path());
    create_cookies_db(
        &tmp.path().join("Default/Network/Cookies"),
        24,
        &[
            FixtureCookie::encrypted(
                ".x.com",
                "gcm10",
                gcm_encrypt(b"v10", &with_host_hash(".x.com", "gcm-value")),
            ),
            FixtureCookie::encrypted("x.com", "gcm11", gcm_encrypt(b"v11", b"no-prefix-but-v24")),
            FixtureCookie::encrypted(".x.com", "bound1", [b"v20".as_slice(), &[9u8; 60]].concat()),
            FixtureCookie::encrypted(".x.com", "bound2", [b"v20".as_slice(), &[8u8; 60]].concat()),
        ],
    );
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::Windows),
        &FakeKeys::default(),
        &CookieFilter::default(),
    )
    .unwrap();
    assert_eq!(report.total, 4);
    assert_eq!(find(&report, "gcm10")["value"], json!("gcm-value"));
    // v24 库里明文不足 32 字节时不剥前缀（防越界）；这里 17 字节原样返回。
    assert_eq!(find(&report, "gcm11")["value"], json!("no-prefix-but-v24"));
    assert_eq!(skipped(&report, SkipReason::AppBoundEncryption), 2);
}

#[test]
fn windows_missing_local_state_key_reports_key_unavailable() {
    let tmp = tempfile::tempdir().unwrap();
    create_cookies_db(
        &tmp.path().join("Default/Cookies"),
        24,
        &[FixtureCookie::encrypted(
            ".x.com",
            "a",
            gcm_encrypt(b"v10", b"zzz"),
        )],
    );
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::Windows),
        &FakeKeys::default(),
        &CookieFilter::default(),
    )
    .unwrap();
    assert_eq!(skipped(&report, SkipReason::KeyUnavailable), 1);
    assert!(report.key_error.unwrap().contains("Local State"));
}

#[test]
fn same_site_expiry_and_cdp_shape_mapping() {
    assert_eq!(same_site_to_cdp(-1), None);
    assert_eq!(same_site_to_cdp(0), Some("None"));
    assert_eq!(same_site_to_cdp(1), Some("Lax"));
    assert_eq!(same_site_to_cdp(2), Some("Strict"));
    // 13_000_000_000 s since 1601 → 1_355_526_400 unix。
    assert_eq!(
        chromium_time_to_unix(13_000_000_000_000_000),
        1_355_526_400.0
    );

    let tmp = tempfile::tempdir().unwrap();
    let mut session = FixtureCookie::plain("app.example.com", "session", "s");
    session.persistent = false;
    session.samesite = -1;
    session.secure = false;
    session.httponly = false;
    session.path = "/app";
    let mut strict = FixtureCookie::plain(".example.com", "strict", "t");
    strict.samesite = 2;
    let mut none_secure = FixtureCookie::plain(".example.com", "none_secure", "n");
    none_secure.samesite = 0;
    let mut none_insecure = FixtureCookie::plain(".example.com", "none_insecure", "n");
    none_insecure.samesite = 0;
    none_insecure.secure = false;
    let mut partitioned = FixtureCookie::plain(".embed.com", "chips", "p");
    partitioned.top_frame_site_key = "https://top.com";
    create_cookies_db(
        &tmp.path().join("Default/Cookies"),
        24,
        &[session, strict, none_secure, none_insecure, partitioned],
    );
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::MacOs),
        &FakeKeys::default(),
        &CookieFilter::default(),
    )
    .unwrap();

    let session = find(&report, "session");
    assert_eq!(session.get("expires"), None, "session cookie omits expires");
    assert_eq!(session.get("sameSite"), None);
    assert_eq!(session.get("domain"), None, "host-only cookie uses url");
    assert_eq!(session["url"], json!("http://app.example.com/app"));
    assert_eq!(session["path"], json!("/app"));
    assert_eq!(session["secure"], json!(false));
    assert_eq!(session["httpOnly"], json!(false));

    let strict = find(&report, "strict");
    assert_eq!(strict["domain"], json!(".example.com"));
    assert_eq!(strict.get("url"), None);
    assert_eq!(strict["sameSite"], json!("Strict"));
    assert_eq!(strict["expires"], json!(4_102_444_800.0));
    assert_eq!(strict["secure"], json!(true));
    assert_eq!(strict["httpOnly"], json!(true));
    assert_eq!(strict["priority"], json!("Medium"));

    assert_eq!(find(&report, "none_secure")["sameSite"], json!("None"));
    assert_eq!(find(&report, "none_insecure").get("sameSite"), None);

    let chips = find(&report, "chips");
    assert_eq!(
        chips["partitionKey"],
        json!({ "topLevelSite": "https://top.com", "hasCrossSiteAncestor": true })
    );
    assert_eq!(find(&report, "strict").get("partitionKey"), None);
}

#[test]
fn expired_cookies_are_skipped_but_session_cookies_kept() {
    let tmp = tempfile::tempdir().unwrap();
    let mut expired = FixtureCookie::encrypted(".old.com", "expired", b"v10garbage".to_vec());
    expired.expires_utc = past_chromium();
    let mut session = FixtureCookie::plain(".old.com", "session", "s");
    session.persistent = false;
    create_cookies_db(&tmp.path().join("Default/Cookies"), 24, &[expired, session]);
    let keys = FakeKeys::with_password(TEST_MAC_PASSWORD);
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::MacOs),
        &keys,
        &CookieFilter::default(),
    )
    .unwrap();
    assert_eq!(report.total, 2);
    assert_eq!(report.cookies.len(), 1);
    assert_eq!(skipped(&report, SkipReason::Expired), 1);
    // 过期判断先于解密：无需为过期 cookie 取密钥（不触发授权弹窗）。
    assert_eq!(*keys.password_calls.lock().unwrap(), 0);
}

#[test]
fn domain_filter_matches_domain_and_subdomains_only() {
    let filter = CookieFilter::new(vec![" .Example.com ".to_string(), String::new()]);
    assert_eq!(filter.domains, vec!["example.com".to_string()]);
    assert!(filter.matches(".example.com"));
    assert!(filter.matches("example.com"));
    assert!(filter.matches("www.example.com"));
    assert!(filter.matches(".a.b.EXAMPLE.com"));
    assert!(!filter.matches("badexample.com"));
    assert!(!filter.matches("example.com.evil.net"));
    assert!(CookieFilter::default().matches("anything.org"));

    let tmp = tempfile::tempdir().unwrap();
    create_cookies_db(
        &tmp.path().join("Default/Cookies"),
        24,
        &[
            FixtureCookie::plain(".example.com", "keep1", "1"),
            FixtureCookie::plain("www.example.com", "keep2", "2"),
            FixtureCookie::plain(".notexample.com", "drop1", "3"),
            FixtureCookie::plain(".other.org", "drop2", "4"),
        ],
    );
    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::MacOs),
        &FakeKeys::default(),
        &filter,
    )
    .unwrap();
    assert_eq!(report.total, 2);
    let mut names: Vec<_> = report
        .cookies
        .iter()
        .map(|cookie| cookie["name"].as_str().unwrap().to_string())
        .collect();
    names.sort();
    assert_eq!(names, vec!["keep1", "keep2"]);
}

fn make_profile_dir(user_data: &Path, dir: &str, network_layout: bool) {
    let db = if network_layout {
        user_data.join(dir).join("Network").join("Cookies")
    } else {
        user_data.join(dir).join("Cookies")
    };
    create_cookies_db(&db, 24, &[]);
}

#[test]
fn local_state_profiles_are_listed_per_browser() {
    let home = tempfile::tempdir().unwrap();
    let roots = browser_roots(CookieCrypto::MacOs, home.path(), None);
    let chrome_root = roots
        .iter()
        .find(|(kind, _)| *kind == BrowserKind::Chrome)
        .map(|(_, root)| root.clone())
        .unwrap();
    assert_eq!(
        chrome_root,
        home.path()
            .join("Library/Application Support/Google/Chrome")
    );
    std::fs::create_dir_all(&chrome_root).unwrap();
    std::fs::write(
        chrome_root.join("Local State"),
        json!({
            "profile": {
                "info_cache": {
                    "Default": { "name": "Work" },
                    "Profile 2": { "name": "Personal" },
                    "Profile 3": { "name": "No cookies yet" },
                    "../escape": { "name": "Evil" }
                },
                "profiles_order": ["Profile 2", "Default"]
            }
        })
        .to_string(),
    )
    .unwrap();
    make_profile_dir(&chrome_root, "Default", true);
    make_profile_dir(&chrome_root, "Profile 2", false);
    std::fs::create_dir_all(chrome_root.join("Profile 3")).unwrap();

    // Brave 没有 Local State：回退 Default。
    let brave_root = home
        .path()
        .join("Library/Application Support/BraveSoftware/Brave-Browser");
    make_profile_dir(&brave_root, "Default", true);

    let profiles = list_source_profiles_in(&roots, CookieCrypto::MacOs);
    let summary: Vec<_> = profiles
        .iter()
        .map(|p| (p.browser, p.profile_dir.as_str(), p.display_name.as_str()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (BrowserKind::Chrome, "Profile 2", "Personal"),
            (BrowserKind::Chrome, "Default", "Work"),
            (BrowserKind::Brave, "Default", "Default"),
        ]
    );
    assert_eq!(
        profiles[1].cookies_db_path().unwrap(),
        chrome_root.join("Default/Network/Cookies")
    );
    assert_eq!(
        profiles[0].cookies_db_path().unwrap(),
        chrome_root.join("Profile 2/Cookies")
    );
    let serialized = serde_json::to_value(&profiles[0]).unwrap();
    assert_eq!(
        serialized,
        json!({
            "browser": "chrome",
            "browserName": "Google Chrome",
            "profileDir": "Profile 2",
            "displayName": "Personal"
        })
    );
}

#[test]
fn windows_and_linux_roots_follow_platform_layout() {
    let home = PathBuf::from("/home/test-user");
    let local = PathBuf::from("/fake/AppData/Local");
    let windows = browser_roots(CookieCrypto::Windows, &home, Some(&local));
    assert!(windows.contains(&(
        BrowserKind::Edge,
        local.join("Microsoft").join("Edge").join("User Data")
    )));
    let linux = browser_roots(CookieCrypto::Linux, &home, None);
    assert!(linux.contains(&(
        BrowserKind::Chrome,
        home.join(".config").join("google-chrome")
    )));
    assert_eq!(BrowserKind::parse(" Edge "), Some(BrowserKind::Edge));
    assert_eq!(BrowserKind::parse("safari"), None);
}

#[test]
fn locked_wal_database_is_read_through_snapshot_copy() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("Default/Network/Cookies");
    create_cookies_db(&db, 24, &[FixtureCookie::plain(".a.com", "base", "1")]);

    // 模拟运行中的浏览器：WAL 模式、禁止自动 checkpoint，新写入只在 -wal 里，
    // 且连接持有写锁不放。
    let browser = Connection::open(&db).unwrap();
    browser
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    insert_cookie(&browser, 99, &FixtureCookie::plain(".a.com", "in_wal", "2"));
    browser.execute_batch("BEGIN IMMEDIATE;").unwrap();
    insert_cookie(
        &browser,
        100,
        &FixtureCookie::plain(".a.com", "uncommitted", "3"),
    );

    let wal = tmp.path().join("Default/Network/Cookies-wal");
    assert!(wal.is_file() && std::fs::metadata(&wal).unwrap().len() > 0);
    let source_before = std::fs::read(&db).unwrap();

    let snapshot = copy_db_snapshot(&db).unwrap();
    assert!(snapshot.path().join("Cookies-wal").is_file());

    let report = read_cookies(
        &profile_at(tmp.path(), CookieCrypto::MacOs),
        &FakeKeys::default(),
        &CookieFilter::default(),
    )
    .unwrap();
    let mut names: Vec<_> = report
        .cookies
        .iter()
        .map(|cookie| cookie["name"].as_str().unwrap().to_string())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec!["base", "in_wal"],
        "committed WAL rows visible, uncommitted not"
    );
    assert_eq!(
        std::fs::read(&db).unwrap(),
        source_before,
        "source DB untouched"
    );

    browser.execute_batch("ROLLBACK;").unwrap();
    let snapshot_path = snapshot.path().to_path_buf();
    drop(snapshot);
    assert!(!snapshot_path.exists(), "temp snapshot removed on drop");
}

fn cookie_values(count: usize) -> Vec<Value> {
    (0..count)
        .map(|i| json!({ "name": format!("c{i}"), "value": "v", "domain": ".a.com", "path": "/" }))
        .collect()
}

#[test]
fn apply_sends_browser_level_set_cookies_in_batches() {
    tauri::async_runtime::block_on(async {
        let cdp = FakeCdp::default();
        let cookies = cookie_values(SET_COOKIES_BATCH * 2 + 50);
        let report = apply_cookies_via_cdp(&cdp, &cookies).await;
        assert_eq!(
            report,
            ApplyReport {
                applied: 250,
                failed: 0,
                errors: vec![]
            }
        );
        let sizes: Vec<_> = cdp
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(method, params)| {
                assert_eq!(method, "Storage.setCookies");
                assert!(params.get("browserContextId").is_none());
                params["cookies"].as_array().unwrap().len()
            })
            .collect();
        assert_eq!(sizes, vec![100, 100, 50]);

        let empty = FakeCdp::default();
        assert_eq!(
            apply_cookies_via_cdp(&empty, &[]).await,
            ApplyReport::default()
        );
        assert!(empty.calls.lock().unwrap().is_empty());
    });
}

#[test]
fn apply_isolates_bad_cookie_by_retrying_failed_batch_individually() {
    tauri::async_runtime::block_on(async {
        let cdp = FakeCdp {
            reject_name: Some("c105".to_string()),
            ..FakeCdp::default()
        };
        let cookies = cookie_values(150);
        let report = apply_cookies_via_cdp(&cdp, &cookies).await;
        assert_eq!(report.applied, 149);
        assert_eq!(report.failed, 1);
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].starts_with("c105:"));
        // 第 1 批成功（1 次）+ 第 2 批失败（1 次）+ 逐条重试 50 次。
        assert_eq!(cdp.calls.lock().unwrap().len(), 52);
    });
}

#[test]
fn import_cookies_end_to_end_with_fake_target() {
    let tmp = tempfile::tempdir().unwrap();
    create_cookies_db(
        &tmp.path().join("Default/Cookies"),
        24,
        &[
            FixtureCookie::encrypted(
                ".site.com",
                "auth",
                mac_encrypt(&with_host_hash(".site.com", "tok")),
            ),
            FixtureCookie::encrypted(".site.com", "dead", {
                let mut v = mac_encrypt(b"x");
                v.truncate(5);
                v
            }),
            FixtureCookie::plain(".elsewhere.com", "other", "o"),
        ],
    );
    let profile = profile_at(tmp.path(), CookieCrypto::MacOs);
    tauri::async_runtime::block_on(async {
        // 目标浏览器未运行：先失败，且根本不去取密钥。
        let keys = Arc::new(FakeKeys::with_password(TEST_MAC_PASSWORD));
        let error = import_cookies(
            &FakeTarget(None),
            profile.clone(),
            keys.clone(),
            CookieFilter::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(error, IN_APP_BROWSER_NOT_RUNNING);
        assert_eq!(*keys.password_calls.lock().unwrap(), 0);

        let cdp = Arc::new(FakeCdp::default());
        let summary = import_cookies(
            &FakeTarget(Some(cdp.clone())),
            profile,
            keys,
            CookieFilter::new(vec!["site.com".to_string()]),
        )
        .await
        .unwrap();
        assert_eq!(
            summary,
            ImportSummary {
                total: 2,
                imported: 1,
                failed: 0,
                skipped: vec![SkippedCookies {
                    reason: SkipReason::DecryptFailed,
                    count: 1
                }],
                key_error: None,
                errors: vec![],
            }
        );
        let calls = cdp.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1["cookies"][0]["value"], json!("tok"));
        // 摘要序列化不含任何 cookie 值。
        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(!serialized.contains("tok"));
        assert!(serialized.contains("\"reason\":\"decryptFailed\""));
    });
}
