//! 解密密钥来源抽象。真实实现访问系统密钥设施（会触发系统授权弹窗，
//! 由用户主动点击导入触发，属预期）；测试注入假实现。

use super::discovery::BrowserKind;

pub trait KeyProvider: Send + Sync {
    /// macOS / Linux(v11)：浏览器的 "Safe Storage" 密码。
    /// `Ok(None)` 表示该条目不存在（未保存过 / 无 secret service）。
    fn safe_storage_password(&self, browser: BrowserKind) -> Result<Option<Vec<u8>>, String>;

    /// Windows：DPAPI 解封（CryptUnprotectData，当前用户范围）。
    fn dpapi_unprotect(&self, blob: &[u8]) -> Result<Vec<u8>, String>;
}

/// 访问当前平台真实密钥设施的实现。
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemKeyProvider;

impl KeyProvider for SystemKeyProvider {
    fn safe_storage_password(&self, browser: BrowserKind) -> Result<Option<Vec<u8>>, String> {
        platform::safe_storage_password(browser)
    }

    fn dpapi_unprotect(&self, blob: &[u8]) -> Result<Vec<u8>, String> {
        platform::dpapi_unprotect(blob)
    }
}

/// 仅 debug 构建：设置该环境变量后，导入改用固定的 Safe Storage 密码，
/// 完全不访问系统钥匙串（用于在临时 HOME 下对夹具 profile 做手工验收）。
/// release 构建里这段代码不存在。
#[cfg(debug_assertions)]
pub const DEBUG_FIXED_PASSWORD_ENV: &str = "LIVEAGENT_DEBUG_COOKIE_IMPORT_PASSWORD";

#[cfg(debug_assertions)]
struct FixedPasswordKeyProvider(Vec<u8>);

#[cfg(debug_assertions)]
impl KeyProvider for FixedPasswordKeyProvider {
    fn safe_storage_password(&self, _browser: BrowserKind) -> Result<Option<Vec<u8>>, String> {
        Ok(Some(self.0.clone()))
    }

    fn dpapi_unprotect(&self, _blob: &[u8]) -> Result<Vec<u8>, String> {
        Err("调试用固定密钥不支持 DPAPI".to_string())
    }
}

/// 导入命令使用的密钥来源：默认访问系统密钥设施。
pub fn import_key_provider() -> std::sync::Arc<dyn KeyProvider> {
    #[cfg(debug_assertions)]
    if let Some(password) = std::env::var_os(DEBUG_FIXED_PASSWORD_ENV).filter(|v| !v.is_empty()) {
        return std::sync::Arc::new(FixedPasswordKeyProvider(
            password.to_string_lossy().into_owned().into_bytes(),
        ));
    }
    std::sync::Arc::new(SystemKeyProvider)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::BrowserKind;

    /// 读 Keychain 中浏览器的通用密码项（其他应用的条目，系统会弹授权框）。
    pub(super) fn safe_storage_password(browser: BrowserKind) -> Result<Option<Vec<u8>>, String> {
        let (service, account) = browser.keychain_item();
        let entry = keyring::Entry::new(service, account)
            .map_err(|e| format!("打开钥匙串条目 {service} 失败：{e}"))?;
        match entry.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("读取钥匙串条目 {service} 失败：{e}")),
        }
    }

    pub(super) fn dpapi_unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
        Err("DPAPI 仅在 Windows 上可用".to_string())
    }
}

#[cfg(windows)]
mod platform {
    use super::BrowserKind;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    pub(super) fn safe_storage_password(_browser: BrowserKind) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }

    pub(super) fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(blob.len()).map_err(|_| "DPAPI 输入过大".to_string())?,
            pbData: blob.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: input 指向调用期间有效的只读缓冲；output 由系统以 LocalAlloc
        // 分配，拷出后用 LocalFree 释放。
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 || output.pbData.is_null() {
            return Err(format!(
                "DPAPI 解密失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: 成功时 pbData/cbData 描述一块有效的系统分配内存。
        let data =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            LocalFree(output.pbData as _);
        }
        Ok(data)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use std::process::{Command, Stdio};

    use super::BrowserKind;

    /// v11 密码存于 libsecret（GNOME Keyring 等），用 `secret-tool` 查询，
    /// 避免为此引入 D-Bus 依赖。工具缺失或无条目时返回 None，调用方回退空密码。
    /// KWallet 暂不支持。
    pub(super) fn safe_storage_password(browser: BrowserKind) -> Result<Option<Vec<u8>>, String> {
        let output = Command::new("secret-tool")
            .args(["lookup", "application", browser.linux_secret_application()])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        match output {
            Ok(output) if output.status.success() && !output.stdout.is_empty() => {
                let mut secret = output.stdout;
                while secret.last() == Some(&b'\n') {
                    secret.pop();
                }
                Ok(Some(secret))
            }
            _ => Ok(None),
        }
    }

    pub(super) fn dpapi_unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
        Err("DPAPI 仅在 Windows 上可用".to_string())
    }
}
