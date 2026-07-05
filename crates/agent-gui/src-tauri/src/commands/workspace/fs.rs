use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use lopdf::Document as PdfDocument;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Cursor, Read, Seek};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use std::time::UNIX_EPOCH;
use thiserror::Error;
use zip::ZipArchive;

use crate::runtime::platform::expand_tilde_path;

const READ_MAX_TEXT_BYTES: usize = 200 * 1024; // 200KB
const EDITABLE_TEXT_MAX_BYTES: usize = 3 * 1024 * 1024; // 3MB
const READ_MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024; // 25MB
const READ_MAX_PREVIEW_BYTES: usize = 25 * 1024 * 1024; // 25MB
const DOCUMENT_PREVIEW_CACHE_VERSION: &str = "v1";
const IMAGE_SOURCE_HTTP_TIMEOUT_SECS: u64 = 20;
const DEFAULT_READ_LIMIT_LINES: usize = 200;
const DEFAULT_READ_LIMIT_PDF_PAGES: usize = 5;
const DEFAULT_READ_LIMIT_NOTEBOOK_CELLS: usize = 20;
const DEFAULT_ARCHIVE_ENTRY_LIMIT: usize = 200;
const MAX_ZIP_XML_ENTRY_BYTES: usize = 4 * 1024 * 1024;

const DEFAULT_LIST_DEPTH: usize = 2;
const DEFAULT_PAGE_LIMIT: usize = 200;
const DEFAULT_LIST_DIRS_MAX_RESULTS: usize = 2000;
const HARD_LIST_DIRS_MAX_RESULTS: usize = 10000;

const DEFAULT_GREP_HEAD_LIMIT: usize = 200;
const MAX_GREP_LINE_CHARS: usize = 400;

async fn run_blocking<R: Send + 'static>(
    label: &'static str,
    f: impl FnOnce() -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("{label} join failed: {e}"))?
}

#[derive(Debug, Error)]
enum FsError {
    #[error("workdir must be an existing absolute directory: {0}")]
    InvalidWorkdir(String),

    #[error(
        "resolved path segment must not contain .., drive letters, or an absolute root path: {0}"
    )]
    InvalidRelPath(String),

    #[error("Target path is outside the resolved directory: {0}")]
    OutOfBounds(String),

    #[error("{path} does not exist")]
    NotFound { path: String, did_you_mean: Vec<String> },

    #[error("{path} is not a directory")]
    NotADirectory { path: String, entry_kind: String },

    #[error("{path} is not a regular file")]
    NotAFile { path: String, entry_kind: String },

    #[error("{message}")]
    UnsupportedTarget { path: String, message: String },

    #[error("{path} requires a full-file Read first")]
    RequiresFullRead { path: String },

    #[error("{message}")]
    StaleFile { path: String, message: String },

    #[error("old_string was not found in {path}")]
    EditNoMatch { path: String },

    #[error("old_string matched {matches} locations in {path}")]
    EditAmbiguous { path: String, matches: usize },

    #[error("expected {expected} replacements but found {actual} in {path}")]
    EditCountMismatch {
        path: String,
        expected: usize,
        actual: usize,
    },

    #[error("{message}")]
    TooLarge { path: String, message: String },

    #[error("{path} is not valid UTF-8 text")]
    NotUtf8 { path: String },

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("Regular expression error: {0}")]
    Regex(String),

    #[error("Glob pattern error: {0}")]
    Glob(String),

    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FsErrorCode {
    InvalidWorkdir,
    InvalidPath,
    OutOfBounds,
    NotFound,
    NotADirectory,
    NotAFile,
    UnsupportedTarget,
    RequiresFullRead,
    StaleFile,
    EditNoMatch,
    EditAmbiguous,
    EditCountMismatch,
    TooLarge,
    NotUtf8,
    RegexInvalid,
    GlobInvalid,
    Io,
    Other,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCommandError {
    pub code: FsErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_kind: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub did_you_mean: Vec<String>,
}

impl FsCommandError {
    fn other(message: impl Into<String>) -> Self {
        Self {
            code: FsErrorCode::Other,
            message: message.into(),
            path: None,
            workdir: None,
            entry_kind: None,
            did_you_mean: Vec::new(),
        }
    }

    fn with_workdir(mut self, workdir: &Path) -> Self {
        self.workdir = Some(display_path(workdir));
        self
    }
}

impl From<FsError> for FsCommandError {
    fn from(err: FsError) -> Self {
        let message = err.to_string();
        let (code, path, entry_kind, did_you_mean) = match err {
            FsError::InvalidWorkdir(_) => (FsErrorCode::InvalidWorkdir, None, None, Vec::new()),
            FsError::InvalidRelPath(path) => (FsErrorCode::InvalidPath, Some(path), None, Vec::new()),
            FsError::OutOfBounds(path) => (FsErrorCode::OutOfBounds, Some(path), None, Vec::new()),
            FsError::NotFound { path, did_you_mean } => {
                (FsErrorCode::NotFound, Some(path), None, did_you_mean)
            }
            FsError::NotADirectory { path, entry_kind } => {
                (FsErrorCode::NotADirectory, Some(path), Some(entry_kind), Vec::new())
            }
            FsError::NotAFile { path, entry_kind } => {
                (FsErrorCode::NotAFile, Some(path), Some(entry_kind), Vec::new())
            }
            FsError::UnsupportedTarget { path, .. } => {
                (FsErrorCode::UnsupportedTarget, Some(path), None, Vec::new())
            }
            FsError::RequiresFullRead { path } => {
                (FsErrorCode::RequiresFullRead, Some(path), None, Vec::new())
            }
            FsError::StaleFile { path, .. } => (FsErrorCode::StaleFile, Some(path), None, Vec::new()),
            FsError::EditNoMatch { path } => (FsErrorCode::EditNoMatch, Some(path), None, Vec::new()),
            FsError::EditAmbiguous { path, .. } => {
                (FsErrorCode::EditAmbiguous, Some(path), None, Vec::new())
            }
            FsError::EditCountMismatch { path, .. } => {
                (FsErrorCode::EditCountMismatch, Some(path), None, Vec::new())
            }
            FsError::TooLarge { path, .. } => (FsErrorCode::TooLarge, Some(path), None, Vec::new()),
            FsError::NotUtf8 { path } => (FsErrorCode::NotUtf8, Some(path), None, Vec::new()),
            FsError::Io(err) if err.kind() == io::ErrorKind::NotFound => {
                (FsErrorCode::NotFound, None, None, Vec::new())
            }
            FsError::Io(_) => (FsErrorCode::Io, None, None, Vec::new()),
            FsError::Regex(_) => (FsErrorCode::RegexInvalid, None, None, Vec::new()),
            FsError::Glob(_) => (FsErrorCode::GlobInvalid, None, None, Vec::new()),
            FsError::Other(_) => (FsErrorCode::Other, None, None, Vec::new()),
        };
        Self {
            code,
            message,
            path,
            workdir: None,
            entry_kind,
            did_you_mean,
        }
    }
}

async fn run_blocking_fs<R: Send + 'static>(
    label: &'static str,
    f: impl FnOnce() -> Result<R, FsCommandError> + Send + 'static,
) -> Result<R, FsCommandError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| FsCommandError::other(format!("{label} join failed: {e}")))?
}

#[cfg(unix)]
fn file_identity(meta: &fs::Metadata, _canon: &Path) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", meta.dev(), meta.ino())
}

#[cfg(windows)]
fn file_identity(_meta: &fs::Metadata, canon: &Path) -> String {
    // std's volume_serial_number()/file_index() are unstable (windows_by_handle,
    // rust-lang/rust#63010); query GetFileInformationByHandle directly instead.
    fn identity_by_handle(path: &Path) -> Option<String> {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        };

        // access_mode(0): metadata-only handle, no read permission required.
        // FILE_FLAG_BACKUP_SEMANTICS is required to open directories.
        let file = fs::OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .ok()?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return None;
        }
        let volume = info.dwVolumeSerialNumber;
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        Some(format!("{volume}:{index}"))
    }
    identity_by_handle(canon)
        .unwrap_or_else(|| format!("path:{}", display_path(canon).to_lowercase()))
}

fn levenshtein_at_most(a: &str, b: &str, max: usize) -> bool {
    let a: Vec<char> = a.chars().take(64).collect();
    let b: Vec<char> = b.chars().take(64).collect();
    if a.len().abs_diff(b.len()) > max {
        return false;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = Vec::with_capacity(b.len() + 1);
        cur.push(i + 1);
        let mut row_min = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            let value = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
            row_min = row_min.min(value);
            cur.push(value);
        }
        if row_min > max {
            return false;
        }
        prev = cur;
    }
    prev[b.len()] <= max
}

fn nearest_entries(parent: &Path, missing_name: &str, limit: usize) -> Vec<String> {
    let needle = missing_name.to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut ranked: Vec<(u8, String)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let rank = if lower == needle {
            0
        } else if lower.starts_with(&needle) || needle.starts_with(&lower) || lower.contains(&needle)
        {
            1
        } else if levenshtein_at_most(&lower, &needle, 2) {
            2
        } else {
            continue;
        };
        ranked.push((rank, name));
    }
    ranked.sort();
    ranked.into_iter().take(limit).map(|(_, name)| name).collect()
}

fn not_found_error(workdir: &Path, rel: &Path) -> FsError {
    let mut existing = workdir.to_path_buf();
    let mut existing_rel = PathBuf::new();
    let mut missing: Option<String> = None;
    for component in rel.components() {
        let name = component.as_os_str().to_string_lossy().to_string();
        let candidate = existing.join(&name);
        if candidate.exists() {
            existing = candidate;
            existing_rel.push(&name);
        } else {
            missing = Some(name);
            break;
        }
    }
    let did_you_mean = missing
        .as_deref()
        .map(|name| {
            nearest_entries(&existing, name, 5)
                .into_iter()
                .map(|candidate| logical_rel_path(&existing_rel.join(candidate)))
                .collect()
        })
        .unwrap_or_default();
    FsError::NotFound {
        path: logical_rel_path(rel),
        did_you_mean,
    }
}

fn resolve_target(workdir: &Path, rel: &Path) -> Result<PathBuf, FsError> {
    let target = workdir.join(rel);
    match fs::canonicalize(&target) {
        Ok(canon) => {
            if !canon.starts_with(workdir) {
                return Err(FsError::OutOfBounds(canon.display().to_string()));
            }
            Ok(canon)
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Err(not_found_error(workdir, rel)),
        Err(err) => Err(FsError::Io(err)),
    }
}

fn canonicalize_workdir(workdir: &str) -> Result<PathBuf, FsError> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err(FsError::InvalidWorkdir(workdir.to_string()));
    }

    let p = expand_tilde_path(raw);
    if !p.is_absolute() {
        return Err(FsError::InvalidWorkdir(workdir.to_string()));
    }

    let md = fs::metadata(&p).map_err(|_| FsError::InvalidWorkdir(workdir.to_string()))?;
    if !md.is_dir() {
        return Err(FsError::InvalidWorkdir(workdir.to_string()));
    }

    Ok(fs::canonicalize(&p)?)
}

fn normalize_rel_path_input(input: &str) -> String {
    input.trim().replace('\\', "/")
}

fn sanitize_rel_path_core(input: &str) -> Result<Option<PathBuf>, FsError> {
    let normalized = normalize_rel_path_input(input);
    if normalized.is_empty() {
        return Err(FsError::InvalidRelPath(input.to_string()));
    }

    let p = Path::new(&normalized);
    let mut out = PathBuf::new();

    for c in p.components() {
        match c {
            Component::Prefix(_) | Component::RootDir => {
                return Err(FsError::InvalidRelPath(input.to_string()));
            }
            Component::ParentDir => return Err(FsError::InvalidRelPath(input.to_string())),
            Component::CurDir => {}
            Component::Normal(seg) => {
                let segment = seg.to_string_lossy();
                if segment.contains(':') || is_platform_reserved_rel_path_component(&segment) {
                    return Err(FsError::InvalidRelPath(input.to_string()));
                }
                out.push(seg);
            }
        }
    }

    if out.as_os_str().is_empty() {
        return Ok(None);
    }

    Ok(Some(out))
}

fn is_platform_reserved_rel_path_component(input: &str) -> bool {
    #[cfg(windows)]
    {
        return is_windows_reserved_path_component(input);
    }
    #[cfg(not(windows))]
    {
        let _ = input;
        false
    }
}

#[cfg(any(windows, test))]
fn is_windows_reserved_path_component(input: &str) -> bool {
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

fn sanitize_rel_path(input: &str) -> Result<PathBuf, FsError> {
    sanitize_rel_path_core(input)?.ok_or_else(|| FsError::InvalidRelPath(input.to_string()))
}

fn sanitize_optional_rel_path(input: Option<String>) -> Result<Option<PathBuf>, FsError> {
    match input {
        None => Ok(None),
        Some(s) => {
            if s.trim().is_empty() {
                return Ok(None);
            }
            sanitize_rel_path_core(&s)
        }
    }
}

fn ensure_within_workdir_existing(workdir: &Path, target: &Path) -> Result<PathBuf, FsError> {
    let canon = fs::canonicalize(target)?;
    if !canon.starts_with(workdir) {
        return Err(FsError::OutOfBounds(canon.display().to_string()));
    }
    Ok(canon)
}

fn rel_to_workdir_str(workdir: &Path, abs: &Path) -> String {
    abs.strip_prefix(workdir)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

fn normalize_glob_pattern_input(input: &str) -> String {
    input.trim().replace('\\', "/")
}

fn build_globset_from_pipe_patterns(patterns: &str) -> Result<GlobSet, FsError> {
    let parts: Vec<&str> = patterns
        .split('|')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    if parts.is_empty() {
        return Err(FsError::Glob("file_pattern cannot be empty".to_string()));
    }

    let mut builder = GlobSetBuilder::new();
    for p in parts {
        let normalized = normalize_glob_pattern_input(p);
        let g = Glob::new(&normalized).map_err(|e| FsError::Glob(e.to_string()))?;
        builder.add(g);
    }

    builder.build().map_err(|e| FsError::Glob(e.to_string()))
}

fn metadata_mtime_ms(md: &fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn logical_rel_path(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

fn display_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    if let Some(rest) = normalized.strip_prefix("//?/") {
        return rest.to_string();
    }
    normalized
}

fn resolve_existing_file_target(workdir: &Path, rel: &Path) -> Result<PathBuf, FsError> {
    let resolved = resolve_target(workdir, rel)?;
    let md = fs::metadata(&resolved)?;
    if !md.is_file() {
        let entry_kind = if md.is_dir() { "dir" } else { "other" };
        return Err(FsError::NotAFile {
            path: logical_rel_path(rel),
            entry_kind: entry_kind.to_string(),
        });
    }
    Ok(resolved)
}

fn ensure_parent_dir(workdir: &Path, target: &Path) -> Result<(), FsError> {
    let parent = target
        .parent()
        .ok_or_else(|| FsError::Other("Invalid target path".to_string()))?;
    fs::create_dir_all(parent)?;
    ensure_within_workdir_existing(workdir, parent)?;
    Ok(())
}

fn split_text_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split_inclusive('\n').collect()
    }
}

fn count_text_lines(text: &str) -> usize {
    split_text_lines(text).len()
}

fn build_numbered_text_window(
    text: &str,
    requested_start_line: usize,
    requested_limit: usize,
) -> (String, usize, usize, usize, bool, bool) {
    let lines = split_text_lines(text);
    let total_lines = lines.len();
    let start_line = requested_start_line.max(1);
    let limit = requested_limit.max(1);

    if total_lines == 0 {
        return (String::new(), start_line, 0, 0, false, false);
    }

    let start_idx = start_line.saturating_sub(1);
    let mut out = String::new();
    let mut num_lines = 0usize;
    let mut truncated = false;

    for (idx, line) in lines.iter().enumerate().skip(start_idx) {
        if num_lines >= limit {
            truncated = true;
            break;
        }

        let numbered = format!("{:>6}\t{}", idx + 1, line);
        if out.len().saturating_add(numbered.len()) > READ_MAX_TEXT_BYTES {
            truncated = true;
            break;
        }

        out.push_str(&numbered);
        num_lines += 1;
    }

    if start_idx.saturating_add(num_lines) < total_lines {
        truncated = true;
    }

    let is_partial_view = start_line > 1 || num_lines < total_lines;
    (
        out,
        start_line,
        num_lines,
        total_lines,
        truncated,
        is_partial_view,
    )
}

fn infer_image_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("avif") => Some("image/avif"),
        Some("bmp") => Some("image/bmp"),
        Some("svg") => Some("image/svg+xml"),
        Some("ico") => Some("image/x-icon"),
        _ => None,
    }
}

fn normalize_supported_image_mime(value: &str) -> Option<String> {
    let mime = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/png" => Some("image/png".to_string()),
        "image/jpeg" | "image/jpg" => Some("image/jpeg".to_string()),
        "image/gif" => Some("image/gif".to_string()),
        "image/webp" => Some("image/webp".to_string()),
        "image/avif" => Some("image/avif".to_string()),
        "image/bmp" => Some("image/bmp".to_string()),
        "image/svg+xml" => Some("image/svg+xml".to_string()),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("image/x-icon".to_string()),
        _ => None,
    }
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let prefix_len = bytes.len().min(1024);
    let prefix = String::from_utf8_lossy(&bytes[..prefix_len]);
    let trimmed = prefix.trim_start_matches('\u{feff}').trim_start();
    trimmed.starts_with("<svg") || trimmed.contains("<svg")
}

fn infer_image_mime_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && bytes[8..].windows(4).any(|w| w == b"avif") {
        return Some("image/avif");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    if looks_like_svg(bytes) {
        return Some("image/svg+xml");
    }
    None
}

fn validate_image_size(label: &str, len: usize) -> Result<(), FsError> {
    if len > READ_MAX_IMAGE_BYTES {
        return Err(FsError::TooLarge {
            path: label.to_string(),
            message: format!("Image is too large to read via tool ({label})"),
        });
    }
    Ok(())
}

fn resolve_supported_image_mime(
    label: &str,
    provided_mime: Option<&str>,
    path_hint: Option<&Path>,
    bytes: &[u8],
) -> Result<String, FsError> {
    if let Some(mime) = provided_mime.and_then(normalize_supported_image_mime) {
        return Ok(mime);
    }
    if let Some(mime) = path_hint.and_then(infer_image_mime) {
        return Ok(mime.to_string());
    }
    if let Some(mime) = infer_image_mime_from_bytes(bytes) {
        return Ok(mime.to_string());
    }
    Err(FsError::UnsupportedTarget {
        path: label.to_string(),
        message: format!("{label} is not a supported image file"),
    })
}

