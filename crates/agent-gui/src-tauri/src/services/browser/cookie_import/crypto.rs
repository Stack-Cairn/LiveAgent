//! Chromium cookie 加密方案（os_crypt）：
//! - macOS：`v10` + AES-128-CBC，key = PBKDF2-HMAC-SHA1(Keychain 密码, "saltysalt", 1003, 16)，IV = 16 个空格；
//! - Linux：`v10` 密码 "peanuts"、`v11` 密码来自 secret service，PBKDF2 迭代 1 次，其余同上；
//! - Windows：`v10`/`v11` + AES-256-GCM（12 字节 nonce、16 字节 tag），key 经 DPAPI 解封；
//!   `v20`（app-bound）不可解，按跳过处理。
//!
//! Cookies DB meta.version ≥ 24 时明文前缀 32 字节 SHA256(host_key)，需剥离。

use std::cell::OnceCell;

use aes::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes256Gcm;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use super::discovery::{windows_encrypted_key, CookieCrypto, SourceProfile};
use super::keys::KeyProvider;
use super::SkipReason;

pub(crate) const SALT: &[u8] = b"saltysalt";
pub(crate) const CBC_IV: [u8; 16] = [b' '; 16];
pub(crate) const MAC_ITERATIONS: u32 = 1003;
pub(crate) const LINUX_ITERATIONS: u32 = 1;
pub(crate) const LINUX_V10_PASSWORD: &[u8] = b"peanuts";
/// 明文带 SHA256(host_key) 前缀的最低 Cookies DB 版本。
pub(crate) const HASH_PREFIX_MIN_DB_VERSION: i64 = 24;
const GCM_NONCE_LEN: usize = 12;
const GCM_TAG_LEN: usize = 16;

/// PBKDF2-HMAC-SHA1 取前 16 字节（只需一个 20 字节块），用现有 hmac/sha1 依赖实现。
pub(crate) fn pbkdf2_sha1_16(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 16] {
    let prf = Hmac::<Sha1>::new_from_slice(password).expect("HMAC accepts any key length");
    let mut mac = prf.clone();
    mac.update(salt);
    mac.update(&1u32.to_be_bytes());
    let mut u = mac.finalize().into_bytes();
    let mut block = u;
    for _ in 1..iterations.max(1) {
        let mut mac = prf.clone();
        mac.update(&u);
        u = mac.finalize().into_bytes();
        for (acc, byte) in block.iter_mut().zip(u.iter()) {
            *acc ^= byte;
        }
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(&block[..16]);
    key
}

pub(crate) fn aes128_cbc_decrypt(key: &[u8; 16], ciphertext: &[u8]) -> Option<Vec<u8>> {
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
        return None;
    }
    let mut buf = ciphertext.to_vec();
    let decryptor = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, &CBC_IV).ok()?;
    let plaintext = decryptor.decrypt_padded::<Pkcs7>(&mut buf).ok()?;
    Some(plaintext.to_vec())
}

/// `payload` = 12 字节 nonce ‖ 密文 ‖ 16 字节 tag（已去掉 v10/v11 前缀）。
pub(crate) fn aes256_gcm_decrypt(key: &[u8], payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < GCM_NONCE_LEN + GCM_TAG_LEN {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let (nonce, ciphertext) = payload.split_at(GCM_NONCE_LEN);
    let nonce = aes_gcm::Nonce::try_from(nonce).ok()?;
    cipher.decrypt(&nonce, ciphertext).ok()
}

/// 按源 profile 的平台方案解密 `encrypted_value`。密钥惰性获取并缓存：
/// 库里没有加密 cookie 时不会触发系统授权弹窗；拿不到时只记一次错误。
pub(crate) struct CookieDecryptor<'a> {
    profile: &'a SourceProfile,
    keys: &'a dyn KeyProvider,
    db_version: i64,
    /// macOS v10 / Linux v11（secret service 密码）派生的 AES-128 key。
    password_key: OnceCell<Result<Option<[u8; 16]>, String>>,
    /// Windows：DPAPI 解封后的 AES-256 key。
    windows_key: OnceCell<Result<Vec<u8>, String>>,
}

impl<'a> CookieDecryptor<'a> {
    pub(crate) fn new(
        profile: &'a SourceProfile,
        keys: &'a dyn KeyProvider,
        db_version: i64,
    ) -> Self {
        Self {
            profile,
            keys,
            db_version,
            password_key: OnceCell::new(),
            windows_key: OnceCell::new(),
        }
    }

