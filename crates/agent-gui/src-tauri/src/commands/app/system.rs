use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use regex::Regex;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, TryLockError};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::runtime::platform::expand_tilde_path;
use crate::services::power_activity::PowerActivityManager;
pub use crate::services::skills::{
    SystemListSkillFilesResponse, SystemManageSkillResponse, SystemReadSkillMetadataResponse,
    SystemReadSkillTextResponse,
};

const UPLOADED_IMAGE_PREVIEW_MAX_BYTES: usize = 5 * 1024 * 1024; // 5MB
const UPLOADED_NATIVE_ATTACHMENT_MAX_BYTES: u64 = 25 * 1024 * 1024; // 25MB
pub(crate) const DEBUG_SANITIZER_VERSION: u32 = 3;
const LEGACY_DEBUG_DIR_NAME: &str = "debug";
const MAX_DEBUG_LOG_ENTRY_BYTES: usize = 1024 * 1024;
const MAX_DEBUG_LOG_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_DEBUG_LOG_DIRECTORY_BYTES: u64 = 100 * 1024 * 1024;
const MAX_DEBUG_LOG_DIRECTORY_FILES: usize = 128;
const UNLEASED_DEBUG_LOG_GRACE: Duration = Duration::from_secs(10 * 60);
const MAX_DEBUG_VALUE_DEPTH: usize = 64;
const LEGACY_DEBUG_WARNING_MARKER: &str = "SECURITY-WARNING-legacy-debug-cleanup.txt";
const DEBUG_LOG_QUOTA_LOCK_FILE: &str = ".quota.lock";
const DEBUG_PROCESS_LEASE_PREFIX: &str = ".lease.";
const REDACTED_DEBUG_CREDENTIAL: &str = "[redacted credential]";
const REDACTED_DEBUG_CREDENTIAL_TEXT: &str = "[redacted credential-bearing text]";
const REDACTED_NESTED_DEBUG_VALUE: &str = "[redacted deeply nested debug value]";
static DEBUG_LOGS_PREPARED: Mutex<bool> = Mutex::new(false);
static DEBUG_PROCESS_LEASE: Mutex<Option<fs::File>> = Mutex::new(None);
static DEBUG_LOG_WRITE_LOCK: Mutex<()> = Mutex::new(());
static DEBUG_PROCESS_FILE_SUFFIX: LazyLock<String> =
    LazyLock::new(|| format!("{}-{}", std::process::id(), Uuid::new_v4()));
static DEBUG_CREDENTIAL_ASSIGNMENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)["']?([a-z][a-z0-9_.-]*)["']?\s*[:=]"#)
        .expect("debug credential assignment regex must compile")
});
static DEBUG_HEADER_PAIR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)["']([a-z][a-z0-9_.-]*)["']\s*,"#)
        .expect("debug header pair regex must compile")
});
static DEBUG_PRIVATE_KEY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
        .expect("debug private key regex must compile")
});
static DEBUG_AUTH_SCHEME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[\s:,])bearer\s+[^\s,;]+").expect("debug auth scheme regex must compile")
});
static DEBUG_URL_USERINFO_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@")
        .expect("debug URL userinfo regex must compile")
});
static DEBUG_DATA_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*data:[^,;]*;base64,").expect("debug data URL regex must compile")
});
static DEBUG_LOG_FILE_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^.+\.([0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$",
    )
    .expect("debug log filename regex must compile")
});

#[derive(Debug, Clone, Copy)]
struct DebugLogDirectoryLimits {
    max_bytes: u64,
    max_files: usize,
    unleased_grace: Duration,
}

impl DebugLogDirectoryLimits {
    const PRODUCTION: Self = Self {
        max_bytes: MAX_DEBUG_LOG_DIRECTORY_BYTES,
        max_files: MAX_DEBUG_LOG_DIRECTORY_FILES,
        unleased_grace: UNLEASED_DEBUG_LOG_GRACE,
    };
}

#[derive(Debug, Default)]
pub(crate) struct DebugLogPreparationReport {
    pub(crate) legacy_cleanup_warning: Option<String>,
    pub(crate) maintenance_warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DebugProcessLeaseStatus {
    Active,
    Stale,
    Unknown,
}

#[derive(Debug)]
struct DebugLogPruneCandidate {
    path: PathBuf,
    file_name: String,
    size_bytes: u64,
    modified: SystemTime,
}

#[derive(Debug, Default)]
struct DebugLogInventory {
    total_bytes: u64,
    total_files: usize,
    prune_candidates: Vec<DebugLogPruneCandidate>,
    stale_lease_paths: Vec<PathBuf>,
    target_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
struct DebugAppendPlan {
    existing_bytes: u64,
    final_bytes: u64,
    needs_separator: bool,
    truncate: bool,
    existed: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemReadableFileEntry {
    pub relative_path: String,
    pub absolute_path: String,
    pub file_name: String,
    pub kind: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPickReadableFilesResponse {
    pub files: Vec<SystemReadableFileEntry>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SystemReadableFileUploadInput {
    pub file_name: String,
    pub mime_type: Option<String>,
    pub content: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUploadedReadableFileInput {
    pub file_name: String,
    pub mime_type: Option<String>,
    pub content_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPastedTextInput {
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUploadedImagePreviewResponse {
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUploadedNativeAttachmentResponse {
    pub mime_type: String,
    pub data: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCreateProjectFolderResponse {
    pub path: String,
}

fn app_storage_dir() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Failed to locate the user home directory".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create the application directory: {e}"))?;
    Ok(dir)
}

fn legacy_debug_root_dir(storage_dir: &Path) -> PathBuf {
    storage_dir.join(LEGACY_DEBUG_DIR_NAME)
}

fn current_debug_root_dir_in(storage_dir: &Path) -> Result<PathBuf, String> {
    let dir = storage_dir.join(format!("debug-v{DEBUG_SANITIZER_VERSION}"));
    fs::create_dir_all(&dir).map_err(|e| format!("创建 debug 目录失败：{e}"))?;
    let metadata = fs::symlink_metadata(&dir)
        .map_err(|e| format!("检查 debug 目录 {} 失败：{e}", dir.display()))?;
    if !metadata.file_type().is_dir() {
        return Err(format!(
            "debug 路径必须是真实目录，不能是文件或符号链接：{}",
            dir.display()
        ));
    }
    #[cfg(unix)]
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("收紧 debug 目录权限 {} 失败：{e}", dir.display()))?;
    Ok(dir)
}

fn current_debug_root_dir() -> Result<PathBuf, String> {
    current_debug_root_dir_in(&app_storage_dir()?)
}

fn set_private_file_permissions(file: &fs::File, path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("收紧文件权限 {} 失败：{error}", path.display()))?;
    Ok(())
}

fn open_or_create_private_control_file(path: &Path) -> Result<fs::File, String> {
    loop {
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err(format!(
                    "debug 控制路径必须是真实文件，不能是目录或符号链接：{}",
                    path.display()
                ));
            }
            Ok(_) => {
                let file = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(path)
                    .map_err(|error| {
                        format!("打开 debug 控制文件 {} 失败：{error}", path.display())
                    })?;
                set_private_file_permissions(&file, path)?;
                return Ok(file);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut options = fs::OpenOptions::new();
                options.read(true).write(true).create_new(true);
                #[cfg(unix)]
                options.mode(0o600);
                match options.open(path) {
                    Ok(file) => {
                        set_private_file_permissions(&file, path)?;
                        return Ok(file);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => {
                        return Err(format!(
                            "创建 debug 控制文件 {} 失败：{error}",
                            path.display()
                        ));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "检查 debug 控制文件 {} 失败：{error}",
                    path.display()
                ));
            }
        }
    }
}

fn open_and_lock_debug_quota_file(debug_root: &Path) -> Result<fs::File, String> {
    let path = debug_root.join(DEBUG_LOG_QUOTA_LOCK_FILE);
    let file = open_or_create_private_control_file(&path)?;
    file.lock()
        .map_err(|error| format!("锁定 debug 目录配额文件 {} 失败：{error}", path.display()))?;
    Ok(file)
}

fn validate_debug_process_suffix(process_file_suffix: &str) -> Result<(), String> {
    let Some((pid, nonce)) = process_file_suffix.split_once('-') else {
        return Err("非法的 debug 进程标识".to_string());
    };
    if pid.is_empty()
        || !pid.bytes().all(|byte| byte.is_ascii_digit())
        || Uuid::parse_str(nonce).is_err()
    {
        return Err("非法的 debug 进程标识".to_string());
    }
    Ok(())
}

fn debug_process_lease_path(debug_root: &Path, process_file_suffix: &str) -> PathBuf {
    debug_root.join(format!("{DEBUG_PROCESS_LEASE_PREFIX}{process_file_suffix}"))
}

fn acquire_debug_process_lease(
    debug_root: &Path,
    process_file_suffix: &str,
) -> Result<fs::File, String> {
    validate_debug_process_suffix(process_file_suffix)?;
    let path = debug_process_lease_path(debug_root, process_file_suffix);
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options
        .open(&path)
        .map_err(|error| format!("创建 debug 进程 lease {} 失败：{error}", path.display()))?;
    set_private_file_permissions(&file, &path)?;
    file.lock()
        .map_err(|error| format!("锁定 debug 进程 lease {} 失败：{error}", path.display()))?;
    Ok(file)
}

fn write_legacy_debug_warning_marker(storage_dir: &Path, warning: &str) -> Result<(), String> {
    let path = storage_dir.join(LEGACY_DEBUG_WARNING_MARKER);
    let mut file = open_or_create_private_control_file(&path)?;
    file.set_len(0)
        .map_err(|error| format!("清空安全警告 marker {} 失败：{error}", path.display()))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("定位安全警告 marker {} 失败：{error}", path.display()))?;
    file.write_all(warning.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|error| format!("写入安全警告 marker {} 失败：{error}", path.display()))?;
    file.flush()
        .map_err(|error| format!("刷新安全警告 marker {} 失败：{error}", path.display()))?;
    set_private_file_permissions(&file, &path)?;
    Ok(())
}

fn remove_legacy_debug_warning_marker(storage_dir: &Path) -> Result<(), String> {
    let path = storage_dir.join(LEGACY_DEBUG_WARNING_MARKER);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.file_type().is_file() => Err(format!(
            "安全警告 marker 必须是真实文件，不能是目录或符号链接：{}",
            path.display()
        )),
        Ok(_) => fs::remove_file(&path)
            .map_err(|error| format!("删除安全警告 marker {} 失败：{error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "检查安全警告 marker {} 失败：{error}",
            path.display()
        )),
    }
}

fn sanitize_debug_file_stem(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("对话 ID 不能为空".to_string());
    }
    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Ok(trimmed.to_string());
    }
    Err(format!("非法的对话 ID：{input}"))
}

fn canonicalize_upload_workdir(workdir: &str) -> Result<PathBuf, String> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err("项目目录未选择，无法导入文件".to_string());
    }

    let path = expand_tilde_path(raw);
    if !path.is_absolute() {
        return Err(format!("工作目录必须是绝对路径：{workdir}"));
    }

    let metadata =
        fs::metadata(&path).map_err(|_| format!("工作目录不存在或不可访问：{workdir}"))?;
    if !metadata.is_dir() {
        return Err(format!("工作目录不是文件夹：{workdir}"));
    }

    fs::canonicalize(&path).map_err(|e| format!("无法解析工作目录：{e}"))
}

