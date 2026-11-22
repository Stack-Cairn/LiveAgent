//! Diagnostics export: native facts, bounded log tails and the zip writer.
//!
//! The frontend builds and redacts the bundle; this module only adds what the
//! webview cannot see (OS facts, K-brain log tails) and writes the archive the
//! user previewed. Every text file is passed through a backstop redaction
//! before it is written, so a frontend bug cannot put a home path, bearer
//! token or well-known key format into the archive.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Upper bound for one log file tail.
const LOG_TAIL_BYTES: u64 = 1024 * 1024;
/// Upper bound for all native log tails together.
const LOG_BUDGET_BYTES: u64 = 3 * 1024 * 1024;
/// Newest goroutine dumps to include.
const MAX_STACK_FILES: usize = 2;
const MAX_STDERR_TAIL_BYTES: usize = 64 * 1024;
/// Limits for what the frontend may ask us to write.
const MAX_BUNDLE_FILES: usize = 64;
const MAX_BUNDLE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsLogFile {
    pub name: String,
    pub content: String,
    pub truncated: bool,
    pub original_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnostics {
    pub app_version: String,
    pub build_profile: String,
    pub os: String,
    pub os_version: Option<String>,
    pub arch: String,
    pub home_dir: Option<String>,
    pub data_root: Option<String>,
    pub log_files: Vec<DiagnosticsLogFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiagnosticsBundleFile {
    pub path: String,
    pub content: String,
}

/// Reads at most `max_bytes` from the end of `path`. A cut tail starts at the
/// next full line so no partial (possibly multi-byte) line leads the excerpt.
pub(crate) fn read_tail(path: &Path, max_bytes: u64) -> io::Result<(String, bool, u64)> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let truncated = length > max_bytes;
    let start = length.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity(length.min(max_bytes) as usize);
    file.take(max_bytes).read_to_end(&mut bytes)?;
    let mut slice = bytes.as_slice();
    if truncated {
        if let Some(newline) = slice.iter().position(|byte| *byte == b'\n') {
            slice = &slice[newline + 1..];
        }
    }
    Ok((String::from_utf8_lossy(slice).into_owned(), truncated, length))
}

fn log_candidates(root: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![root.join("k-brain.log"), root.join("k-brain.log.1")];
    let mut stacks: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("stacks-") && name.ends_with(".txt")) {
                return None;
            }
            let modified = entry.metadata().and_then(|meta| meta.modified()).ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    stacks.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    candidates.extend(stacks.into_iter().take(MAX_STACK_FILES).map(|(_, path)| path));
    candidates
}

/// Tails of the K-brain logs under `root`, newest first, within `budget` bytes.
pub(crate) fn collect_log_files(root: &Path, budget: u64) -> Vec<DiagnosticsLogFile> {
    let mut remaining = budget;
    let mut files = Vec::new();
    for path in log_candidates(root) {
        if remaining == 0 {
            break;
        }
        let Ok((content, truncated, original_bytes)) =
            read_tail(&path, LOG_TAIL_BYTES.min(remaining))
        else {
            continue;
        };
        remaining = remaining.saturating_sub(content.len() as u64);
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        files.push(DiagnosticsLogFile {
            name,
            content,
            truncated,
            original_bytes,
        });
    }
    files
}

/// Replaces every spelling of `home` (as written, with the other separator and
/// JSON-escaped) with `~`.
pub(crate) fn fold_home(text: &str, home: Option<&Path>) -> String {
    let Some(home) = home.map(|home| home.to_string_lossy().into_owned()) else {
        return text.to_string();
    };
    let home = home.trim_end_matches(['/', '\\']);
    if home.len() < 2 {
        return text.to_string();
    }
    let mut variants = vec![
        home.to_string(),
        home.replace('\\', "/"),
        home.replace('/', "\\"),
        home.replace('\\', "\\\\"),
    ];
    variants.sort_by_key(|variant| std::cmp::Reverse(variant.len()));
    variants.dedup();
    let mut folded = text.to_string();
    for variant in variants {
        folded = folded.replace(&variant, "~");
    }
    folded
}

fn backstop_patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
                "[REDACTED:private-key]",
            ),
            (r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", "$1 [REDACTED]"),
            (
                r#"(?i)\b(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|cookie)(["']?\s*[:=]\s*["']?)([^\s"',;\]\[]{4,})"#,
                "$1$2[REDACTED]",
            ),
            (r"\bsk-[A-Za-z0-9_-]{16,}", "[REDACTED:key]"),
            (r"\bgh[pousr]_[A-Za-z0-9]{20,}", "[REDACTED:key]"),
            (r"\bAKIA[0-9A-Z]{16}\b", "[REDACTED:key]"),
            (
                r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
                "[REDACTED:jwt]",
            ),
            (
                r"(?i)(?:/private)?/(?:Users|home)/[^/\s\x22']+",
                "~",
            ),
            (r"(?i)\b[A-Z]:\\Users\\[^\\\s\x22']+", "~"),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid pattern"), replacement))
        .collect()
    })
}