    /// 首个密钥获取错误（供报告提示用户，如拒绝了钥匙串授权）。
    pub(crate) fn key_error(&self) -> Option<String> {
        let password_error = match self.password_key.get() {
            Some(Err(error)) => Some(error.clone()),
            Some(Ok(None)) if self.profile.crypto == CookieCrypto::MacOs => Some(format!(
                "钥匙串中未找到 {} 的 Safe Storage 密码",
                self.profile.browser.display_name()
            )),
            _ => None,
        };
        password_error.or_else(|| match self.windows_key.get() {
            Some(Err(error)) => Some(error.clone()),
            _ => None,
        })
    }

    fn password_key(&self) -> Result<Option<[u8; 16]>, String> {
        self.password_key
            .get_or_init(|| {
                let iterations = match self.profile.crypto {
                    CookieCrypto::MacOs => MAC_ITERATIONS,
                    _ => LINUX_ITERATIONS,
                };
                Ok(self
                    .keys
                    .safe_storage_password(self.profile.browser)?
                    .map(|password| pbkdf2_sha1_16(&password, SALT, iterations)))
            })
            .clone()
    }

    fn windows_key(&self) -> Result<Vec<u8>, String> {
        self.windows_key
            .get_or_init(|| {
                let wrapped = windows_encrypted_key(&self.profile.user_data_dir)?;
                let key = self.keys.dpapi_unprotect(&wrapped)?;
                if key.len() != 32 {
                    return Err(format!("解封后的密钥长度异常（{} 字节）", key.len()));
                }
                Ok(key)
            })
            .clone()
    }

    /// 解出 cookie 明文值；失败返回跳过原因。
    pub(crate) fn decrypt(&self, host_key: &str, blob: &[u8]) -> Result<String, SkipReason> {
        let (prefix, payload) = if blob.len() >= 3 {
            blob.split_at(3)
        } else {
            (blob, &[][..])
        };
        if prefix == b"v20" {
            return Err(SkipReason::AppBoundEncryption);
        }
        let plaintext = match (self.profile.crypto, prefix) {
            (CookieCrypto::MacOs, b"v10") => {
                let key = self
                    .password_key()
                    .ok()
                    .flatten()
                    .ok_or(SkipReason::KeyUnavailable)?;
                aes128_cbc_decrypt(&key, payload).ok_or(SkipReason::DecryptFailed)?
            }
            (CookieCrypto::Linux, b"v10") => {
                let key = pbkdf2_sha1_16(LINUX_V10_PASSWORD, SALT, LINUX_ITERATIONS);
                aes128_cbc_decrypt(&key, payload).ok_or(SkipReason::DecryptFailed)?
            }
            (CookieCrypto::Linux, b"v11") => {
                // 无 secret service 时 Chromium 以空密码派生 v11 key，作为回退一并尝试。
                let stored = self.password_key().ok().flatten();
                let empty = pbkdf2_sha1_16(b"", SALT, LINUX_ITERATIONS);
                stored
                    .into_iter()
                    .chain(std::iter::once(empty))
                    .find_map(|key| aes128_cbc_decrypt(&key, payload))
                    .ok_or(SkipReason::DecryptFailed)?
            }
            (CookieCrypto::Windows, b"v10" | b"v11") => {
                let key = self.windows_key().map_err(|_| SkipReason::KeyUnavailable)?;
                aes256_gcm_decrypt(&key, payload).ok_or(SkipReason::DecryptFailed)?
            }
            // 早期 Windows 版本：整段直接 DPAPI 加密、无版本前缀。
            (CookieCrypto::Windows, _) if !blob.starts_with(b"v1") => self
                .keys
                .dpapi_unprotect(blob)
                .map_err(|_| SkipReason::DecryptFailed)?,
            _ => return Err(SkipReason::UnsupportedEncryption),
        };
        let plaintext = strip_host_hash(host_key, plaintext, self.db_version);
        String::from_utf8(plaintext).map_err(|_| SkipReason::DecryptFailed)
    }
}

/// meta.version ≥ 24：明文 = SHA256(host_key) ‖ value，剥前缀。旧库若恰好也带
/// 匹配的前缀（版本信息缺失的情况）同样剥离。
fn strip_host_hash(host_key: &str, mut plaintext: Vec<u8>, db_version: i64) -> Vec<u8> {
    if plaintext.len() < 32 {
        return plaintext;
    }
    let has_prefix = db_version >= HASH_PREFIX_MIN_DB_VERSION
        || plaintext[..32] == Sha256::digest(host_key.as_bytes())[..];
    if has_prefix {
        plaintext.drain(..32);
    }
    plaintext
}