fn build_image_read_response(
    label: String,
    bytes: Vec<u8>,
    mime_type: String,
    mtime_ms: u64,
    file_id: Option<String>,
) -> ReadResponse {
    let size_bytes = bytes.len();
    let content_hash = hash_bytes(&bytes);
    ReadResponse {
        kind: "image".to_string(),
        path: label,
        content: None,
        truncated: None,
        start_line: None,
        num_lines: None,
        total_lines: None,
        is_partial_view: None,
        page_start: None,
        num_pages: None,
        total_pages: None,
        cell_start: None,
        num_cells: None,
        total_cells: None,
        mtime_ms,
        content_hash,
        mime_type: Some(mime_type),
        data: Some(BASE64_STANDARD.encode(bytes)),
        size_bytes: Some(size_bytes),
        file_id,
    }
}

fn is_pdf_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("pdf")),
        Some(true)
    )
}

fn is_notebook_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("ipynb")),
        Some(true)
    )
}

fn file_name_lower(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

fn is_word_file(path: &Path) -> bool {
    matches!(
        extension_lower(path).as_deref(),
        Some("docx") | Some("doc") | Some("rtf")
    )
}

fn is_word_extractable_file(path: &Path) -> bool {
    matches!(extension_lower(path).as_deref(), Some("docx"))
}

fn is_convertible_document_preview_file(path: &Path) -> bool {
    matches!(extension_lower(path).as_deref(), Some("doc") | Some("rtf"))
}

fn is_spreadsheet_file(path: &Path) -> bool {
    matches!(
        extension_lower(path).as_deref(),
        Some("xlsx") | Some("xlsm") | Some("xltx") | Some("xltm") | Some("xls")
    )
}

fn is_xlsx_extractable_file(path: &Path) -> bool {
    matches!(
        extension_lower(path).as_deref(),
        Some("xlsx") | Some("xlsm") | Some("xltx") | Some("xltm")
    )
}

fn is_archive_file(path: &Path) -> bool {
    let name = file_name_lower(path);
    matches!(
        extension_lower(path).as_deref(),
        Some("zip")
            | Some("rar")
            | Some("7z")
            | Some("tar")
            | Some("gz")
            | Some("tgz")
            | Some("bz2")
            | Some("xz")
            | Some("txz")
            | Some("tbz")
            | Some("tbz2")
    ) || name.ends_with(".tar.gz")
        || name.ends_with(".tar.bz2")
        || name.ends_with(".tar.xz")
}

fn is_zip_archive_file(path: &Path) -> bool {
    matches!(extension_lower(path).as_deref(), Some("zip"))
}

fn editable_text_unsupported_reason(path: &Path) -> Option<&'static str> {
    if infer_image_mime(path).is_some() {
        return Some("Image files are not supported in the code editor");
    }
    if is_pdf_file(path) {
        return Some("PDF files are not supported in the code editor");
    }
    if is_notebook_file(path) {
        return Some("Notebook files are not supported in the code editor");
    }
    if is_word_file(path) || is_spreadsheet_file(path) {
        return Some("Office documents are not supported in the code editor");
    }
    if is_archive_file(path) {
        return Some("Archive files are not supported in the code editor");
    }
    None
}

fn office_mime_type(path: &Path) -> Option<&'static str> {
    match extension_lower(path).as_deref() {
        Some("docx") => {
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        }
        Some("doc") => Some("application/msword"),
        Some("rtf") => Some("application/rtf"),
        Some("xlsx") | Some("xltx") => {
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        }
        Some("xlsm") | Some("xltm") => Some("application/vnd.ms-excel.sheet.macroEnabled.12"),
        Some("xls") => Some("application/vnd.ms-excel"),
        Some("ods") => Some("application/vnd.oasis.opendocument.spreadsheet"),
        Some("zip") => Some("application/zip"),
        Some("rar") => Some("application/vnd.rar"),
        Some("7z") => Some("application/x-7z-compressed"),
        Some("tar") => Some("application/x-tar"),
        Some("gz") | Some("tgz") => Some("application/gzip"),
        Some("bz2") | Some("tbz") | Some("tbz2") => Some("application/x-bzip2"),
        Some("xz") | Some("txz") => Some("application/x-xz"),
        _ => None,
    }
}

fn infer_workspace_preview_mime(path: &Path, bytes: &[u8]) -> Option<&'static str> {
    if let Some(mime_type) = infer_image_mime(path).or_else(|| infer_image_mime_from_bytes(bytes)) {
        return Some(mime_type);
    }

    if is_pdf_file(path) || bytes.starts_with(b"%PDF-") {
        return Some("application/pdf");
    }

    match extension_lower(path).as_deref() {
        Some("html") | Some("htm") => Some("text/html"),
        Some("md") | Some("mdx") => Some("text/markdown"),
        Some("txt") | Some("log") => Some("text/plain"),
        Some("csv") => Some("text/csv"),
        Some("tsv") => Some("text/tab-separated-values"),
        Some("docx") => {
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        }
        Some("doc") => Some("application/msword"),
        Some("rtf") => Some("application/rtf"),
        Some("xlsx") | Some("xltx") => {
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        }
        Some("xlsm") | Some("xltm") => Some("application/vnd.ms-excel.sheet.macroEnabled.12"),
        Some("xls") => Some("application/vnd.ms-excel"),
        Some("ods") => Some("application/vnd.oasis.opendocument.spreadsheet"),
        Some("mp3") => Some("audio/mpeg"),
        Some("wav") => Some("audio/wav"),
        Some("ogg") | Some("oga") => Some("audio/ogg"),
        Some("flac") => Some("audio/flac"),
        Some("m4a") => Some("audio/mp4"),
        Some("mp4") | Some("m4v") => Some("video/mp4"),
        Some("webm") => Some("video/webm"),
        Some("ogv") => Some("video/ogg"),
        Some("mov") => Some("video/quicktime"),
        _ => None,
    }
}

fn truncate_process_error(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).trim().to_string();
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(400).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        text
    }
}

#[cfg(target_os = "macos")]
fn convert_document_to_html_preview(target: &Path) -> Result<Vec<u8>, String> {
    let output = Command::new("/usr/bin/textutil")
        .arg("-convert")
        .arg("html")
        .arg("-stdout")
        .arg("-encoding")
        .arg("UTF-8")
        .arg("--")
        .arg(target)
        .output()
        .map_err(|e| format!("Failed to start textutil for document preview: {e}"))?;

    if !output.status.success() {
        let detail = truncate_process_error(&output.stderr);
        return Err(if detail.is_empty() {
            "Failed to convert document preview with textutil".to_string()
        } else {
            format!("Failed to convert document preview with textutil: {detail}")
        });
    }

    if output.stdout.is_empty() {
        return Err("Document preview conversion returned empty HTML".to_string());
    }
    if output.stdout.len() > READ_MAX_PREVIEW_BYTES {
        return Err(FsError::Other(format!(
            "Converted document preview is too large ({} bytes, max {READ_MAX_PREVIEW_BYTES} bytes)",
            output.stdout.len()
        ))
        .to_string());
    }
    Ok(output.stdout)
}

#[cfg(not(target_os = "macos"))]
fn soffice_candidate_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["soffice.exe", "soffice.com"]
    } else {
        &["soffice", "libreoffice"]
    }
}

#[cfg(not(target_os = "macos"))]
fn find_soffice_binary() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("LIVEAGENT_SOFFICE_PATH") {
        let trimmed = raw.trim().trim_matches('"');
        if !trimmed.is_empty() {
            let path = expand_tilde_path(trimmed);
            if path.is_file() {
                return Some(path);
            }
        }
    }

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        for name in soffice_candidate_names() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    #[cfg(windows)]
    {
        let roots = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|var| std::env::var_os(var).map(PathBuf::from))
            .chain([
                PathBuf::from(r"C:\Program Files"),
                PathBuf::from(r"C:\Program Files (x86)"),
            ]);
        for root in roots {
            let candidate = root.join("LibreOffice").join("program").join("soffice.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    #[cfg(not(windows))]
    {
        for candidate in [
            "/usr/bin/soffice",
            "/usr/local/bin/soffice",
            "/opt/libreoffice/program/soffice",
        ] {
            let candidate = Path::new(candidate);
            if candidate.is_file() {
                return Some(candidate.to_path_buf());
            }
        }
    }

    None
}

#[cfg(not(target_os = "macos"))]
fn path_to_file_url(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut encoded = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '/' | ':' | '.' | '-' | '_' | '~' => {
                encoded.push(ch);
            }
            _ => {
                let mut buf = [0u8; 4];
                for byte in ch.encode_utf8(&mut buf).as_bytes() {
                    encoded.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

#[cfg(not(target_os = "macos"))]
fn run_soffice_document_conversion(
    soffice: &Path,
    target: &Path,
    out_dir: &Path,
) -> Result<Vec<u8>, String> {
    // A dedicated profile keeps headless conversion from clashing with a running LibreOffice.
    let profile_url = path_to_file_url(&out_dir.join("profile"));
    let mut command = Command::new(soffice);
    #[cfg(windows)]
    crate::runtime::process::configure_child_process_group(&mut command);
    let output = command
        .arg(format!("-env:UserInstallation={profile_url}"))
        .arg("--headless")
        .arg("--norestore")
        .arg("--convert-to")
        .arg("html")
        .arg("--outdir")
        .arg(out_dir)
        .arg(target)
        .output()
        .map_err(|e| format!("Failed to start LibreOffice for document preview: {e}"))?;

    if !output.status.success() {
        let detail = truncate_process_error(&output.stderr);
        return Err(if detail.is_empty() {
            "Failed to convert document preview with LibreOffice".to_string()
        } else {
            format!("Failed to convert document preview with LibreOffice: {detail}")
        });
    }

    let stem = target
        .file_stem()
        .ok_or_else(|| "Document preview target has no file name".to_string())?;
    let html_path = out_dir.join(stem).with_extension("html");
    let bytes = fs::read(&html_path)
        .map_err(|e| format!("LibreOffice did not produce a document preview: {e}"))?;
    if bytes.is_empty() {
        return Err("Document preview conversion returned empty HTML".to_string());
    }
    if bytes.len() > READ_MAX_PREVIEW_BYTES {
        return Err(FsError::Other(format!(
            "Converted document preview is too large ({} bytes, max {READ_MAX_PREVIEW_BYTES} bytes)",
            bytes.len()
        ))
        .to_string());
    }
    Ok(bytes)
}

#[cfg(not(target_os = "macos"))]
fn convert_document_to_html_preview(target: &Path) -> Result<Vec<u8>, String> {
    let soffice = find_soffice_binary().ok_or_else(|| {
        "Legacy Word/RTF preview conversion requires LibreOffice; install it or set LIVEAGENT_SOFFICE_PATH to the soffice binary".to_string()
    })?;

    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let out_dir = std::env::temp_dir()
        .join("liveagent")
        .join("workspace-preview-convert")
        .join(format!("{}-{}", std::process::id(), nanos));
    fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Failed to prepare document preview workspace: {e}"))?;

    let result = run_soffice_document_conversion(&soffice, target, &out_dir);
    let _ = fs::remove_dir_all(&out_dir);
    result
}

fn document_preview_cache_dir() -> PathBuf {
    std::env::temp_dir()
        .join("liveagent")
        .join("workspace-preview-cache")
}

fn document_preview_cache_path(
    target: &Path,
    mtime_ms: u64,
    size_bytes: usize,
    content_hash: &str,
) -> PathBuf {
    let key = format!(
        "{}\0{}\0{}\0{}\0{}",
        DOCUMENT_PREVIEW_CACHE_VERSION,
        display_path(target),
        mtime_ms,
        size_bytes,
        content_hash
    );
    document_preview_cache_dir().join(format!("{}.html", hash_bytes(key.as_bytes())))
}

fn read_cached_document_preview(cache_path: &Path) -> Option<Vec<u8>> {
    match fs::read(cache_path) {
        Ok(bytes) if !bytes.is_empty() && bytes.len() <= READ_MAX_PREVIEW_BYTES => Some(bytes),
        _ => None,
    }
}

fn write_cached_document_preview(cache_path: &Path, bytes: &[u8]) {
    if bytes.is_empty() || bytes.len() > READ_MAX_PREVIEW_BYTES {
        return;
    }

    let Some(parent) = cache_path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }

    let file_name = cache_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("preview.html");
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp_path = cache_path.with_file_name(format!(
        "{}.{}.{}.tmp",
        file_name,
        std::process::id(),
        nanos
    ));

    if fs::write(&temp_path, bytes).is_ok() {
        let _ = fs::rename(&temp_path, cache_path);
    }
    let _ = fs::remove_file(temp_path);
}

fn convert_document_to_html_preview_cached(
    target: &Path,
    mtime_ms: u64,
    size_bytes: usize,
    content_hash: &str,
) -> Result<Vec<u8>, String> {
    let cache_path = document_preview_cache_path(target, mtime_ms, size_bytes, content_hash);
    if let Some(bytes) = read_cached_document_preview(&cache_path) {
        return Ok(bytes);
    }

    let bytes = convert_document_to_html_preview(target)?;
    write_cached_document_preview(&cache_path, &bytes);
    Ok(bytes)
}

fn build_workspace_preview_response(
    logical_path: String,
    bytes: Vec<u8>,
    mime_type: &'static str,
    mtime_ms: u64,
    content_hash: String,
    size_bytes: usize,
    file_id: Option<String>,
) -> ReadResponse {
    let kind = if mime_type.starts_with("image/") {
        "image"
    } else {
        "preview"
    };

    ReadResponse {
        kind: kind.to_string(),
        path: logical_path,
        content: None,
        truncated: None,
        start_line: None,
        num_lines: None,
        total_lines: None,
        is_partial_view: None,
        page_start: None,
        num_pages: None,
        total_pages: None,
        cell_start: None,
        num_cells: None,
        total_cells: None,
        mtime_ms,
        content_hash,
        mime_type: Some(mime_type.to_string()),
        data: Some(BASE64_STANDARD.encode(bytes)),
        size_bytes: Some(size_bytes),
        file_id,
    }
}

fn read_local_preview_file(target: PathBuf, logical_path: String) -> Result<ReadResponse, FsError> {
    let md = fs::metadata(&target)?;
    let size_bytes = usize::try_from(md.len()).unwrap_or(usize::MAX);
    if size_bytes > READ_MAX_PREVIEW_BYTES {
        return Err(FsError::TooLarge {
            path: logical_path,
            message: format!(
                "File is too large to preview ({size_bytes} bytes, max {READ_MAX_PREVIEW_BYTES} bytes)"
            ),
        });
    }

    let bytes = fs::read(&target)?;
    if bytes.len() > READ_MAX_PREVIEW_BYTES {
        return Err(FsError::TooLarge {
            path: logical_path,
            message: format!(
                "File is too large to preview ({} bytes, max {READ_MAX_PREVIEW_BYTES} bytes)",
                bytes.len()
            ),
        });
    }

    let mtime_ms = metadata_mtime_ms(&md);
    let content_hash = hash_bytes(&bytes);
    let original_size_bytes = bytes.len();
    let file_id = Some(file_identity(&md, &target));

    if is_convertible_document_preview_file(&target) {
        let html_bytes = convert_document_to_html_preview_cached(
            &target,
            mtime_ms,
            original_size_bytes,
            &content_hash,
        )
        .map_err(FsError::Other)?;
        return Ok(build_workspace_preview_response(
            logical_path,
            html_bytes,
            "text/html",
            mtime_ms,
            content_hash,
            original_size_bytes,
            file_id,
        ));
    }

    let mime_type =
        infer_workspace_preview_mime(&target, &bytes).ok_or_else(|| FsError::UnsupportedTarget {
            path: logical_path.clone(),
            message: "File type is not supported for preview".to_string(),
        })?;

    Ok(build_workspace_preview_response(
        logical_path,
        bytes,
        mime_type,
        mtime_ms,
        content_hash,
        original_size_bytes,
        file_id,
    ))
}

fn truncate_text_to_byte_limit(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }

    let mut end = 0usize;
    for (idx, ch) in text.char_indices() {
        let next = idx + ch.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    (text[..end].to_string(), true)
}

fn join_text_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn truncate_block_preview(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let preview = trimmed.chars().take(max_chars).collect::<String>();
    format!("{preview}...")
}

fn summarize_notebook_outputs(cell: &Value) -> Option<String> {
    let outputs = cell.get("outputs")?.as_array()?;
    if outputs.is_empty() {
        return None;
    }

    let mut parts = Vec::new();
    for output in outputs.iter().take(3) {
        let summary = match output.get("output_type").and_then(Value::as_str) {
            Some("stream") => {
                let name = output
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("stream");
                let text = join_text_value(output.get("text").unwrap_or(&Value::Null));
                let preview = truncate_block_preview(&text, 180);
                if preview.is_empty() {
                    format!("{name}: (empty)")
                } else {
                    format!("{name}: {preview}")
                }
            }
            Some("error") => {
                let ename = output
                    .get("ename")
                    .and_then(Value::as_str)
                    .unwrap_or("error");
                let evalue = output.get("evalue").and_then(Value::as_str).unwrap_or("");
                let trace = output
                    .get("traceback")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" | ")
                    })
                    .unwrap_or_default();
                truncate_block_preview(&format!("{ename}: {evalue} {trace}"), 180)
            }
            _ => {
                let data = output.get("data").and_then(Value::as_object);
                let text = data
                    .and_then(|map| map.get("text/plain"))
                    .map(join_text_value)
                    .or_else(|| {
                        data.and_then(|map| map.get("text/markdown"))
                            .map(join_text_value)
                    })
                    .or_else(|| {
                        data.and_then(|map| map.get("text/html"))
                            .map(join_text_value)
                    })
                    .unwrap_or_default();
                let preview = truncate_block_preview(&text, 180);
                if preview.is_empty() {
                    let output_type = output
                        .get("output_type")
                        .and_then(Value::as_str)
                        .unwrap_or("output");
                    format!("{output_type}: (non-text output)")
                } else {
                    preview
                }
            }
        };

        if !summary.trim().is_empty() {
            parts.push(summary);
        }
    }

    if outputs.len() > 3 {
        parts.push(format!("... {} more output item(s)", outputs.len() - 3));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn build_notebook_window(
    bytes: &[u8],
    requested_cell_start: usize,
    requested_cell_limit: usize,
) -> Result<(String, usize, usize, usize, bool), String> {
    let notebook: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("Failed to parse notebook JSON: {e}"))?;
    let cells = notebook
        .get("cells")
        .and_then(Value::as_array)
        .ok_or_else(|| "Notebook does not contain a cells array".to_string())?;

    let total_cells = cells.len();
    let cell_start = requested_cell_start.max(1);
    let cell_limit = requested_cell_limit.max(1);

    if total_cells == 0 {
        return Ok((String::new(), cell_start, 0, 0, false));
    }

    let start_idx = cell_start.saturating_sub(1);
    let mut out = String::new();
    let mut num_cells = 0usize;
    let mut truncated = false;

    for (idx, cell) in cells.iter().enumerate().skip(start_idx) {
        if num_cells >= cell_limit {
            truncated = true;
            break;
        }

        let cell_type = cell
            .get("cell_type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let source = join_text_value(cell.get("source").unwrap_or(&Value::Null));
        let preview = truncate_block_preview(&source, 1200);
        let outputs = summarize_notebook_outputs(cell);

        let mut block = format!(
            "Cell {} [{}]\n{}\n",
            idx + 1,
            cell_type,
            if preview.is_empty() {
                "(empty)"
            } else {
                &preview
            }
        );
        if let Some(outputs_preview) = outputs {
            block.push_str("\nOutputs\n");
            block.push_str(&outputs_preview);
            block.push('\n');
        }
        block.push('\n');

        if out.len().saturating_add(block.len()) > READ_MAX_TEXT_BYTES {
            truncated = true;
            break;
        }

        out.push_str(&block);
        num_cells += 1;
    }

    if start_idx.saturating_add(num_cells) < total_cells {
        truncated = true;
    }

    Ok((out, cell_start, num_cells, total_cells, truncated))
}

fn build_pdf_window(
    bytes: &[u8],
    requested_page_start: usize,
    requested_page_limit: usize,
) -> Result<(String, usize, usize, usize, bool), String> {
    let document = PdfDocument::load_mem(bytes).map_err(|e| format!("Failed to parse PDF: {e}"))?;
    let page_numbers = document.get_pages().into_keys().collect::<Vec<_>>();
    let total_pages = page_numbers.len();
    let page_start = requested_page_start.max(1);
    let page_limit = requested_page_limit.max(1);

    if total_pages == 0 {
        return Ok((String::new(), page_start, 0, 0, false));
    }

    let selected_pages = page_numbers
        .into_iter()
        .skip(page_start.saturating_sub(1))
        .take(page_limit)
        .collect::<Vec<_>>();
    let num_pages = selected_pages.len();

    let extracted = if num_pages == 0 {
        String::new()
    } else {
        document
            .extract_text(&selected_pages)
            .map_err(|e| format!("Failed to extract PDF text: {e}"))?
    };

    let (content, byte_truncated) = truncate_text_to_byte_limit(&extracted, READ_MAX_TEXT_BYTES);
    let has_more_pages = page_start.saturating_sub(1).saturating_add(num_pages) < total_pages;
    Ok((
        content,
        page_start,
        num_pages,
        total_pages,
        has_more_pages || byte_truncated,
    ))
}

fn decode_xml_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '&' {
            out.push(ch);
            continue;
        }

        let mut entity = String::new();
        let mut terminated = false;
        while let Some(next) = chars.peek().copied() {
            chars.next();
            if next == ';' {
                terminated = true;
                break;
            }
            if entity.len() > 16 {
                break;
            }
            entity.push(next);
        }

        if !terminated {
            out.push('&');
            out.push_str(&entity);
            continue;
        }

        match entity.as_str() {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            _ if entity.starts_with("#x") => {
                if let Ok(value) = u32::from_str_radix(&entity[2..], 16) {
                    if let Some(decoded) = char::from_u32(value) {
                        out.push(decoded);
                    }
                }
            }
            _ if entity.starts_with('#') => {
                if let Ok(value) = entity[1..].parse::<u32>() {
                    if let Some(decoded) = char::from_u32(value) {
                        out.push(decoded);
                    }
                }
            }
            _ => {
                out.push('&');
                out.push_str(&entity);
                out.push(';');
            }
        }
    }

    out
}

