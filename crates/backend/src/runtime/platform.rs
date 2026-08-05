use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn expand_tilde_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            if trimmed == "~" {
                return home;
            }
            return home.join(&trimmed[2..]);
        }
    }
    PathBuf::from(trimmed)
}

/// `fs::canonicalize` returns `\\?\`-verbatim paths on Windows. Classic Win32
/// form is required for child-process cwd (cmd.exe / Windows PowerShell
/// mishandle verbatim) and for user-facing workdir strings. No-op elsewhere.
pub(crate) fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{stripped}"));
        }
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped.to_string());
        }
    }
    path
}

pub fn maybe_augment_macos_path(command: &mut Command) {
    if !cfg!(target_os = "macos") {
        return;
    }

    let mut extra: Vec<String> = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    if let Some(home) = dirs::home_dir() {
        extra.push(home.join(".local/bin").to_string_lossy().into_owned());
    }

    let current = env::var("PATH").unwrap_or_default();
    let mut current_parts: Vec<String> = current
        .split(':')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();

    let mut out: Vec<String> = Vec::new();
    for p in extra.drain(..) {
        if current_parts.iter().any(|existing| existing == &p) {
            continue;
        }
        out.push(p);
    }
    out.append(&mut current_parts);

    command.env("PATH", out.join(":"));
}

pub(crate) fn shell_basename(shell: &str) -> String {
    Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell)
        .to_string()
}

pub fn resolve_program_path_with_current_dir(raw: &str, _current_dir: Option<&Path>) -> PathBuf {
    let expanded = expand_tilde_path(raw);

    #[cfg(windows)]
    {
        resolve_windows_program_path(raw, &expanded, _current_dir).unwrap_or(expanded)
    }

    #[cfg(not(windows))]
    {
        expanded
    }
}

#[cfg(windows)]
fn resolve_windows_program_path(
    raw: &str,
    expanded: &Path,
    current_dir: Option<&Path>,
) -> Option<PathBuf> {
    if expanded.is_absolute() || raw.contains('\\') || raw.contains('/') {
        let candidate = if expanded.is_absolute() {
            expanded.to_path_buf()
        } else if let Some(current_dir) = current_dir {
            current_dir.join(expanded)
        } else {
            expanded.to_path_buf()
        };
        return resolve_windows_path_candidate(&candidate);
    }

    if let Some(current_dir) = current_dir {
        for candidate in windows_program_names(raw) {
            let path = current_dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }

    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        for candidate in windows_program_names(raw) {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(windows)]
fn resolve_windows_path_candidate(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    if path.extension().is_some() {
        return None;
    }

    for ext in windows_path_extensions() {
        let candidate = path.with_extension(ext.trim_start_matches('.'));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn windows_program_names(raw: &str) -> Vec<String> {
    if Path::new(raw).extension().is_some() {
        return vec![raw.to_string()];
    }
    windows_path_extensions()
        .into_iter()
        .map(|ext| format!("{raw}{ext}"))
        .collect()
}

#[cfg(windows)]
fn windows_path_extensions() -> Vec<String> {
    let raw = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut out: Vec<String> = raw
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.starts_with('.') {
                value.to_string()
            } else {
                format!(".{value}")
            }
        })
        .collect();
    if out.is_empty() {
        out.extend([".COM", ".EXE", ".BAT", ".CMD"].map(String::from));
    }
    out
}