fn infer_image_upload_kind(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp") | Some("bmp")
        | Some("svg") | Some("ico") => Some("image"),
        _ => None,
    }
}

fn infer_image_upload_mime(path: &Path) -> Option<&'static str> {
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
        Some("bmp") => Some("image/bmp"),
        Some("svg") => Some("image/svg+xml"),
        Some("ico") => Some("image/x-icon"),
        _ => None,
    }
}

fn is_pdf_upload(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("pdf")),
        Some(true)
    )
}

fn is_notebook_upload(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("ipynb")),
        Some(true)
    )
}

fn upload_extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

fn upload_file_name_lower(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_word_upload(path: &Path) -> bool {
    matches!(
        upload_extension_lower(path).as_deref(),
        Some("docx") | Some("doc")
    )
}

fn is_spreadsheet_upload(path: &Path) -> bool {
    matches!(
        upload_extension_lower(path).as_deref(),
        Some("xlsx") | Some("xlsm") | Some("xltx") | Some("xltm") | Some("xls")
    )
}

fn is_archive_upload(path: &Path) -> bool {
    let name = upload_file_name_lower(path);
    matches!(
        upload_extension_lower(path).as_deref(),
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

fn normalized_mime_matches(mime_type: Option<&str>, candidates: &[&str]) -> bool {
    let Some(normalized) = mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
    else {
        return false;
    };
    candidates.iter().any(|candidate| normalized == *candidate)
}

fn is_word_upload_mime(mime_type: Option<&str>) -> bool {
    normalized_mime_matches(
        mime_type,
        &[
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
    )
}

fn is_spreadsheet_upload_mime(mime_type: Option<&str>) -> bool {
    normalized_mime_matches(
        mime_type,
        &[
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel.sheet.macroenabled.12",
            "application/vnd.ms-excel.template.macroenabled.12",
        ],
    )
}

fn is_archive_upload_mime(mime_type: Option<&str>) -> bool {
    normalized_mime_matches(
        mime_type,
        &[
            "application/zip",
            "application/x-zip-compressed",
            "application/x-7z-compressed",
            "application/vnd.rar",
            "application/x-rar-compressed",
            "application/gzip",
            "application/x-gzip",
            "application/x-tar",
            "application/x-bzip2",
            "application/x-xz",
        ],
    )
}

fn probe_file_prefix(path: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| format!("无法打开文件 {}: {e}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut buffer = vec![0u8; max_bytes.max(1)];
    let read = reader
        .read(&mut buffer)
        .map_err(|e| format!("读取文件失败 {}: {e}", path.display()))?;
    buffer.truncate(read);
    Ok(buffer)
}

fn is_probably_utf8_text_file(path: &Path) -> Result<bool, String> {
    let buffer = probe_file_prefix(path, 32 * 1024)?;
    if buffer.is_empty() {
        return Ok(true);
    }
    if buffer.contains(&0) {
        return Ok(false);
    }
    let bytes = buffer
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(buffer.as_slice());
    Ok(std::str::from_utf8(bytes).is_ok())
}

fn is_probably_utf8_text_bytes(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    if bytes.contains(&0) {
        return false;
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    std::str::from_utf8(bytes).is_ok()
}

fn detect_upload_file_kind(path: &Path) -> Result<&'static str, String> {
    if let Some(kind) = infer_image_upload_kind(path) {
        return Ok(kind);
    }
    if is_pdf_upload(path) {
        return Ok("pdf");
    }
    if is_notebook_upload(path) {
        return Ok("notebook");
    }
    if is_word_upload(path) {
        return Ok("word");
    }
    if is_spreadsheet_upload(path) {
        return Ok("spreadsheet");
    }
    if is_archive_upload(path) {
        return Ok("archive");
    }
    if is_probably_utf8_text_file(path)? {
        return Ok("text");
    }
    Err(format!(
        "{} 不是当前 Read 支持解析的文本/图片/PDF/notebook/Word/Excel/压缩包文件",
        path.display()
    ))
}

fn detect_uploaded_bytes_kind(
    file_name: &str,
    mime_type: Option<&str>,
    bytes: &[u8],
) -> Result<&'static str, String> {
    let path = Path::new(file_name);
    let normalized_mime = mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());

    if normalized_mime
        .as_deref()
        .map(|value| value.starts_with("image/"))
        .unwrap_or(false)
    {
        return Ok("image");
    }
    if let Some(kind) = infer_image_upload_kind(path) {
        return Ok(kind);
    }
    if normalized_mime.as_deref() == Some("application/pdf") || is_pdf_upload(path) {
        return Ok("pdf");
    }
    if is_notebook_upload(path) {
        return Ok("notebook");
    }
    if is_word_upload(path) || is_word_upload_mime(mime_type) {
        return Ok("word");
    }
    if is_spreadsheet_upload(path) || is_spreadsheet_upload_mime(mime_type) {
        return Ok("spreadsheet");
    }
    if is_archive_upload(path) || is_archive_upload_mime(mime_type) {
        return Ok("archive");
    }
    if is_probably_utf8_text_bytes(bytes) {
        return Ok("text");
    }

    Err(format!(
        "{file_name} 不是当前 Read 支持解析的文本/图片/PDF/notebook/Word/Excel/压缩包文件"
    ))
}

fn sanitize_uploaded_file_name(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').trim_matches('.').to_string();
    let candidate = if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed
    };
    avoid_windows_reserved_file_name(candidate)
}

fn is_windows_reserved_file_name(input: &str) -> bool {
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

fn avoid_windows_reserved_file_name(candidate: String) -> String {
    if !is_windows_reserved_file_name(&candidate) {
        return candidate;
    }
    if let Some(dot_index) = candidate.find('.') {
        return format!(
            "{}_file{}",
            &candidate[..dot_index],
            &candidate[dot_index..]
        );
    }
    format!("{candidate}_file")
}

fn unique_path_for_copy(mut target: PathBuf) -> PathBuf {
    if !target.exists() {
        return target;
    }

    let stem = target
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string());
    let parent = target
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(PathBuf::new);

    for idx in 2..=10_000usize {
        let file_name = match ext.as_deref() {
            Some(ext) if !ext.is_empty() => format!("{stem}-{idx}.{ext}"),
            _ => format!("{stem}-{idx}"),
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    target.set_file_name(format!(
        "{}-{}",
        stem,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    target
}

fn rel_to_workdir_forward_slash(workdir: &Path, abs: &Path) -> Result<String, String> {
    abs.strip_prefix(workdir)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|_| format!("路径超出工作目录：{}", abs.display()))
}

fn upload_import_root(workdir: &Path) -> Result<PathBuf, String> {
    let batch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let root = workdir.join("uploads").join(batch.to_string());
    fs::create_dir_all(&root).map_err(|e| format!("创建上传目录失败 {}: {e}", root.display()))?;
    Ok(root)
}

fn build_readable_file_entry(
    workdir: &Path,
    destination: &Path,
    kind: &str,
    size_bytes: u64,
) -> Result<SystemReadableFileEntry, String> {
    let relative_path = rel_to_workdir_forward_slash(workdir, destination)?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&relative_path)
        .to_string();

    Ok(SystemReadableFileEntry {
        relative_path,
        absolute_path: destination.to_string_lossy().into_owned(),
        file_name,
        kind: kind.to_string(),
        size_bytes,
    })
}

fn canonicalize_uploaded_file_path(absolute_path: &str) -> Result<PathBuf, String> {
    let raw = absolute_path.trim();
    if raw.is_empty() {
        return Err("图片路径不能为空".to_string());
    }

    let path = expand_tilde_path(raw);
    if !path.is_absolute() {
        return Err(format!("图片路径必须是绝对路径：{absolute_path}"));
    }

    let metadata =
        fs::metadata(&path).map_err(|_| format!("图片文件不存在或不可访问：{absolute_path}"))?;
    if !metadata.is_file() {
        return Err(format!("图片路径不是普通文件：{absolute_path}"));
    }

    fs::canonicalize(&path).map_err(|e| format!("无法解析图片路径：{e}"))
}

fn canonicalize_uploaded_attachment_path(
    workdir: &Path,
    absolute_path: Option<&str>,
    relative_path: Option<&str>,
) -> Result<PathBuf, String> {
    let target = if let Some(raw_absolute_path) = absolute_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        canonicalize_uploaded_file_path(raw_absolute_path)?
    } else {
        let raw_relative_path = relative_path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "附件路径不能为空".to_string())?;
        let rel = Path::new(raw_relative_path);
        if rel.is_absolute()
            || rel
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(format!(
                "附件路径必须是工作目录内的相对路径：{raw_relative_path}"
            ));
        }
        let candidate = workdir.join(rel);
        let metadata = fs::metadata(&candidate)
            .map_err(|_| format!("附件文件不存在或不可访问：{raw_relative_path}"))?;
        if !metadata.is_file() {
            return Err(format!("附件路径不是普通文件：{raw_relative_path}"));
        }
        fs::canonicalize(&candidate).map_err(|e| format!("无法解析附件路径：{e}"))?
    };

    if !target.starts_with(workdir) {
        return Err(format!("附件路径超出当前工作目录：{}", target.display()));
    }
    Ok(target)
}

fn infer_native_attachment_mime(path: &Path, kind: Option<&str>) -> String {
    if let Some(mime_type) = infer_image_upload_mime(path) {
        return mime_type.to_string();
    }

    if is_pdf_upload(path) {
        return "application/pdf".to_string();
    }
    if is_notebook_upload(path) {
        return "application/json".to_string();
    }
    if is_word_upload(path) {
        return match upload_extension_lower(path).as_deref() {
            Some("doc") => "application/msword",
            _ => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }
        .to_string();
    }
    if is_spreadsheet_upload(path) {
        return match upload_extension_lower(path).as_deref() {
            Some("xls") => "application/vnd.ms-excel",
            Some("xlsm") => "application/vnd.ms-excel.sheet.macroenabled.12",
            Some("xltx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
            Some("xltm") => "application/vnd.ms-excel.template.macroenabled.12",
            _ => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
        .to_string();
    }
    if is_archive_upload(path) {
        return match upload_extension_lower(path).as_deref() {
            Some("zip") => "application/zip",
            Some("7z") => "application/x-7z-compressed",
            Some("rar") => "application/vnd.rar",
            Some("tar") => "application/x-tar",
            Some("gz") | Some("tgz") => "application/gzip",
            Some("bz2") | Some("tbz") | Some("tbz2") => "application/x-bzip2",
            Some("xz") | Some("txz") => "application/x-xz",
            _ => "application/octet-stream",
        }
        .to_string();
    }

    match kind.map(str::trim).filter(|value| !value.is_empty()) {
        Some("text") => "text/plain".to_string(),
        Some("pdf") => "application/pdf".to_string(),
        Some("notebook") => "application/json".to_string(),
        Some("word") => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string()
        }
        Some("spreadsheet") => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()
        }
        Some("archive") => "application/octet-stream".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn system_pick_readable_files_sync(
    workdir: String,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;
    let selected = FileDialog::new().set_directory(&workdir).pick_files();

    let Some(selected_paths) = selected else {
        return Ok(SystemPickReadableFilesResponse {
            files: Vec::new(),
            skipped: Vec::new(),
        });
    };

    import_readable_file_paths_into_workdir(
        &workdir,
        selected_paths,
        max_files.unwrap_or(usize::MAX),
        Vec::new(),
    )
}

fn system_import_readable_file_paths_sync(
    workdir: String,
    paths: Vec<String>,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;
    let mut selected_paths = Vec::with_capacity(paths.len());
    let mut skipped = Vec::new();

    for path in paths {
        let raw = path.trim();
        if raw.is_empty() {
            skipped.push("存在空的拖入文件路径".to_string());
            continue;
        }
        let path = expand_tilde_path(raw);
        if !path.is_absolute() {
            skipped.push(format!("拖入文件路径必须是绝对路径：{raw}"));
            continue;
        }
        selected_paths.push(path);
    }

    import_readable_file_paths_into_workdir(
        &workdir,
        selected_paths,
        max_files.unwrap_or(usize::MAX),
        skipped,
    )
}

fn import_readable_file_paths_into_workdir(
    workdir: &Path,
    selected_paths: Vec<PathBuf>,
    max_files: usize,
    mut skipped: Vec<String>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let mut import_root: Option<PathBuf> = None;
    let mut files = Vec::new();
    let mut skipped_for_limit = 0usize;

    for source in selected_paths {
        if files.len() >= max_files {
            skipped_for_limit += 1;
            continue;
        }

        let metadata = match fs::metadata(&source) {
            Ok(value) => value,
            Err(err) => {
                skipped.push(format!("{}: {err}", source.display()));
                continue;
            }
        };
        if !metadata.is_file() {
            skipped.push(format!("{}: 仅支持选择普通文件", source.display()));
            continue;
        }

        let kind = match detect_upload_file_kind(&source) {
            Ok(kind) => kind,
            Err(message) => {
                skipped.push(message);
                continue;
            }
        };

        let canonical_source = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
        let destination = if canonical_source.starts_with(workdir) {
            canonical_source
        } else {
            let import_root = match import_root.as_ref() {
                Some(root) => root.clone(),
                None => {
                    let root = upload_import_root(workdir)?;
                    import_root = Some(root.clone());
                    root
                }
            };
            let source_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("file");
            let sanitized_name = sanitize_uploaded_file_name(source_name);
            let target = unique_path_for_copy(import_root.join(sanitized_name));
            fs::copy(&source, &target).map_err(|e| {
                format!(
                    "复制文件到工作区失败 {} -> {}: {e}",
                    source.display(),
                    target.display()
                )
            })?;
            target
        };

        files.push(build_readable_file_entry(
            workdir,
            &destination,
            kind,
            metadata.len(),
        )?);
    }

    if skipped_for_limit > 0 {
        skipped.push(format!(
            "已达到上传数量上限，已忽略 {skipped_for_limit} 个额外文件"
        ));
    }

    Ok(SystemPickReadableFilesResponse { files, skipped })
}

pub(crate) fn system_import_uploaded_readable_files_sync(
    workdir: String,
    uploads: Vec<SystemReadableFileUploadInput>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;

    if uploads.is_empty() {
        return Ok(SystemPickReadableFilesResponse {
            files: Vec::new(),
            skipped: Vec::new(),
        });
    }

    let mut import_root: Option<PathBuf> = None;
    let mut files = Vec::new();
    let mut skipped = Vec::new();

    for upload in uploads {
        let source_name = upload.file_name.trim();
        if source_name.is_empty() {
            skipped.push("存在缺少文件名的上传文件".to_string());
            continue;
        }

        let kind = match detect_uploaded_bytes_kind(
            source_name,
            upload.mime_type.as_deref(),
            &upload.content,
        ) {
            Ok(kind) => kind,
            Err(message) => {
                skipped.push(message);
                continue;
            }
        };

        let import_root = match import_root.as_ref() {
            Some(root) => root.clone(),
            None => {
                let root = upload_import_root(&workdir)?;
                import_root = Some(root.clone());
                root
            }
        };

        let sanitized_name = sanitize_uploaded_file_name(source_name);
        let target = unique_path_for_copy(import_root.join(sanitized_name));
        fs::write(&target, &upload.content)
            .map_err(|e| format!("写入上传文件失败 {}: {e}", target.display()))?;

        files.push(build_readable_file_entry(
            &workdir,
            &target,
            kind,
            upload.content.len() as u64,
        )?);
    }

    Ok(SystemPickReadableFilesResponse { files, skipped })
}

fn system_import_uploaded_readable_files_from_base64_sync(
    workdir: String,
    files: Vec<SystemUploadedReadableFileInput>,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    let max_files = max_files.unwrap_or(usize::MAX);
    let mut skipped_for_limit = 0usize;
    let mut uploads = Vec::new();

    for file in files {
        if uploads.len() >= max_files {
            skipped_for_limit += 1;
            continue;
        }
        let source_name = file.file_name.trim().to_string();
        let content_base64 = file.content_base64.trim();
        let content = BASE64_STANDARD.decode(content_base64).map_err(|err| {
            if source_name.is_empty() {
                format!("解码剪贴板上传文件失败: {err}")
            } else {
                format!("解码剪贴板上传文件 {source_name} 失败: {err}")
            }
        })?;
        uploads.push(SystemReadableFileUploadInput {
            file_name: source_name,
            mime_type: file
                .mime_type
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            content,
        });
    }

    let mut response = system_import_uploaded_readable_files_sync(workdir, uploads)?;
    if skipped_for_limit > 0 {
        response.skipped.push(format!(
            "已达到上传数量上限，已忽略 {skipped_for_limit} 个额外文件"
        ));
    }
    Ok(response)
}

pub(crate) fn system_read_uploaded_image_preview_sync(
    workdir: String,
    absolute_path: String,
) -> Result<SystemUploadedImagePreviewResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;
    let target = canonicalize_uploaded_file_path(&absolute_path)?;
    if !target.starts_with(&workdir) {
        return Err(format!("图片路径超出当前工作目录：{}", target.display()));
    }
    let mime_type = infer_image_upload_mime(&target)
        .ok_or_else(|| format!("{} 不是受支持的图片文件", target.display()))?;
    let bytes = fs::read(&target).map_err(|e| format!("读取图片失败 {}: {e}", target.display()))?;
    if bytes.len() > UPLOADED_IMAGE_PREVIEW_MAX_BYTES {
        return Err(format!(
            "图片过大，无法用于聊天附件预览（{}）",
            target.display()
        ));
    }

    Ok(SystemUploadedImagePreviewResponse {
        mime_type: mime_type.to_string(),
        data: BASE64_STANDARD.encode(bytes),
    })
}

pub(crate) fn system_read_uploaded_native_attachment_sync(
    workdir: String,
    absolute_path: Option<String>,
    relative_path: Option<String>,
    kind: Option<String>,
) -> Result<SystemUploadedNativeAttachmentResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;
    let target = canonicalize_uploaded_attachment_path(
        &workdir,
        absolute_path.as_deref(),
        relative_path.as_deref(),
    )?;
    let metadata = fs::metadata(&target)
        .map_err(|e| format!("读取附件元数据失败 {}: {e}", target.display()))?;
    if metadata.len() > UPLOADED_NATIVE_ATTACHMENT_MAX_BYTES {
        return Err(format!(
            "附件过大，无法作为原生 Responses 附件内联（{}，上限 {} MiB）",
            target.display(),
            UPLOADED_NATIVE_ATTACHMENT_MAX_BYTES / 1024 / 1024
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("读取附件失败 {}: {e}", target.display()))?;

    Ok(SystemUploadedNativeAttachmentResponse {
        mime_type: infer_native_attachment_mime(&target, kind.as_deref()),
        data: BASE64_STANDARD.encode(bytes),
        size_bytes: metadata.len(),
    })
}

pub(crate) fn system_list_skill_files_sync() -> Result<SystemListSkillFilesResponse, String> {
    crate::services::skills::system_list_skill_files_sync()
}

pub(crate) fn system_read_skill_metadata_sync(
    path: String,
) -> Result<SystemReadSkillMetadataResponse, String> {
    crate::services::skills::system_read_skill_metadata_sync(path)
}

pub(crate) fn system_read_skill_text_sync(
    path: String,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    crate::services::skills::system_read_skill_text_sync(path, offset, length)
}

fn remove_legacy_debug_logs_in_with<F>(dir: &Path, mut remove_file: F) -> Result<(), String>
where
    F: FnMut(&Path) -> std::io::Result<()>,
{
    match fs::symlink_metadata(dir) {
        Ok(metadata) if !metadata.file_type().is_dir() => {
            return Err(format!(
                "旧版 debug 路径必须是真实目录，不能是文件或符号链接：{}",
                dir.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "检查旧版 debug 目录 {} 失败：{error}",
                dir.display()
            ));
        }
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            return Err(format!(
                "读取旧版 debug 目录 {} 失败：{error}",
                dir.display()
            ))
        }
    };
    let mut errors = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(format!("读取目录项失败：{error}"));
                continue;
            }
        };
        let path = entry.path();
        let is_jsonl = path.extension().and_then(|value| value.to_str()) == Some("jsonl");
        if !is_jsonl {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                errors.push(format!("读取 {} 的文件类型失败：{error}", path.display()));
                continue;
            }
        };
        if !file_type.is_file() {
            continue;
        }
        if let Err(error) = remove_file(&path) {
            errors.push(format!("删除 {} 失败：{error}", path.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("清理旧版 debug 日志失败：{}", errors.join("；")))
    }
}

