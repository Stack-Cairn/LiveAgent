//! Skills 根目录解析、路径回显与路径 / 名称清洗。

use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_SKILL_NAME_LENGTH: usize = 64;

pub fn app_storage_dir() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Failed to locate the user home directory".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create the application directory: {e}"))?;
    Ok(dir)
}

pub fn skills_root_dir() -> Result<PathBuf, String> {
    let dir = app_storage_dir()?.join("skills");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create the skills directory: {e}"))?;
    fs::canonicalize(&dir).map_err(|e| format!("Failed to resolve the skills directory: {e}"))
}

pub(crate) fn skill_root_display(root: &Path) -> String {
    let raw = root.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", stripped).replace('\\', "/");
        }
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.replace('\\', "/");
        }
    }
    raw.replace('\\', "/")
}

pub(crate) fn rel_to_root_str(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub(crate) fn ensure_within_skills_root_existing(
    root: &Path,
    target: &Path,
) -> Result<PathBuf, String> {
    let canon =
        fs::canonicalize(target).map_err(|e| format!("Failed to resolve the Skill file: {e}"))?;
    if !canon.starts_with(root) {
        return Err(format!(
            "Target Skill file is outside the skills root: {}",
            canon.display()
        ));
    }
    Ok(canon)
}

pub(crate) fn sanitize_skill_rel_path(input: &str) -> Result<PathBuf, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Skill path cannot be empty".to_string());
    }

    let path = Path::new(raw);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                return Err(format!("Skill path must be relative: {input}"));
            }
            Component::ParentDir => {
                return Err(format!("Skill path must not contain ..: {input}"));
            }
            Component::CurDir => {}
            Component::Normal(segment) => {
                let segment = segment.to_string_lossy();
                if segment.contains(':') || is_windows_reserved_path_component(&segment) {
                    return Err(format!("Invalid Skill path: {input}"));
                }
                out.push(segment.as_ref());
            }
        }
    }

    if out.as_os_str().is_empty() {
        return Err("Skill path cannot be empty".to_string());
    }

    Ok(out)
}

pub(crate) fn sanitize_skill_child_rel_path(input: &str) -> Result<PathBuf, String> {
    let rel = sanitize_skill_rel_path(input)?;
    if rel
        .components()
        .any(|component| matches!(component, Component::Normal(segment) if segment.to_string_lossy().starts_with('.')))
    {
        return Err(format!("Skill file path must not use hidden control directories: {input}"));
    }
    Ok(rel)
}

pub(crate) fn sanitize_skill_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("Skill name cannot be empty".to_string());
    }
    if name.len() > MAX_SKILL_NAME_LENGTH {
        return Err(format!(
            "Skill name '{name}' is too long; maximum is {MAX_SKILL_NAME_LENGTH}"
        ));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(format!(
            "Skill name '{name}' must use lowercase letters, digits, and hyphens only"
        ));
    }
    if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return Err(format!(
            "Skill name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
        ));
    }
    if is_windows_reserved_path_component(name) {
        return Err(format!("Skill name '{name}' is reserved on Windows"));
    }
    Ok(name.to_string())
}

pub(crate) fn is_windows_reserved_path_component(input: &str) -> bool {
    let stem = input
        .split('.')
        .next()
        .unwrap_or(input)
        .trim_matches(|ch| ch == ' ' || ch == '.')
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

pub(crate) fn normalize_skill_name(raw_name: &str) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in raw_name.trim().chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            out.push('-');
            previous_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

pub(crate) fn title_case_skill_name(skill_name: &str) -> String {
    skill_name
        .split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
