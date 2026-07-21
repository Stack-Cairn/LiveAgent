use russh::client;
use russh::keys::ssh_key::HashAlg;
use russh::keys::PrivateKeyWithHashAlg;
use russh::MethodKind;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use crate::commands::settings::RuntimeSshHostConfig;

use super::*;

pub(crate) fn resolve_ssh_auth_material(
    host: &RuntimeSshHostConfig,
) -> Result<ResolvedSshAuth, String> {
    if host.auth_type == "keyboardInteractive" {
        Ok(ResolvedSshAuth::KeyboardInteractive)
    } else if host.auth_type == "privateKey" {
        let key = if !host.private_key.trim().is_empty() {
            host.private_key.trim().to_string()
        } else {
            let path = host.private_key_path.trim();
            if path.is_empty() {
                return Err("SSH private key is not configured".to_string());
            }
            let expanded = expand_ssh_private_key_path(path);
            fs::read_to_string(&expanded)
                .map_err(|error| {
                    format!(
                        "failed to read SSH private key {}: {error}",
                        expanded.display()
                    )
                })?
                .trim()
                .to_string()
        };
        let key = normalize_ssh_private_key_material(&key);
        if key.is_empty() {
            return Err("SSH private key is empty".to_string());
        }
        let passphrase = host.private_key_passphrase.trim().to_string();
        Ok(ResolvedSshAuth::PrivateKey {
            key,
            passphrase: (!passphrase.is_empty()).then_some(passphrase),
        })
    } else {
        let password = host.password.trim().to_string();
        if password.is_empty() {
            return Err("SSH password is not configured".to_string());
        }
        Ok(ResolvedSshAuth::Password(password))
    }
}

/// Normalize pasted or stored private key material so that common copy/paste
/// artifacts do not break key parsing. russh's PEM reader matches the
/// `-----BEGIN ...-----` marker by exact line equality and silently drops any
/// base64 line that carries extra characters (for example a trailing space),
/// so a key that "looks fine" in the settings UI can fail to decode with
/// `Could not read key`. This repairs:
/// - UTF-8 BOM, zero-width characters, and non-breaking spaces
/// - CRLF / lone CR line endings and literal `\n` / `\r\n` escape sequences
///   (keys copied out of JSON or shell one-liners)
/// - per-line leading/trailing whitespace (indented paste)
/// - PEM blocks collapsed onto a single line (newlines lost while pasting)
pub(crate) fn normalize_ssh_private_key_material(raw: &str) -> String {
    let mut text = raw.to_string();
    for zero_width in ['\u{feff}', '\u{200b}', '\u{200c}', '\u{200d}'] {
        text = text.replace(zero_width, "");
    }
    text = text.replace('\u{a0}', " ");
    text = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n");
    let joined = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    refold_pem_block(&joined).unwrap_or(joined)
}

/// Rebuild the first PEM block found in `text` with canonical line folding:
/// the BEGIN/END markers on their own lines and the base64 body wrapped at
/// 64 columns. Returns `None` (leaving the input untouched) when there is no
/// PEM block or when the body carries PEM headers such as `Proc-Type:` /
/// `DEK-Info:` (legacy encrypted PEM), whose line structure must be kept.
pub(crate) fn refold_pem_block(text: &str) -> Option<String> {
    const BEGIN: &str = "-----BEGIN ";
    const DASHES: &str = "-----";
    let begin_start = text.find(BEGIN)?;
    let after_begin = &text[begin_start + BEGIN.len()..];
    let label_end = after_begin.find(DASHES)?;
    let label = after_begin[..label_end].trim();
    if label.is_empty() {
        return None;
    }
    let body_start = begin_start + BEGIN.len() + label_end + DASHES.len();
    let end_marker = format!("-----END {label}-----");
    let end_rel = text[body_start..].find(&end_marker)?;
    let body_raw = &text[body_start..body_start + end_rel];
    if body_raw.contains(':') {
        return None;
    }
    let body: String = body_raw.chars().filter(|c| !c.is_whitespace()).collect();
    if body.is_empty() {
        return None;
    }
    let mut folded = format!("-----BEGIN {label}-----\n");
    for chunk in body.as_bytes().chunks(64) {
        folded.push_str(std::str::from_utf8(chunk).ok()?);
        folded.push('\n');
    }
    folded.push_str(&end_marker);
    Some(folded)
}

