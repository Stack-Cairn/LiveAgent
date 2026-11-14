//! 源浏览器与 profile 枚举：按平台定位 user-data 目录，解析 `Local State`。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserKind {
    Chrome,
    Edge,
    Chromium,
    Brave,
}

impl BrowserKind {
    pub const ALL: [BrowserKind; 4] = [Self::Chrome, Self::Edge, Self::Chromium, Self::Brave];

    pub fn id(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Edge => "edge",
            Self::Chromium => "chromium",
            Self::Brave => "brave",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.id().eq_ignore_ascii_case(raw.trim()))
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Chrome => "Google Chrome",
            Self::Edge => "Microsoft Edge",
            Self::Chromium => "Chromium",
            Self::Brave => "Brave",
        }
    }

    /// macOS Keychain 通用密码项：(service, account)。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn keychain_item(self) -> (&'static str, &'static str) {
        match self {
            Self::Chrome => ("Chrome Safe Storage", "Chrome"),
            Self::Edge => ("Microsoft Edge Safe Storage", "Microsoft Edge"),
            Self::Chromium => ("Chromium Safe Storage", "Chromium"),
            Self::Brave => ("Brave Safe Storage", "Brave"),
        }
    }

    /// Linux libsecret 条目的 `application` 属性。
    #[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
    pub(crate) fn linux_secret_application(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Edge => "microsoft-edge",
            Self::Chromium => "chromium",
            Self::Brave => "brave",
        }
    }

    /// user-data 目录相对平台基准目录的路径片段。
    fn user_data_rel(self, os: CookieCrypto) -> &'static [&'static str] {
        match (os, self) {
            (CookieCrypto::MacOs, Self::Chrome) => &["Google", "Chrome"],
            (CookieCrypto::MacOs, Self::Edge) => &["Microsoft Edge"],
            (CookieCrypto::MacOs, Self::Chromium) => &["Chromium"],
            (CookieCrypto::MacOs, Self::Brave) => &["BraveSoftware", "Brave-Browser"],
            (CookieCrypto::Windows, Self::Chrome) => &["Google", "Chrome", "User Data"],
            (CookieCrypto::Windows, Self::Edge) => &["Microsoft", "Edge", "User Data"],
            (CookieCrypto::Windows, Self::Chromium) => &["Chromium", "User Data"],
            (CookieCrypto::Windows, Self::Brave) => {
                &["BraveSoftware", "Brave-Browser", "User Data"]
            }
            (CookieCrypto::Linux, Self::Chrome) => &["google-chrome"],
            (CookieCrypto::Linux, Self::Edge) => &["microsoft-edge"],
            (CookieCrypto::Linux, Self::Chromium) => &["chromium"],
            (CookieCrypto::Linux, Self::Brave) => &["BraveSoftware", "Brave-Browser"],
        }
    }
}

/// cookie 加密方案（由源 profile 所在平台决定）。显式建模而非直接 cfg，
/// 让三种方案都能在任一平台上做单元测试。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CookieCrypto {
    MacOs,
    Linux,
    Windows,
}

impl CookieCrypto {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProfile {
    pub browser: BrowserKind,
    pub browser_name: String,
    /// profile 目录名（`Default`、`Profile 1`…），也是导入命令的定位键。
    pub profile_dir: String,
    /// `Local State` 里用户可见的 profile 名。
    pub display_name: String,
    #[serde(skip)]
    pub user_data_dir: PathBuf,
    #[serde(skip)]
    pub crypto: CookieCrypto,
}

impl SourceProfile {
    pub fn profile_path(&self) -> PathBuf {
        self.user_data_dir.join(&self.profile_dir)
    }

