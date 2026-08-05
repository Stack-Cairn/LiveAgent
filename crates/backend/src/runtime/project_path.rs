use std::path::Path;

pub fn project_path_key(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if is_windows_project_path_like(trimmed) {
        normalize_windows_project_path_key(trimmed)
    } else {
        normalize_posix_project_path_key(trimmed)
    }
}

pub fn project_path_keys_equal(left: &str, right: &str) -> bool {
    project_path_key(left) == project_path_key(right)
}

fn is_windows_project_path_like(value: &str) -> bool {
    has_windows_extended_prefix(value)
        || has_windows_drive_prefix(value)
        || has_windows_unc_prefix(value)
}

fn normalize_windows_project_path_key(value: &str) -> String {
    let stripped = strip_windows_extended_prefix(value);
    let normalized = stripped.replace('\\', "/");
    trim_trailing_windows_project_slashes(&normalized).to_lowercase()
}

fn normalize_posix_project_path_key(value: &str) -> String {
    let mut next = value.to_string();
    while next.len() > 1 && next.ends_with('/') {
        next.pop();
    }
    next
}

fn strip_windows_extended_prefix(value: &str) -> String {
    if has_windows_extended_unc_prefix(value) {
        return format!("//{}", &value[8..]);
    }
    if has_windows_extended_prefix(value) {
        return value[4..].to_string();
    }
    value.to_string()
}

fn trim_trailing_windows_project_slashes(value: &str) -> String {
    let min_len = windows_project_root_len(value);
    let mut next = value.to_string();
    while next.len() > min_len && next.ends_with('/') {
        next.pop();
    }
    next
}

fn windows_project_root_len(value: &str) -> usize {
    let bytes = value.as_bytes();
    if bytes.len() >= 3 && is_ascii_alpha(bytes[0]) && bytes[1] == b':' && bytes[2] == b'/' {
        return 3;
    }
    if let Some(rest) = value.strip_prefix("//") {
        let mut parts = rest.split('/');
        let Some(server) = parts.next().filter(|part| !part.is_empty()) else {
            return 2;
        };
        let Some(share) = parts.next().filter(|part| !part.is_empty()) else {
            return 2;
        };
        return 2 + server.len() + 1 + share.len();
    }
    1
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2
        && is_ascii_alpha(bytes[0])
        && bytes[1] == b':'
        && (bytes.len() == 2 || is_path_separator(bytes[2]))
}

fn has_windows_unc_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 2 || !is_path_separator(bytes[0]) || !is_path_separator(bytes[1]) {
        return false;
    }
    let rest = &value[2..];
    let mut parts = rest.split(['\\', '/']);
    let Some(server) = parts.next().filter(|part| !part.is_empty()) else {
        return false;
    };
    let Some(share) = parts.next().filter(|part| !part.is_empty()) else {
        return false;
    };
    !server.is_empty() && !share.is_empty()
}

fn has_windows_extended_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 4
        && is_path_separator(bytes[0])
        && is_path_separator(bytes[1])
        && bytes[2] == b'?'
        && is_path_separator(bytes[3])
}

fn has_windows_extended_unc_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 8
        && is_path_separator(bytes[0])
        && is_path_separator(bytes[1])
        && bytes[2] == b'?'
        && is_path_separator(bytes[3])
        && bytes[4].eq_ignore_ascii_case(&b'U')
        && bytes[5].eq_ignore_ascii_case(&b'N')
        && bytes[6].eq_ignore_ascii_case(&b'C')
        && is_path_separator(bytes[7])
}

fn is_path_separator(value: u8) -> bool {
    value == b'\\' || value == b'/'
}

fn is_ascii_alpha(value: u8) -> bool {
    value.is_ascii_alphabetic()
}

/// Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）。跨平台都要挡：
/// 在 macOS 上建出 `COM1` 目录，同步到 Windows 客户端时就打不开了。
fn is_windows_reserved_project_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem[3..]
                .parse::<u8>()
                .is_ok_and(|value| (1..=9).contains(&value)))
}

pub fn validate_project_folder_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("项目名不能为空".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("项目名不能是 . 或 ..".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains(':') {
        return Err("项目名不能包含路径分隔符".to_string());
    }
    if trimmed
        .chars()
        .any(|ch| ch == '\0' || ch.is_ascii_control())
    {
        return Err("项目名包含非法字符".to_string());
    }
    if Path::new(trimmed).components().count() != 1 {
        return Err("项目名不能包含路径片段".to_string());
    }
    if is_windows_reserved_project_name(trimmed) {
        return Err("项目名不能使用系统保留名称".to_string());
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::{project_path_key, project_path_keys_equal};

    #[test]
    fn project_path_key_normalizes_windows_drive_paths() {
        assert_eq!(project_path_key(r" C:\Users\Me\Repo\ "), "c:/users/me/repo");
        assert_eq!(project_path_key("c:/USERS/me/REPO"), "c:/users/me/repo");
        assert_eq!(project_path_key(r"C:\"), "c:/");
    }

    #[test]
    fn project_path_key_normalizes_windows_unc_paths() {
        assert_eq!(
            project_path_key(r"\\Server\Share\Repo\"),
            "//server/share/repo"
        );
        assert_eq!(project_path_key(r"\\Server\Share\"), "//server/share");
    }

    #[test]
    fn project_path_key_strips_windows_extended_prefixes() {
        assert_eq!(
            project_path_key(r"\\?\C:\Users\Me\Repo\"),
            "c:/users/me/repo"
        );
        assert_eq!(
            project_path_key(r"\\?\UNC\Server\Share\Repo\"),
            "//server/share/repo"
        );
    }

    #[test]
    fn project_path_key_preserves_posix_case_and_backslashes() {
        assert_eq!(project_path_key(" /Users/A/App/ "), "/Users/A/App");
        assert_eq!(project_path_key("/tmp/Foo"), "/tmp/Foo");
        assert_eq!(project_path_key(r"/tmp/Foo\"), r"/tmp/Foo\");
        assert!(!project_path_keys_equal("/tmp/Foo", "/tmp/foo"));
    }

    #[test]
    fn project_path_keys_equal_compares_normalized_windows_shapes() {
        assert!(project_path_keys_equal(r"C:\Repo", "c:/repo/"));
        assert!(project_path_keys_equal(
            r"\\?\UNC\Server\Share\Repo",
            r"\\server\share\repo\"
        ));
    }
}