/// Last-resort scrub applied to every file before it is zipped.
pub(crate) fn backstop_redact(text: &str, home: Option<&Path>) -> String {
    let mut out = fold_home(text, home);
    for (pattern, replacement) in backstop_patterns() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// Accepts only plain relative paths such as `logs/k-brain.log`.
pub(crate) fn sanitize_entry_path(path: &str) -> Option<String> {
    if path.is_empty() || path.len() > 200 || path.contains('\\') {
        return None;
    }
    let candidate = Path::new(path);
    let mut parts = Vec::new();
    for component in candidate.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_str()?;
        if !part
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            || part.starts_with('.')
        {
            return None;
        }
        parts.push(part);
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn validate_bundle(files: &[DiagnosticsBundleFile]) -> Result<Vec<(String, &str)>, String> {
    if files.is_empty() || files.len() > MAX_BUNDLE_FILES {
        return Err("Diagnostics bundle has an invalid number of files".into());
    }
    let total: usize = files.iter().map(|file| file.content.len()).sum();
    if total > MAX_BUNDLE_BYTES {
        return Err("Diagnostics bundle is too large".into());
    }
    let mut seen = std::collections::HashSet::new();
    files
        .iter()
        .map(|file| {
            let path = sanitize_entry_path(&file.path)
                .ok_or_else(|| format!("Invalid diagnostics entry name: {}", file.path))?;
            if !seen.insert(path.clone()) {
                return Err(format!("Duplicate diagnostics entry: {path}"));
            }
            Ok((path, file.content.as_str()))
        })
        .collect()
}

/// Writes the zip next to `target` and renames it into place.
pub(crate) fn write_bundle_zip(
    target: &Path,
    files: &[DiagnosticsBundleFile],
    home: Option<&Path>,
) -> Result<(), String> {
    let entries = validate_bundle(files)?;
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Unable to create diagnostics file: {error}"))?;
    {
        let mut zip = ZipWriter::new(temp.as_file());
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for (path, content) in entries {
            zip.start_file(path.as_str(), options)
                .map_err(|error| format!("Unable to write {path}: {error}"))?;
            zip.write_all(backstop_redact(content, home).as_bytes())
                .map_err(|error| format!("Unable to write {path}: {error}"))?;
        }
        zip.finish()
            .map_err(|error| format!("Unable to finish diagnostics zip: {error}"))?;
    }
    temp.persist(target)
        .map_err(|error| format!("Unable to save diagnostics zip: {}", error.error))?;
    Ok(())
}

static STDERR_TAIL: OnceLock<std::sync::Mutex<StderrTail>> = OnceLock::new();

#[derive(Default)]
struct StderrTail {
    bytes: std::collections::VecDeque<u8>,
    token: String,
}

fn stderr_tail() -> &'static std::sync::Mutex<StderrTail> {
    STDERR_TAIL.get_or_init(Default::default)
}

type SharedStderrTail = std::sync::Mutex<StderrTail>;

fn reset_tail(tail: &SharedStderrTail, token: &str) {
    if let Ok(mut tail) = tail.lock() {
        tail.bytes.clear();
        tail.token = token.to_string();
    }
}

fn append_tail(tail: &SharedStderrTail, bytes: &[u8]) {
    if let Ok(mut tail) = tail.lock() {
        tail.bytes.extend(bytes.iter().copied());
        let overflow = tail.bytes.len().saturating_sub(MAX_STDERR_TAIL_BYTES);
        tail.bytes.drain(..overflow);
    }
}

fn read_stderr_tail(tail: &SharedStderrTail) -> Option<DiagnosticsLogFile> {
    let tail = tail.lock().ok()?;
    if tail.bytes.is_empty() {
        return None;
    }
    let (front, back) = tail.bytes.as_slices();
    let mut raw = Vec::with_capacity(tail.bytes.len());
    raw.extend_from_slice(front);
    raw.extend_from_slice(back);
    let mut content = String::from_utf8_lossy(&raw).into_owned();
    if !tail.token.is_empty() {
        content = content.replace(&tail.token, "<redacted>");
    }
    Some(DiagnosticsLogFile {
        name: "k-brain-stderr.log".into(),
        original_bytes: raw.len() as u64,
        truncated: raw.len() >= MAX_STDERR_TAIL_BYTES,
        content,
    })
}

/// Starts a fresh K-brain stderr tail; `token` is redacted when it is read.
pub(crate) fn reset_kbrain_stderr_tail(token: &str) {
    reset_tail(stderr_tail(), token);
}

/// Keeps the newest K-brain stderr output in memory for diagnostics.
pub(crate) fn append_kbrain_stderr(bytes: &[u8]) {
    append_tail(stderr_tail(), bytes);
}

fn kbrain_stderr_tail() -> Option<DiagnosticsLogFile> {
    read_stderr_tail(stderr_tail())
}

/// Same resolution as the backend launcher: env overrides, then the data root.
fn backend_root() -> Option<PathBuf> {
    ["LIVEAGENT_HOME", "K_BRAIN_HOME"]
        .into_iter()
        .find_map(|name| std::env::var_os(name).filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .or_else(crate::runtime::data_home::data_root)
}

fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return (!version.is_empty()).then_some(version);
    }
    #[cfg(target_os = "linux")]
    {
        let release = fs::read_to_string("/etc/os-release").ok()?;
        return release
            .lines()
            .find_map(|line| line.strip_prefix("PRETTY_NAME="))
            .map(|value| value.trim_matches('"').to_string());
    }
    #[allow(unreachable_code)]
    None
}