#[cfg(test)]
fn remove_legacy_debug_logs_in(dir: &Path) -> Result<(), String> {
    remove_legacy_debug_logs_in_with(dir, |path| fs::remove_file(path))
}

fn prepare_debug_logs_in_with<F>(
    storage_dir: &Path,
    process_file_suffix: &str,
    limits: DebugLogDirectoryLimits,
    now: SystemTime,
    remove_file: F,
) -> Result<(DebugLogPreparationReport, fs::File), String>
where
    F: FnMut(&Path) -> std::io::Result<()>,
{
    let debug_root = current_debug_root_dir_in(storage_dir)?;
    let process_lease = acquire_debug_process_lease(&debug_root, process_file_suffix)?;
    let _quota_guard = open_and_lock_debug_quota_file(&debug_root)?;
    let mut report = DebugLogPreparationReport::default();
    let legacy_root = legacy_debug_root_dir(storage_dir);

    match remove_legacy_debug_logs_in_with(&legacy_root, remove_file) {
        Ok(()) => {
            if let Err(error) = remove_legacy_debug_warning_marker(storage_dir) {
                report.maintenance_warnings.push(error);
            }
        }
        Err(error) => {
            let mut warning = format!(
                "旧版 debug 日志清理失败；{} 中的 JSONL 可能仍包含凭据，请退出 LiveAgent 后手动删除。详情：{error}",
                legacy_root.display()
            );
            if let Err(marker_error) = write_legacy_debug_warning_marker(storage_dir, &warning) {
                warning.push_str(&format!("；安全警告 marker 写入失败：{marker_error}"));
            }
            report.legacy_cleanup_warning = Some(warning);
        }
    }

    if let Err(error) =
        prune_debug_logs_to_limits_locked(&debug_root, process_file_suffix, None, limits, now)
    {
        report
            .maintenance_warnings
            .push(format!("启动时收敛 debug 目录配额失败：{error}"));
    }

    Ok((report, process_lease))
}

fn prepare_debug_logs_in(
    storage_dir: &Path,
    process_file_suffix: &str,
) -> Result<(DebugLogPreparationReport, fs::File), String> {
    prepare_debug_logs_in_with(
        storage_dir,
        process_file_suffix,
        DebugLogDirectoryLimits::PRODUCTION,
        SystemTime::now(),
        |path| fs::remove_file(path),
    )
}