    /// Cookies 数据库位置：Chrome 96+ 在 `Network/Cookies`，更早在 profile 根。
    pub fn cookies_db_path(&self) -> Option<PathBuf> {
        cookies_db_in(&self.profile_path())
    }
}

fn cookies_db_in(profile_path: &Path) -> Option<PathBuf> {
    [
        profile_path.join("Network").join("Cookies"),
        profile_path.join("Cookies"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

/// 列出本机所有带 Cookies 数据库的源 profile。
pub fn list_source_profiles() -> Vec<SourceProfile> {
    let os = CookieCrypto::current();
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    list_source_profiles_in(&browser_roots(os, &home, local_app_data.as_deref()), os)
}

/// 各浏览器 user-data 根目录候选（纯函数，测试传入临时 HOME）。
pub(crate) fn browser_roots(
    os: CookieCrypto,
    home: &Path,
    local_app_data: Option<&Path>,
) -> Vec<(BrowserKind, PathBuf)> {
    let base = match os {
        CookieCrypto::MacOs => home.join("Library").join("Application Support"),
        CookieCrypto::Linux => std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.starts_with(home))
            .unwrap_or_else(|| home.join(".config")),
        CookieCrypto::Windows => local_app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Local")),
    };
    BrowserKind::ALL
        .into_iter()
        .map(|kind| {
            let root = kind
                .user_data_rel(os)
                .iter()
                .fold(base.clone(), |path, part| path.join(part));
            (kind, root)
        })
        .collect()
}

pub(crate) fn list_source_profiles_in(
    roots: &[(BrowserKind, PathBuf)],
    crypto: CookieCrypto,
) -> Vec<SourceProfile> {
    roots
        .iter()
        .filter(|(_, root)| root.is_dir())
        .flat_map(|(kind, root)| profiles_in_user_data(*kind, root, crypto))
        .collect()
}

/// profile 目录名必须是单段普通名字（Local State 来自磁盘，不盲信）。
fn is_safe_profile_dir(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && !name.contains(':')
}

fn profiles_in_user_data(
    kind: BrowserKind,
    user_data_dir: &Path,
    crypto: CookieCrypto,
) -> Vec<SourceProfile> {
    let local_state = std::fs::read(user_data_dir.join("Local State"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let profile_section = local_state.as_ref().and_then(|state| state.get("profile"));
    let info_cache = profile_section
        .and_then(|profile| profile.get("info_cache"))
        .and_then(Value::as_object);

    // 顺序：profiles_order（浏览器 UI 的顺序）→ info_cache 剩余项按名排序；
    // Local State 缺失/损坏时退回 Default。
    let mut ordered: Vec<String> = profile_section
        .and_then(|profile| profile.get("profiles_order"))
        .and_then(Value::as_array)
        .map(|order| {
            order
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if let Some(cache) = info_cache {
        let mut rest: Vec<String> = cache
            .keys()
            .filter(|key| !ordered.contains(key))
            .cloned()
            .collect();
        rest.sort();
        ordered.extend(rest);
    }
    if ordered.is_empty() {
        ordered.push("Default".to_string());
    }

    let mut seen = std::collections::HashSet::new();
    ordered
        .into_iter()
        .filter(|dir| is_safe_profile_dir(dir) && seen.insert(dir.clone()))
        .filter(|dir| cookies_db_in(&user_data_dir.join(dir)).is_some())
        .map(|dir| {
            let display_name = info_cache
                .and_then(|cache| cache.get(&dir))
                .and_then(|info| info.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(&dir)
                .to_string();
            SourceProfile {
                browser: kind,
                browser_name: kind.display_name().to_string(),
                profile_dir: dir,
                display_name,
                user_data_dir: user_data_dir.to_path_buf(),
                crypto,
            }
        })
        .collect()
}

/// Windows：`Local State` 的 `os_crypt.encrypted_key`（base64，`DPAPI` 前缀）。
pub(crate) fn windows_encrypted_key(user_data_dir: &Path) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let bytes = std::fs::read(user_data_dir.join("Local State"))
        .map_err(|e| format!("读取 Local State 失败：{e}"))?;
    let state: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析 Local State 失败：{e}"))?;
    let encoded = state
        .pointer("/os_crypt/encrypted_key")
        .and_then(Value::as_str)
        .ok_or_else(|| "Local State 缺少 os_crypt.encrypted_key".to_string())?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("encrypted_key 不是合法 base64：{e}"))?;
    decoded
        .strip_prefix(b"DPAPI")
        .map(<[u8]>::to_vec)
        .ok_or_else(|| "encrypted_key 缺少 DPAPI 前缀".to_string())
}