/// Translate private key decode failures into actionable messages instead of
/// a generic "Invalid SSH private key".
pub(crate) fn describe_ssh_private_key_decode_error(
    error: &russh::keys::Error,
    has_passphrase: bool,
) -> String {
    match error {
        russh::keys::Error::KeyIsEncrypted if !has_passphrase => {
            "SSH private key is encrypted; configure the key passphrase for this host".to_string()
        }
        _ if has_passphrase => {
            format!("Invalid SSH private key or wrong passphrase: {error}")
        }
        _ => format!("Invalid SSH private key: {error}"),
    }
}

pub(crate) fn expand_ssh_private_key_path(path: &str) -> PathBuf {
    let home = dirs::home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let profile = if cfg!(windows) {
        SshPathProfile::Windows
    } else {
        SshPathProfile::Posix
    };
    let expanded = expand_ssh_identity_path_for_profile(&home, path, profile);
    PathBuf::from(expanded)
}

pub(crate) fn expand_ssh_identity_path_for_profile(
    home_path: &str,
    path: &str,
    profile: SshPathProfile,
) -> String {
    expand_ssh_identity_path_for_profile_with_env(home_path, path, profile, |key| {
        std::env::var(key).ok()
    })
}

pub(crate) fn expand_ssh_identity_path_for_profile_with_env<F>(
    home_path: &str,
    path: &str,
    profile: SshPathProfile,
    env: F,
) -> String
where
    F: Fn(&str) -> Option<String>,
{
    let trimmed = strip_wrapping_quotes(path);
    if trimmed.is_empty() {
        return String::new();
    }
    match profile {
        SshPathProfile::Windows => expand_windows_ssh_identity_path(home_path, &trimmed, env),
        SshPathProfile::Posix => expand_posix_ssh_identity_path(home_path, &trimmed),
    }
}

pub(crate) fn strip_wrapping_quotes(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0] as char;
        let last = trimmed.as_bytes()[trimmed.len() - 1] as char;
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

pub(crate) fn expand_windows_ssh_identity_path<F>(home_path: &str, path: &str, env: F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    if is_windows_absolute_path(path) {
        return path.to_string();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return join_windows_identity_path(home_path, rest);
    }
    if let Some(rest) = path
        .strip_prefix("$HOME/")
        .or_else(|| path.strip_prefix("$HOME\\"))
    {
        return join_windows_identity_path(home_path, rest);
    }
    if let Some(rest) = path
        .strip_prefix("${HOME}/")
        .or_else(|| path.strip_prefix("${HOME}\\"))
    {
        return join_windows_identity_path(home_path, rest);
    }
    if let Some(rest) = strip_prefix_ci(path, "%USERPROFILE%") {
        if rest.starts_with('\\') || rest.starts_with('/') {
            let user_profile = env("USERPROFILE").unwrap_or_else(|| home_path.to_string());
            return join_windows_identity_path(&user_profile, rest);
        }
    }
    if let Some(rest) = strip_prefix_ci(path, "%HOMEDRIVE%%HOMEPATH%") {
        if rest.starts_with('\\') || rest.starts_with('/') {
            let home_drive = env("HOMEDRIVE").unwrap_or_default();
            let home_path_env = env("HOMEPATH").unwrap_or_default();
            let home = if home_drive.is_empty() && home_path_env.is_empty() {
                home_path.to_string()
            } else {
                format!("{home_drive}{home_path_env}")
            };
            return join_windows_identity_path(&home, rest);
        }
    }
    if path.starts_with('\\') || path.starts_with('/') {
        return path.to_string();
    }
    join_windows_identity_path(home_path, path)
}

pub(crate) fn expand_posix_ssh_identity_path(home_path: &str, path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        return join_posix_identity_path(home_path, rest);
    }
    if let Some(rest) = path.strip_prefix("$HOME/") {
        return join_posix_identity_path(home_path, rest);
    }
    if let Some(rest) = path.strip_prefix("${HOME}/") {
        return join_posix_identity_path(home_path, rest);
    }
    if path.starts_with('/') {
        return trim_trailing_posix_slashes(path);
    }
    join_posix_identity_path(home_path, path)
}

pub(crate) fn is_windows_absolute_path(path: &str) -> bool {
    if path.starts_with(r"\\?\") || path.starts_with(r"//?/") {
        return true;
    }
    if path.len() >= 3
        && path.as_bytes()[1] == b':'
        && path.as_bytes()[0].is_ascii_alphabetic()
        && matches!(path.as_bytes()[2], b'\\' | b'/')
    {
        return true;
    }
    path.starts_with(r"\\") || path.starts_with("//")
}