pub(crate) fn prepare_debug_logs_on_startup() -> Result<DebugLogPreparationReport, String> {
    let mut prepared = DEBUG_LOGS_PREPARED
        .lock()
        .map_err(|_| "debug sanitizer state lock poisoned".to_string())?;
    if *prepared {
        return Ok(DebugLogPreparationReport::default());
    }

    let (report, process_lease) =
        prepare_debug_logs_in(&app_storage_dir()?, &DEBUG_PROCESS_FILE_SUFFIX)?;
    let mut stored_lease = DEBUG_PROCESS_LEASE
        .lock()
        .map_err(|_| "debug process lease state lock poisoned".to_string())?;
    *stored_lease = Some(process_lease);
    *prepared = true;
    Ok(report)
}

fn normalize_debug_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_sensitive_debug_key(key: &str) -> bool {
    let normalized = normalize_debug_key(key);
    if matches!(
        normalized.as_str(),
        "hasapikey"
            | "inputtoken"
            | "outputtoken"
            | "maxtoken"
            | "totaltoken"
            | "contexttoken"
            | "prompttoken"
            | "completiontoken"
    ) {
        return false;
    }
    matches!(
        normalized.as_str(),
        "apikey"
            | "apikeys"
            | "authorization"
            | "authorizationheader"
            | "proxyauthorization"
            | "xapikey"
            | "xgoogapikey"
            | "xliveagentproxytoken"
            | "cookie"
            | "cookies"
            | "cookieheader"
            | "setcookie"
            | "token"
            | "auth"
            | "authentication"
            | "apikeyheader"
            | "authtoken"
            | "bearertoken"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "sessiontoken"
            | "securitytoken"
            | "personalaccesstoken"
            | "secret"
            | "secrets"
            | "secretkey"
            | "secretaccesskey"
            | "awssecretaccesskey"
            | "accesskeyid"
            | "awsaccesskeyid"
            | "key"
            | "access"
            | "refresh"
            | "credential"
            | "credentials"
            | "clientsecret"
            | "privatekey"
            | "password"
            | "passwords"
            | "passwd"
            | "pwd"
            | "passphrase"
            | "subscriptionkey"
            | "signingkey"
    ) || [
        "apikey",
        "token",
        "secret",
        "secretkey",
        "secretaccesskey",
        "privatekey",
        "password",
        "passwd",
        "pwd",
        "passphrase",
        "cookie",
        "cookies",
        "authorization",
        "auth",
        "accesskeyid",
        "credential",
        "credentials",
        "secrets",
        "passwords",
        "subscriptionkey",
        "signingkey",
    ]
    .iter()
    .any(|suffix| normalized.ends_with(suffix))
}

fn plain_debug_string_contains_credentials(value: &str) -> bool {
    if DEBUG_DATA_URL_RE.is_match(value)
        || DEBUG_PRIVATE_KEY_RE.is_match(value)
        || DEBUG_AUTH_SCHEME_RE.is_match(value)
        || DEBUG_URL_USERINFO_RE.is_match(value)
    {
        return true;
    }
    DEBUG_CREDENTIAL_ASSIGNMENT_RE
        .captures_iter(value)
        .filter_map(|captures| captures.get(1))
        .any(|name| is_sensitive_debug_key(name.as_str()))
        || DEBUG_HEADER_PAIR_RE
            .captures_iter(value)
            .filter_map(|captures| captures.get(1))
            .any(|name| is_sensitive_debug_key(name.as_str()))
}

fn is_json_like_debug_string(value: &str) -> bool {
    let trimmed = value.trim();
    (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
}

fn json_string_tokens_contain_sensitive_keys(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'"' {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        let mut escaped = false;
        let mut closed = false;
        while index < bytes.len() {
            let byte = bytes[index];
            index += 1;
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                closed = true;
                break;
            }
        }
        if !closed {
            return false;
        }
        let end = index;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if matches!(bytes.get(index), Some(b':') | Some(b',')) {
            if let Ok(decoded) = serde_json::from_str::<String>(&value[start..end]) {
                if is_sensitive_debug_key(&decoded) {
                    return true;
                }
            }
        }
    }
    false
}

fn debug_json_value_contains_credentials(value: &Value, depth: usize) -> bool {
    if depth >= MAX_DEBUG_VALUE_DEPTH && matches!(value, Value::Array(_) | Value::Object(_)) {
        return true;
    }
    match value {
        Value::String(text) => debug_string_contains_credentials(text, depth + 1),
        Value::Array(items) => {
            let is_sensitive_pair = items.len() > 1
                && items
                    .first()
                    .and_then(Value::as_str)
                    .is_some_and(is_sensitive_debug_key);
            is_sensitive_pair
                || items
                    .iter()
                    .any(|item| debug_json_value_contains_credentials(item, depth + 1))
        }
        Value::Object(object) => {
            let has_sensitive_name = object.len() > 1
                && object.iter().any(|(key, child)| {
                    matches!(
                        normalize_debug_key(key).as_str(),
                        "name" | "header" | "headername" | "key"
                    ) && child.as_str().is_some_and(is_sensitive_debug_key)
                });
            has_sensitive_name
                || object.iter().any(|(key, child)| {
                    is_sensitive_debug_key(key)
                        || debug_json_value_contains_credentials(child, depth + 1)
                })
        }
        _ => false,
    }
}

fn debug_string_contains_credentials(value: &str, depth: usize) -> bool {
    if plain_debug_string_contains_credentials(value) {
        return true;
    }
    if !is_json_like_debug_string(value) {
        return false;
    }
    if json_string_tokens_contain_sensitive_keys(value) || depth >= MAX_DEBUG_VALUE_DEPTH {
        return true;
    }
    serde_json::from_str::<Value>(value.trim())
        .ok()
        .is_some_and(|parsed| debug_json_value_contains_credentials(&parsed, depth + 1))
}

fn sanitize_debug_value(value: &mut Value, depth: usize) {
    if depth >= MAX_DEBUG_VALUE_DEPTH && matches!(value, Value::Array(_) | Value::Object(_)) {
        *value = Value::String(REDACTED_NESTED_DEBUG_VALUE.to_string());
        return;
    }
    match value {
        Value::String(text) if debug_string_contains_credentials(text, depth) => {
            *text = REDACTED_DEBUG_CREDENTIAL_TEXT.to_string();
        }
        Value::Array(items) => {
            let is_sensitive_pair = items
                .first()
                .and_then(Value::as_str)
                .is_some_and(is_sensitive_debug_key);
            for (index, item) in items.iter_mut().enumerate() {
                if is_sensitive_pair && index > 0 {
                    *item = Value::String(REDACTED_DEBUG_CREDENTIAL.to_string());
                } else {
                    sanitize_debug_value(item, depth + 1);
                }
            }
        }
        Value::Object(object) => {
            let has_sensitive_name = object.iter().any(|(key, child)| {
                matches!(
                    normalize_debug_key(key).as_str(),
                    "name" | "header" | "headername" | "key"
                ) && child.as_str().is_some_and(is_sensitive_debug_key)
            });
            for (key, child) in object {
                let normalized_key = normalize_debug_key(key);
                let is_named_credential_value = has_sensitive_name
                    && !matches!(
                        normalized_key.as_str(),
                        "name" | "header" | "headername" | "key"
                    );
                if is_sensitive_debug_key(key) || is_named_credential_value {
                    *child = Value::String(REDACTED_DEBUG_CREDENTIAL.to_string());
                } else {
                    sanitize_debug_value(child, depth + 1);
                }
            }
        }
        _ => {}
    }
}

fn sanitize_debug_entry(mut entry: Value) -> Result<Value, String> {
    if !entry.is_object() {
        return Err("debug entry must be a JSON object".to_string());
    }
    sanitize_debug_value(&mut entry, 0);
    entry
        .as_object_mut()
        .expect("debug entry object checked above")
        .insert(
            "sanitizerVersion".to_string(),
            Value::from(DEBUG_SANITIZER_VERSION),
        );
    Ok(entry)
}

fn validate_debug_entry_capacity(
    entry_bytes: &[u8],
    max_entry_bytes: usize,
    max_file_bytes: u64,
) -> Result<(), String> {
    if entry_bytes.len() > max_entry_bytes {
        return Err(format!(
            "调试日志单条记录过大（{} bytes，上限 {max_entry_bytes} bytes）",
            entry_bytes.len()
        ));
    }
    if entry_bytes.len() as u64 > max_file_bytes {
        return Err("调试日志单条记录超过文件容量上限".to_string());
    }
    Ok(())
}

fn plan_debug_append(
    path: &Path,
    entry_bytes: &[u8],
    max_file_bytes: u64,
) -> Result<DebugAppendPlan, String> {
    let (existing_bytes, existed) = match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(format!(
                "调试日志路径必须是真实文件，不能是目录或符号链接：{}",
                path.display()
            ));
        }
        Ok(metadata) => (metadata.len(), true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (0, false),
        Err(error) => return Err(format!("读取调试日志文件大小失败：{error}")),
    };
    let needs_separator = if existing_bytes == 0 || existing_bytes >= max_file_bytes {
        false
    } else {
        let mut existing =
            fs::File::open(path).map_err(|error| format!("检查调试日志末尾失败：{error}"))?;
        existing
            .seek(SeekFrom::End(-1))
            .map_err(|error| format!("定位调试日志末尾失败：{error}"))?;
        let mut last_byte = [0u8; 1];
        existing
            .read_exact(&mut last_byte)
            .map_err(|error| format!("读取调试日志末尾失败：{error}"))?;
        last_byte[0] != b'\n'
    };
    let appended_bytes = (entry_bytes.len() as u64)
        .checked_add(u64::from(needs_separator))
        .ok_or_else(|| "计算调试日志追加大小溢出".to_string())?;
    let truncate = existing_bytes > max_file_bytes.saturating_sub(appended_bytes);
    let final_bytes = if truncate {
        entry_bytes.len() as u64
    } else {
        existing_bytes
            .checked_add(appended_bytes)
            .ok_or_else(|| "计算调试日志文件大小溢出".to_string())?
    };
    Ok(DebugAppendPlan {
        existing_bytes,
        final_bytes,
        needs_separator,
        truncate,
        existed,
    })
}