fn xml_attr(tag: &str, name: &str) -> Option<String> {
    let patterns = [format!("{name}=\""), format!("{name}='")];
    for pattern in patterns {
        let Some(start_index) = tag.find(&pattern) else {
            continue;
        };
        let start = start_index + pattern.len();
        let Some(quote) = pattern.chars().last() else {
            continue;
        };
        let rest = &tag[start..];
        let Some(end) = rest.find(quote) else {
            continue;
        };
        return Some(decode_xml_entities(&rest[..end]));
    }
    None
}

fn normalize_text_preview(input: &str) -> String {
    input
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_xml_text(xml: &str, paragraph_breaks: bool) -> String {
    let mut out = String::new();
    let mut cursor = 0usize;

    while cursor < xml.len() {
        let Some(tag_start_rel) = xml[cursor..].find('<') else {
            out.push_str(&decode_xml_entities(&xml[cursor..]));
            break;
        };
        let tag_start = cursor + tag_start_rel;
        if tag_start > cursor {
            out.push_str(&decode_xml_entities(&xml[cursor..tag_start]));
        }
        let Some(tag_end_rel) = xml[tag_start..].find('>') else {
            break;
        };
        let tag_end = tag_start + tag_end_rel;
        let tag = xml[tag_start + 1..tag_end]
            .trim_start_matches('/')
            .trim()
            .to_ascii_lowercase();
        if paragraph_breaks {
            if tag.starts_with("w:p")
                || tag.starts_with("w:br")
                || tag.starts_with("a:p")
                || tag.starts_with("text:p")
            {
                out.push('\n');
            } else if tag.starts_with("w:tab") {
                out.push('\t');
            }
        }
        cursor = tag_end + 1;
    }

    normalize_text_preview(&out)
}

fn read_zip_entry_text<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    max_bytes: usize,
) -> Result<Option<(String, bool)>, String> {
    let mut file = match archive.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(format!("Failed to read ZIP entry {name}: {error}")),
    };
    let mut bytes = Vec::new();
    let mut limited = (&mut file).take((max_bytes + 1) as u64);
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read ZIP entry {name}: {e}"))?;
    let truncated = bytes.len() > max_bytes;
    if truncated {
        bytes.truncate(max_bytes);
    }
    Ok(Some((
        String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    )))
}

fn open_zip_archive<'a>(
    bytes: &'a [u8],
    label: &str,
) -> Result<ZipArchive<Cursor<&'a [u8]>>, String> {
    ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Failed to parse {label} as ZIP: {e}"))
}

fn build_docx_window(bytes: &[u8]) -> Result<(String, bool), String> {
    let mut archive = open_zip_archive(bytes, "Word document")?;
    let Some((xml, zip_truncated)) =
        read_zip_entry_text(&mut archive, "word/document.xml", MAX_ZIP_XML_ENTRY_BYTES)?
    else {
        return Err("Word document does not contain word/document.xml".to_string());
    };
    let text = extract_xml_text(&xml, true);
    let (content, byte_truncated) = truncate_text_to_byte_limit(&text, READ_MAX_TEXT_BYTES);
    Ok((content, zip_truncated || byte_truncated))
}

fn extract_xml_elements(xml: &str, tag_name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    let start_pattern = format!("<{tag_name}");
    let end_pattern = format!("</{tag_name}>");

    while let Some(start_rel) = xml[cursor..].find(&start_pattern) {
        let start = cursor + start_rel;
        let Some(start_end_rel) = xml[start..].find('>') else {
            break;
        };
        let body_start = start + start_end_rel + 1;
        let Some(end_rel) = xml[body_start..].find(&end_pattern) else {
            break;
        };
        let end = body_start + end_rel;
        out.push(xml[body_start..end].to_string());
        cursor = end + end_pattern.len();
    }

    out
}

fn extract_first_xml_element(xml: &str, tag_name: &str) -> Option<String> {
    extract_xml_elements(xml, tag_name).into_iter().next()
}

fn extract_xml_tag_bodies(xml: &str, tag_name: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut cursor = 0usize;
    let start_pattern = format!("<{tag_name}");
    let end_pattern = format!("</{tag_name}>");

    while let Some(start_rel) = xml[cursor..].find(&start_pattern) {
        let start = cursor + start_rel;
        let Some(start_end_rel) = xml[start..].find('>') else {
            break;
        };
        let start_end = start + start_end_rel;
        let body_start = start_end + 1;
        let Some(end_rel) = xml[body_start..].find(&end_pattern) else {
            break;
        };
        let end = body_start + end_rel;
        out.push((
            xml[start + 1..start_end].to_string(),
            xml[body_start..end].to_string(),
        ));
        cursor = end + end_pattern.len();
    }

    out
}

fn parse_shared_strings(xml: &str) -> Vec<String> {
    extract_xml_elements(xml, "si")
        .into_iter()
        .map(|item| extract_xml_text(&item, false))
        .collect()
}

fn parse_workbook_relationships(xml: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut cursor = 0usize;

    while let Some(start_rel) = xml[cursor..].find("<Relationship") {
        let start = cursor + start_rel;
        let Some(end_rel) = xml[start..].find('>') else {
            break;
        };
        let end = start + end_rel;
        let tag = &xml[start + 1..end];
        if let (Some(id), Some(target)) = (xml_attr(tag, "Id"), xml_attr(tag, "Target")) {
            let trimmed = target.trim_start_matches('/');
            let normalized = if trimmed.starts_with("xl/") {
                trimmed.to_string()
            } else {
                format!("xl/{trimmed}")
            };
            out.insert(id, normalized);
        }
        cursor = end + 1;
    }

    out
}

fn parse_workbook_sheets(
    workbook_xml: &str,
    rels: &BTreeMap<String, String>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut cursor = 0usize;

    while let Some(start_rel) = workbook_xml[cursor..].find("<sheet") {
        let start = cursor + start_rel;
        let Some(end_rel) = workbook_xml[start..].find('>') else {
            break;
        };
        let end = start + end_rel;
        let tag = &workbook_xml[start + 1..end];
        let name = xml_attr(tag, "name").unwrap_or_else(|| "Sheet".to_string());
        let rel_id = xml_attr(tag, "r:id").or_else(|| xml_attr(tag, "id"));
        if let Some(path) = rel_id.and_then(|id| rels.get(&id).cloned()) {
            out.push((name, path));
        }
        cursor = end + 1;
    }

    out
}

fn list_worksheet_paths<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for index in 0..archive.len() {
        let Ok(file) = archive.by_index(index) else {
            continue;
        };
        let name = file.name().to_string();
        if name.starts_with("xl/worksheets/") && name.ends_with(".xml") {
            let label = name
                .rsplit('/')
                .next()
                .unwrap_or(&name)
                .trim_end_matches(".xml")
                .to_string();
            out.push((label, name));
        }
    }
    out.sort_by(|left, right| left.1.cmp(&right.1));
    out
}

fn parse_sheet_rows(xml: &str, shared_strings: &[String], max_rows: usize) -> (String, bool) {
    let mut out = String::new();
    let mut row_count = 0usize;
    let mut truncated = false;

    for (row_tag, row_body) in extract_xml_tag_bodies(xml, "row") {
        if row_count >= max_rows {
            truncated = true;
            break;
        }
        let row_label = xml_attr(&row_tag, "r").unwrap_or_else(|| (row_count + 1).to_string());
        let mut cells = Vec::new();

        for (cell_tag, cell_body) in extract_xml_tag_bodies(&row_body, "c") {
            let cell_ref = xml_attr(&cell_tag, "r").unwrap_or_else(|| "?".to_string());
            let cell_type = xml_attr(&cell_tag, "t").unwrap_or_default();
            let value = if cell_type == "s" {
                extract_first_xml_element(&cell_body, "v")
                    .and_then(|raw| raw.trim().parse::<usize>().ok())
                    .and_then(|idx| shared_strings.get(idx).cloned())
                    .unwrap_or_default()
            } else if cell_type == "inlineStr" {
                extract_first_xml_element(&cell_body, "is")
                    .map(|raw| extract_xml_text(&raw, false))
                    .unwrap_or_default()
            } else {
                let formula = extract_first_xml_element(&cell_body, "f")
                    .map(|raw| extract_xml_text(&raw, false))
                    .filter(|value| !value.trim().is_empty());
                let raw_value = extract_first_xml_element(&cell_body, "v")
                    .map(|raw| decode_xml_entities(raw.trim()))
                    .unwrap_or_default();
                match formula {
                    Some(formula) if raw_value.trim().is_empty() => format!("={formula}"),
                    Some(formula) => format!("{raw_value} (formula: {formula})"),
                    None => raw_value,
                }
            };

            let value = value.trim();
            if !value.is_empty() {
                cells.push(format!("{cell_ref}={}", truncate_block_preview(value, 160)));
            }
            if cells.len() >= 24 {
                truncated = true;
                break;
            }
        }

        if !cells.is_empty() {
            out.push_str(&format!("Row {row_label}: {}\n", cells.join(" | ")));
            row_count += 1;
        }
        if out.len() > READ_MAX_TEXT_BYTES {
            truncated = true;
            break;
        }
    }

    let (content, byte_truncated) = truncate_text_to_byte_limit(&out, READ_MAX_TEXT_BYTES);
    (content, truncated || byte_truncated)
}

fn build_xlsx_window(bytes: &[u8]) -> Result<(String, bool), String> {
    let mut archive = open_zip_archive(bytes, "Excel workbook")?;
    let shared_strings = read_zip_entry_text(
        &mut archive,
        "xl/sharedStrings.xml",
        MAX_ZIP_XML_ENTRY_BYTES,
    )?
    .map(|(xml, _)| parse_shared_strings(&xml))
    .unwrap_or_default();

    let rels = read_zip_entry_text(
        &mut archive,
        "xl/_rels/workbook.xml.rels",
        MAX_ZIP_XML_ENTRY_BYTES,
    )?
    .map(|(xml, _)| parse_workbook_relationships(&xml))
    .unwrap_or_default();
    let workbook_sheets =
        read_zip_entry_text(&mut archive, "xl/workbook.xml", MAX_ZIP_XML_ENTRY_BYTES)?
            .map(|(xml, _)| parse_workbook_sheets(&xml, &rels))
            .unwrap_or_default();
    let sheets = if workbook_sheets.is_empty() {
        list_worksheet_paths(&mut archive)
    } else {
        workbook_sheets
    };

    if sheets.is_empty() {
        return Err("Excel workbook does not contain worksheets".to_string());
    }

    let mut out = String::new();
    let mut truncated = false;
    for (index, (name, path)) in sheets.iter().enumerate() {
        if index >= 8 {
            truncated = true;
            break;
        }
        let Some((sheet_xml, sheet_truncated)) =
            read_zip_entry_text(&mut archive, path, MAX_ZIP_XML_ENTRY_BYTES)?
        else {
            continue;
        };
        let (rows, rows_truncated) = parse_sheet_rows(&sheet_xml, &shared_strings, 80);
        out.push_str(&format!("Sheet: {name} ({path})\n"));
        if rows.trim().is_empty() {
            out.push_str("(no non-empty cells found in preview)\n\n");
        } else {
            out.push_str(&rows);
            out.push('\n');
        }
        truncated = truncated || sheet_truncated || rows_truncated;
        if out.len() > READ_MAX_TEXT_BYTES {
            truncated = true;
            break;
        }
    }

    let (content, byte_truncated) = truncate_text_to_byte_limit(&out, READ_MAX_TEXT_BYTES);
    Ok((content, truncated || byte_truncated))
}

fn build_archive_window(path: &Path, bytes: &[u8]) -> Result<(String, bool), String> {
    if !is_zip_archive_file(path) {
        let label = extension_lower(path)
            .map(|ext| ext.to_ascii_uppercase())
            .unwrap_or_else(|| "archive".to_string());
        return Ok((
            format!(
                "{label} archive file recognized and uploaded.\nRead can list ZIP archives directly; use Bash or an external extractor when you need to inspect entries in this archive format."
            ),
            false,
        ));
    }

    let mut archive = open_zip_archive(bytes, "ZIP archive")?;
    let total_entries = archive.len();
    let mut out = String::new();
    let mut listed = 0usize;

    for index in 0..total_entries.min(DEFAULT_ARCHIVE_ENTRY_LIMIT) {
        let file = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read ZIP entry #{index}: {e}"))?;
        let kind = if file.is_dir() { "dir" } else { "file" };
        out.push_str(&format!(
            "- [{kind}] {} | {} bytes compressed / {} bytes original\n",
            file.name(),
            file.compressed_size(),
            file.size()
        ));
        listed += 1;
        if out.len() > READ_MAX_TEXT_BYTES {
            break;
        }
    }

    let truncated = listed < total_entries || out.len() > READ_MAX_TEXT_BYTES;
    let (content, byte_truncated) = truncate_text_to_byte_limit(&out, READ_MAX_TEXT_BYTES);
    Ok((
        format!("ZIP entries: {listed}/{total_entries}\n{content}"),
        truncated || byte_truncated,
    ))
}

fn build_document_read_response(
    kind: &str,
    logical_path: String,
    content: String,
    truncated: bool,
    mtime_ms: u64,
    content_hash: String,
    mime_type: Option<String>,
    size_bytes: usize,
    file_id: Option<String>,
) -> ReadResponse {
    ReadResponse {
        kind: kind.to_string(),
        path: logical_path,
        content: Some(content),
        truncated: Some(truncated),
        start_line: None,
        num_lines: None,
        total_lines: None,
        is_partial_view: None,
        page_start: None,
        num_pages: None,
        total_pages: None,
        cell_start: None,
        num_cells: None,
        total_cells: None,
        mtime_ms,
        content_hash,
        mime_type,
        data: None,
        size_bytes: Some(size_bytes),
        file_id,
    }
}

fn trim_line_for_preview(line: &str) -> String {
    let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
    if trimmed.chars().count() > MAX_GREP_LINE_CHARS {
        trimmed
            .chars()
            .take(MAX_GREP_LINE_CHARS)
            .collect::<String>()
            + "..."
    } else {
        trimmed.to_string()
    }
}

fn build_line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (idx, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(idx + 1);
        }
    }
    starts
}

fn byte_index_to_line(line_starts: &[usize], index: usize) -> usize {
    match line_starts.binary_search(&index) {
        Ok(pos) => pos + 1,
        Err(pos) => pos.max(1),
    }
}

fn split_lines_for_grep(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}

fn line_text_for_grep(lines: &[&str], line_no: usize) -> String {
    if line_no == 0 {
        return String::new();
    }
    lines
        .get(line_no - 1)
        .map(|line| trim_line_for_preview(line))
        .unwrap_or_default()
}