pub(crate) fn collect_native(home: Option<&Path>, root: Option<&Path>) -> NativeDiagnostics {
    let mut log_files = root
        .map(|root| collect_log_files(root, LOG_BUDGET_BYTES))
        .unwrap_or_default();
    log_files.extend(kbrain_stderr_tail());
    for file in &mut log_files {
        file.content = backstop_redact(&file.content, home);
    }
    NativeDiagnostics {
        app_version: env!("LIVEAGENT_APP_VERSION").to_string(),
        build_profile: if cfg!(debug_assertions) { "debug" } else { "release" }.into(),
        os: std::env::consts::OS.into(),
        os_version: os_version(),
        arch: std::env::consts::ARCH.into(),
        home_dir: home.map(|home| home.to_string_lossy().into_owned()),
        data_root: root.map(|root| fold_home(&root.to_string_lossy(), home)),
        log_files,
    }
}

fn sanitize_file_name(file_name: &str) -> String {
    let name: String = file_name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        .take(120)
        .collect();
    if name.ends_with(".zip") && name.len() > 4 {
        name
    } else {
        "liveagent-diagnostics.zip".into()
    }
}

#[tauri::command]
pub async fn diagnostics_collect_native() -> Result<NativeDiagnostics, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = crate::runtime::data_home::home_dir();
        let root = backend_root();
        collect_native(home.as_deref(), root.as_deref())
    })
    .await
    .map_err(|error| format!("diagnostics_collect_native join failed: {error}"))
}