pub(crate) fn strip_prefix_ci<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        .then(|| &value[prefix.len()..])
}

pub(crate) fn join_windows_identity_path(base: &str, child: &str) -> String {
    let separator = if base.contains('\\') { '\\' } else { '/' };
    let base = base.trim_end_matches(['\\', '/']);
    let child = child.trim_start_matches(['\\', '/']);
    if child.is_empty() {
        base.to_string()
    } else if base.is_empty() {
        child.to_string()
    } else {
        format!("{base}{separator}{child}")
    }
}

pub(crate) fn join_posix_identity_path(base: &str, child: &str) -> String {
    let base = base.trim_end_matches('/');
    let child = child.trim_start_matches('/');
    if child.is_empty() {
        base.to_string()
    } else if base.is_empty() {
        child.to_string()
    } else {
        format!("{base}/{child}")
    }
}

pub(crate) fn trim_trailing_posix_slashes(path: &str) -> String {
    let mut next = path.to_string();
    while next.len() > 1 && next.ends_with('/') {
        next.pop();
    }
    next
}

pub(crate) async fn authenticate_ssh_handle(
    handle: &mut client::Handle<LiveAgentSshClient>,
    host: &RuntimeSshHostConfig,
    auth: ResolvedSshAuth,
) -> Result<SshAuthOutcome, String> {
    match auth {
        ResolvedSshAuth::Password(password) => {
            let result = handle
                .authenticate_password(host.username.as_str(), password.clone())
                .await
                .map_err(|error| format!("SSH password authentication failed: {error}"))?;
            if result.success() {
                return Ok(SshAuthOutcome::Authenticated);
            }
            if auth_result_can_continue_with_kbi(&result) {
                let response = handle
                    .authenticate_keyboard_interactive_start(host.username.as_str(), None::<String>)
                    .await
                    .map_err(|error| {
                        format!("SSH keyboard-interactive authentication failed: {error}")
                    })?;
                return continue_keyboard_interactive_auth(handle, response, Some(password)).await;
            }
            Err("SSH authentication failed".to_string())
        }
        ResolvedSshAuth::PrivateKey { key, passphrase } => {
            let key_pair = russh::keys::decode_secret_key(&key, passphrase.as_deref())
                .map_err(|error| {
                    describe_ssh_private_key_decode_error(&error, passphrase.is_some())
                })?;
            // Negotiate the RSA signature hash from the server's
            // `server-sig-algs` extension (RFC 8308). Hardcoding SHA-256
            // breaks against servers that only accept `ssh-rsa` (SHA-1);
            // when the server does not advertise the extension, keep the
            // previous SHA-256 behavior. Non-RSA keys skip the negotiation
            // entirely because the hash algorithm is ignored for them.
            let hash_alg = if key_pair.algorithm().is_rsa() {
                handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|error| format!("SSH private key authentication failed: {error}"))?
                    .unwrap_or(Some(HashAlg::Sha256))
            } else {
                None
            };
            let key = PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg);
            let result = handle
                .authenticate_publickey(host.username.as_str(), key)
                .await
                .map_err(|error| format!("SSH private key authentication failed: {error}"))?;
            if result.success() {
                return Ok(SshAuthOutcome::Authenticated);
            }
            if auth_result_can_continue_with_kbi(&result) {
                let response = handle
                    .authenticate_keyboard_interactive_start(host.username.as_str(), None::<String>)
                    .await
                    .map_err(|error| {
                        format!("SSH keyboard-interactive authentication failed: {error}")
                    })?;
                return continue_keyboard_interactive_auth(handle, response, None).await;
            }
            Err("SSH authentication failed".to_string())
        }
        ResolvedSshAuth::KeyboardInteractive => {
            let response = handle
                .authenticate_keyboard_interactive_start(host.username.as_str(), None::<String>)
                .await
                .map_err(|error| {
                    format!("SSH keyboard-interactive authentication failed: {error}")
                })?;
            // Servers with keyboard-interactive disabled (e.g. sshd's
            // `KbdInteractiveAuthentication no`) reject the method before any
            // prompt round. Fall back to asking the user for the password
            // interactively when the server still allows password auth.
            if let client::KeyboardInteractiveAuthResponse::Failure {
                remaining_methods, ..
            } = &response
            {
                if remaining_methods.contains(&MethodKind::Password) {
                    return Ok(SshAuthOutcome::KeyboardInteractivePrompt(
                        password_fallback_prompt_data(host, false),
                    ));
                }
                return Err(
                    "SSH keyboard-interactive authentication is not supported by this server"
                        .to_string(),
                );
            }
            continue_keyboard_interactive_auth(handle, response, None).await
        }
    }
}