fn build_context_for_line(
    lines: &[&str],
    line_no: usize,
    context: usize,
) -> (Vec<String>, Vec<String>) {
    if context == 0 || line_no == 0 {
        return (Vec::new(), Vec::new());
    }

    let before_start = line_no.saturating_sub(context + 1);
    let before_end = line_no.saturating_sub(1);
    let after_start = line_no;
    let after_end = (line_no + context).min(lines.len());

    let before = lines[before_start..before_end]
        .iter()
        .map(|line| trim_line_for_preview(line))
        .collect();
    let after = lines[after_start..after_end]
        .iter()
        .map(|line| trim_line_for_preview(line))
        .collect();

    (before, after)
}

#[derive(Debug)]
struct ExpectedVersion {
    mtime_ms: u64,
    content_hash: String,
}

fn parse_expected_version(
    expected_mtime_ms: Option<u64>,
    expected_content_hash: Option<String>,
) -> Result<Option<ExpectedVersion>, FsError> {
    match (expected_mtime_ms, expected_content_hash) {
        (None, None) => Ok(None),
        (Some(mtime_ms), Some(content_hash)) if !content_hash.trim().is_empty() => {
            Ok(Some(ExpectedVersion {
                mtime_ms,
                content_hash,
            }))
        }
        _ => Err(FsError::Other(
            "expected_mtime_ms and expected_content_hash must be provided together".to_string(),
        )),
    }
}