/// Asks where to save, then writes the previewed files. `None` means cancelled.
#[tauri::command]
pub async fn diagnostics_save_bundle(
    file_name: String,
    files: Vec<DiagnosticsBundleFile>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_bundle(&files)?;
        let Some(target) = FileDialog::new()
            .set_file_name(sanitize_file_name(&file_name))
            .add_filter("Zip", &["zip"])
            .save_file()
        else {
            return Ok(None);
        };
        let home = crate::runtime::data_home::home_dir();
        write_bundle_zip(&target, &files, home.as_deref())?;
        Ok(Some(fold_home(&target.to_string_lossy(), home.as_deref())))
    })
    .await
    .map_err(|error| format!("diagnostics_save_bundle join failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, content: &str) -> DiagnosticsBundleFile {
        DiagnosticsBundleFile {
            path: path.into(),
            content: content.into(),
        }
    }

    #[test]
    fn zip_round_trip_keeps_entries_and_scrubs_content() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home").join("alice");
        let target = dir.path().join("out.zip");
        let files = vec![
            file("README.txt", "hello"),
            file(
                "logs/k-brain.log",
                &format!(
                    "opened {}/project/a.txt\nAuthorization: Bearer abcdefgh12345678\nkey sk-abcdefghijklmnopqrstu\n",
                    home.display()
                ),
            ),
        ];
        write_bundle_zip(&target, &files, Some(&home)).unwrap();

        let mut archive = zip::ZipArchive::new(File::open(&target).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect();
        assert_eq!(names, vec!["README.txt", "logs/k-brain.log"]);
        let mut log = String::new();
        archive
            .by_name("logs/k-brain.log")
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        assert!(log.contains("opened ~/project/a.txt"), "{log}");
        assert!(!log.contains("abcdefgh12345678"), "{log}");
        assert!(!log.contains("sk-abcdefghijklmnopqrstu"), "{log}");
        assert!(!log.contains("alice"), "{log}");
    }

    #[test]
    fn zip_rejects_unsafe_entry_names() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.zip");
        for bad in [
            "../escape.txt",
            "/abs.txt",
            "logs/../../x",
            "C:\\x.txt",
            ".hidden",
            "",
        ] {
            let result = write_bundle_zip(&target, &[file(bad, "x")], None);
            assert!(result.is_err(), "{bad} should be rejected");
        }
        assert!(!target.exists());
        let duplicate = write_bundle_zip(&target, &[file("a.txt", "1"), file("a.txt", "2")], None);
        assert!(duplicate.is_err());
    }

    #[test]
    fn tail_is_bounded_and_starts_on_a_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("k-brain.log");
        let mut body = String::new();
        for index in 0..5000 {
            body.push_str(&format!("line {index:05} ok\n"));
        }
        fs::write(&path, &body).unwrap();
        let (tail, truncated, original) = read_tail(&path, 1024).unwrap();
        assert!(truncated);
        assert_eq!(original, body.len() as u64);
        assert!(tail.len() <= 1024);
        assert!(tail.starts_with("line "), "{tail:?}");
        assert!(tail.ends_with("line 04999 ok\n"));

        let (whole, truncated, _) = read_tail(&path, 10 * 1024 * 1024).unwrap();
        assert!(!truncated);
        assert_eq!(whole, body);
    }

    #[test]
    fn log_collection_respects_the_total_budget() {
        let dir = tempfile::tempdir().unwrap();
        let big = "x".repeat(200) + "\n";
        fs::write(dir.path().join("k-brain.log"), big.repeat(2000)).unwrap();
        fs::write(dir.path().join("k-brain.log.1"), big.repeat(2000)).unwrap();
        fs::write(dir.path().join("stacks-1.txt"), "goroutine 1\n").unwrap();
        fs::write(dir.path().join("unrelated.txt"), "ignored").unwrap();
        let files = collect_log_files(dir.path(), 300 * 1024);
        let total: usize = files.iter().map(|file| file.content.len()).sum();
        assert!(total <= 300 * 1024, "total {total}");
        assert_eq!(files[0].name, "k-brain.log");
        assert!(files[0].truncated);
        assert!(files.iter().all(|file| file.name != "unrelated.txt"));

        let roomy = collect_log_files(dir.path(), LOG_BUDGET_BYTES);
        let names: Vec<&str> = roomy.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(names, vec!["k-brain.log", "k-brain.log.1", "stacks-1.txt"]);
    }

    #[test]
    fn home_paths_are_folded_in_every_spelling() {
        let home = Path::new("/Users/alice");
        assert_eq!(fold_home("/Users/alice/x", Some(home)), "~/x");
        assert_eq!(
            fold_home(r#"{"p":"C:\\Users\\bob\\x"}"#, Some(Path::new(r"C:\Users\bob"))),
            r#"{"p":"~\\x"}"#
        );
        assert_eq!(backstop_redact("/home/carol/.config", None), "~/.config");
        assert_eq!(backstop_redact(r"D:\Users\dave\repo", None), r"~\repo");
        assert_eq!(
            backstop_redact("/private/Users/erin/tmp", None),
            "~/tmp"
        );
        let collected = collect_native(Some(home), None);
        assert_eq!(collected.home_dir.as_deref(), Some("/Users/alice"));
    }

    #[test]
    fn backstop_keeps_already_redacted_and_harmless_text() {
        let text = r#"{"apiKeyConfigured": true, "maxTokens": 4096, "api_key": "[REDACTED]"}"#;
        assert_eq!(backstop_redact(text, None), text);
        assert_eq!(
            backstop_redact("password=hunter2hunter2", None),
            "password=[REDACTED]"
        );
    }

    #[test]
    fn stderr_tail_is_bounded_and_hides_the_token() {
        // A private tail: the global one is shared with running backend tests.
        let shared = SharedStderrTail::default();
        reset_tail(&shared, "tok-123456");
        append_tail(&shared, &vec![b'a'; MAX_STDERR_TAIL_BYTES]);
        append_tail(&shared, b"\nfailed with tok-123456\n");
        let tail = read_stderr_tail(&shared).unwrap();
        assert_eq!(tail.content.len(), MAX_STDERR_TAIL_BYTES);
        assert!(tail.truncated);
        assert!(tail.content.ends_with("failed with <redacted>\n"));
        reset_tail(&shared, "");
        assert!(read_stderr_tail(&shared).is_none());
    }

    #[test]
    fn file_names_are_sanitized() {
        assert_eq!(
            sanitize_file_name("liveagent-diagnostics-20261122-101500.zip"),
            "liveagent-diagnostics-20261122-101500.zip"
        );
        assert_eq!(sanitize_file_name("../../etc/passwd"), "liveagent-diagnostics.zip");
    }
}