fn write_debug_entry_with_plan(
    path: &Path,
    entry_bytes: &[u8],
    plan: DebugAppendPlan,
) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    if plan.truncate {
        options.truncate(true);
    } else {
        options.append(true);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("打开调试日志文件失败：{e}"))?;
    set_private_file_permissions(&file, path)?;
    if plan.needs_separator && !plan.truncate {
        file.write_all(b"\n")
            .map_err(|e| format!("修复调试日志行边界失败：{e}"))?;
    }
    file.write_all(entry_bytes)
        .map_err(|e| format!("写入调试日志失败：{e}"))?;
    file.flush().map_err(|e| format!("刷新调试日志失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
fn append_debug_entry_bytes(
    path: &Path,
    entry_bytes: &[u8],
    max_entry_bytes: usize,
    max_file_bytes: u64,
) -> Result<(), String> {
    validate_debug_entry_capacity(entry_bytes, max_entry_bytes, max_file_bytes)?;

    let _write_guard = DEBUG_LOG_WRITE_LOCK
        .lock()
        .map_err(|_| "debug log write lock poisoned".to_string())?;
    let plan = plan_debug_append(path, entry_bytes, max_file_bytes)?;
    write_debug_entry_with_plan(path, entry_bytes, plan)
}

fn debug_log_owner_from_file_name(file_name: &str) -> Option<String> {
    DEBUG_LOG_FILE_NAME_RE
        .captures(file_name)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().to_ascii_lowercase())
}

fn debug_process_lease_status(
    lease_path: &Path,
    process_file_suffix: &str,
    current_process_file_suffix: &str,
) -> DebugProcessLeaseStatus {
    if process_file_suffix.eq_ignore_ascii_case(current_process_file_suffix) {
        return DebugProcessLeaseStatus::Active;
    }
    let metadata = match fs::symlink_metadata(lease_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            eprintln!(
                "debug lease status unknown for {}: {error}",
                lease_path.display()
            );
            return DebugProcessLeaseStatus::Unknown;
        }
    };
    if !metadata.file_type().is_file() {
        return DebugProcessLeaseStatus::Unknown;
    }
    let file = match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lease_path)
    {
        Ok(file) => file,
        Err(error) => {
            eprintln!(
                "debug lease status unknown for {}: {error}",
                lease_path.display()
            );
            return DebugProcessLeaseStatus::Unknown;
        }
    };
    match file.try_lock() {
        Ok(()) => DebugProcessLeaseStatus::Stale,
        Err(TryLockError::WouldBlock) => DebugProcessLeaseStatus::Active,
        Err(TryLockError::Error(error)) => {
            eprintln!(
                "debug lease status unknown for {}: {error}",
                lease_path.display()
            );
            DebugProcessLeaseStatus::Unknown
        }
    }
}

fn scan_debug_log_inventory(
    debug_root: &Path,
    current_process_file_suffix: &str,
    protected_target: Option<&Path>,
    unleased_grace: Duration,
    now: SystemTime,
) -> Result<DebugLogInventory, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(debug_root)
        .map_err(|error| format!("读取 debug 目录 {} 失败：{error}", debug_root.display()))?
    {
        let entry = entry.map_err(|error| format!("读取 debug 目录项失败：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取 {} 文件类型失败：{error}", entry.path().display()))?;
        entries.push((entry.path(), entry.file_name(), file_type));
    }

    let mut lease_statuses = HashMap::new();
    let mut stale_lease_paths = Vec::new();
    for (path, file_name, _) in &entries {
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(process_file_suffix) = file_name.strip_prefix(DEBUG_PROCESS_LEASE_PREFIX) else {
            continue;
        };
        if validate_debug_process_suffix(process_file_suffix).is_err() {
            continue;
        }
        let status =
            debug_process_lease_status(path, process_file_suffix, current_process_file_suffix);
        if status == DebugProcessLeaseStatus::Stale {
            stale_lease_paths.push(path.clone());
        }
        lease_statuses.insert(process_file_suffix.to_ascii_lowercase(), status);
    }

    let mut inventory = DebugLogInventory {
        stale_lease_paths,
        ..DebugLogInventory::default()
    };
    for (path, file_name, file_type) in entries {
        if !file_type.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取 debug 日志元数据 {} 失败：{error}", path.display()))?;
        if !metadata.file_type().is_file() {
            continue;
        }
        inventory.total_bytes = inventory
            .total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "统计 debug 目录大小溢出".to_string())?;
        inventory.total_files = inventory
            .total_files
            .checked_add(1)
            .ok_or_else(|| "统计 debug 日志文件数溢出".to_string())?;
        if protected_target.is_some_and(|target| target == path) {
            inventory.target_size_bytes = Some(metadata.len());
            continue;
        }

        let file_name = file_name.to_string_lossy().into_owned();
        let Some(owner) = debug_log_owner_from_file_name(&file_name) else {
            continue;
        };
        if owner.eq_ignore_ascii_case(current_process_file_suffix) {
            continue;
        }
        let modified = match metadata.modified() {
            Ok(modified) => modified,
            Err(error) => {
                eprintln!(
                    "debug log modification time unknown for {}: {error}",
                    path.display()
                );
                continue;
            }
        };
        let eligible = match lease_statuses.get(&owner).copied() {
            Some(DebugProcessLeaseStatus::Stale) => true,
            Some(DebugProcessLeaseStatus::Active | DebugProcessLeaseStatus::Unknown) => false,
            None => now
                .duration_since(modified)
                .is_ok_and(|age| age >= unleased_grace),
        };
        if eligible {
            inventory.prune_candidates.push(DebugLogPruneCandidate {
                path,
                file_name,
                size_bytes: metadata.len(),
                modified,
            });
        }
    }
    inventory.prune_candidates.sort_by(|left, right| {
        left.modified
            .cmp(&right.modified)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    Ok(inventory)
}

fn remove_stale_debug_leases(paths: &[PathBuf]) {
    for path in paths {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!(
                "failed to remove stale debug process lease {}: {error}",
                path.display()
            ),
        }
    }
}

fn debug_quota_is_exceeded(
    total_bytes: u64,
    total_files: usize,
    limits: DebugLogDirectoryLimits,
) -> bool {
    total_bytes > limits.max_bytes || total_files > limits.max_files
}

fn prune_debug_logs_to_limits_locked(
    debug_root: &Path,
    current_process_file_suffix: &str,
    pending_append: Option<(&Path, DebugAppendPlan)>,
    limits: DebugLogDirectoryLimits,
    now: SystemTime,
) -> Result<(), String> {
    let protected_target = pending_append.map(|(path, _)| path);
    let mut inventory = scan_debug_log_inventory(
        debug_root,
        current_process_file_suffix,
        protected_target,
        limits.unleased_grace,
        now,
    )?;
    let mut prospective_bytes = inventory.total_bytes;
    let mut prospective_files = inventory.total_files;
    if let Some((target, append_plan)) = pending_append {
        match (append_plan.existed, inventory.target_size_bytes) {
            (true, Some(accounted_bytes)) if accounted_bytes == append_plan.existing_bytes => {
                prospective_bytes = prospective_bytes
                    .checked_sub(accounted_bytes)
                    .and_then(|value| value.checked_add(append_plan.final_bytes))
                    .ok_or_else(|| "计算 debug 目录写后大小溢出".to_string())?;
            }
            (false, None) => {
                prospective_bytes = prospective_bytes
                    .checked_add(append_plan.final_bytes)
                    .ok_or_else(|| "计算 debug 目录写后大小溢出".to_string())?;
                prospective_files = prospective_files
                    .checked_add(1)
                    .ok_or_else(|| "计算 debug 目录写后文件数溢出".to_string())?;
            }
            _ => {
                return Err(format!(
                    "debug 目标文件在配额扫描期间发生变化：{}",
                    target.display()
                ));
            }
        }
    }

    if debug_quota_is_exceeded(prospective_bytes, prospective_files, limits) {
        let reclaimable_bytes = inventory
            .prune_candidates
            .iter()
            .try_fold(0u64, |total, candidate| {
                total.checked_add(candidate.size_bytes)
            })
            .ok_or_else(|| "统计可回收 debug 日志大小溢出".to_string())?;
        let minimum_bytes = prospective_bytes.saturating_sub(reclaimable_bytes);
        let minimum_files = prospective_files.saturating_sub(inventory.prune_candidates.len());
        if debug_quota_is_exceeded(minimum_bytes, minimum_files, limits) {
            remove_stale_debug_leases(&inventory.stale_lease_paths);
            return Err(format!(
                "debug 目录配额不足（写后至少 {minimum_bytes} bytes/{minimum_files} files，上限 {} bytes/{} files）；活跃或状态未知的日志受到保护",
                limits.max_bytes, limits.max_files
            ));
        }
    }

    for candidate in inventory.prune_candidates.drain(..) {
        if !debug_quota_is_exceeded(prospective_bytes, prospective_files, limits) {
            break;
        }
        match fs::remove_file(&candidate.path) {
            Ok(()) => {
                prospective_bytes = prospective_bytes.saturating_sub(candidate.size_bytes);
                prospective_files = prospective_files.saturating_sub(1);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                prospective_bytes = prospective_bytes.saturating_sub(candidate.size_bytes);
                prospective_files = prospective_files.saturating_sub(1);
            }
            Err(error) => eprintln!(
                "failed to prune stale debug log {}: {error}",
                candidate.path.display()
            ),
        }
    }
    remove_stale_debug_leases(&inventory.stale_lease_paths);
    if debug_quota_is_exceeded(prospective_bytes, prospective_files, limits) {
        return Err(format!(
            "debug 目录配额不足（写后 {prospective_bytes} bytes/{prospective_files} files，上限 {} bytes/{} files）",
            limits.max_bytes, limits.max_files
        ));
    }
    Ok(())
}

fn append_debug_entry_bytes_with_quota(
    debug_root: &Path,
    path: &Path,
    process_file_suffix: &str,
    entry_bytes: &[u8],
    max_entry_bytes: usize,
    max_file_bytes: u64,
    limits: DebugLogDirectoryLimits,
    now: SystemTime,
) -> Result<(), String> {
    validate_debug_entry_capacity(entry_bytes, max_entry_bytes, max_file_bytes)?;
    let _write_guard = DEBUG_LOG_WRITE_LOCK
        .lock()
        .map_err(|_| "debug log write lock poisoned".to_string())?;
    let _quota_guard = open_and_lock_debug_quota_file(debug_root)?;
    let append_plan = plan_debug_append(path, entry_bytes, max_file_bytes)?;
    prune_debug_logs_to_limits_locked(
        debug_root,
        process_file_suffix,
        Some((path, append_plan)),
        limits,
        now,
    )?;
    write_debug_entry_with_plan(path, entry_bytes, append_plan)
}

fn persist_debug_entry_in(
    debug_root: &Path,
    process_file_suffix: &str,
    conversation_id: &str,
    entry: Value,
    max_entry_bytes: usize,
    max_file_bytes: u64,
    limits: DebugLogDirectoryLimits,
) -> Result<PathBuf, String> {
    let file_stem = sanitize_debug_file_stem(conversation_id)?;
    let entry = sanitize_debug_entry(entry)?;
    let mut entry_bytes =
        serde_json::to_vec(&entry).map_err(|e| format!("序列化调试日志失败：{e}"))?;
    entry_bytes.push(b'\n');
    let debug_path = debug_root.join(format!("{file_stem}.{process_file_suffix}.jsonl"));
    append_debug_entry_bytes_with_quota(
        debug_root,
        &debug_path,
        process_file_suffix,
        &entry_bytes,
        max_entry_bytes,
        max_file_bytes,
        limits,
        SystemTime::now(),
    )?;
    Ok(debug_path)
}

fn system_append_debug_jsonl_sync(conversation_id: String, entry: Value) -> Result<(), String> {
    let prepared = DEBUG_LOGS_PREPARED
        .lock()
        .map_err(|_| "debug sanitizer state lock poisoned".to_string())?;
    if !*prepared {
        return Err("debug logs were not safely prepared during startup".to_string());
    }
    drop(prepared);

    let debug_root = current_debug_root_dir()?;
    persist_debug_entry_in(
        &debug_root,
        &DEBUG_PROCESS_FILE_SUFFIX,
        &conversation_id,
        entry,
        MAX_DEBUG_LOG_ENTRY_BYTES,
        MAX_DEBUG_LOG_FILE_BYTES,
        DebugLogDirectoryLimits::PRODUCTION,
    )?;
    Ok(())
}

fn resolve_pick_folder_initial_dir(initial_workdir: Option<String>) -> Option<PathBuf> {
    let raw = initial_workdir?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let path = expand_tilde_path(trimmed);
    if path.is_dir() {
        return Some(path);
    }

    path.parent()
        .filter(|parent| parent.is_dir())
        .map(Path::to_path_buf)
}

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