fn ensure_expected_version_matches(
    target: &Path,
    logical_path: &str,
    expected: &ExpectedVersion,
) -> Result<(), FsError> {
    let md = fs::metadata(target)?;
    let bytes = fs::read(target)?;
    let actual_mtime_ms = metadata_mtime_ms(&md);
    let actual_content_hash = hash_bytes(&bytes);
    if actual_mtime_ms != expected.mtime_ms || actual_content_hash != expected.content_hash {
        return Err(FsError::StaleFile {
            path: logical_path.to_string(),
            message:
                "File changed since the last full Read. Read the file again before modifying it."
                    .to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResponse {
    pub kind: String,
    pub path: String,
    pub content: Option<String>,
    pub truncated: Option<bool>,
    pub start_line: Option<usize>,
    pub num_lines: Option<usize>,
    pub total_lines: Option<usize>,
    pub is_partial_view: Option<bool>,
    pub page_start: Option<usize>,
    pub num_pages: Option<usize>,
    pub total_pages: Option<usize>,
    pub cell_start: Option<usize>,
    pub num_cells: Option<usize>,
    pub total_cells: Option<usize>,
    pub mtime_ms: u64,
    pub content_hash: String,
    pub mime_type: Option<String>,
    pub data: Option<String>,
    pub size_bytes: Option<usize>,
    pub file_id: Option<String>,
}

fn compact_base64(input: &str) -> String {
    input.chars().filter(|c| !c.is_ascii_whitespace()).collect()
}

fn decode_base64_image_bytes(label: &str, input: &str) -> Result<Vec<u8>, FsError> {
    let compact = compact_base64(input);
    let bytes = BASE64_STANDARD
        .decode(compact.as_bytes())
        .map_err(|e| FsError::Other(format!("{label} is not valid base64: {e}")))?;
    validate_image_size(label, bytes.len())?;
    Ok(bytes)
}

fn hex_digit_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_data_url_payload(label: &str, payload: &str) -> Result<Vec<u8>, FsError> {
    let bytes = payload.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(FsError::Other(format!(
                    "{label} data URL contains an incomplete percent escape"
                )));
            }
            let hi = hex_digit_value(bytes[index + 1]).ok_or_else(|| {
                FsError::Other(format!(
                    "{label} data URL contains an invalid percent escape"
                ))
            })?;
            let lo = hex_digit_value(bytes[index + 2]).ok_or_else(|| {
                FsError::Other(format!(
                    "{label} data URL contains an invalid percent escape"
                ))
            })?;
            out.push((hi << 4) | lo);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    validate_image_size(label, out.len())?;
    Ok(out)
}

fn parse_data_image_url(
    label: &str,
    source: &str,
    fallback_mime_type: Option<&str>,
) -> Result<Option<(Vec<u8>, String)>, FsError> {
    if !source
        .get(..5)
        .map(|prefix| prefix.eq_ignore_ascii_case("data:"))
        .unwrap_or(false)
    {
        return Ok(None);
    }

    let (header, payload) = source
        .split_once(',')
        .ok_or_else(|| FsError::Other(format!("{label} data URL is missing a comma")))?;
    let is_base64 = header
        .split(';')
        .any(|part| part.trim().eq_ignore_ascii_case("base64"));

    let declared_mime = header.get(5..).and_then(|value| value.split(';').next());
    let bytes = if is_base64 {
        decode_base64_image_bytes(label, payload)?
    } else {
        percent_decode_data_url_payload(label, payload)?
    };
    if !is_base64 {
        let normalized_mime = declared_mime
            .or(fallback_mime_type)
            .and_then(normalize_supported_image_mime)
            .ok_or_else(|| {
                FsError::Other(format!(
                    "{label} non-base64 data URL must declare image/svg+xml"
                ))
            })?;
        if normalized_mime != "image/svg+xml" || !looks_like_svg(&bytes) {
            return Err(FsError::Other(format!(
                "{label} non-base64 data URL only supports SVG image data"
            )));
        }
    }
    let mime_type =
        resolve_supported_image_mime(label, declared_mime.or(fallback_mime_type), None, &bytes)?;
    Ok(Some((bytes, mime_type)))
}

fn read_base64_image_source(
    source: &str,
    mime_type: Option<String>,
) -> Result<ReadResponse, FsError> {
    let label = "base64 image";
    let (bytes, mime_type) = match parse_data_image_url(label, source, mime_type.as_deref())? {
        Some(parsed) => parsed,
        None => {
            let bytes = decode_base64_image_bytes(label, source)?;
            let mime_type =
                resolve_supported_image_mime(label, mime_type.as_deref(), None, &bytes)?;
            (bytes, mime_type)
        }
    };
    let display_label = format!("base64:{mime_type}:{} bytes", bytes.len());
    Ok(build_image_read_response(
        display_label,
        bytes,
        mime_type,
        0,
        None,
    ))
}

fn read_inline_svg_image_source(source: &str) -> Result<ReadResponse, FsError> {
    let label = "inline SVG";
    let bytes = source.as_bytes().to_vec();
    validate_image_size(label, bytes.len())?;
    if !looks_like_svg(&bytes) {
        return Err(FsError::Other(format!("{label} is not valid SVG image data")));
    }
    let mime_type = resolve_supported_image_mime(label, Some("image/svg+xml"), None, &bytes)?;
    let display_label = format!("inline-svg:{mime_type}:{} bytes", bytes.len());
    Ok(build_image_read_response(
        display_label,
        bytes,
        mime_type,
        0,
        None,
    ))
}

fn read_local_image_file(target: PathBuf, label: String) -> Result<ReadResponse, FsError> {
    let md = fs::metadata(&target)?;
    if !md.is_file() {
        let entry_kind = if md.is_dir() { "dir" } else { "other" };
        return Err(FsError::NotAFile {
            path: label,
            entry_kind: entry_kind.to_string(),
        });
    }

    let bytes = fs::read(&target)?;
    validate_image_size(&label, bytes.len())?;
    let mime_type = resolve_supported_image_mime(&label, None, Some(&target), &bytes)?;
    let mtime_ms = metadata_mtime_ms(&md);
    let file_id = Some(file_identity(&md, &target));
    Ok(build_image_read_response(
        label, bytes, mime_type, mtime_ms, file_id,
    ))
}

fn read_path_image_source(workdir: &str, source: &str) -> Result<ReadResponse, FsError> {
    let raw = source.trim();
    if raw.is_empty() {
        return Err(FsError::InvalidRelPath(source.to_string()));
    }

    if let Some(file_path) = parse_file_url_path(raw)? {
        let target = fs::canonicalize(&file_path)?;
        let label = display_path(&target);
        return read_local_image_file(target, label);
    }

    let expanded = expand_tilde_path(raw);
    if expanded.is_absolute() {
        let target = fs::canonicalize(&expanded)?;
        let label = display_path(&target);
        return read_local_image_file(target, label);
    }

    let wd = canonicalize_workdir(workdir)?;
    let rel = sanitize_rel_path(raw)?;
    let logical_path = logical_rel_path(&rel);
    let target = resolve_existing_file_target(&wd, &rel)?;
    read_local_image_file(target, logical_path)
}

fn parse_file_url_path(source: &str) -> Result<Option<PathBuf>, FsError> {
    let Ok(url) = Url::parse(source) else {
        return Ok(None);
    };
    if url.scheme() != "file" {
        return Ok(None);
    }
    url.to_file_path()
        .map(Some)
        .map_err(|_| FsError::Other("Image.file URL must resolve to a local file path".to_string()))
}

fn read_url_image_source(source: &str) -> Result<ReadResponse, FsError> {
    let url = Url::parse(source)
        .map_err(|e| FsError::Other(format!("Image.url must be an absolute URL: {e}")))?;
    match url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(FsError::Other(format!(
                "Image.url only supports http and https, got {scheme}"
            )));
        }
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(IMAGE_SOURCE_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| FsError::Other(format!("Failed to create the HTTP client: {e}")))?;
    let response = client
        .get(url.clone())
        .send()
        .map_err(|e| FsError::Other(format!("Image.url request failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(FsError::Other(format!(
            "Image.url request failed with HTTP status {status}"
        )));
    }

    if let Some(content_length) = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        validate_image_size(url.as_str(), content_length)?;
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let path_hint = Path::new(url.path());
    let mut reader = response.take((READ_MAX_IMAGE_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| FsError::Other(format!("Failed to read Image.url response: {e}")))?;
    validate_image_size(url.as_str(), bytes.len())?;
    let mime_type = resolve_supported_image_mime(
        url.as_str(),
        content_type.as_deref(),
        Some(path_hint),
        &bytes,
    )?;
    Ok(build_image_read_response(
        url.to_string(),
        bytes,
        mime_type,
        0,
        None,
    ))
}

fn is_http_image_source(source: &str) -> bool {
    Url::parse(source)
        .map(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or(false)
}

fn fs_read_image_source_sync(
    workdir: String,
    source: String,
    source_type: Option<String>,
    mime_type: Option<String>,
) -> Result<ReadResponse, FsCommandError> {
    fs_read_image_source_impl(workdir, source, source_type, mime_type)
        .map_err(FsCommandError::from)
}

fn fs_read_image_source_impl(
    workdir: String,
    source: String,
    source_type: Option<String>,
    mime_type: Option<String>,
) -> Result<ReadResponse, FsError> {
    let source = source.trim().to_string();
    if source.is_empty() {
        return Err(FsError::Other("Image source cannot be empty".to_string()));
    }

    let normalized_type = source_type
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();

    match normalized_type.as_str() {
        "base64" => read_base64_image_source(&source, mime_type),
        "url" => read_url_image_source(&source),
        "path" => read_path_image_source(&workdir, &source),
        "auto" | "" => {
            if source
                .get(..5)
                .map(|prefix| prefix.eq_ignore_ascii_case("data:"))
                .unwrap_or(false)
            {
                read_base64_image_source(&source, mime_type)
            } else if looks_like_svg(source.as_bytes()) {
                read_inline_svg_image_source(&source)
            } else if is_http_image_source(&source) {
                read_url_image_source(&source)
            } else {
                read_path_image_source(&workdir, &source)
            }
        }
        other => Err(FsError::Other(format!(
            "Image sourceType must be one of path, url, base64, or auto, got {other}"
        ))),
    }
}

#[tauri::command]
pub async fn fs_read_image_source(
    workdir: String,
    source: String,
    source_type: Option<String>,
    mime_type: Option<String>,
) -> Result<ReadResponse, FsCommandError> {
    run_blocking_fs("fs_read_image_source", move || {
        fs_read_image_source_sync(workdir, source, source_type, mime_type)
    })
    .await
}

pub(crate) fn fs_read_workspace_image_sync(
    workdir: String,
    path: String,
) -> Result<ReadResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_read_workspace_image_impl(&wd, &path)
        .map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_read_workspace_image_impl(wd: &Path, path: &str) -> Result<ReadResponse, FsError> {
    let rel = sanitize_rel_path(path)?;
    let logical_path = logical_rel_path(&rel);
    let target = resolve_existing_file_target(wd, &rel)?;
    read_local_preview_file(target, logical_path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_read_workspace_image(
    workdir: String,
    path: String,
) -> Result<ReadResponse, FsCommandError> {
    run_blocking_fs("fs_read_workspace_image", move || {
        fs_read_workspace_image_sync(workdir, path)
    })
    .await
}

fn fs_read_text_sync(
    workdir: String,
    path: String,
    start_line: Option<usize>,
    limit: Option<usize>,
    page_start: Option<usize>,
    page_limit: Option<usize>,
    cell_start: Option<usize>,
    cell_limit: Option<usize>,
) -> Result<ReadResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_read_text_impl(
        &wd, &path, start_line, limit, page_start, page_limit, cell_start, cell_limit,
    )
    .map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_read_text_impl(
    wd: &Path,
    path: &str,
    start_line: Option<usize>,
    limit: Option<usize>,
    page_start: Option<usize>,
    page_limit: Option<usize>,
    cell_start: Option<usize>,
    cell_limit: Option<usize>,
) -> Result<ReadResponse, FsError> {
    let rel = sanitize_rel_path(path)?;
    let logical_path = logical_rel_path(&rel);
    let target = resolve_existing_file_target(wd, &rel)?;

    let md = fs::metadata(&target)?;
    let bytes = fs::read(&target)?;
    let mtime_ms = metadata_mtime_ms(&md);
    let content_hash = hash_bytes(&bytes);
    let file_id = Some(file_identity(&md, &target));

    if let Some(mime_type) = infer_image_mime(&target) {
        if bytes.len() > READ_MAX_IMAGE_BYTES {
            return Err(FsError::TooLarge {
                path: logical_path,
                message: format!("Image is too large to read via tool ({})", target.display()),
            });
        }

        return Ok(ReadResponse {
            kind: "image".to_string(),
            path: logical_path,
            content: None,
            truncated: None,
            start_line: None,
            num_lines: None,
            total_lines: None,
            is_partial_view: None,
            page_start: None,
            num_pages: None,
            total_pages: None,
            cell_start: None,
            num_cells: None,
            total_cells: None,
            mtime_ms,
            content_hash,
            mime_type: Some(mime_type.to_string()),
            data: Some(BASE64_STANDARD.encode(bytes)),
            size_bytes: Some(md.len() as usize),
            file_id,
        });
    }

    if is_pdf_file(&target) {
        let (content, page_start, num_pages, total_pages, truncated) = build_pdf_window(
            &bytes,
            page_start.unwrap_or(1),
            page_limit.unwrap_or(DEFAULT_READ_LIMIT_PDF_PAGES),
        )
        .map_err(FsError::Other)?;
        return Ok(ReadResponse {
            kind: "pdf".to_string(),
            path: logical_path,
            content: Some(content),
            truncated: Some(truncated),
            start_line: None,
            num_lines: None,
            total_lines: None,
            is_partial_view: None,
            page_start: Some(page_start),
            num_pages: Some(num_pages),
            total_pages: Some(total_pages),
            cell_start: None,
            num_cells: None,
            total_cells: None,
            mtime_ms,
            content_hash,
            mime_type: Some("application/pdf".to_string()),
            data: None,
            size_bytes: Some(md.len() as usize),
            file_id,
        });
    }

    if is_notebook_file(&target) {
        let (content, cell_start, num_cells, total_cells, truncated) = build_notebook_window(
            &bytes,
            cell_start.unwrap_or(1),
            cell_limit.unwrap_or(DEFAULT_READ_LIMIT_NOTEBOOK_CELLS),
        )
        .map_err(FsError::Other)?;
        return Ok(ReadResponse {
            kind: "notebook".to_string(),
            path: logical_path,
            content: Some(content),
            truncated: Some(truncated),
            start_line: None,
            num_lines: None,
            total_lines: None,
            is_partial_view: None,
            page_start: None,
            num_pages: None,
            total_pages: None,
            cell_start: Some(cell_start),
            num_cells: Some(num_cells),
            total_cells: Some(total_cells),
            mtime_ms,
            content_hash,
            mime_type: Some("application/x-ipynb+json".to_string()),
            data: None,
            size_bytes: Some(md.len() as usize),
            file_id,
        });
    }

    if is_word_file(&target) {
        let (content, truncated) = if is_word_extractable_file(&target) {
            build_docx_window(&bytes).map_err(FsError::Other)?
        } else {
            (
                "Legacy Word .doc binary file recognized and uploaded.\nRead extracts text from .docx directly; use Bash or an external converter when you need to inspect legacy .doc contents.".to_string(),
                false,
            )
        };
        return Ok(build_document_read_response(
            "word",
            logical_path,
            content,
            truncated,
            mtime_ms,
            content_hash,
            office_mime_type(&target).map(str::to_string),
            md.len() as usize,
            file_id,
        ));
    }

    if is_spreadsheet_file(&target) {
        let (content, truncated) = if is_xlsx_extractable_file(&target) {
            build_xlsx_window(&bytes).map_err(FsError::Other)?
        } else {
            (
                "Legacy Excel .xls binary file recognized and uploaded.\nRead extracts workbook previews from .xlsx/.xlsm directly; use Bash or an external converter when you need to inspect legacy .xls contents.".to_string(),
                false,
            )
        };
        return Ok(build_document_read_response(
            "spreadsheet",
            logical_path,
            content,
            truncated,
            mtime_ms,
            content_hash,
            office_mime_type(&target).map(str::to_string),
            md.len() as usize,
            file_id,
        ));
    }

    if is_archive_file(&target) {
        let (content, truncated) = build_archive_window(&target, &bytes).map_err(FsError::Other)?;
        return Ok(build_document_read_response(
            "archive",
            logical_path,
            content,
            truncated,
            mtime_ms,
            content_hash,
            office_mime_type(&target).map(str::to_string),
            md.len() as usize,
            file_id,
        ));
    }

    let text = String::from_utf8_lossy(&bytes);
    let (content, start_line, num_lines, total_lines, truncated, is_partial_view) =
        build_numbered_text_window(
            &text,
            start_line.unwrap_or(1),
            limit.unwrap_or(DEFAULT_READ_LIMIT_LINES),
        );

    Ok(ReadResponse {
        kind: "text".to_string(),
        path: logical_path,
        content: Some(content),
        truncated: Some(truncated),
        start_line: Some(start_line),
        num_lines: Some(num_lines),
        total_lines: Some(total_lines),
        is_partial_view: Some(is_partial_view),
        page_start: None,
        num_pages: None,
        total_pages: None,
        cell_start: None,
        num_cells: None,
        total_cells: None,
        mtime_ms,
        content_hash,
        mime_type: None,
        data: None,
        size_bytes: Some(md.len() as usize),
        file_id,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_read_text(
    workdir: String,
    path: String,
    start_line: Option<usize>,
    limit: Option<usize>,
    page_start: Option<usize>,
    page_limit: Option<usize>,
    cell_start: Option<usize>,
    cell_limit: Option<usize>,
) -> Result<ReadResponse, FsCommandError> {
    run_blocking_fs("fs_read_text", move || {
        fs_read_text_sync(
            workdir, path, start_line, limit, page_start, page_limit, cell_start, cell_limit,
        )
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadEditableTextResponse {
    pub path: String,
    pub content: String,
    pub mtime_ms: u64,
    pub content_hash: String,
    pub size_bytes: usize,
    pub total_lines: usize,
    pub file_id: Option<String>,
}

pub(crate) fn fs_read_editable_text_sync(
    workdir: String,
    path: String,
) -> Result<ReadEditableTextResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_read_editable_text_impl(&wd, &path).map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_read_editable_text_impl(wd: &Path, path: &str) -> Result<ReadEditableTextResponse, FsError> {
    let rel = sanitize_rel_path(path)?;
    let logical_path = logical_rel_path(&rel);
    let target = resolve_existing_file_target(wd, &rel)?;
    if let Some(reason) = editable_text_unsupported_reason(&target) {
        return Err(FsError::UnsupportedTarget {
            path: logical_path,
            message: reason.to_string(),
        });
    }

    let md = fs::metadata(&target)?;
    let size_bytes = usize::try_from(md.len()).unwrap_or(usize::MAX);
    if size_bytes > EDITABLE_TEXT_MAX_BYTES {
        return Err(FsError::TooLarge {
            path: logical_path,
            message: format!(
                "File is too large to edit ({size_bytes} bytes, max {EDITABLE_TEXT_MAX_BYTES} bytes)"
            ),
        });
    }

    let bytes = fs::read(&target)?;
    if bytes.len() > EDITABLE_TEXT_MAX_BYTES {
        return Err(FsError::TooLarge {
            path: logical_path,
            message: format!(
                "File is too large to edit ({} bytes, max {EDITABLE_TEXT_MAX_BYTES} bytes)",
                bytes.len()
            ),
        });
    }

    let mtime_ms = metadata_mtime_ms(&md);
    let content_hash = hash_bytes(&bytes);
    let file_id = Some(file_identity(&md, &target));
    let content = String::from_utf8(bytes).map_err(|_| FsError::NotUtf8 {
        path: logical_path.clone(),
    })?;
    let total_lines = count_text_lines(&content);

    Ok(ReadEditableTextResponse {
        path: logical_path,
        content,
        mtime_ms,
        content_hash,
        size_bytes,
        total_lines,
        file_id,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_read_editable_text(
    workdir: String,
    path: String,
) -> Result<ReadEditableTextResponse, FsCommandError> {
    run_blocking_fs("fs_read_editable_text", move || {
        fs_read_editable_text_sync(workdir, path)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStatusResponse {
    pub path: String,
    pub exists: bool,
    pub kind: Option<String>,
    pub size_bytes: Option<u64>,
    pub mtime_ms: Option<u64>,
    pub file_id: Option<String>,
}

pub(crate) fn fs_path_status_sync(
    workdir: String,
    path: String,
) -> Result<PathStatusResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_path_status_impl(&wd, &path).map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_path_status_impl(wd: &Path, path: &str) -> Result<PathStatusResponse, FsError> {
    let rel = sanitize_rel_path(path)?;
    let logical_path = logical_rel_path(&rel);
    let target = wd.join(&rel);

    match fs::symlink_metadata(&target) {
        Ok(meta) => {
            let file_type = meta.file_type();
            let kind = if file_type.is_symlink() {
                "symlink"
            } else if meta.is_file() {
                "file"
            } else if meta.is_dir() {
                "dir"
            } else {
                "other"
            };
            let file_id = fs::canonicalize(&target)
                .ok()
                .map(|canon| file_identity(&meta, &canon));
            Ok(PathStatusResponse {
                path: logical_path,
                exists: true,
                kind: Some(kind.to_string()),
                size_bytes: Some(meta.len()),
                mtime_ms: Some(metadata_mtime_ms(&meta)),
                file_id,
            })
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(PathStatusResponse {
            path: logical_path,
            exists: false,
            kind: None,
            size_bytes: None,
            mtime_ms: None,
            file_id: None,
        }),
        Err(err) => Err(FsError::Io(err)),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_path_status(
    workdir: String,
    path: String,
) -> Result<PathStatusResponse, FsCommandError> {
    run_blocking_fs("fs_path_status", move || fs_path_status_sync(workdir, path)).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextResponse {
    pub path: String,
    pub mode: String,
    pub existed_before: bool,
    pub bytes_written: usize,
    pub mtime_ms: u64,
    pub content_hash: String,
    pub total_lines: usize,
    pub file_id: Option<String>,
}

pub(crate) fn fs_write_text_sync(
    workdir: String,
    path: String,
    content: String,
    mode: String,
    expected_mtime_ms: Option<u64>,
    expected_content_hash: Option<String>,
) -> Result<WriteTextResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_write_text_impl(
        &wd,
        &path,
        content,
        mode,
        expected_mtime_ms,
        expected_content_hash,
    )
    .map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_write_text_impl(
    wd: &Path,
    path: &str,
    content: String,
    mode: String,
    expected_mtime_ms: Option<u64>,
    expected_content_hash: Option<String>,
) -> Result<WriteTextResponse, FsError> {
    let rel = sanitize_rel_path(path)?;
    let logical_path = logical_rel_path(&rel);
    let raw_target = wd.join(&rel);
    let expected = parse_expected_version(expected_mtime_ms, expected_content_hash)?;

    if mode != "rewrite" {
        return Err(FsError::Other("Write.mode only supports rewrite".to_string()));
    }

    let (target, existed_before) = match fs::symlink_metadata(&raw_target) {
        Ok(meta) => {
            if meta.is_dir() {
                return Err(FsError::NotAFile {
                    path: logical_path,
                    entry_kind: "dir".to_string(),
                });
            }
            (resolve_existing_file_target(wd, &rel)?, true)
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            ensure_parent_dir(wd, &raw_target)?;
            (raw_target.clone(), false)
        }
        Err(err) => return Err(FsError::Io(err)),
    };

    if existed_before {
        let expected = expected.ok_or_else(|| FsError::RequiresFullRead {
            path: logical_path.clone(),
        })?;
        ensure_expected_version_matches(&target, &logical_path, &expected)?;
    }

    fs::write(&target, content.as_bytes())?;
    let canon = fs::canonicalize(&target)?;
    let md = fs::metadata(&canon)?;

    Ok(WriteTextResponse {
        path: logical_path,
        mode,
        existed_before,
        bytes_written: content.as_bytes().len(),
        mtime_ms: metadata_mtime_ms(&md),
        content_hash: hash_bytes(content.as_bytes()),
        total_lines: count_text_lines(&content),
        file_id: Some(file_identity(&md, &canon)),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_write_text(
    workdir: String,
    path: String,
    content: String,
    mode: String,
    expected_mtime_ms: Option<u64>,
    expected_content_hash: Option<String>,
) -> Result<WriteTextResponse, FsCommandError> {
    run_blocking_fs("fs_write_text", move || {
        fs_write_text_sync(
            workdir,
            path,
            content,
            mode,
            expected_mtime_ms,
            expected_content_hash,
        )
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTextResponse {
    pub path: String,
    pub replacements: usize,
    pub replace_all: bool,
    pub mtime_ms: u64,
    pub content_hash: String,
    pub total_lines: usize,
    pub file_id: Option<String>,
}

pub(crate) fn fs_edit_text_sync(
    workdir: String,
    path: String,
    old_string: String,
    new_string: String,
    expected_replacements: Option<usize>,
    replace_all: Option<bool>,
    expected_mtime_ms: Option<u64>,
    expected_content_hash: Option<String>,
) -> Result<EditTextResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_edit_text_impl(
        &wd,
        &path,
        old_string,
        new_string,
        expected_replacements,
        replace_all,
        expected_mtime_ms,
        expected_content_hash,
    )
    .map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_edit_text_impl(
    wd: &Path,
    path: &str,
    old_string: String,
    new_string: String,
    expected_replacements: Option<usize>,
    replace_all: Option<bool>,
    expected_mtime_ms: Option<u64>,
    expected_content_hash: Option<String>,
) -> Result<EditTextResponse, FsError> {
    let rel = sanitize_rel_path(path)?;
    let logical_path = logical_rel_path(&rel);
    let target = resolve_existing_file_target(wd, &rel)?;
    let expected = parse_expected_version(expected_mtime_ms, expected_content_hash)?
        .ok_or_else(|| FsError::RequiresFullRead {
            path: logical_path.clone(),
        })?;

    if old_string.is_empty() {
        return Err(FsError::Other(
            "Edit.old_string must be a non-empty string".to_string(),
        ));
    }

    ensure_expected_version_matches(&target, &logical_path, &expected)?;

    let bytes = fs::read(&target)?;
    let text = String::from_utf8_lossy(&bytes);
    let match_count = text.matches(&old_string).count();

    if match_count == 0 {
        return Err(FsError::EditNoMatch { path: logical_path });
    }

    let replace_all = replace_all.unwrap_or(false);
    if !replace_all && match_count > 1 {
        return Err(FsError::EditAmbiguous {
            path: logical_path,
            matches: match_count,
        });
    }

    let actual_replacements = if replace_all { match_count } else { 1 };
    if let Some(expected_count) = expected_replacements {
        if actual_replacements != expected_count {
            return Err(FsError::EditCountMismatch {
                path: logical_path,
                expected: expected_count,
                actual: actual_replacements,
            });
        }
    }

    let next = if replace_all {
        text.replace(&old_string, &new_string)
    } else {
        text.replacen(&old_string, &new_string, 1)
    };

    fs::write(&target, next.as_bytes())?;
    let md = fs::metadata(&target)?;

    Ok(EditTextResponse {
        path: logical_path,
        replacements: actual_replacements,
        replace_all,
        mtime_ms: metadata_mtime_ms(&md),
        content_hash: hash_bytes(next.as_bytes()),
        total_lines: count_text_lines(&next),
        file_id: Some(file_identity(&md, &target)),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_edit_text(
    workdir: String,
    path: String,
    old_string: String,
    new_string: String,
    expected_replacements: Option<usize>,
    replace_all: Option<bool>,
    expected_mtime_ms: Option<u64>,
    expected_content_hash: Option<String>,
) -> Result<EditTextResponse, FsCommandError> {
    run_blocking_fs("fs_edit_text", move || {
        fs_edit_text_sync(
            workdir,
            path,
            old_string,
            new_string,
            expected_replacements,
            replace_all,
            expected_mtime_ms,
            expected_content_hash,
        )
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResponse {
    pub path: String,
    pub kind: String,
}

fn remove_symlink_path(target: &Path) -> Result<(), io::Error> {
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(file_err) => match fs::remove_dir(target) {
            Ok(()) => Ok(()),
            Err(_) => Err(file_err),
        },
    }
}

pub(crate) fn fs_delete_sync(
    workdir: String,
    path: String,
) -> Result<DeleteResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_delete_impl(&wd, &path).map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_delete_impl(wd: &Path, path: &str) -> Result<DeleteResponse, FsError> {
    let rel = sanitize_rel_path(path)?;
    let logical_path = logical_rel_path(&rel);
    let file_name = rel
        .file_name()
        .ok_or_else(|| FsError::Other("Invalid target path".to_string()))?;
    let parent = rel.parent().map_or(wd.to_path_buf(), |p| wd.join(p));
    let parent = ensure_within_workdir_existing(wd, &parent)?;
    let target = parent.join(file_name);

    let meta = fs::symlink_metadata(&target)?;
    let kind = if meta.file_type().is_symlink() {
        remove_symlink_path(&target)?;
        "symlink"
    } else if meta.is_file() {
        fs::remove_file(&target)?;
        "file"
    } else if meta.is_dir() {
        fs::remove_dir_all(&target)?;
        "dir"
    } else {
        return Err(FsError::Other(
            "Only regular files, directories, or symlinks can be deleted".to_string(),
        ));
    };

    Ok(DeleteResponse {
        path: logical_path,
        kind: kind.to_string(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_delete(workdir: String, path: String) -> Result<DeleteResponse, FsCommandError> {
    run_blocking_fs("fs_delete", move || fs_delete_sync(workdir, path)).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspacePathResponse {
    pub path: String,
    pub absolute_path: String,
    pub kind: String,
    pub mode: String,
}

#[cfg(target_os = "macos")]
fn spawn_workspace_open_command(target: &Path, kind: &str, mode: &str) -> Result<(), String> {
    let mut command = Command::new("open");
    if mode == "reveal" && kind == "file" {
        command.arg("-R");
    }
    command.arg(target);
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open path with macOS open: {e}"))
}

#[cfg(target_os = "windows")]
fn spawn_workspace_open_command(target: &Path, kind: &str, mode: &str) -> Result<(), String> {
    let mut command = Command::new("explorer.exe");
    if mode == "reveal" && kind == "file" {
        command.arg(format!("/select,{}", target.display()));
    } else {
        command.arg(target);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open path with Windows Explorer: {e}"))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn spawn_workspace_open_command(target: &Path, kind: &str, mode: &str) -> Result<(), String> {
    let open_target = if mode == "reveal" && kind == "file" {
        target.parent().unwrap_or(target)
    } else {
        target
    };
    Command::new("xdg-open")
        .arg(open_target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open path with xdg-open: {e}"))
}

pub(crate) fn fs_open_workspace_path_sync(
    workdir: String,
    path: String,
    mode: Option<String>,
) -> Result<OpenWorkspacePathResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_open_workspace_path_impl(&wd, &path, mode)
        .map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_open_workspace_path_impl(
    wd: &Path,
    path: &str,
    mode: Option<String>,
) -> Result<OpenWorkspacePathResponse, FsError> {
    let rel = sanitize_rel_path(path)?;
    let logical_path = logical_rel_path(&rel);
    let target = resolve_target(wd, &rel)?;
    let meta = fs::metadata(&target)?;
    let kind = if meta.is_file() {
        "file"
    } else if meta.is_dir() {
        "dir"
    } else {
        return Err(FsError::Other(
            "Only regular files and directories can be opened".to_string(),
        ));
    };
    let normalized_mode = mode
        .as_deref()
        .unwrap_or("open")
        .trim()
        .to_ascii_lowercase();
    let normalized_mode = match normalized_mode.as_str() {
        "" | "open" => "open",
        "reveal" | "containing_dir" | "containing-directory" => "reveal",
        other => {
            return Err(FsError::Other(format!(
                "Open mode must be open or reveal, got {other}"
            )))
        }
    };

    spawn_workspace_open_command(&target, kind, normalized_mode).map_err(FsError::Other)?;

    Ok(OpenWorkspacePathResponse {
        path: logical_path,
        absolute_path: display_path(&target),
        kind: kind.to_string(),
        mode: normalized_mode.to_string(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_open_workspace_path(
    workdir: String,
    path: String,
    mode: Option<String>,
) -> Result<OpenWorkspacePathResponse, FsCommandError> {
    run_blocking_fs("fs_open_workspace_path", move || {
        fs_open_workspace_path_sync(workdir, path, mode)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDirResponse {
    pub path: String,
    pub kind: String,
}

pub(crate) fn fs_create_dir_sync(
    workdir: String,
    path: String,
) -> Result<CreateDirResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_create_dir_impl(&wd, &path).map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_create_dir_impl(wd: &Path, path: &str) -> Result<CreateDirResponse, FsError> {
    let rel = sanitize_rel_path(path)?;
    let logical_path = logical_rel_path(&rel);
    let file_name = rel
        .file_name()
        .ok_or_else(|| FsError::Other("Invalid target path".to_string()))?;
    let parent = rel.parent().map_or(wd.to_path_buf(), |p| wd.join(p));
    let parent = ensure_within_workdir_existing(wd, &parent)?;
    let target = parent.join(file_name);

    match fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(FsError::Other("Target path already exists".to_string()));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(FsError::Io(error)),
    }

    fs::create_dir(&target)?;
    Ok(CreateDirResponse {
        path: logical_path,
        kind: "dir".to_string(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_create_dir(
    workdir: String,
    path: String,
) -> Result<CreateDirResponse, FsCommandError> {
    run_blocking_fs("fs_create_dir", move || fs_create_dir_sync(workdir, path)).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResponse {
    pub from_path: String,
    pub path: String,
    pub kind: String,
}

pub(crate) fn fs_rename_sync(
    workdir: String,
    from_path: String,
    to_path: String,
) -> Result<RenameResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_rename_impl(&wd, &from_path, &to_path)
        .map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_rename_impl(wd: &Path, from_path: &str, to_path: &str) -> Result<RenameResponse, FsError> {
    let from_rel = sanitize_rel_path(from_path)?;
    let to_rel = sanitize_rel_path(to_path)?;
    let from_logical_path = logical_rel_path(&from_rel);
    let to_logical_path = logical_rel_path(&to_rel);

    if from_rel.parent() != to_rel.parent() {
        return Err(FsError::Other(
            "Rename only supports targets in the same directory".to_string(),
        ));
    }

    let from_name = from_rel
        .file_name()
        .ok_or_else(|| FsError::Other("Invalid source path".to_string()))?;
    let to_name = to_rel
        .file_name()
        .ok_or_else(|| FsError::Other("Invalid target path".to_string()))?;
    let parent_rel = from_rel.parent();
    let parent = parent_rel.map_or(wd.to_path_buf(), |p| wd.join(p));
    let parent = ensure_within_workdir_existing(wd, &parent)?;
    let source = parent.join(from_name);
    let target = parent.join(to_name);

    let meta = fs::symlink_metadata(&source)?;
    let kind = if meta.file_type().is_symlink() {
        "symlink"
    } else if meta.is_file() {
        "file"
    } else if meta.is_dir() {
        "dir"
    } else {
        return Err(FsError::Other(
            "Only regular files, directories, or symlinks can be renamed".to_string(),
        ));
    };

    match fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(FsError::Other("Target path already exists".to_string()));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(FsError::Io(error)),
    }

    fs::rename(&source, &target)?;
    Ok(RenameResponse {
        from_path: from_logical_path,
        path: to_logical_path,
        kind: kind.to_string(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_rename(
    workdir: String,
    from_path: String,
    to_path: String,
) -> Result<RenameResponse, FsCommandError> {
    run_blocking_fs("fs_rename", move || {
        fs_rename_sync(workdir, from_path, to_path)
    })
    .await
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResponse {
    pub path: Option<String>,
    pub depth: usize,
    pub offset: usize,
    pub max_results: usize,
    pub total: usize,
    pub has_more: bool,
    pub entries: Vec<ListEntry>,
    pub target_kind: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsRoot {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsRootsResponse {
    pub roots: Vec<FsRoot>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsDirEntry {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsListDirsResponse {
    pub path: String,
    pub entries: Vec<FsDirEntry>,
    pub truncated: bool,
}

pub(crate) fn fs_roots_sync() -> Result<FsRootsResponse, String> {
    let mut roots: Vec<FsRoot> = Vec::new();

    #[cfg(not(windows))]
    {
        roots.push(FsRoot {
            id: "/".to_string(),
            path: "/".to_string(),
            kind: "root".to_string(),
            label: "/".to_string(),
        });
    }

    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy().trim().to_string();
        if !home_str.is_empty() && home_str != "/" {
            roots.push(FsRoot {
                id: home_str.clone(),
                path: home_str,
                kind: "home".to_string(),
                label: "~".to_string(),
            });
        }
    }

    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetLogicalDrives() -> u32;
        }

        let mask = unsafe { GetLogicalDrives() };
        if mask == 0 {
            // Keep the picker usable if we at least have home.
            if !roots.is_empty() {
                return Ok(FsRootsResponse { roots });
            }
            return Err(io::Error::last_os_error().to_string());
        }

        for i in 0..26u32 {
            if mask & (1u32 << i) == 0 {
                continue;
            }
            let drive = (b'A' + u8::try_from(i).unwrap_or(0)) as char;
            let path = format!("{drive}:\\");
            roots.push(FsRoot {
                id: path.clone(),
                path,
                kind: "drive".to_string(),
                label: format!("{drive}:"),
            });
        }
    }

    Ok(FsRootsResponse { roots })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_roots() -> Result<FsRootsResponse, String> {
    run_blocking("fs_roots", fs_roots_sync).await
}

pub(crate) fn fs_list_dirs_sync(
    path: String,
    max_results: Option<usize>,
) -> Result<FsListDirsResponse, String> {
    let dir = path.trim().to_string();
    if dir.is_empty() {
        return Err("path is required".to_string());
    }

    let limit = max_results
        .unwrap_or(DEFAULT_LIST_DIRS_MAX_RESULTS)
        .clamp(1, HARD_LIST_DIRS_MAX_RESULTS);

    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut dirs: Vec<FsDirEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;

        let mut is_dir = file_type.is_dir();
        if !is_dir && file_type.is_symlink() {
            if let Ok(metadata) = entry.metadata() {
                is_dir = metadata.is_dir();
            }
        }
        if !is_dir {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        let child_path = entry.path().to_string_lossy().into_owned();
        dirs.push(FsDirEntry {
            path: display_path(&PathBuf::from(child_path)),
            name,
        });
    }

    dirs.sort_by(|a, b| {
        let left = a.name.to_lowercase();
        let right = b.name.to_lowercase();
        if left == right {
            a.name.cmp(&b.name)
        } else {
            left.cmp(&right)
        }
    });

    let truncated = dirs.len() > limit;
    if truncated {
        dirs.truncate(limit);
    }

    Ok(FsListDirsResponse {
        path: dir,
        entries: dirs,
        truncated,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_list_dirs(
    path: String,
    max_results: Option<usize>,
) -> Result<FsListDirsResponse, String> {
    run_blocking("fs_list_dirs", move || fs_list_dirs_sync(path, max_results)).await
}

fn build_ignore_walker(base: &Path, max_depth: Option<usize>) -> ignore::Walk {
    let mut builder = WalkBuilder::new(base);
    builder
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false);
    if let Some(depth) = max_depth {
        builder.max_depth(Some(depth));
    }
    builder.build()
}

pub(crate) fn fs_list_sync(
    workdir: String,
    path: Option<String>,
    depth: Option<usize>,
    offset: Option<usize>,
    max_results: Option<usize>,
) -> Result<ListResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_list_impl(&wd, path, depth, offset, max_results)
        .map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_list_impl(
    wd: &Path,
    path: Option<String>,
    depth: Option<usize>,
    offset: Option<usize>,
    max_results: Option<usize>,
) -> Result<ListResponse, FsError> {
    let rel_opt = sanitize_optional_rel_path(path)?;
    let path_display = rel_opt.as_ref().map(|rel| logical_rel_path(rel));
    let base = match rel_opt.as_ref() {
        None => wd.to_path_buf(),
        Some(rel) => resolve_target(wd, rel)?,
    };

    let md = fs::metadata(&base)?;
    let target_kind = if md.is_dir() {
        "dir"
    } else if md.is_file() {
        "file"
    } else {
        return Err(FsError::NotADirectory {
            path: path_display.unwrap_or_default(),
            entry_kind: "other".to_string(),
        });
    };

    let depth = depth.unwrap_or(DEFAULT_LIST_DEPTH).max(1);
    let offset = offset.unwrap_or(0);
    let max_results = max_results.unwrap_or(DEFAULT_PAGE_LIMIT).max(1);

    let mut entries: Vec<ListEntry> = Vec::new();
    if target_kind == "file" {
        entries.push(ListEntry {
            path: rel_to_workdir_str(wd, &base),
            kind: "file".to_string(),
        });
    } else {
        for result in build_ignore_walker(&base, Some(depth)) {
            let entry = match result {
                Ok(v) => v,
                Err(_) => continue,
            };

            if entry.path() == base.as_path() {
                continue;
            }

            let file_type = match entry.file_type() {
                Some(file_type) => file_type,
                None => continue,
            };

            let kind = if file_type.is_dir() { "dir" } else { "file" };
            entries.push(ListEntry {
                path: rel_to_workdir_str(wd, entry.path()),
                kind: kind.to_string(),
            });
        }
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let total = entries.len();
    let has_more = offset.saturating_add(max_results) < total;
    let entries = entries
        .into_iter()
        .skip(offset)
        .take(max_results)
        .collect::<Vec<_>>();

    Ok(ListResponse {
        path: path_display,
        depth,
        offset,
        max_results,
        total,
        has_more,
        entries,
        target_kind: Some(target_kind.to_string()),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_list(
    workdir: String,
    path: Option<String>,
    depth: Option<usize>,
    offset: Option<usize>,
    max_results: Option<usize>,
) -> Result<ListResponse, FsCommandError> {
    run_blocking_fs("fs_list", move || {
        fs_list_sync(workdir, path, depth, offset, max_results)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobResponse {
    pub path: Option<String>,
    pub pattern: String,
    pub sort_by: String,
    pub offset: usize,
    pub max_results: usize,
    pub total: usize,
    pub has_more: bool,
    pub paths: Vec<String>,
    pub target_kind: Option<String>,
}

fn fs_glob_sync(
    workdir: String,
    path: Option<String>,
    pattern: String,
    offset: Option<usize>,
    max_results: Option<usize>,
    sort_by: Option<String>,
) -> Result<GlobResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_glob_impl(&wd, path, pattern, offset, max_results, sort_by)
        .map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_glob_impl(
    wd: &Path,
    path: Option<String>,
    pattern: String,
    offset: Option<usize>,
    max_results: Option<usize>,
    sort_by: Option<String>,
) -> Result<GlobResponse, FsError> {
    let rel_opt = sanitize_optional_rel_path(path)?;
    let path_display = rel_opt.as_ref().map(|rel| logical_rel_path(rel));
    let target = match rel_opt.as_ref() {
        None => wd.to_path_buf(),
        Some(rel) => resolve_target(wd, rel)?,
    };
    let md = fs::metadata(&target)?;
    let target_kind = if md.is_dir() {
        "dir"
    } else if md.is_file() {
        "file"
    } else {
        return Err(FsError::NotADirectory {
            path: path_display.unwrap_or_default(),
            entry_kind: "other".to_string(),
        });
    };
    let base = if target_kind == "file" {
        target.parent().map(Path::to_path_buf).unwrap_or_else(|| wd.to_path_buf())
    } else {
        target
    };

    let pat = normalize_glob_pattern_input(&pattern);
    if pat.is_empty() {
        return Err(FsError::Glob("pattern cannot be empty".to_string()));
    }

    let sort_by = sort_by.unwrap_or_else(|| "path".to_string());
    if sort_by != "path" {
        return Err(FsError::Other("Glob.sort_by only supports path".to_string()));
    }

    let mut builder = GlobSetBuilder::new();
    builder.add(Glob::new(&pat).map_err(|e| FsError::Glob(e.to_string()))?);
    let globset = builder.build().map_err(|e| FsError::Glob(e.to_string()))?;

    let offset = offset.unwrap_or(0);
    let max_results = max_results.unwrap_or(DEFAULT_PAGE_LIMIT).max(1);

    let mut paths: Vec<String> = Vec::new();
    for result in build_ignore_walker(&base, None) {
        let entry = match result {
            Ok(v) => v,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Some(file_type) => file_type,
            None => continue,
        };
        if !file_type.is_file() {
            continue;
        }

        let rel_to_base = match entry.path().strip_prefix(&base) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if globset.is_match(rel_to_base) {
            paths.push(rel_to_workdir_str(wd, entry.path()));
        }
    }

    paths.sort();
    let total = paths.len();
    let has_more = offset.saturating_add(max_results) < total;
    let paths = paths
        .into_iter()
        .skip(offset)
        .take(max_results)
        .collect::<Vec<_>>();

    Ok(GlobResponse {
        path: path_display,
        pattern: pat,
        sort_by,
        offset,
        max_results,
        total,
        has_more,
        paths,
        target_kind: Some(target_kind.to_string()),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_glob(
    workdir: String,
    path: Option<String>,
    pattern: String,
    offset: Option<usize>,
    max_results: Option<usize>,
    sort_by: Option<String>,
) -> Result<GlobResponse, FsCommandError> {
    run_blocking_fs("fs_glob", move || {
        fs_glob_sync(workdir, path, pattern, offset, max_results, sort_by)
    })
    .await
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrepFileSummary {
    pub path: String,
    pub count: usize,
    pub first_line: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResponse {
    pub path: Option<String>,
    pub pattern: String,
    pub file_pattern: Option<String>,
    pub ignore_case: bool,
    pub output_mode: String,
    pub head_limit: usize,
    pub offset: usize,
    pub context: usize,
    pub multiline: bool,
    pub match_count: usize,
    pub file_count: usize,
    pub has_more: bool,
    pub matches: Vec<GrepMatch>,
    pub files: Vec<GrepFileSummary>,
    pub target_kind: Option<String>,
}

fn scan_grep_file(
    wd: &Path,
    file: &Path,
    re: &regex::Regex,
    multiline: bool,
    context: usize,
    matches: &mut Vec<GrepMatch>,
    file_summaries: &mut BTreeMap<String, GrepFileSummary>,
) {
    let bytes = match fs::read(file) {
        Ok(value) => value,
        Err(_) => return,
    };
    let text = String::from_utf8_lossy(&bytes);
    let lines = split_lines_for_grep(&text);
    let file_path = rel_to_workdir_str(wd, file);
    let mut file_match_count = 0usize;
    let mut first_line: Option<usize> = None;

    if multiline {
        let line_starts = build_line_starts(&text);
        for mat in re.find_iter(&text) {
            let line_no = byte_index_to_line(&line_starts, mat.start());
            let (before, after) = build_context_for_line(&lines, line_no, context);
            let text = line_text_for_grep(&lines, line_no);
            matches.push(GrepMatch {
                path: file_path.clone(),
                line: line_no,
                text,
                before,
                after,
            });
            file_match_count += 1;
            if first_line.is_none() {
                first_line = Some(line_no);
            }
        }
    } else {
        for (idx, line) in lines.iter().enumerate() {
            if !re.is_match(line) {
                continue;
            }
            let line_no = idx + 1;
            let (before, after) = build_context_for_line(&lines, line_no, context);
            matches.push(GrepMatch {
                path: file_path.clone(),
                line: line_no,
                text: trim_line_for_preview(line),
                before,
                after,
            });
            file_match_count += 1;
            if first_line.is_none() {
                first_line = Some(line_no);
            }
        }
    }

    if file_match_count > 0 {
        file_summaries.insert(
            file_path.clone(),
            GrepFileSummary {
                path: file_path,
                count: file_match_count,
                first_line,
            },
        );
    }
}

fn fs_grep_sync(
    workdir: String,
    path: Option<String>,
    pattern: String,
    file_pattern: Option<String>,
    ignore_case: Option<bool>,
    output_mode: Option<String>,
    head_limit: Option<usize>,
    offset: Option<usize>,
    context: Option<usize>,
    multiline: Option<bool>,
) -> Result<GrepResponse, FsCommandError> {
    let wd = canonicalize_workdir(&workdir)?;
    fs_grep_impl(
        &wd,
        path,
        pattern,
        file_pattern,
        ignore_case,
        output_mode,
        head_limit,
        offset,
        context,
        multiline,
    )
    .map_err(|e| FsCommandError::from(e).with_workdir(&wd))
}

fn fs_grep_impl(
    wd: &Path,
    path: Option<String>,
    pattern: String,
    file_pattern: Option<String>,
    ignore_case: Option<bool>,
    output_mode: Option<String>,
    head_limit: Option<usize>,
    offset: Option<usize>,
    context: Option<usize>,
    multiline: Option<bool>,
) -> Result<GrepResponse, FsError> {
    let rel_opt = sanitize_optional_rel_path(path)?;
    let path_display = rel_opt.as_ref().map(|rel| logical_rel_path(rel));
    let base = match rel_opt.as_ref() {
        None => wd.to_path_buf(),
        Some(rel) => resolve_target(wd, rel)?,
    };
    let md = fs::metadata(&base)?;
    let target_kind = if md.is_dir() {
        "dir"
    } else if md.is_file() {
        "file"
    } else {
        return Err(FsError::NotADirectory {
            path: path_display.unwrap_or_default(),
            entry_kind: "other".to_string(),
        });
    };

    let pat = pattern.trim();
    if pat.is_empty() {
        return Err(FsError::Regex("pattern cannot be empty".to_string()));
    }

    let ignore_case = ignore_case.unwrap_or(true);
    let output_mode = output_mode.unwrap_or_else(|| "content".to_string());
    if output_mode != "content" && output_mode != "files" && output_mode != "count" {
        return Err(FsError::Other(
            "Grep.output_mode must be content, files, or count".to_string(),
        ));
    }
    let head_limit = head_limit.unwrap_or(DEFAULT_GREP_HEAD_LIMIT).max(1);
    let offset = offset.unwrap_or(0);
    let context = context.unwrap_or(0);
    let multiline = multiline.unwrap_or(false);

    let mut rb = regex::RegexBuilder::new(pat);
    rb.case_insensitive(ignore_case);
    rb.multi_line(multiline);
    rb.dot_matches_new_line(multiline);
    let re = rb.build().map_err(|e| FsError::Regex(e.to_string()))?;

    let file_globset = match file_pattern.as_ref() {
        None => None,
        Some(value) if value.trim().is_empty() => None,
        Some(value) => Some(build_globset_from_pipe_patterns(value)?),
    };

    let mut matches: Vec<GrepMatch> = Vec::new();
    let mut file_summaries = BTreeMap::<String, GrepFileSummary>::new();

    if target_kind == "file" {
        scan_grep_file(
            wd,
            &base,
            &re,
            multiline,
            context,
            &mut matches,
            &mut file_summaries,
        );
    } else {
        for result in build_ignore_walker(&base, None) {
            let entry = match result {
                Ok(v) => v,
                Err(_) => continue,
            };

            let file_type = match entry.file_type() {
                Some(file_type) => file_type,
                None => continue,
            };
            if !file_type.is_file() {
                continue;
            }

            let rel_to_base = match entry.path().strip_prefix(&base) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if let Some(globset) = file_globset.as_ref() {
                if !globset.is_match(rel_to_base) {
                    continue;
                }
            }

            let canonical = match fs::canonicalize(entry.path()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if !canonical.starts_with(wd) {
                continue;
            }

            scan_grep_file(
                wd,
                entry.path(),
                &re,
                multiline,
                context,
                &mut matches,
                &mut file_summaries,
            );
        }
    }

    matches.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    let mut files = file_summaries.into_values().collect::<Vec<_>>();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let match_count = matches.len();
    let file_count = files.len();

    let has_more = match output_mode.as_str() {
        "files" => offset.saturating_add(head_limit) < file_count,
        "count" => false,
        _ => offset.saturating_add(head_limit) < match_count,
    };

    let matches = if output_mode == "content" {
        matches
            .into_iter()
            .skip(offset)
            .take(head_limit)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let files = if output_mode == "files" {
        files
            .into_iter()
            .skip(offset)
            .take(head_limit)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    Ok(GrepResponse {
        path: path_display,
        pattern: pat.to_string(),
        file_pattern,
        ignore_case,
        output_mode,
        head_limit,
        offset,
        context,
        multiline,
        match_count,
        file_count,
        has_more,
        matches,
        files,
        target_kind: Some(target_kind.to_string()),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_grep(
    workdir: String,
    path: Option<String>,
    pattern: String,
    file_pattern: Option<String>,
    ignore_case: Option<bool>,
    output_mode: Option<String>,
    head_limit: Option<usize>,
    offset: Option<usize>,
    context: Option<usize>,
    multiline: Option<bool>,
) -> Result<GrepResponse, FsCommandError> {
    run_blocking_fs("fs_grep", move || {
        fs_grep_sync(
            workdir,
            path,
            pattern,
            file_pattern,
            ignore_case,
            output_mode,
            head_limit,
            offset,
            context,
            multiline,
        )
    })
    .await
}

// ---- File mention listing (gitignore-aware) ----

const DEFAULT_MENTION_MAX_RESULTS: usize = 5000;
const QUERY_MENTION_CANDIDATE_LIMIT: usize = 20_000;
const MENTION_IGNORED_DIR_NAMES: &[&str] = &[
    ".cache",
    ".gradle",
    ".hg",
    ".idea",
    ".next",
    ".nox",
    ".nuxt",
    ".parcel-cache",
    ".pnpm-store",
    ".pytest_cache",
    ".ruff_cache",
    ".sass-cache",
    ".serverless",
    ".svn",
    ".svelte-kit",
    ".tox",
    ".turbo",
    ".venv",
    ".vite",
    ".webpack",
    ".yarn",
    "__pycache__",
    "bin",
    "bower_components",
    "build",
    "CMakeFiles",
    "coverage",
    "DerivedData",
    "dist",
    "dist-ssr",
    "env",
    "gradle",
    "htmlcov",
    "node_modules",
    "obj",
    "out",
    "Pods",
    "target",
    "venv",
    "vendor",
];

#[derive(Debug, Serialize)]
pub struct MentionFileEntry {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct MentionListResponse {
    pub entries: Vec<MentionFileEntry>,
    pub truncated: bool,
}

fn is_common_ignored_mention_dir_name(name: &str) -> bool {
    MENTION_IGNORED_DIR_NAMES
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
        || name
            .get(..12)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("cmake-build-"))
}

fn should_visit_mention_entry(entry: &ignore::DirEntry) -> bool {
    if !entry
        .file_type()
        .is_some_and(|file_type| file_type.is_dir())
    {
        return true;
    }

    entry
        .file_name()
        .to_str()
        .map(|name| !is_common_ignored_mention_dir_name(name))
        .unwrap_or(true)
}

fn normalize_mention_query(query: Option<String>) -> String {
    query
        .unwrap_or_default()
        .trim()
        .trim_start_matches('@')
        .replace('\\', "/")
        .to_lowercase()
}

fn mention_path_depth(path: &str) -> usize {
    path.bytes().filter(|value| *value == b'/').count()
}

fn mention_sort_key(path: &str, kind: &str, query: &str) -> (usize, usize, usize, String) {
    let normalized_path = path.to_lowercase();
    let normalized_name = normalized_path
        .rsplit('/')
        .next()
        .unwrap_or(&normalized_path);
    let match_rank = if query.is_empty() {
        0
    } else if normalized_name.starts_with(query) {
        0
    } else if normalized_path.starts_with(query) {
        1
    } else if normalized_name.contains(query) {
        2
    } else {
        3
    };
    let kind_rank = if kind == "dir" { 0 } else { 1 };
    (
        match_rank,
        mention_path_depth(path),
        kind_rank,
        normalized_path,
    )
}

pub fn fs_mention_list_sync(
    workdir: String,
    max_results: Option<usize>,
    query: Option<String>,
) -> Result<MentionListResponse, String> {
    let wd = canonicalize_workdir(&workdir).map_err(|e| e.to_string())?;
    let max_results = max_results.unwrap_or(DEFAULT_MENTION_MAX_RESULTS).max(1);
    let query = normalize_mention_query(query);
    let candidate_limit = if query.is_empty() {
        max_results
    } else {
        QUERY_MENTION_CANDIDATE_LIMIT.max(max_results)
    };

    let walker = WalkBuilder::new(&wd)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(should_visit_mention_entry)
        .build();

    let mut entries: Vec<MentionFileEntry> = Vec::new();
    let mut truncated = false;

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.path() == wd.as_path() {
            continue;
        }

        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind = if md.is_dir() { "dir" } else { "file" };
        let path = rel_to_workdir_str(&wd, entry.path());
        if !query.is_empty() && !path.to_lowercase().contains(&query) {
            continue;
        }

        if entries.len() >= candidate_limit {
            truncated = true;
            if query.is_empty() {
                break;
            }
            continue;
        }

        entries.push(MentionFileEntry {
            path,
            kind: kind.to_string(),
        });
    }

    entries.sort_by(|a, b| {
        mention_sort_key(&a.path, &a.kind, &query).cmp(&mention_sort_key(&b.path, &b.kind, &query))
    });
    if entries.len() > max_results {
        entries.truncate(max_results);
        truncated = true;
    }

    Ok(MentionListResponse { entries, truncated })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fs_mention_list(
    workdir: String,
    max_results: Option<usize>,
    query: Option<String>,
) -> Result<MentionListResponse, String> {
    run_blocking("fs_mention_list", move || {
        fs_mention_list_sync(workdir, max_results, query)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::write::FileOptions;

    fn unique_test_workdir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("liveagent-{name}-{suffix}"))
    }

    fn png_like_bytes() -> Vec<u8> {
        b"\x89PNG\r\n\x1a\nliveagent-test".to_vec()
    }

    fn svg_text() -> &'static str {
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>"#
    }

    fn build_test_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, content) in entries {
            writer.start_file(*name, options).expect("start zip file");
            writer
                .write_all(content.as_bytes())
                .expect("write zip file");
        }
        writer.finish().expect("finish zip").into_inner()
    }

    #[test]
    fn detects_windows_reserved_path_components() {
        assert!(is_windows_reserved_path_component("CON"));
        assert!(is_windows_reserved_path_component("con.txt"));
        assert!(is_windows_reserved_path_component("AUX"));
        assert!(is_windows_reserved_path_component("LPT1.log"));
        assert!(is_windows_reserved_path_component("COM9"));
        assert!(!is_windows_reserved_path_component("COM0"));
        assert!(!is_windows_reserved_path_component("console.txt"));
    }

    #[cfg(windows)]
    #[test]
    fn rel_path_rejects_windows_reserved_components_on_windows() {
        assert!(sanitize_rel_path("notes/readme.md").is_ok());
        assert!(sanitize_rel_path("CON.txt").is_err());
        assert!(sanitize_rel_path("notes/LPT1.log").is_err());
        assert!(sanitize_optional_rel_path(Some("uploads/AUX".to_string())).is_err());
    }

    #[test]
    fn image_source_reads_absolute_local_path() {
        let workdir = unique_test_workdir("image-absolute");
        fs::create_dir_all(&workdir).expect("create workdir");
        let image_path = workdir.join("absolute.png");
        let bytes = png_like_bytes();
        fs::write(&image_path, &bytes).expect("write image");

        let response = fs_read_image_source_sync(
            workdir.display().to_string(),
            image_path.display().to_string(),
            Some("path".to_string()),
            None,
        )
        .expect("absolute image path should read");

        assert_eq!(response.kind, "image");
        assert_eq!(response.mime_type.as_deref(), Some("image/png"));
        assert_eq!(response.size_bytes, Some(bytes.len()));
        assert_eq!(
            response.data.as_deref(),
            Some(BASE64_STANDARD.encode(&bytes).as_str())
        );
        assert!(
            response.path.ends_with("absolute.png"),
            "unexpected path: {}",
            response.path
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn image_source_reads_file_url_local_path() {
        let workdir = unique_test_workdir("image-file-url");
        fs::create_dir_all(&workdir).expect("create workdir");
        let image_path = workdir.join("file-url.png");
        let bytes = png_like_bytes();
        fs::write(&image_path, &bytes).expect("write image");
        let file_url = reqwest::Url::from_file_path(&image_path).expect("build file URL");

        let response = fs_read_image_source_sync(
            workdir.display().to_string(),
            file_url.to_string(),
            Some("auto".to_string()),
            None,
        )
        .expect("file URL image path should read");

        assert_eq!(response.kind, "image");
        assert_eq!(response.mime_type.as_deref(), Some("image/png"));
        assert_eq!(response.size_bytes, Some(bytes.len()));
        assert_eq!(
            response.data.as_deref(),
            Some(BASE64_STANDARD.encode(&bytes).as_str())
        );
        assert!(
            response.path.ends_with("file-url.png"),
            "unexpected path: {}",
            response.path
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn image_source_reads_data_url_and_raw_base64() {
        let workdir = unique_test_workdir("image-base64");
        fs::create_dir_all(&workdir).expect("create workdir");
        let bytes = png_like_bytes();
        let encoded = BASE64_STANDARD.encode(&bytes);

        let data_url_response = fs_read_image_source_sync(
            workdir.display().to_string(),
            format!("data:image/png;base64,{encoded}"),
            Some("base64".to_string()),
            None,
        )
        .expect("data URL should read");
        assert_eq!(data_url_response.kind, "image");
        assert_eq!(data_url_response.mime_type.as_deref(), Some("image/png"));
        assert_eq!(data_url_response.data.as_deref(), Some(encoded.as_str()));

        let raw_response = fs_read_image_source_sync(
            workdir.display().to_string(),
            encoded.clone(),
            Some("base64".to_string()),
            Some("image/png".to_string()),
        )
        .expect("raw base64 should read");
        assert_eq!(raw_response.kind, "image");
        assert_eq!(raw_response.mime_type.as_deref(), Some("image/png"));
        assert_eq!(raw_response.data.as_deref(), Some(encoded.as_str()));

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn image_source_reads_svg_path_data_url_and_inline_xml() {
        let workdir = unique_test_workdir("image-svg");
        fs::create_dir_all(&workdir).expect("create workdir");
        let svg = svg_text();
        let svg_bytes = svg.as_bytes();
        let encoded = BASE64_STANDARD.encode(svg_bytes);
        fs::write(workdir.join("logo.svg"), svg).expect("write svg");

        let path_response = fs_read_image_source_sync(
            workdir.display().to_string(),
            "logo.svg".to_string(),
            Some("path".to_string()),
            None,
        )
        .expect("svg path should read");
        assert_eq!(path_response.kind, "image");
        assert_eq!(path_response.mime_type.as_deref(), Some("image/svg+xml"));
        assert_eq!(path_response.size_bytes, Some(svg_bytes.len()));
        assert_eq!(path_response.data.as_deref(), Some(encoded.as_str()));

        let data_url_response = fs_read_image_source_sync(
            workdir.display().to_string(),
            format!("data:image/svg+xml;base64,{encoded}"),
            Some("base64".to_string()),
            None,
        )
        .expect("svg base64 data URL should read");
        assert_eq!(data_url_response.kind, "image");
        assert_eq!(
            data_url_response.mime_type.as_deref(),
            Some("image/svg+xml")
        );
        assert_eq!(data_url_response.data.as_deref(), Some(encoded.as_str()));

        let plain_data_url_response = fs_read_image_source_sync(
            workdir.display().to_string(),
            "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E"
                .to_string(),
            Some("auto".to_string()),
            None,
        )
        .expect("plain svg data URL should read");
        assert_eq!(
            plain_data_url_response.mime_type.as_deref(),
            Some("image/svg+xml")
        );
        assert_eq!(
            plain_data_url_response.data.as_deref(),
            Some(
                BASE64_STANDARD
                    .encode(r#"<svg xmlns="http://www.w3.org/2000/svg"/>"#)
                    .as_str()
            )
        );

        let invalid_plain_data_url = fs_read_image_source_sync(
            workdir.display().to_string(),
            "data:image/png,not-a-png".to_string(),
            Some("auto".to_string()),
            None,
        )
        .expect_err("non-base64 non-SVG data URL should be rejected");
        assert!(
            invalid_plain_data_url.message.contains("only supports SVG"),
            "unexpected error: {}",
            invalid_plain_data_url.message
        );

        let inline_response = fs_read_image_source_sync(
            workdir.display().to_string(),
            svg.to_string(),
            Some("auto".to_string()),
            None,
        )
        .expect("inline SVG XML should read");
        assert_eq!(inline_response.kind, "image");
        assert_eq!(inline_response.mime_type.as_deref(), Some("image/svg+xml"));
        assert_eq!(inline_response.data.as_deref(), Some(encoded.as_str()));
        assert!(
            inline_response
                .path
                .starts_with("inline-svg:image/svg+xml:"),
            "unexpected path: {}",
            inline_response.path
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn workspace_image_reads_relative_path_and_rejects_out_of_bounds_sources() {
        let workdir = unique_test_workdir("workspace-image");
        fs::create_dir_all(workdir.join("assets")).expect("create workdir");
        let bytes = png_like_bytes();
        fs::write(workdir.join("assets/preview.png"), &bytes).expect("write workspace image");

        let response = fs_read_workspace_image_sync(
            workdir.display().to_string(),
            "assets/preview.png".to_string(),
        )
        .expect("workspace image should read");

        assert_eq!(response.kind, "image");
        assert_eq!(response.path, "assets/preview.png");
        assert_eq!(response.mime_type.as_deref(), Some("image/png"));
        assert_eq!(response.size_bytes, Some(bytes.len()));
        assert_eq!(
            response.data.as_deref(),
            Some(BASE64_STANDARD.encode(&bytes).as_str())
        );

        for path in ["/tmp/liveagent-outside.png", "../outside.png", ""] {
            let error =
                fs_read_workspace_image_sync(workdir.display().to_string(), path.to_string())
                    .expect_err("out-of-bounds workspace image path should fail");
            assert!(
                matches!(error.code, FsErrorCode::InvalidPath),
                "expected invalid path error for {path:?}, got {:?}",
                error.code
            );
            assert!(!error.message.trim().is_empty(), "expected error for {path:?}");
        }

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn workspace_preview_reads_common_preview_documents() {
        let workdir = unique_test_workdir("workspace-preview");
        fs::create_dir_all(workdir.join("docs")).expect("create workdir");
        let files = [
            ("docs/page.html", "text/html", b"<h1>Hello</h1>".as_slice()),
            ("docs/readme.md", "text/markdown", b"# Hello".as_slice()),
            ("docs/file.pdf", "application/pdf", b"%PDF-1.7\n".as_slice()),
        ];

        for (path, _mime_type, bytes) in files {
            fs::write(workdir.join(path), bytes).expect("write preview file");
        }

        for (path, mime_type, bytes) in files {
            let response =
                fs_read_workspace_image_sync(workdir.display().to_string(), path.to_string())
                    .expect("workspace preview should read");
            assert_eq!(response.kind, "preview");
            assert_eq!(response.path, path);
            assert_eq!(response.mime_type.as_deref(), Some(mime_type));
            assert_eq!(response.size_bytes, Some(bytes.len()));
            assert_eq!(
                response.data.as_deref(),
                Some(BASE64_STANDARD.encode(bytes).as_str())
            );
        }

        let _ = fs::remove_dir_all(workdir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_preview_converts_rtf_to_html_on_macos() {
        let workdir = unique_test_workdir("workspace-preview-rtf");
        fs::create_dir_all(workdir.join("docs")).expect("create workdir");
        let target_path = workdir.join("docs/report.rtf");
        let rtf = r#"{\rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}\f0\pard Hello RTF\par}"#;
        fs::write(&target_path, rtf).expect("write rtf");
        let target = fs::canonicalize(&target_path).expect("canonical rtf path");

        let response = fs_read_workspace_image_sync(
            workdir.display().to_string(),
            "docs/report.rtf".to_string(),
        )
        .expect("rtf preview should convert to html");

        assert_eq!(response.kind, "preview");
        assert_eq!(response.path, "docs/report.rtf");
        assert_eq!(response.mime_type.as_deref(), Some("text/html"));
        assert_eq!(response.size_bytes, Some(rtf.len()));
        let html = String::from_utf8(
            BASE64_STANDARD
                .decode(response.data.expect("preview html data"))
                .expect("decode html data"),
        )
        .expect("html should be utf-8");
        assert!(html.contains("Hello RTF"), "unexpected html: {html}");

        let source_bytes = fs::read(&target).expect("read source rtf");
        let source_md = fs::metadata(&target).expect("source metadata");
        let cache_path = document_preview_cache_path(
            &target,
            metadata_mtime_ms(&source_md),
            source_bytes.len(),
            &hash_bytes(&source_bytes),
        );
        assert!(cache_path.exists(), "expected document preview cache file");

        let cached_html = "<html><body>Cached RTF Preview</body></html>";
        fs::write(&cache_path, cached_html).expect("overwrite cache file");
        let cached_response = fs_read_workspace_image_sync(
            workdir.display().to_string(),
            "docs/report.rtf".to_string(),
        )
        .expect("rtf preview should use cached html");
        let cached = String::from_utf8(
            BASE64_STANDARD
                .decode(cached_response.data.expect("cached preview html data"))
                .expect("decode cached html data"),
        )
        .expect("cached html should be utf-8");
        assert!(
            cached.contains("Cached RTF Preview"),
            "unexpected cached html: {cached}"
        );

        let updated_rtf = r#"{\rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}\f0\pard Updated RTF\par}"#;
        fs::write(&target, updated_rtf).expect("update rtf");
        let updated_response = fs_read_workspace_image_sync(
            workdir.display().to_string(),
            "docs/report.rtf".to_string(),
        )
        .expect("rtf preview should refresh after source change");
        let updated = String::from_utf8(
            BASE64_STANDARD
                .decode(updated_response.data.expect("updated preview html data"))
                .expect("decode updated html data"),
        )
        .expect("updated html should be utf-8");
        assert!(
            updated.contains("Updated RTF"),
            "unexpected html: {updated}"
        );
        assert!(
            !updated.contains("Cached RTF Preview"),
            "source change should not reuse stale cache: {updated}"
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn read_docx_extracts_word_text() {
        let workdir = unique_test_workdir("read-docx");
        fs::create_dir_all(&workdir).expect("create workdir");
        let docx = build_test_zip(&[(
            "word/document.xml",
            r#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello Word</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>"#,
        )]);
        fs::write(workdir.join("report.docx"), docx).expect("write docx");

        let response = fs_read_text_sync(
            workdir.display().to_string(),
            "report.docx".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("docx should read");

        assert_eq!(response.kind, "word");
        assert_eq!(
            response.mime_type.as_deref(),
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        );
        let content = response.content.expect("docx content");
        assert!(content.contains("Hello Word"), "content={content}");
        assert!(content.contains("Second paragraph"), "content={content}");

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn read_xlsx_extracts_shared_string_cells() {
        let workdir = unique_test_workdir("read-xlsx");
        fs::create_dir_all(&workdir).expect("create workdir");
        let xlsx = build_test_zip(&[
            (
                "xl/workbook.xml",
                r#"<workbook xmlns:r="r"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/sharedStrings.xml",
                r#"<sst><si><t>Name</t></si><si><t>Total</t></si></sst>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>May</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>"#,
            ),
        ]);
        fs::write(workdir.join("workbook.xlsx"), xlsx).expect("write xlsx");

        let response = fs_read_text_sync(
            workdir.display().to_string(),
            "workbook.xlsx".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("xlsx should read");

        assert_eq!(response.kind, "spreadsheet");
        let content = response.content.expect("xlsx content");
        assert!(content.contains("Sheet: Budget"), "content={content}");
        assert!(content.contains("A1=Name"), "content={content}");
        assert!(content.contains("B1=Total"), "content={content}");
        assert!(content.contains("A2=May"), "content={content}");
        assert!(content.contains("B2=42"), "content={content}");

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn read_zip_lists_archive_entries() {
        let workdir = unique_test_workdir("read-zip");
        fs::create_dir_all(&workdir).expect("create workdir");
        let zip = build_test_zip(&[("docs/readme.md", "hello"), ("src/main.rs", "fn main() {}")]);
        fs::write(workdir.join("assets.zip"), zip).expect("write zip");

        let response = fs_read_text_sync(
            workdir.display().to_string(),
            "assets.zip".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("zip should read");

        assert_eq!(response.kind, "archive");
        let content = response.content.expect("zip content");
        assert!(content.contains("ZIP entries: 2/2"), "content={content}");
        assert!(content.contains("docs/readme.md"), "content={content}");
        assert!(content.contains("src/main.rs"), "content={content}");

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn read_editable_text_returns_raw_utf8_with_version_metadata() {
        let workdir = unique_test_workdir("read-editable");
        fs::create_dir_all(workdir.join("src")).expect("create workdir");
        fs::write(workdir.join("src/main.rs"), "fn main() {}\n").expect("write file");

        let response =
            fs_read_editable_text_sync(workdir.display().to_string(), "src/main.rs".to_string())
                .expect("editable text should read");

        assert_eq!(response.path, "src/main.rs");
        assert_eq!(response.content, "fn main() {}\n");
        assert_eq!(response.size_bytes, "fn main() {}\n".len());
        assert_eq!(response.total_lines, 1);
        assert!(
            !response.content.contains("\tfn main"),
            "content must not be numbered"
        );
        assert_ne!(response.mtime_ms, 0);
        assert_eq!(
            response.content_hash,
            hash_bytes("fn main() {}\n".as_bytes())
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn path_status_reports_existing_file_directory_and_missing_path() {
        let workdir = unique_test_workdir("path-status");
        fs::create_dir_all(workdir.join("src")).expect("create workdir");
        fs::write(workdir.join("src/main.rs"), "fn main() {}\n").expect("write file");

        let file = fs_path_status_sync(workdir.display().to_string(), "src/main.rs".to_string())
            .expect("file status should succeed");
        assert_eq!(file.path, "src/main.rs");
        assert!(file.exists);
        assert_eq!(file.kind.as_deref(), Some("file"));
        assert_eq!(file.size_bytes, Some("fn main() {}\n".len() as u64));
        assert!(file.mtime_ms.unwrap_or_default() > 0);

        let dir = fs_path_status_sync(workdir.display().to_string(), "src".to_string())
            .expect("dir status should succeed");
        assert_eq!(dir.kind.as_deref(), Some("dir"));
        assert!(dir.exists);

        let missing = fs_path_status_sync(workdir.display().to_string(), "new.html".to_string())
            .expect("missing status should succeed");
        assert_eq!(missing.path, "new.html");
        assert!(!missing.exists);
        assert!(missing.kind.is_none());
        assert!(missing.size_bytes.is_none());
        assert!(missing.mtime_ms.is_none());

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn read_editable_text_rejects_invalid_targets_and_non_utf8() {
        let workdir = unique_test_workdir("read-editable-invalid");
        fs::create_dir_all(workdir.join("src")).expect("create workdir");
        fs::write(workdir.join("src/binary.bin"), [0xff, 0xfe, 0xfd]).expect("write binary");
        fs::write(workdir.join("src/notebook.ipynb"), "{}\n").expect("write notebook");
        fs::write(workdir.join("src/readme.pdf"), "%PDF-1.7\n").expect("write pdf");
        fs::write(
            workdir.join("src/too-large.txt"),
            vec![b'a'; EDITABLE_TEXT_MAX_BYTES + 1],
        )
        .expect("write large file");

        let dir_error =
            fs_read_editable_text_sync(workdir.display().to_string(), "src".to_string())
                .expect_err("directory should fail");
        assert!(
            matches!(dir_error.code, FsErrorCode::NotAFile),
            "unexpected error: {:?}",
            dir_error.code
        );
        assert_eq!(dir_error.entry_kind.as_deref(), Some("dir"));

        let utf8_error =
            fs_read_editable_text_sync(workdir.display().to_string(), "src/binary.bin".to_string())
                .expect_err("invalid UTF-8 should fail");
        assert!(
            matches!(utf8_error.code, FsErrorCode::NotUtf8),
            "unexpected error: {:?}",
            utf8_error.code
        );
        assert_eq!(utf8_error.path.as_deref(), Some("src/binary.bin"));

        for (path, expected) in [
            ("src/notebook.ipynb", "Notebook"),
            ("src/readme.pdf", "PDF"),
        ] {
            let error = fs_read_editable_text_sync(workdir.display().to_string(), path.to_string())
                .expect_err("unsupported preview file should fail");
            assert!(
                matches!(error.code, FsErrorCode::UnsupportedTarget),
                "unexpected error for {path}: {:?}",
                error.code
            );
            assert!(
                error.message.contains(expected),
                "unexpected error for {path}: {}",
                error.message
            );
        }

        let large_error = fs_read_editable_text_sync(
            workdir.display().to_string(),
            "src/too-large.txt".to_string(),
        )
        .expect_err("large file should fail");
        assert!(
            matches!(large_error.code, FsErrorCode::TooLarge),
            "unexpected error: {:?}",
            large_error.code
        );
        assert!(
            large_error.message.contains("too large"),
            "unexpected error: {}",
            large_error.message
        );

        for path in ["", "/tmp/liveagent-outside", "../outside"] {
            let error = fs_read_editable_text_sync(workdir.display().to_string(), path.to_string())
                .expect_err("invalid path should fail");
            assert!(
                matches!(error.code, FsErrorCode::InvalidPath),
                "expected invalid path error for {path:?}, got {:?}",
                error.code
            );
        }

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn create_dir_creates_project_directory_and_rejects_invalid_targets() {
        let workdir = unique_test_workdir("create-dir");
        fs::create_dir_all(&workdir).expect("create workdir");

        let response = fs_create_dir_sync(workdir.display().to_string(), "src".to_string())
            .expect("create dir should succeed");
        assert_eq!(response.path, "src");
        assert_eq!(response.kind, "dir");
        assert!(workdir.join("src").is_dir());

        for path in ["", "/tmp/liveagent-outside", "../outside", "src"] {
            let error = fs_create_dir_sync(workdir.display().to_string(), path.to_string())
                .expect_err("invalid or existing target should fail");
            assert!(!error.message.trim().is_empty(), "expected error for {path:?}");
        }

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn rename_handles_files_and_directories_without_overwrite_or_moves() {
        let workdir = unique_test_workdir("rename");
        fs::create_dir_all(workdir.join("src")).expect("create src");
        fs::write(workdir.join("src/old.txt"), "old").expect("write old");

        let file_response = fs_rename_sync(
            workdir.display().to_string(),
            "src/old.txt".to_string(),
            "src/new.txt".to_string(),
        )
        .expect("rename file should succeed");
        assert_eq!(file_response.from_path, "src/old.txt");
        assert_eq!(file_response.path, "src/new.txt");
        assert_eq!(file_response.kind, "file");
        assert!(!workdir.join("src/old.txt").exists());
        assert!(workdir.join("src/new.txt").is_file());

        fs::create_dir_all(workdir.join("src/dir-old/nested")).expect("create dir");
        let dir_response = fs_rename_sync(
            workdir.display().to_string(),
            "src/dir-old".to_string(),
            "src/dir-new".to_string(),
        )
        .expect("rename directory should succeed");
        assert_eq!(dir_response.path, "src/dir-new");
        assert_eq!(dir_response.kind, "dir");
        assert!(workdir.join("src/dir-new/nested").is_dir());

        fs::write(workdir.join("src/existing.txt"), "existing").expect("write existing");
        let overwrite_error = fs_rename_sync(
            workdir.display().to_string(),
            "src/new.txt".to_string(),
            "src/existing.txt".to_string(),
        )
        .expect_err("rename should reject overwrite");
        assert!(
            overwrite_error.message.contains("already exists"),
            "unexpected error: {}",
            overwrite_error.message
        );

        fs::create_dir_all(workdir.join("other")).expect("create other");
        let move_error = fs_rename_sync(
            workdir.display().to_string(),
            "src/new.txt".to_string(),
            "other/new.txt".to_string(),
        )
        .expect_err("rename should reject cross-directory move");
        assert!(
            move_error.message.contains("same directory"),
            "unexpected error: {}",
            move_error.message
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn delete_removes_files_empty_dirs_and_non_empty_dirs() {
        let workdir = unique_test_workdir("delete");
        fs::create_dir_all(workdir.join("empty")).expect("create empty");
        fs::create_dir_all(workdir.join("nested/child")).expect("create nested");
        fs::write(workdir.join("file.txt"), "file").expect("write file");
        fs::write(workdir.join("nested/child/file.txt"), "file").expect("write nested file");

        let file_response = fs_delete_sync(workdir.display().to_string(), "file.txt".to_string())
            .expect("delete file should succeed");
        assert_eq!(file_response.kind, "file");
        assert!(!workdir.join("file.txt").exists());

        let empty_response = fs_delete_sync(workdir.display().to_string(), "empty".to_string())
            .expect("delete empty dir should succeed");
        assert_eq!(empty_response.kind, "dir");
        assert!(!workdir.join("empty").exists());

        let nested_response = fs_delete_sync(workdir.display().to_string(), "nested".to_string())
            .expect("delete non-empty dir should succeed");
        assert_eq!(nested_response.kind, "dir");
        assert!(!workdir.join("nested").exists());

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn list_dirs_returns_sorted_directories_and_truncates() {
        let workdir = unique_test_workdir("list-dirs");
        fs::create_dir_all(workdir.join("zeta")).expect("create zeta");
        fs::create_dir_all(workdir.join("Alpha")).expect("create alpha");
        fs::write(workdir.join("file.txt"), "file").expect("write file");

        let response = fs_list_dirs_sync(workdir.display().to_string(), Some(1))
            .expect("list dirs should succeed");

        assert_eq!(response.path, workdir.display().to_string());
        assert!(response.truncated);
        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.entries[0].name, "Alpha");
        assert_eq!(
            response.entries[0].path,
            display_path(&workdir.join("Alpha"))
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn list_respects_gitignore_and_rejects_outside_paths() {
        let workdir = unique_test_workdir("list-ignore");
        fs::create_dir_all(workdir.join("src")).expect("create src");
        fs::create_dir_all(workdir.join("ignored_dir")).expect("create ignored dir");
        fs::write(
            workdir.join(".gitignore"),
            "ignored_dir/\nignored_file.txt\n",
        )
        .expect("write gitignore");
        fs::write(workdir.join("src/app.ts"), "export {}").expect("write app");
        fs::write(workdir.join("ignored_dir/hidden.ts"), "hidden").expect("write hidden");
        fs::write(workdir.join("ignored_file.txt"), "hidden").expect("write ignored file");

        let response = fs_list_sync(
            workdir.display().to_string(),
            None,
            Some(3),
            None,
            Some(100),
        )
        .expect("list should succeed");
        let paths = response
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"src/app.ts"));
        assert!(
            !paths.iter().any(|path| path.starts_with("ignored_dir")),
            ".gitignore directory entries should be skipped: {paths:?}"
        );
        assert!(
            !paths.contains(&"ignored_file.txt"),
            ".gitignore file entries should be skipped: {paths:?}"
        );

        let outside_error = fs_list_sync(
            workdir.display().to_string(),
            Some("../outside".to_string()),
            Some(1),
            None,
            Some(10),
        )
        .expect_err("outside path should fail");
        assert!(
            matches!(outside_error.code, FsErrorCode::InvalidPath),
            "unexpected error: {:?}",
            outside_error.code
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[cfg(unix)]
    #[test]
    fn create_dir_and_rename_reject_out_of_bounds_symlink_parents() {
        let workdir = unique_test_workdir("symlink-boundary");
        let outside = unique_test_workdir("symlink-outside");
        fs::create_dir_all(&workdir).expect("create workdir");
        fs::create_dir_all(&outside).expect("create outside");
        std::os::unix::fs::symlink(&outside, workdir.join("outside_link")).expect("create symlink");

        let create_error = fs_create_dir_sync(
            workdir.display().to_string(),
            "outside_link/new-dir".to_string(),
        )
        .expect_err("create dir should reject symlink parent outside workdir");
        assert!(
            matches!(create_error.code, FsErrorCode::OutOfBounds),
            "unexpected error: {:?}",
            create_error.code
        );

        fs::write(outside.join("old.txt"), "outside").expect("write outside");
        let rename_error = fs_rename_sync(
            workdir.display().to_string(),
            "outside_link/old.txt".to_string(),
            "outside_link/new.txt".to_string(),
        )
        .expect_err("rename should reject symlink parent outside workdir");
        assert!(
            matches!(rename_error.code, FsErrorCode::OutOfBounds),
            "unexpected error: {:?}",
            rename_error.code
        );

        let _ = fs::remove_dir_all(workdir);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn mention_list_skips_common_dependency_directories_without_gitignore() {
        let workdir = unique_test_workdir("mention-ignore");
        fs::create_dir_all(workdir.join("src")).expect("create src");
        fs::create_dir_all(workdir.join("node_modules/pkg")).expect("create node_modules");
        fs::write(workdir.join("src/app.ts"), "export {}").expect("write app");
        fs::write(workdir.join("node_modules/pkg/ignored.ts"), "export {}").expect("write ignored");

        let response = fs_mention_list_sync(workdir.display().to_string(), Some(100), None)
            .expect("mention list should succeed");
        let paths = response
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"src/app.ts"));
        assert!(
            !paths.iter().any(|path| path.starts_with("node_modules")),
            "node_modules entries should be skipped: {paths:?}"
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn mention_list_respects_gitignore_without_git_repository() {
        let workdir = unique_test_workdir("mention-gitignore");
        fs::create_dir_all(workdir.join("src")).expect("create src");
        fs::create_dir_all(workdir.join("ignored_dir")).expect("create ignored dir");
        fs::write(
            workdir.join(".gitignore"),
            "ignored_dir/\nignored_file.txt\n",
        )
        .expect("write gitignore");
        fs::write(workdir.join("src/app.ts"), "export {}").expect("write app");
        fs::write(workdir.join("ignored_dir/hidden.ts"), "export {}").expect("write hidden");
        fs::write(workdir.join("ignored_file.txt"), "hidden").expect("write ignored file");

        let response = fs_mention_list_sync(workdir.display().to_string(), Some(100), None)
            .expect("mention list should succeed");
        let paths = response
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"src/app.ts"));
        assert!(
            !paths.iter().any(|path| path.starts_with("ignored_dir")),
            ".gitignore directory entries should be skipped: {paths:?}"
        );
        assert!(
            !paths.contains(&"ignored_file.txt"),
            ".gitignore file entries should be skipped: {paths:?}"
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn mention_list_query_filters_and_ranks_filename_matches() {
        let workdir = unique_test_workdir("mention-query");
        fs::create_dir_all(workdir.join("src/deep")).expect("create dirs");
        fs::write(workdir.join("src/deep/other-needle.ts"), "").expect("write other");
        fs::write(workdir.join("src/needle.ts"), "").expect("write needle");
        fs::write(workdir.join("src/unrelated.ts"), "").expect("write unrelated");

        let response = fs_mention_list_sync(
            workdir.display().to_string(),
            Some(10),
            Some("needle".to_string()),
        )
        .expect("mention list should succeed");
        let paths = response
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths.first(), Some(&"src/needle.ts"));
        assert!(paths.contains(&"src/deep/other-needle.ts"));
        assert!(!paths.contains(&"src/unrelated.ts"));

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn read_missing_file_reports_not_found_with_did_you_mean() {
        let workdir = unique_test_workdir("not-found-suggestion");
        fs::create_dir_all(&workdir).expect("create workdir");
        fs::write(workdir.join("App.tsx"), "export {}").expect("write file");

        let error = fs_read_text_sync(
            workdir.display().to_string(),
            "App.tx".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect_err("missing file should fail");

        assert!(
            matches!(error.code, FsErrorCode::NotFound),
            "unexpected error: {:?}",
            error.code
        );
        assert_eq!(error.path.as_deref(), Some("App.tx"));
        assert!(
            error.did_you_mean.iter().any(|value| value == "App.tsx"),
            "expected App.tsx suggestion, got {:?}",
            error.did_you_mean
        );

        let _ = fs::remove_dir_all(workdir);
    }

    #[cfg(unix)]
    #[test]
    fn path_status_reports_same_file_id_for_case_variant_queries() {
        let workdir = unique_test_workdir("case-identity");
        fs::create_dir_all(&workdir).expect("create workdir");
        fs::write(workdir.join("App.tsx"), "export {}").expect("write file");

        let exact = fs_path_status_sync(workdir.display().to_string(), "App.tsx".to_string())
            .expect("exact case status should succeed");
        assert!(exact.exists);
        assert!(exact.file_id.is_some());

        let lower = fs_path_status_sync(workdir.display().to_string(), "app.tsx".to_string())
            .expect("lowercase status should succeed");
        if !lower.exists {
            return;
        }
        assert!(lower.file_id.is_some());
        assert_eq!(exact.file_id, lower.file_id);

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn list_glob_grep_accept_file_targets() {
        let workdir = unique_test_workdir("file-targets");
        fs::create_dir_all(workdir.join("src")).expect("create workdir");
        fs::write(workdir.join("src/app.ts"), "export const needle = 1;\n").expect("write file");
        fs::write(workdir.join("src/other.ts"), "export {}\n").expect("write other");

        let list = fs_list_sync(
            workdir.display().to_string(),
            Some("src/app.ts".to_string()),
            None,
            None,
            None,
        )
        .expect("list should accept a file target");
        assert_eq!(list.target_kind.as_deref(), Some("file"));
        assert_eq!(list.total, 1);
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].path, "src/app.ts");
        assert_eq!(list.entries[0].kind, "file");

        let glob = fs_glob_sync(
            workdir.display().to_string(),
            Some("src/app.ts".to_string()),
            "*.ts".to_string(),
            None,
            None,
            None,
        )
        .expect("glob should accept a file target");
        assert_eq!(glob.target_kind.as_deref(), Some("file"));
        assert!(
            glob.paths.contains(&"src/app.ts".to_string()),
            "unexpected glob paths: {:?}",
            glob.paths
        );

        let grep = fs_grep_sync(
            workdir.display().to_string(),
            Some("src/app.ts".to_string()),
            "needle".to_string(),
            Some("*.md".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("grep should accept a file target");
        assert_eq!(grep.target_kind.as_deref(), Some("file"));
        assert_eq!(grep.match_count, 1);
        assert_eq!(grep.matches.len(), 1);
        assert_eq!(grep.matches[0].path, "src/app.ts");

        let _ = fs::remove_dir_all(workdir);
    }

    #[test]
    fn write_response_file_id_matches_path_status() {
        let workdir = unique_test_workdir("write-file-id");
        fs::create_dir_all(&workdir).expect("create workdir");

        let write = fs_write_text_sync(
            workdir.display().to_string(),
            "notes.txt".to_string(),
            "hello\n".to_string(),
            "rewrite".to_string(),
            None,
            None,
        )
        .expect("write should succeed");
        assert!(write.file_id.is_some());

        let status = fs_path_status_sync(workdir.display().to_string(), "notes.txt".to_string())
            .expect("status should succeed");
        assert!(status.exists);
        assert_eq!(write.file_id, status.file_id);

        let _ = fs::remove_dir_all(workdir);
    }
}