pub(crate) fn password_fallback_prompt_data(
    host: &RuntimeSshHostConfig,
    retry: bool,
) -> KeyboardInteractivePromptData {
    KeyboardInteractivePromptData {
        name: String::new(),
        instructions: if retry {
            "Permission denied, please try again.".to_string()
        } else {
            String::new()
        },
        prompt: format!("{}@{}'s password:", host.username.trim(), host.host.trim()),
        echo: false,
        answer_mode: SshPromptAnswerMode::Password,
    }
}

pub(crate) fn auth_result_can_continue_with_kbi(result: &client::AuthResult) -> bool {
    matches!(
        result,
        client::AuthResult::Failure {
            remaining_methods,
            ..
        } if remaining_methods.contains(&MethodKind::KeyboardInteractive)
    )
}

pub(crate) fn prompt_looks_like_password(prompt: &str) -> bool {
    let normalized = prompt.trim().to_ascii_lowercase();
    normalized.contains("password") || prompt.contains("密码")
}

pub(crate) fn classify_password_kbi_prompts(
    prompts: &[client::Prompt],
    password_prompt_consumed: bool,
) -> PasswordKbiPromptAction {
    if prompts.is_empty() {
        PasswordKbiPromptAction::RespondEmpty
    } else if !password_prompt_consumed
        && prompts.len() == 1
        && !prompts[0].echo
        && prompt_looks_like_password(&prompts[0].prompt)
    {
        PasswordKbiPromptAction::SendPassword
    } else {
        PasswordKbiPromptAction::PromptUser
    }
}

pub(crate) async fn continue_keyboard_interactive_auth(
    handle: &mut client::Handle<LiveAgentSshClient>,
    mut response: client::KeyboardInteractiveAuthResponse,
    auto_password: Option<String>,
) -> Result<SshAuthOutcome, String> {
    let mut password_prompt_consumed = false;
    for _ in 0..5 {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => {
                return Ok(SshAuthOutcome::Authenticated);
            }
            client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("SSH keyboard-interactive authentication failed".to_string());
            }
            client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => match classify_password_kbi_prompts(&prompts, password_prompt_consumed) {
                PasswordKbiPromptAction::RespondEmpty => {
                    response = handle
                        .authenticate_keyboard_interactive_respond(Vec::new())
                        .await
                        .map_err(|error| {
                            format!("SSH keyboard-interactive response failed: {error}")
                        })?;
                }
                PasswordKbiPromptAction::SendPassword if auto_password.is_some() => {
                    password_prompt_consumed = true;
                    response = handle
                        .authenticate_keyboard_interactive_respond(vec![auto_password
                            .clone()
                            .unwrap_or_default()])
                        .await
                        .map_err(|error| {
                            format!("SSH keyboard-interactive response failed: {error}")
                        })?;
                }
                PasswordKbiPromptAction::SendPassword | PasswordKbiPromptAction::PromptUser => {
                    if prompts.len() != 1 {
                        return Err(
                            "SSH keyboard-interactive requested multiple prompts, which is not supported in V1."
                                .to_string(),
                        );
                    }
                    let prompt = prompts
                        .into_iter()
                        .next()
                        .ok_or_else(|| "SSH keyboard-interactive prompt is empty".to_string())?;
                    return Ok(SshAuthOutcome::KeyboardInteractivePrompt(
                        KeyboardInteractivePromptData {
                            name,
                            instructions,
                            prompt: prompt.prompt,
                            echo: prompt.echo,
                            answer_mode: SshPromptAnswerMode::KeyboardInteractive,
                        },
                    ));
                }
            },
        }
    }
    Err("SSH keyboard-interactive exceeded maximum prompt rounds".to_string())
}

pub(crate) fn ssh_keyboard_interactive_message(
    prompt_data: &KeyboardInteractivePromptData,
) -> String {
    let mut parts = Vec::new();
    if !prompt_data.name.trim().is_empty() {
        parts.push(prompt_data.name.trim().to_string());
    }
    if !prompt_data.instructions.trim().is_empty() {
        parts.push(prompt_data.instructions.trim().to_string());
    }
    if !prompt_data.prompt.trim().is_empty() {
        parts.push(prompt_data.prompt.trim().to_string());
    }
    if parts.is_empty() {
        "SSH keyboard-interactive authentication requires input.".to_string()
    } else {
        parts.join("\n")
    }
}