fn validate_project_folder_name(name: &str) -> Result<&str, String> {
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

fn canonicalize_project_folder(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn system_create_project_folder_sync(
    parent: String,
    name: String,
) -> Result<SystemCreateProjectFolderResponse, String> {
    let parent_raw = parent.trim();
    if parent_raw.is_empty() {
        return Err("父目录不能为空".to_string());
    }
    let parent_path = expand_tilde_path(parent_raw);
    if !parent_path.is_absolute() {
        return Err(format!("父目录必须是绝对路径：{parent_raw}"));
    }
    let parent_meta =
        fs::metadata(&parent_path).map_err(|_| format!("父目录不存在或不可访问：{parent_raw}"))?;
    if !parent_meta.is_dir() {
        return Err(format!("父目录不是文件夹：{parent_raw}"));
    }
    let parent_path = fs::canonicalize(&parent_path).map_err(|e| format!("无法解析父目录：{e}"))?;
    let folder_name = validate_project_folder_name(&name)?;
    let target = parent_path.join(folder_name);

    match fs::metadata(&target) {
        Ok(meta) if meta.is_dir() => {
            return Ok(SystemCreateProjectFolderResponse {
                path: canonicalize_project_folder(&target),
            });
        }
        Ok(_) => {
            return Err(format!("目标路径已存在且不是文件夹：{}", target.display()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("无法访问目标路径：{error}"));
        }
    }

    match fs::create_dir(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && target.is_dir() => {}
        Err(error) => return Err(format!("创建项目目录失败：{error}")),
    }

    Ok(SystemCreateProjectFolderResponse {
        path: canonicalize_project_folder(&target),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_pick_folder(initial_workdir: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = FileDialog::new();
        if let Some(initial_dir) = resolve_pick_folder_initial_dir(initial_workdir) {
            dialog = dialog.set_directory(initial_dir);
        }

        Ok(dialog
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("system_pick_folder join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_create_project_folder(
    parent: String,
    name: String,
) -> Result<SystemCreateProjectFolderResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_create_project_folder_sync(parent, name))
        .await
        .map_err(|e| format!("system_create_project_folder join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_pick_readable_files(
    workdir: String,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_pick_readable_files_sync(workdir, max_files)
    })
    .await
    .map_err(|e| format!("system_pick_readable_files join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_import_readable_file_paths(
    workdir: String,
    paths: Vec<String>,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_import_readable_file_paths_sync(workdir, paths, max_files)
    })
    .await
    .map_err(|e| format!("system_import_readable_file_paths join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_import_uploaded_readable_files(
    workdir: String,
    files: Vec<SystemUploadedReadableFileInput>,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_import_uploaded_readable_files_from_base64_sync(workdir, files, max_files)
    })
    .await
    .map_err(|e| format!("system_import_uploaded_readable_files join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_import_pasted_texts(
    workdir: String,
    texts: Vec<SystemPastedTextInput>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let uploads = texts
            .into_iter()
            .map(|text| SystemReadableFileUploadInput {
                file_name: text.file_name,
                mime_type: Some("text/plain".to_string()),
                content: text.content.into_bytes(),
            })
            .collect();
        system_import_uploaded_readable_files_sync(workdir, uploads)
    })
    .await
    .map_err(|e| format!("system_import_pasted_texts join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_read_uploaded_image_preview(
    workdir: String,
    absolute_path: String,
) -> Result<SystemUploadedImagePreviewResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_read_uploaded_image_preview_sync(workdir, absolute_path)
    })
    .await
    .map_err(|e| format!("system_read_uploaded_image_preview join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_read_uploaded_native_attachment(
    workdir: String,
    absolute_path: Option<String>,
    relative_path: Option<String>,
    kind: Option<String>,
) -> Result<SystemUploadedNativeAttachmentResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_read_uploaded_native_attachment_sync(workdir, absolute_path, relative_path, kind)
    })
    .await
    .map_err(|e| format!("system_read_uploaded_native_attachment join failed: {e}"))?
}

#[tauri::command]
pub async fn system_list_skill_files() -> Result<SystemListSkillFilesResponse, String> {
    tauri::async_runtime::spawn_blocking(system_list_skill_files_sync)
        .await
        .map_err(|e| format!("system_list_skill_files join 失败：{e}"))?
}

#[tauri::command]
pub async fn system_ensure_builtin_skills(
) -> Result<Vec<crate::services::skills::SystemBuiltinSkillSeedResponse>, String> {
    tauri::async_runtime::spawn_blocking(crate::services::skills::ensure_builtin_agent_skills_sync)
        .await
        .map_err(|e| format!("system_ensure_builtin_skills join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_manage_skill(payload: Value) -> Result<SystemManageSkillResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::skills::system_manage_skill_sync(payload)
    })
    .await
    .map_err(|e| format!("system_manage_skill join failed: {e}"))?
}

#[tauri::command]
pub async fn system_read_skill_text(
    path: String,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_read_skill_text_sync(path, offset, length))
        .await
        .map_err(|e| format!("system_read_skill_text join failed: {e}"))?
}

#[tauri::command]
pub async fn system_read_skill_metadata(
    path: String,
) -> Result<SystemReadSkillMetadataResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_read_skill_metadata_sync(path))
        .await
        .map_err(|e| format!("system_read_skill_metadata join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_append_debug_jsonl(
    conversation_id: String,
    entry: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_append_debug_jsonl_sync(conversation_id, entry)
    })
    .await
    .map_err(|e| format!("system_append_debug_jsonl join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub fn system_begin_power_activity(
    activity_id: String,
    reason: String,
    ttl_ms: Option<u64>,
    power_activity: tauri::State<'_, Arc<PowerActivityManager>>,
) -> Result<(), String> {
    power_activity.begin(activity_id, reason, ttl_ms);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn system_end_power_activity(
    activity_id: String,
    power_activity: tauri::State<'_, Arc<PowerActivityManager>>,
) -> Result<(), String> {
    power_activity.end(activity_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn debug_test_process_suffix(pid: u32, nonce: u64) -> String {
        format!("{pid}-00000000-0000-0000-0000-{nonce:012x}")
    }

    fn debug_test_limits(
        max_bytes: u64,
        max_files: usize,
        grace_secs: u64,
    ) -> DebugLogDirectoryLimits {
        DebugLogDirectoryLimits {
            max_bytes,
            max_files,
            unleased_grace: Duration::from_secs(grace_secs),
        }
    }

    fn set_debug_test_modified(path: &Path, modified: SystemTime) {
        let file = fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open test log for timestamp update");
        file.set_times(fs::FileTimes::new().set_modified(modified))
            .expect("set test log modified time");
    }

    #[test]
    fn sanitize_uploaded_file_name_avoids_windows_reserved_names() {
        assert_eq!(
            sanitize_uploaded_file_name("safe name.txt"),
            "safe_name.txt"
        );
        assert_eq!(sanitize_uploaded_file_name("CON.txt"), "CON_file.txt");
        assert_eq!(sanitize_uploaded_file_name("aux"), "aux_file");
        assert_eq!(sanitize_uploaded_file_name("LPT9.log"), "LPT9_file.log");
        assert_eq!(sanitize_uploaded_file_name("COM0.log"), "COM0.log");
    }

    #[test]
    fn upload_import_root_uses_workdir_uploads_directory() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let workdir = std::env::temp_dir().join(format!(
            "liveagent-upload-root-test-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&workdir).expect("create test workdir");

        let root = upload_import_root(&workdir).expect("create upload root");

        assert!(
            root.starts_with(workdir.join("uploads")),
            "upload root should be under workdir/uploads: {}",
            root.display()
        );
        assert!(
            !root.starts_with(workdir.join(".liveagent")),
            "upload root must not use workdir/.liveagent: {}",
            root.display()
        );
        assert!(root.exists(), "upload root should be created");

        let _ = fs::remove_dir_all(&workdir);
    }

    #[test]
    fn create_project_folder_creates_new_directory() {
        let temp = tempdir().expect("create temp dir");
        let response = system_create_project_folder_sync(
            temp.path().to_string_lossy().into_owned(),
            "Project Alpha".to_string(),
        )
        .expect("create project folder");

        let path = PathBuf::from(response.path);
        assert!(path.is_dir());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("Project Alpha")
        );
    }

    #[test]
    fn create_project_folder_reuses_existing_directory() {
        let temp = tempdir().expect("create temp dir");
        let existing = temp.path().join("Existing");
        fs::create_dir(&existing).expect("create existing dir");

        let response = system_create_project_folder_sync(
            temp.path().to_string_lossy().into_owned(),
            "Existing".to_string(),
        )
        .expect("reuse existing dir");

        assert_eq!(
            PathBuf::from(response.path),
            existing.canonicalize().expect("canonicalize existing dir")
        );
    }

    #[test]
    fn create_project_folder_rejects_invalid_name_and_file_conflict() {
        let temp = tempdir().expect("create temp dir");
        let invalid = system_create_project_folder_sync(
            temp.path().to_string_lossy().into_owned(),
            "..".to_string(),
        )
        .expect_err("reject invalid project name");
        assert!(invalid.contains("项目名"));

        let file_path = temp.path().join("conflict");
        fs::write(&file_path, b"not a directory").expect("write conflict file");
        let conflict = system_create_project_folder_sync(
            temp.path().to_string_lossy().into_owned(),
            "conflict".to_string(),
        )
        .expect_err("reject file conflict");
        assert!(conflict.contains("不是文件夹"));
    }

    #[test]
    fn create_project_folder_rejects_missing_parent() {
        let temp = tempdir().expect("create temp dir");
        let missing_parent = temp.path().join("missing");

        let error = system_create_project_folder_sync(
            missing_parent.to_string_lossy().into_owned(),
            "Project".to_string(),
        )
        .expect_err("reject missing parent");

        assert!(error.contains("父目录不存在"));
    }

    #[test]
    fn import_uploaded_readable_files_keeps_multiple_files_in_one_batch() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let workdir = std::env::temp_dir().join(format!(
            "liveagent-upload-multiple-test-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&workdir).expect("create test workdir");

        let response = system_import_uploaded_readable_files_sync(
            workdir.to_string_lossy().into_owned(),
            vec![
                SystemReadableFileUploadInput {
                    file_name: "notes.txt".to_string(),
                    mime_type: Some("text/plain".to_string()),
                    content: b"hello".to_vec(),
                },
                SystemReadableFileUploadInput {
                    file_name: "tasks.md".to_string(),
                    mime_type: Some("text/markdown".to_string()),
                    content: b"# tasks".to_vec(),
                },
            ],
        )
        .expect("import multiple uploaded files");

        assert!(
            response.skipped.is_empty(),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(response.files.len(), 2);
        assert_eq!(response.files[0].file_name, "notes.txt");
        assert_eq!(response.files[1].file_name, "tasks.md");
        assert!(response.files[0].relative_path.starts_with("uploads/"));
        assert!(response.files[1].relative_path.starts_with("uploads/"));

        let first_parent = Path::new(&response.files[0].absolute_path)
            .parent()
            .expect("first upload parent")
            .to_path_buf();
        let second_parent = Path::new(&response.files[1].absolute_path)
            .parent()
            .expect("second upload parent")
            .to_path_buf();
        assert_eq!(
            first_parent, second_parent,
            "files selected in one upload should share a batch directory"
        );

        let _ = fs::remove_dir_all(&workdir);
    }

    #[test]
    fn import_uploaded_readable_files_from_base64_respects_max_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let workdir = std::env::temp_dir().join(format!(
            "liveagent-upload-base64-test-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&workdir).expect("create test workdir");

        let response = system_import_uploaded_readable_files_from_base64_sync(
            workdir.to_string_lossy().into_owned(),
            vec![
                SystemUploadedReadableFileInput {
                    file_name: "clipboard-a.txt".to_string(),
                    mime_type: Some("text/plain".to_string()),
                    content_base64: BASE64_STANDARD.encode("alpha"),
                },
                SystemUploadedReadableFileInput {
                    file_name: "clipboard-b.txt".to_string(),
                    mime_type: Some("text/plain".to_string()),
                    content_base64: BASE64_STANDARD.encode("beta"),
                },
            ],
            Some(1),
        )
        .expect("import base64 clipboard upload");

        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].file_name, "clipboard-a.txt");
        assert!(
            response
                .skipped
                .iter()
                .any(|item| item.contains("已忽略 1 个额外文件")),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(
            fs::read_to_string(&response.files[0].absolute_path).expect("read imported file"),
            "alpha"
        );

        let _ = fs::remove_dir_all(&workdir);
    }

    #[test]
    fn read_uploaded_native_attachment_reads_workspace_file_and_rejects_escape() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        let upload_dir = workdir.join("uploads").join("batch");
        fs::create_dir_all(&upload_dir).expect("create upload dir");
        let upload = upload_dir.join("note.txt");
        fs::write(&upload, b"hello").expect("write upload");

        let response = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            None,
            Some("uploads/batch/note.txt".to_string()),
            Some("text".to_string()),
        )
        .expect("read native attachment");

        assert_eq!(response.mime_type, "text/plain");
        assert_eq!(response.data, BASE64_STANDARD.encode(b"hello"));
        assert_eq!(response.size_bytes, 5);

        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"outside").expect("write outside file");
        let error = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            Some(outside.to_string_lossy().into_owned()),
            None,
            Some("text".to_string()),
        )
        .expect_err("outside file must be rejected");

        assert!(
            error.contains("附件路径超出当前工作目录"),
            "error = {error}"
        );
    }

    #[test]
    fn import_readable_file_paths_copies_external_files_and_honors_limit() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp_root = std::env::temp_dir().join(format!(
            "liveagent-upload-paths-test-{}-{unique}",
            std::process::id()
        ));
        let workdir = temp_root.join("workspace");
        let external = temp_root.join("external");
        fs::create_dir_all(&workdir).expect("create test workdir");
        fs::create_dir_all(&external).expect("create external dir");
        let external_file = external.join("notes.txt");
        let workspace_file = workdir.join("inside.md");
        fs::write(&external_file, "hello").expect("write external file");
        fs::write(&workspace_file, "# inside").expect("write workspace file");

        let response = system_import_readable_file_paths_sync(
            workdir.to_string_lossy().into_owned(),
            vec![
                external_file.to_string_lossy().into_owned(),
                workspace_file.to_string_lossy().into_owned(),
            ],
            Some(1),
        )
        .expect("import readable file paths");

        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].file_name, "notes.txt");
        assert!(response.files[0].relative_path.starts_with("uploads/"));
        assert!(
            response
                .skipped
                .iter()
                .any(|item| item.contains("已达到上传数量上限")),
            "skipped = {:?}",
            response.skipped
        );

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn detects_office_and_archive_upload_kinds() {
        assert_eq!(
            detect_uploaded_bytes_kind(
                "report.docx",
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                b"not validated here",
            )
            .expect("docx should be accepted"),
            "word"
        );
        assert_eq!(
            detect_uploaded_bytes_kind(
                "workbook.xlsx",
                Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                b"not validated here",
            )
            .expect("xlsx should be accepted"),
            "spreadsheet"
        );
        assert_eq!(
            detect_uploaded_bytes_kind("bundle.tar.gz", Some("application/gzip"), b"gzip")
                .expect("tar.gz should be accepted"),
            "archive"
        );
        assert_eq!(
            detect_uploaded_bytes_kind("assets.7z", Some("application/x-7z-compressed"), b"7z")
                .expect("7z should be accepted"),
            "archive"
        );
    }

    #[test]
    fn legacy_debug_cleanup_is_filename_only_and_skips_current_directory() {
        let temp = tempdir().expect("create debug temp dir");
        let legacy_root = legacy_debug_root_dir(temp.path());
        fs::create_dir(&legacy_root).expect("create legacy debug root");
        let malformed = legacy_root.join("malformed.jsonl");
        let oversized = legacy_root.join("oversized.jsonl");
        let unrelated = legacy_root.join("notes.txt");
        let jsonl_directory = legacy_root.join("nested.jsonl");
        fs::write(&malformed, br#"{"apiKey":"truncated"#).expect("write malformed legacy log");
        fs::write(
            &oversized,
            vec![b'x'; MAX_DEBUG_LOG_FILE_BYTES as usize + 1],
        )
        .expect("write oversized legacy log");
        fs::write(&unrelated, "keep").expect("write unrelated file");
        fs::create_dir(&jsonl_directory).expect("create jsonl-named directory");

        let current_root = current_debug_root_dir_in(temp.path()).expect("create current root");
        let current = current_root.join("current.1-nonce.jsonl");
        fs::write(&current, b"{truncated current tail").expect("write current log");

        remove_legacy_debug_logs_in(&legacy_root).expect("remove legacy logs without parsing");

        assert!(!malformed.exists(), "malformed legacy log must be removed");
        assert!(!oversized.exists(), "oversized legacy log must be removed");
        assert!(
            current.exists(),
            "current log directory must not be scanned"
        );
        assert!(
            unrelated.exists(),
            "unrelated debug artifact must be retained"
        );
        assert!(
            jsonl_directory.exists(),
            "directories must never be removed"
        );
        assert_ne!(
            legacy_root, current_root,
            "log generations must be isolated"
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&current_root)
                .expect("current root metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "current debug directory must be private"
        );
    }

    #[test]
    fn legacy_debug_cleanup_aggregates_all_removal_failures() {
        let temp = tempdir().expect("create debug temp dir");
        let first = temp.path().join("first.jsonl");
        let second = temp.path().join("second.jsonl");
        fs::write(&first, "first").expect("write first legacy log");
        fs::write(&second, "second").expect("write second legacy log");
        let mut attempts = Vec::new();

        let error = remove_legacy_debug_logs_in_with(temp.path(), |path| {
            attempts.push(path.to_path_buf());
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("cannot remove {}", path.display()),
            ))
        })
        .expect_err("all cleanup failures must be reported");

        assert_eq!(attempts.len(), 2, "cleanup must continue after a failure");
        assert!(error.contains("first.jsonl"), "error = {error}");
        assert!(error.contains("second.jsonl"), "error = {error}");
    }

    #[test]
    fn legacy_debug_cleanup_failure_is_reported_and_marker_is_reconciled() {
        let temp = tempdir().expect("create debug temp dir");
        let legacy_root = legacy_debug_root_dir(temp.path());
        fs::create_dir(&legacy_root).expect("create legacy debug root");
        let legacy_log = legacy_root.join("credentials.jsonl");
        fs::write(&legacy_log, r#"{"apiKey":"legacy-secret"}"#).expect("write legacy debug log");
        let now = UNIX_EPOCH + Duration::from_secs(10_000);

        let (failed_report, failed_lease) = prepare_debug_logs_in_with(
            temp.path(),
            &debug_test_process_suffix(4101, 1),
            debug_test_limits(1024, 8, 60),
            now,
            |_path| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected removal failure",
                ))
            },
        )
        .expect("legacy cleanup failure must not fail current debug preparation");
        let warning = failed_report
            .legacy_cleanup_warning
            .expect("security warning must be returned");
        assert!(warning.contains("可能仍包含凭据"), "warning = {warning}");
        assert!(legacy_log.exists(), "failed legacy log must remain");
        let marker = temp.path().join(LEGACY_DEBUG_WARNING_MARKER);
        let marker_text = fs::read_to_string(&marker).expect("read warning marker");
        assert!(marker_text.contains("可能仍包含凭据"));
        assert!(!marker_text.contains("legacy-secret"));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&marker)
                .expect("warning marker metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "warning marker must be private"
        );
        drop(failed_lease);

        let (success_report, success_lease) = prepare_debug_logs_in_with(
            temp.path(),
            &debug_test_process_suffix(4102, 2),
            debug_test_limits(1024, 8, 60),
            now,
            |path| fs::remove_file(path),
        )
        .expect("subsequent cleanup should succeed");
        assert!(success_report.legacy_cleanup_warning.is_none());
        assert!(!legacy_log.exists(), "legacy log must be removed on retry");
        assert!(
            !marker.exists(),
            "successful retry must remove warning marker"
        );
        drop(success_lease);
    }

    #[test]
    fn current_debug_path_and_process_lease_failures_remain_fatal() {
        let path_failure = tempdir().expect("create current path temp dir");
        let current_root = path_failure
            .path()
            .join(format!("debug-v{DEBUG_SANITIZER_VERSION}"));
        fs::write(&current_root, "not a directory").expect("write conflicting current path");
        let error = prepare_debug_logs_in_with(
            path_failure.path(),
            &debug_test_process_suffix(4201, 1),
            debug_test_limits(1024, 8, 0),
            SystemTime::now(),
            |path| fs::remove_file(path),
        )
        .expect_err("unsafe current debug path must remain fatal");
        assert!(error.contains("真实目录"), "error = {error}");

        let lease_failure = tempdir().expect("create lease temp dir");
        let debug_root =
            current_debug_root_dir_in(lease_failure.path()).expect("create current debug root");
        let suffix = debug_test_process_suffix(4202, 2);
        fs::write(debug_process_lease_path(&debug_root, &suffix), "collision")
            .expect("precreate conflicting lease");
        let error = prepare_debug_logs_in_with(
            lease_failure.path(),
            &suffix,
            debug_test_limits(1024, 8, 0),
            SystemTime::now(),
            |path| fs::remove_file(path),
        )
        .expect_err("lease acquisition failure must remain fatal");
        assert!(error.contains("lease"), "error = {error}");
    }

    #[cfg(unix)]
    #[test]
    fn debug_log_directories_reject_symlink_traversal() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().expect("create debug temp dir");
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).expect("create outside directory");
        let outside_log = outside.join("keep.jsonl");
        fs::write(&outside_log, "must survive").expect("write outside log");

        let legacy_link = legacy_debug_root_dir(temp.path());
        symlink(&outside, &legacy_link).expect("create legacy directory symlink");
        let legacy_error = remove_legacy_debug_logs_in(&legacy_link)
            .expect_err("legacy cleanup must not follow a directory symlink");
        assert!(legacy_error.contains("符号链接"), "error = {legacy_error}");
        assert_eq!(
            fs::read_to_string(&outside_log).expect("outside log survives"),
            "must survive"
        );

        let current_link = temp
            .path()
            .join(format!("debug-v{DEBUG_SANITIZER_VERSION}"));
        symlink(&outside, &current_link).expect("create current directory symlink");
        let current_error = current_debug_root_dir_in(temp.path())
            .expect_err("current debug directory must not follow a symlink");
        assert!(
            current_error.contains("符号链接"),
            "error = {current_error}"
        );
    }

    #[test]
    fn backend_resanitizes_untrusted_debug_entries_and_forces_version() {
        let temp = tempdir().expect("create current debug temp dir");
        let mut deep = serde_json::json!({"apiKey": "deep-raw-secret"});
        for _ in 0..(MAX_DEBUG_VALUE_DEPTH + 4) {
            deep = serde_json::json!({"nested": deep});
        }
        let untrusted = serde_json::json!({
            "sanitizerVersion": 999,
            "apiKey": "raw-api-key",
            "oauth": {"access": "raw-access", "refresh": "raw-refresh"},
            "auth": {"scheme": "Bearer", "value": "raw-auth"},
            "requestAuthorization": "Bearer raw-request-auth",
            "apiKeyHeader": "raw-header-api-key",
            "authDiagnostic": "request failed: Bearer !raw-punctuated-auth",
            "basicHeader": "Authorization: Basic raw-basic-secret",
            "credentials": ["raw-user", "raw-password"],
            "serviceCredentials": {"password": "raw-service-password"},
            "sessionCookies": {"session": "raw-cookie-map"},
            "url": "https://example.test/path?api_key=url-secret&safe=1",
            "cookieLine": "Cookie: first=one; session=cookie-secret",
            "arrayHeader": "prefix [[\"Authorization\",\"Bearer array-secret\"]]",
            "structuredHeaders": [
                ["X-API-Key", "raw-pair-secret", "raw-pair-second-secret"],
                {
                    "name": "Authorization",
                    "value": "raw-named-secret",
                    "data": "raw-named-data-secret"
                }
            ],
            "pemText": "-----BEGIN PRIVATE KEY----- raw-private -----END PRIVATE KEY-----",
            "pwd": "raw-pwd-secret",
            "signingKey": "raw-signing-secret",
            "Ocp-Apim-Subscription-Key": "raw-subscription-secret",
            "escapedJson": r#"{"api\u004bey":"raw-unicode-secret"}"#,
            "ordinaryBasic": "Please build a basic calculator app",
            "safeJson": "{\"inputToken\":9007199254740993,\"inputToken\":2}",
            "inputToken": 17,
            "deep": deep,
        });

        let path = persist_debug_entry_in(
            temp.path(),
            "test-process-a",
            "conversation",
            untrusted,
            MAX_DEBUG_LOG_ENTRY_BYTES,
            MAX_DEBUG_LOG_FILE_BYTES,
            DebugLogDirectoryLimits::PRODUCTION,
        )
        .expect("persist untrusted entry");
        let persisted = fs::read_to_string(&path).expect("read persisted entry");
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path)
                .expect("persisted log metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "debug log must be private"
        );

        for secret in [
            "raw-api-key",
            "raw-access",
            "raw-refresh",
            "raw-auth",
            "raw-request-auth",
            "raw-header-api-key",
            "raw-punctuated-auth",
            "raw-basic-secret",
            "raw-user",
            "raw-password",
            "raw-service-password",
            "raw-cookie-map",
            "url-secret",
            "cookie-secret",
            "array-secret",
            "raw-pair-secret",
            "raw-pair-second-secret",
            "raw-named-secret",
            "raw-named-data-secret",
            "raw-private",
            "raw-pwd-secret",
            "raw-signing-secret",
            "raw-subscription-secret",
            "raw-unicode-secret",
            "deep-raw-secret",
        ] {
            assert!(!persisted.contains(secret), "leaked {secret}: {persisted}");
        }
        let parsed: Value = serde_json::from_str(persisted.trim()).expect("parse persisted entry");
        assert_eq!(
            parsed.get("sanitizerVersion").and_then(Value::as_u64),
            Some(u64::from(DEBUG_SANITIZER_VERSION))
        );
        assert_eq!(parsed.get("inputToken").and_then(Value::as_u64), Some(17));
        assert_eq!(
            parsed.get("ordinaryBasic").and_then(Value::as_str),
            Some("Please build a basic calculator app")
        );
        assert_eq!(
            parsed.get("safeJson").and_then(Value::as_str),
            Some("{\"inputToken\":9007199254740993,\"inputToken\":2}"),
            "non-credential JSON strings must stay byte-for-byte stable"
        );

        let other_path = persist_debug_entry_in(
            temp.path(),
            "test-process-b",
            "conversation",
            serde_json::json!({"message": "safe"}),
            MAX_DEBUG_LOG_ENTRY_BYTES,
            MAX_DEBUG_LOG_FILE_BYTES,
            DebugLogDirectoryLimits::PRODUCTION,
        )
        .expect("persist from another process identity");
        assert_ne!(
            other_path, path,
            "process identities must never share a log file"
        );
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("conversation.test-process-a.jsonl")
        );
        assert_eq!(
            other_path.file_name().and_then(|name| name.to_str()),
            Some("conversation.test-process-b.jsonl")
        );
    }

    #[test]
    fn debug_directory_quota_prunes_oldest_unleased_logs_before_writing() {
        let temp = tempdir().expect("create quota temp dir");
        let debug_root = current_debug_root_dir_in(temp.path()).expect("create debug root");
        let oldest_suffix = debug_test_process_suffix(4301, 1);
        let newer_suffix = debug_test_process_suffix(4302, 2);
        let current_suffix = debug_test_process_suffix(4303, 3);
        let oldest = debug_root.join(format!("oldest.{oldest_suffix}.jsonl"));
        let newer = debug_root.join(format!("newer.{newer_suffix}.jsonl"));
        let target = debug_root.join(format!("current.{current_suffix}.jsonl"));
        fs::write(&oldest, b"aaaaa").expect("write oldest log");
        fs::write(&newer, b"bbbbb").expect("write newer log");
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        set_debug_test_modified(&oldest, UNIX_EPOCH + Duration::from_secs(100));
        set_debug_test_modified(&newer, UNIX_EPOCH + Duration::from_secs(200));

        append_debug_entry_bytes_with_quota(
            &debug_root,
            &target,
            &current_suffix,
            b"new\n",
            16,
            16,
            debug_test_limits(9, 2, 60),
            now,
        )
        .expect("oldest stale log should make room");

        assert!(!oldest.exists(), "oldest eligible log must be pruned first");
        assert!(newer.exists(), "newer eligible log should be retained");
        assert_eq!(fs::read(&target).expect("read target"), b"new\n");
    }

    #[test]
    fn debug_directory_quota_protects_active_logs_and_keeps_target_unchanged() {
        let temp = tempdir().expect("create active quota temp dir");
        let debug_root = current_debug_root_dir_in(temp.path()).expect("create debug root");
        let active_suffix = debug_test_process_suffix(4401, 1);
        let current_suffix = debug_test_process_suffix(4402, 2);
        let active_lease =
            acquire_debug_process_lease(&debug_root, &active_suffix).expect("acquire active lease");
        let active_lease_path = debug_process_lease_path(&debug_root, &active_suffix);
        let active_log = debug_root.join(format!("active.{active_suffix}.jsonl"));
        let target = debug_root.join(format!("current.{current_suffix}.jsonl"));
        fs::write(&active_log, b"12345678").expect("write active log");
        fs::write(&target, b"original\n").expect("write target");
        let before = fs::read(&target).expect("read target before rejection");
        let limits = debug_test_limits(17, 8, 0);

        let error = append_debug_entry_bytes_with_quota(
            &debug_root,
            &target,
            &current_suffix,
            b"new\n",
            16,
            64,
            limits,
            SystemTime::now(),
        )
        .expect_err("active logs must not be deleted to satisfy quota");
        assert!(error.contains("配额不足"), "error = {error}");
        assert_eq!(
            fs::read(&target).expect("read rejected target"),
            before,
            "quota rejection must not mutate the target"
        );
        assert!(active_log.exists(), "active log must remain");

        drop(active_lease);
        append_debug_entry_bytes_with_quota(
            &debug_root,
            &target,
            &current_suffix,
            b"new\n",
            16,
            64,
            limits,
            SystemTime::now(),
        )
        .expect("released lease should make its stale log reclaimable");
        assert!(!active_log.exists(), "stale owner log should be pruned");
        assert!(
            !active_lease_path.exists(),
            "stale lease should be cleaned up"
        );
        assert_eq!(
            fs::read(&target).expect("read appended target"),
            b"original\nnew\n"
        );
    }

    #[test]
    fn debug_directory_quota_honors_unleased_grace_and_unknown_leases() {
        let temp = tempdir().expect("create grace quota temp dir");
        let debug_root = current_debug_root_dir_in(temp.path()).expect("create debug root");
        let unleased_suffix = debug_test_process_suffix(4501, 1);
        let unknown_suffix = debug_test_process_suffix(4502, 2);
        let current_suffix = debug_test_process_suffix(4503, 3);
        let unleased_log = debug_root.join(format!("recent.{unleased_suffix}.jsonl"));
        let unknown_log = debug_root.join(format!("unknown.{unknown_suffix}.jsonl"));
        let target = debug_root.join(format!("current.{current_suffix}.jsonl"));
        fs::write(&unleased_log, b"aaaaa").expect("write unleased log");
        fs::write(&unknown_log, b"bbbbb").expect("write unknown-owner log");
        fs::create_dir(debug_process_lease_path(&debug_root, &unknown_suffix))
            .expect("create invalid lease path");
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        set_debug_test_modified(&unleased_log, now - Duration::from_secs(30));
        set_debug_test_modified(&unknown_log, UNIX_EPOCH + Duration::from_secs(100));
        let limits = debug_test_limits(9, 2, 60);

        let error = append_debug_entry_bytes_with_quota(
            &debug_root,
            &target,
            &current_suffix,
            b"new\n",
            16,
            16,
            limits,
            now,
        )
        .expect_err("recent unleased and unknown lease logs must be protected");
        assert!(error.contains("配额不足"), "error = {error}");
        assert!(!target.exists(), "rejected new target must not be created");
        assert!(unleased_log.exists());
        assert!(unknown_log.exists());

        append_debug_entry_bytes_with_quota(
            &debug_root,
            &target,
            &current_suffix,
            b"new\n",
            16,
            16,
            limits,
            now + Duration::from_secs(31),
        )
        .expect("expired unleased grace should make enough room");
        assert!(
            !unleased_log.exists(),
            "expired unleased log should be pruned"
        );
        assert!(
            unknown_log.exists(),
            "unknown lease owner must remain protected"
        );
        assert_eq!(fs::read(&target).expect("read target"), b"new\n");
    }

    #[test]
    fn debug_log_capacity_rotates_without_inspecting_existing_content() {
        let temp = tempdir().expect("create debug temp dir");
        let path = temp.path().join("current.jsonl");
        fs::write(&path, b"{truncated-tail").expect("write truncated current tail");

        append_debug_entry_bytes(&path, b"{}\n", 16, 64)
            .expect("append without parsing current file");
        assert_eq!(
            fs::read(&path).expect("read appended file"),
            b"{truncated-tail\n{}\n",
            "a truncated tail must be retained and separated from the next entry"
        );

        append_debug_entry_bytes(&path, b"second-entry\n", 16, 16)
            .expect("rotate file at capacity");
        assert_eq!(
            fs::read(&path).expect("read rotated file"),
            b"second-entry\n",
            "capacity rotation must retain the new complete entry"
        );

        let error = append_debug_entry_bytes(&path, b"entry-is-too-large\n", 8, 16)
            .expect_err("oversized entries must be rejected");
        assert!(error.contains("单条记录过大"), "error = {error}");
        assert_eq!(
            fs::read(&path).expect("read file after rejection"),
            b"second-entry\n",
            "a rejected entry must not mutate the existing log"
        );
    }
}
