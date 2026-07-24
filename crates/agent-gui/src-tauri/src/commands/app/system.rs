use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::runtime::platform::expand_tilde_path;
use crate::services::power_activity::PowerActivityManager;
pub use crate::services::skills::{
    SystemListSkillFilesResponse, SystemManageSkillResponse, SystemReadSkillMetadataResponse,
    SystemReadSkillTextResponse,
};

const UPLOADED_IMAGE_PREVIEW_MAX_BYTES: usize = 5 * 1024 * 1024; // 5MB
const UPLOADED_NATIVE_ATTACHMENT_MAX_BYTES: u64 = 25 * 1024 * 1024; // 25MB
const UPLOADED_TEXT_TRANSCODE_MAX_BYTES: u64 = 64 * 1024 * 1024; // 64MB，超出则原样落盘不转码

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

fn debug_root_dir() -> Result<PathBuf, String> {
    let dir = app_storage_dir()?.join("debug");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 debug 目录失败：{e}"))?;
    Ok(dir)
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

const UPLOAD_TEXT_PROBE_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadTextClass {
    /// 内容是合法 UTF-8（或空文件），可原样使用。
    Utf8,
    /// 内容是文本，但采用 GBK/Big5/Shift-JIS/UTF-16 等非 UTF-8 编码；
    /// 暂存副本需要转码为 UTF-8，否则下游 Read/原生附件内联全是乱码。
    NeedsTranscode,
    /// 不是可解析的文本。
    Binary,
}

/// 上传文本判定不能只做严格 UTF-8 校验：中文 Windows 上 .txt 常见 GBK/
/// UTF-16（记事本"Unicode"），且探测只取前缀，UTF-8 多字节字符被截断
/// 也会导致严格校验失败——这两类都不是二进制文件。
fn classify_upload_text_bytes(bytes: &[u8], prefix_truncated: bool) -> UploadTextClass {
    if bytes.is_empty() {
        return UploadTextClass::Utf8;
    }
    // UTF-16 BOM 要先于 NUL 检查：UTF-16 编码的 ASCII 字符必然带 0x00。
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return UploadTextClass::NeedsTranscode;
    }
    if bytes.contains(&0) {
        return UploadTextClass::Binary;
    }
    let stripped = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(stripped) {
        Ok(_) => return UploadTextClass::Utf8,
        Err(error) => {
            // 探测前缀截断了末尾多字节字符（error_len() == None 表示序列
            // 不完整而非非法），整个文件仍可能是合法 UTF-8。
            if prefix_truncated
                && error.error_len().is_none()
                && stripped.len() - error.valid_up_to() < 4
            {
                return UploadTextClass::Utf8;
            }
        }
    }
    // 无 NUL 且非 UTF-8：按控制字符占比区分传统编码文本与二进制。
    // GBK/Big5/Shift-JIS 的多字节序列全部落在 0x80 以上，正文控制字符
    // 只应出现 \t \n \r（含少量 \x0C 换页、\x1B 转义）。
    let suspicious = stripped
        .iter()
        .filter(|byte| matches!(**byte, 0x01..=0x08 | 0x0B | 0x0E..=0x1A | 0x1C..=0x1F | 0x7F))
        .count();
    if suspicious * 32 > stripped.len() {
        UploadTextClass::Binary
    } else {
        UploadTextClass::NeedsTranscode
    }
}

fn classify_upload_text_file(path: &Path) -> Result<UploadTextClass, String> {
    let buffer = probe_file_prefix(path, UPLOAD_TEXT_PROBE_BYTES)?;
    let prefix_truncated = buffer.len() == UPLOAD_TEXT_PROBE_BYTES;
    Ok(classify_upload_text_bytes(&buffer, prefix_truncated))
}

/// 把非 UTF-8 编码的文本转码为 UTF-8。输入必须是完整文件内容（分类可能
/// 基于截断前缀，这里先复查完整字节，合法 UTF-8 原样返回）。
fn transcode_upload_text_to_utf8(bytes: &[u8]) -> Vec<u8> {
    if bytes.is_empty() || std::str::from_utf8(bytes).is_ok() {
        return bytes.to_vec();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return text.into_owned().into_bytes();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        return text.into_owned().into_bytes();
    }
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned().into_bytes()
}

#[derive(Debug, Clone, Copy)]
struct DetectedUploadKind {
    kind: &'static str,
    /// 仅 kind == "text" 时可能为 true：暂存副本落盘前需转码为 UTF-8。
    needs_utf8_transcode: bool,
}

impl DetectedUploadKind {
    fn plain(kind: &'static str) -> Self {
        Self {
            kind,
            needs_utf8_transcode: false,
        }
    }

    fn from_text_class(class: UploadTextClass) -> Option<Self> {
        match class {
            UploadTextClass::Utf8 => Some(Self::plain("text")),
            UploadTextClass::NeedsTranscode => Some(Self {
                kind: "text",
                needs_utf8_transcode: true,
            }),
            UploadTextClass::Binary => None,
        }
    }
}

fn detect_upload_file_kind(path: &Path) -> Result<DetectedUploadKind, String> {
    if let Some(kind) = infer_image_upload_kind(path) {
        return Ok(DetectedUploadKind::plain(kind));
    }
    if is_pdf_upload(path) {
        return Ok(DetectedUploadKind::plain("pdf"));
    }
    if is_notebook_upload(path) {
        return Ok(DetectedUploadKind::plain("notebook"));
    }
    if is_word_upload(path) {
        return Ok(DetectedUploadKind::plain("word"));
    }
    if is_spreadsheet_upload(path) {
        return Ok(DetectedUploadKind::plain("spreadsheet"));
    }
    if is_archive_upload(path) {
        return Ok(DetectedUploadKind::plain("archive"));
    }
    if let Some(detected) = DetectedUploadKind::from_text_class(classify_upload_text_file(path)?) {
        return Ok(detected);
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
) -> Result<DetectedUploadKind, String> {
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
        return Ok(DetectedUploadKind::plain("image"));
    }
    if let Some(kind) = infer_image_upload_kind(path) {
        return Ok(DetectedUploadKind::plain(kind));
    }
    if normalized_mime.as_deref() == Some("application/pdf") || is_pdf_upload(path) {
        return Ok(DetectedUploadKind::plain("pdf"));
    }
    if is_notebook_upload(path) {
        return Ok(DetectedUploadKind::plain("notebook"));
    }
    if is_word_upload(path) || is_word_upload_mime(mime_type) {
        return Ok(DetectedUploadKind::plain("word"));
    }
    if is_spreadsheet_upload(path) || is_spreadsheet_upload_mime(mime_type) {
        return Ok(DetectedUploadKind::plain("spreadsheet"));
    }
    if is_archive_upload(path) || is_archive_upload_mime(mime_type) {
        return Ok(DetectedUploadKind::plain("archive"));
    }
    if let Some(detected) =
        DetectedUploadKind::from_text_class(classify_upload_text_bytes(bytes, false))
    {
        return Ok(detected);
    }

    Err(format!(
        "{file_name} 不是当前 Read 支持解析的文本/图片/PDF/notebook/Word/Excel/压缩包文件"
    ))
}

fn sanitize_uploaded_file_name(input: &str) -> String {
    // 文件名只需是安全的单段路径组件：保留中文等非 ASCII 字符，仅替换
    // 路径分隔符、Windows 保留符号与控制字符。曾经的 ASCII 白名单会把
    // 全中文文件名磨成纯扩展名（"报告.pdf" → "pdf"）。
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    // 结尾空格/点在 Windows 上非法，隐藏文件前缀点一并修剪。
    let trimmed = out.trim_matches(|ch: char| ch == '.' || ch.is_whitespace());
    let candidate = if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.to_string()
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

/// 上传暂存区基目录（`~/.liveagent/uploads`）。上传的附件是会话资产而非
/// 工作区文件：落到应用存储域，避免污染工作区的 git 状态与文件树。
///
/// 返回的是逻辑路径（不 canonicalize）：落盘、展示与消息里持久化的
/// absolute_path 都用它，避免 Windows 上把 `\\?\` verbatim 路径暴露给
/// 用户与模型。授权比较一律走 [`canonical_upload_staging_base`]。
fn upload_staging_base() -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        Ok(test_upload_staging_base().to_path_buf())
    }
    #[cfg(not(test))]
    {
        Ok(app_storage_dir()?.join("uploads"))
    }
}

/// 单测进程专用暂存根：所有暂存相关测试都写进系统临时目录，绝不触碰
/// 真实的 `~/.liveagent/uploads`。Unix 上刻意让暂存根经过一层 symlink，
/// 使走完整命令链的测试必然覆盖"逻辑路径 ≠ canonical 路径"的比较场景
/// （对应 Windows 的 `\\?\` verbatim 前缀与 symlink home 的发行版）。
#[cfg(test)]
fn test_upload_staging_base() -> &'static Path {
    use std::sync::OnceLock;
    static BASE: OnceLock<PathBuf> = OnceLock::new();
    BASE.get_or_init(|| {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "liveagent-upload-staging-test-{}-{unique}",
            std::process::id()
        ));
        let real = root.join("real");
        fs::create_dir_all(&real).expect("create test staging dir");
        #[cfg(unix)]
        {
            let link = root.join("staging");
            std::os::unix::fs::symlink(&real, &link).expect("symlink test staging dir");
            link
        }
        #[cfg(not(unix))]
        {
            real
        }
    })
}

/// 授权比较用的暂存区根。附件读取的 target 一律来自 `fs::canonicalize`
/// （Windows 上是 `\\?\C:\...` verbatim 形式，symlink 也已被解析），逻辑
/// 路径与它按组件比较永远不相等，必须把暂存根也 canonicalize 成同构形式
/// 再比。目录不存在（从未落过暂存文件）时返回 None，此时暂存分支不放行。
fn canonical_upload_staging_base() -> Option<PathBuf> {
    let base = upload_staging_base().ok()?;
    fs::canonicalize(base).ok()
}

/// 暂存文件保留天数：过期批次由启动 GC 清理。附件路径持久化在历史消息里，
/// 因此不与单个会话的删除绑定，按时效回收是与"暂存区"语义一致的做法。
const UPLOAD_STAGING_RETENTION: std::time::Duration =
    std::time::Duration::from_secs(30 * 24 * 60 * 60);

fn upload_import_root_in(base: &Path) -> Result<PathBuf, String> {
    let batch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    fs::create_dir_all(base).map_err(|e| format!("创建上传目录失败 {}: {e}", base.display()))?;
    // 批次目录是"单次导入"的语义单位：同批文件共享目录，GC 与清理都按
    // 目录整删。同一毫秒的并发导入撞名时追加序号拿独立目录，绝不共享
    // （create_dir 而非 create_dir_all，已存在即视为撞名）。
    for suffix in 0u32..1000 {
        let name = if suffix == 0 {
            batch.to_string()
        } else {
            format!("{batch}-{suffix}")
        };
        let root = base.join(name);
        match fs::create_dir(&root) {
            Ok(()) => return Ok(root),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("创建上传目录失败 {}: {e}", root.display())),
        }
    }
    Err(format!(
        "创建上传目录失败：{} 下批次名冲突过多",
        base.display()
    ))
}

fn upload_import_root() -> Result<PathBuf, String> {
    upload_import_root_in(&upload_staging_base()?)
}

fn gc_upload_staging_in(base: &Path, now: SystemTime, retention: std::time::Duration) -> usize {
    let Ok(entries) = fs::read_dir(base) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let expired = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > retention);
        if expired && fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 启动时清理过期的上传批次；失败只记录，绝不阻断启动。
pub fn gc_upload_staging_on_startup() {
    tauri::async_runtime::spawn_blocking(|| {
        if let Ok(base) = upload_staging_base() {
            gc_upload_staging_in(&base, SystemTime::now(), UPLOAD_STAGING_RETENTION);
        }
    });
}

fn build_readable_file_entry(
    workdir: &Path,
    destination: &Path,
    kind: &str,
    size_bytes: u64,
) -> Result<SystemReadableFileEntry, String> {
    // 工作区内的文件用真实相对路径；暂存区文件用 `uploads/<batch>/<name>`
    // 形式的展示路径（UI 徽标、粘贴引用与去重 key 都吃这个字段），模型侧
    // 的读取路径始终以 absolute_path 为准。调用方契约：暂存区 destination
    // 由 upload_staging_base 的逻辑路径拼出（不 canonicalize），因此这里
    // 用逻辑根 strip 即可对齐。
    let relative_path = match rel_to_workdir_forward_slash(workdir, destination) {
        Ok(relative) => relative,
        Err(_) => {
            let base = upload_staging_base()?;
            let staged = destination.strip_prefix(&base).map_err(|_| {
                format!(
                    "路径既不在工作目录也不在上传暂存区：{}",
                    destination.display()
                )
            })?;
            format!("uploads/{}", staged.to_string_lossy().replace('\\', "/"))
        }
    };
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

/// 附件读取的授权范围：当前工作目录，或应用上传暂存区。
/// 调用方保证 `workdir` 与 `target` 都是 canonicalize 过的路径，
/// 暂存分支因此必须用同样 canonicalize 过的根来比较。
fn is_allowed_attachment_target(workdir: &Path, target: &Path) -> bool {
    if target.starts_with(workdir) {
        return true;
    }
    canonical_upload_staging_base().is_some_and(|base| target.starts_with(base))
}

fn canonicalize_uploaded_attachment_path(
    workdir: &Path,
    absolute_path: Option<&str>,
) -> Result<PathBuf, String> {
    // 附件读取只认 absolute_path：新方案下工作区内文件原地引用、暂存区
    // 文件落 ~/.liveagent/uploads，两者的入口都是导入时返回的绝对路径。
    // 旧版本仅持久化 workdir 相对路径的附件不再兼容，需重新上传。
    let raw_absolute_path = absolute_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "附件缺少绝对路径（旧版本导入的附件请重新上传）".to_string())?;
    let target = canonicalize_uploaded_file_path(raw_absolute_path)?;

    if !is_allowed_attachment_target(workdir, &target) {
        return Err(format!(
            "附件路径超出当前工作目录与上传暂存区：{}",
            target.display()
        ));
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

        let detected = match detect_upload_file_kind(&source) {
            Ok(detected) => detected,
            Err(message) => {
                skipped.push(message);
                continue;
            }
        };

        let canonical_source = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
        let mut entry_size = metadata.len();
        let destination = if canonical_source.starts_with(workdir) {
            // 工作区内文件保持原地引用（含非 UTF-8 文本，不改写用户文件）；
            // 原生附件内联在读取侧转码，见 system_read_uploaded_native_attachment_sync。
            canonical_source
        } else {
            let import_root = match import_root.as_ref() {
                Some(root) => root.clone(),
                None => {
                    let root = upload_import_root()?;
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
            if detected.needs_utf8_transcode && metadata.len() <= UPLOADED_TEXT_TRANSCODE_MAX_BYTES
            {
                let bytes = fs::read(&source)
                    .map_err(|e| format!("读取文件失败 {}: {e}", source.display()))?;
                let utf8 = transcode_upload_text_to_utf8(&bytes);
                entry_size = utf8.len() as u64;
                fs::write(&target, &utf8).map_err(|e| {
                    format!(
                        "写入上传暂存文件失败 {} -> {}: {e}",
                        source.display(),
                        target.display()
                    )
                })?;
            } else {
                fs::copy(&source, &target).map_err(|e| {
                    format!(
                        "复制文件到上传暂存区失败 {} -> {}: {e}",
                        source.display(),
                        target.display()
                    )
                })?;
            }
            target
        };

        files.push(build_readable_file_entry(
            workdir,
            &destination,
            detected.kind,
            entry_size,
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

        let detected = match detect_uploaded_bytes_kind(
            source_name,
            upload.mime_type.as_deref(),
            &upload.content,
        ) {
            Ok(detected) => detected,
            Err(message) => {
                skipped.push(message);
                continue;
            }
        };

        let import_root = match import_root.as_ref() {
            Some(root) => root.clone(),
            None => {
                let root = upload_import_root()?;
                import_root = Some(root.clone());
                root
            }
        };

        let content = if detected.needs_utf8_transcode
            && upload.content.len() as u64 <= UPLOADED_TEXT_TRANSCODE_MAX_BYTES
        {
            transcode_upload_text_to_utf8(&upload.content)
        } else {
            upload.content
        };

        let sanitized_name = sanitize_uploaded_file_name(source_name);
        let target = unique_path_for_copy(import_root.join(sanitized_name));
        fs::write(&target, &content)
            .map_err(|e| format!("写入上传文件失败 {}: {e}", target.display()))?;

        files.push(build_readable_file_entry(
            &workdir,
            &target,
            detected.kind,
            content.len() as u64,
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
    if !is_allowed_attachment_target(&workdir, &target) {
        return Err(format!(
            "图片路径超出当前工作目录与上传暂存区：{}",
            target.display()
        ));
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
    kind: Option<String>,
) -> Result<SystemUploadedNativeAttachmentResponse, String> {
    let workdir = canonicalize_upload_workdir(&workdir)?;
    let target = canonicalize_uploaded_attachment_path(&workdir, absolute_path.as_deref())?;
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
    // 文本类附件必须以 UTF-8 内联：工作区内原地引用的文件可能是 GBK/UTF-16
    // 等编码（导入时不改写用户文件），JS 侧 decodeBase64Utf8 与各家 API 都按
    // UTF-8 解读 text/plain，这里在读取侧转码。
    let bytes = if kind.as_deref() == Some("text") {
        transcode_upload_text_to_utf8(&bytes)
    } else {
        bytes
    };
    let size_bytes = bytes.len() as u64;

    Ok(SystemUploadedNativeAttachmentResponse {
        mime_type: infer_native_attachment_mime(&target, kind.as_deref()),
        data: BASE64_STANDARD.encode(bytes),
        size_bytes,
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

fn system_append_debug_jsonl_sync(conversation_id: String, entry: Value) -> Result<(), String> {
    let file_stem = sanitize_debug_file_stem(&conversation_id)?;
    let debug_path = debug_root_dir()?.join(format!("{file_stem}.jsonl"));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&debug_path)
        .map_err(|e| format!("打开调试日志文件失败：{e}"))?;
    serde_json::to_writer(&mut file, &entry).map_err(|e| format!("序列化调试日志失败：{e}"))?;
    file.write_all(b"\n")
        .map_err(|e| format!("写入调试日志换行失败：{e}"))?;
    file.flush().map_err(|e| format!("刷新调试日志失败：{e}"))?;
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

pub(crate) fn validate_project_folder_name(name: &str) -> Result<&str, String> {
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

/// Mirror of the fs command layer's `display_path`: strip the Windows `\\?\`
/// verbatim prefix and use forward slashes so the returned path matches the
/// shape `fs_roots`/`fs_list_dirs` hand to the WebUI picker (a mismatched
/// shape shows up as a duplicate tree node after the parent refresh).
fn project_folder_display_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    if let Some(rest) = normalized.strip_prefix("//?/") {
        return rest.to_string();
    }
    normalized
}

fn canonicalize_project_folder(path: &Path) -> String {
    project_folder_display_path(&fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
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
pub async fn system_pick_file(
    initial_workdir: Option<String>,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = FileDialog::new();
        if let Some(initial_dir) = resolve_pick_folder_initial_dir(initial_workdir) {
            dialog = dialog.set_directory(initial_dir);
        }
        if let Some(extensions) = extensions.filter(|list| !list.is_empty()) {
            let extension_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(filter_name.as_deref().unwrap_or("Files"), &extension_refs);
        }

        Ok(dialog
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("system_pick_file join 失败：{e}"))?
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
    kind: Option<String>,
) -> Result<SystemUploadedNativeAttachmentResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_read_uploaded_native_attachment_sync(workdir, absolute_path, kind)
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

// 桌面端读系统剪贴板的唯一通道：WKWebView 的 navigator.clipboard.readText()
// 对来自其他应用的剪贴板内容会弹出原生"粘贴"确认气泡（DOM paste access），
// 自定义右键菜单的粘贴必须绕开 webview 直接读原生剪贴板。
fn system_clipboard_read_text_sync() -> Result<String, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        // 剪贴板无文本内容（空/图片/文件）时按空文本处理，前端据此静默收起菜单。
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(format!("clipboard read failed: {e}")),
    }
}

#[tauri::command]
pub async fn system_clipboard_read_text() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(system_clipboard_read_text_sync)
        .await
        .map_err(|e| format!("system_clipboard_read_text join failed: {e}"))?
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

    #[test]
    fn project_folder_display_path_strips_verbatim_and_uses_forward_slashes() {
        assert_eq!(
            project_folder_display_path(Path::new(r"\\?\C:\Users\Me\Repo")),
            "C:/Users/Me/Repo"
        );
        assert_eq!(
            project_folder_display_path(Path::new(r"\\?\UNC\server\share\Repo")),
            "//server/share/Repo"
        );
        assert_eq!(
            project_folder_display_path(Path::new("/Users/me/repo")),
            "/Users/me/repo"
        );
    }

    #[test]
    fn sanitize_uploaded_file_name_avoids_windows_reserved_names() {
        assert_eq!(
            sanitize_uploaded_file_name("safe name.txt"),
            "safe name.txt"
        );
        assert_eq!(sanitize_uploaded_file_name("CON.txt"), "CON_file.txt");
        assert_eq!(sanitize_uploaded_file_name("aux"), "aux_file");
        assert_eq!(sanitize_uploaded_file_name("LPT9.log"), "LPT9_file.log");
        assert_eq!(sanitize_uploaded_file_name("COM0.log"), "COM0.log");
    }

    #[test]
    fn sanitize_uploaded_file_name_preserves_unicode_names() {
        assert_eq!(sanitize_uploaded_file_name("报告.pdf"), "报告.pdf");
        assert_eq!(
            sanitize_uploaded_file_name("第三季度 财务:报表.xlsx"),
            "第三季度 财务_报表.xlsx"
        );
        assert_eq!(
            sanitize_uploaded_file_name("русский файл.txt"),
            "русский файл.txt"
        );
        assert_eq!(
            sanitize_uploaded_file_name("面试题（最终版）.docx"),
            "面试题（最终版）.docx"
        );
        // 路径分隔符与遍历序列被压成单段组件；控制字符被替换。
        assert_eq!(
            sanitize_uploaded_file_name("../../秘密.txt"),
            "_.._秘密.txt"
        );
        assert_eq!(
            sanitize_uploaded_file_name("恶意\u{7}响铃.txt"),
            "恶意_响铃.txt"
        );
        // 全部非法字符时回退到占位名。
        assert_eq!(sanitize_uploaded_file_name("..."), "file");
    }

    #[test]
    fn upload_import_root_stays_outside_the_workspace() {
        let root = upload_import_root().expect("create upload root");

        let staging_base = upload_staging_base().expect("resolve staging base");
        assert!(
            root.starts_with(&staging_base),
            "upload root should live in the app staging area: {}",
            root.display()
        );
        assert!(root.exists(), "upload root should be created");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gc_upload_staging_removes_only_expired_batches() {
        let temp = tempdir().expect("create temp dir");
        let base = temp.path().join("uploads");
        let expired = base.join("100");
        let fresh = base.join("200");
        fs::create_dir_all(&expired).expect("create expired batch");
        fs::create_dir_all(&fresh).expect("create fresh batch");
        fs::write(expired.join("old.txt"), b"old").expect("write expired file");

        let retention = std::time::Duration::from_secs(60);
        let now = SystemTime::now() + std::time::Duration::from_secs(120);
        let removed = gc_upload_staging_in(&base, now, retention);

        assert_eq!(removed, 2, "both stale batches are collected");
        assert!(!expired.exists());
        assert!(!fresh.exists());

        fs::create_dir_all(&fresh).expect("recreate fresh batch");
        let kept = gc_upload_staging_in(&base, SystemTime::now(), retention);
        assert_eq!(kept, 0, "batches inside the retention window survive");
        assert!(fresh.exists());
    }

    #[test]
    fn readable_file_entries_report_staging_display_paths() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        let staging = upload_staging_base().expect("resolve staging base");
        let batch = staging.join("test-batch-entry");
        fs::create_dir_all(&workdir).expect("create workdir");
        fs::create_dir_all(&batch).expect("create staging batch");
        let staged = batch.join("notes.txt");
        fs::write(&staged, b"hello").expect("write staged file");

        let entry =
            build_readable_file_entry(&workdir, &staged, "text", 5).expect("build staged entry");
        assert_eq!(entry.relative_path, "uploads/test-batch-entry/notes.txt");
        assert_eq!(entry.absolute_path, staged.to_string_lossy());

        let inside = workdir.join("src").join("main.rs");
        fs::create_dir_all(inside.parent().expect("parent")).expect("create src dir");
        fs::write(&inside, b"fn main() {}").expect("write workspace file");
        let workspace_entry =
            build_readable_file_entry(&workdir, &inside, "text", 12).expect("build entry");
        assert_eq!(workspace_entry.relative_path, "src/main.rs");

        let _ = fs::remove_dir_all(&batch);
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
            response.path,
            project_folder_display_path(
                &existing.canonicalize().expect("canonicalize existing dir")
            )
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
        assert!(
            !first_parent.starts_with(&workdir),
            "uploads must not land inside the workspace: {}",
            first_parent.display()
        );

        let _ = fs::remove_dir_all(&first_parent);
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

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
        let _ = fs::remove_dir_all(&workdir);
    }

    #[test]
    fn import_uploaded_readable_files_preserves_unicode_file_names() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");

        let response = system_import_uploaded_readable_files_sync(
            workdir.to_string_lossy().into_owned(),
            vec![SystemReadableFileUploadInput {
                file_name: "季度报告.txt".to_string(),
                mime_type: Some("text/plain".to_string()),
                content: "你好".as_bytes().to_vec(),
            }],
        )
        .expect("import unicode-named upload");

        assert!(
            response.skipped.is_empty(),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].file_name, "季度报告.txt");
        assert!(
            response.files[0].relative_path.ends_with("/季度报告.txt"),
            "relative_path = {}",
            response.files[0].relative_path
        );
        assert!(
            response.files[0].absolute_path.ends_with("季度报告.txt"),
            "absolute_path = {}",
            response.files[0].absolute_path
        );

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
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
            Some(upload.to_string_lossy().into_owned()),
            Some("text".to_string()),
        )
        .expect("read native attachment");

        assert_eq!(response.mime_type, "text/plain");
        assert_eq!(response.data, BASE64_STANDARD.encode(b"hello"));
        assert_eq!(response.size_bytes, 5);

        // 仅有 workdir 相对路径的旧附件不再兼容：绝对路径缺失直接拒绝。
        let legacy = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            None,
            Some("text".to_string()),
        )
        .expect_err("relative-only legacy attachments must be rejected");
        assert!(legacy.contains("附件缺少绝对路径"), "error = {legacy}");

        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"outside").expect("write outside file");
        let error = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            Some(outside.to_string_lossy().into_owned()),
            Some("text".to_string()),
        )
        .expect_err("outside file must be rejected");

        assert!(
            error.contains("附件路径超出当前工作目录与上传暂存区"),
            "error = {error}"
        );
    }

    #[test]
    fn read_uploaded_native_attachment_allows_staging_files() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");
        let staging = upload_staging_base().expect("resolve staging base");
        let batch = staging.join("test-batch-native");
        fs::create_dir_all(&batch).expect("create staging batch");
        let staged = batch.join("note.txt");
        fs::write(&staged, b"staged").expect("write staged file");

        let response = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            Some(staged.to_string_lossy().into_owned()),
            Some("text".to_string()),
        )
        .expect("staging attachment must be readable");

        assert_eq!(response.data, BASE64_STANDARD.encode(b"staged"));

        let _ = fs::remove_dir_all(&batch);
    }

    #[test]
    fn attachment_authorization_compares_canonical_staging_base() {
        // 复现线上 bug 形态：授权时 target 一律是 canonicalize 产物（Windows
        // 为 `\\?\` verbatim，symlink 已解析），而逻辑暂存根不是。测试暂存根
        // 在 Unix 上刻意经过 symlink，若比较未按 canonical 同构进行，
        // canonical 化后的 target 不会命中逻辑根，这里立即失败。越界拒绝由
        // read_uploaded_native_attachment_reads_workspace_file_and_rejects_escape 覆盖。
        let staging = upload_staging_base().expect("resolve staging base");
        let batch = staging.join("test-batch-auth");
        fs::create_dir_all(&batch).expect("create staging batch");
        let staged = batch.join("auth.txt");
        fs::write(&staged, b"auth").expect("write staged file");
        let canonical_target = fs::canonicalize(&staged).expect("canonicalize staged file");

        let temp = tempdir().expect("create temp dir");
        let workdir = fs::canonicalize(temp.path()).expect("canonicalize workdir");

        assert!(
            is_allowed_attachment_target(&workdir, &canonical_target),
            "canonicalized staging target must stay authorized: {}",
            canonical_target.display()
        );

        let _ = fs::remove_dir_all(&batch);
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
            !Path::new(&response.files[0].absolute_path).starts_with(&workdir),
            "external uploads must be staged outside the workspace: {}",
            response.files[0].absolute_path
        );
        assert!(
            response
                .skipped
                .iter()
                .any(|item| item.contains("已达到上传数量上限")),
            "skipped = {:?}",
            response.skipped
        );

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
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
            .expect("docx should be accepted")
            .kind,
            "word"
        );
        assert_eq!(
            detect_uploaded_bytes_kind(
                "workbook.xlsx",
                Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                b"not validated here",
            )
            .expect("xlsx should be accepted")
            .kind,
            "spreadsheet"
        );
        assert_eq!(
            detect_uploaded_bytes_kind("bundle.tar.gz", Some("application/gzip"), b"gzip")
                .expect("tar.gz should be accepted")
                .kind,
            "archive"
        );
        assert_eq!(
            detect_uploaded_bytes_kind("assets.7z", Some("application/x-7z-compressed"), b"7z")
                .expect("7z should be accepted")
                .kind,
            "archive"
        );
    }

    /// "中文测试文本" 的 GBK 编码字节。
    fn gbk_sample(repeat: usize) -> Vec<u8> {
        let unit: &[u8] = &[
            0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0xCE, 0xC4, 0xB1, 0xBE,
        ];
        unit.repeat(repeat)
    }

    #[test]
    fn classify_upload_text_bytes_accepts_legacy_encodings() {
        assert_eq!(
            classify_upload_text_bytes("你好".as_bytes(), false),
            UploadTextClass::Utf8
        );
        assert_eq!(
            classify_upload_text_bytes(&[0xEF, 0xBB, 0xBF, b'h', b'i'], false),
            UploadTextClass::Utf8
        );
        assert_eq!(
            classify_upload_text_bytes(&gbk_sample(4), false),
            UploadTextClass::NeedsTranscode
        );
        // UTF-16LE BOM + "你好"：ASCII 之外也不能被 NUL 检查误杀。
        assert_eq!(
            classify_upload_text_bytes(&[0xFF, 0xFE, 0x60, 0x4F, 0x7D, 0x59], false),
            UploadTextClass::NeedsTranscode
        );
        assert_eq!(
            classify_upload_text_bytes(&[0x00, 0x01, 0x02, 0x03], false),
            UploadTextClass::Binary
        );
        // 非 UTF-8 且控制字符占比高：判二进制而不是待转码文本。
        assert_eq!(
            classify_upload_text_bytes(&[0x80, 0x01, 0x02, 0x81, 0x03, 0x04, 0x82, 0x05], false),
            UploadTextClass::Binary
        );
    }

    #[test]
    fn classify_upload_text_bytes_tolerates_truncated_utf8_tail() {
        // 模拟 32KiB 探测边界切断多字节字符：完整 UTF-8 文本在截断前缀上
        // 也必须判为 UTF-8 文本，而不是二进制或待转码。
        let mut prefix = vec![b'a'; 16];
        prefix.extend_from_slice(&"界".as_bytes()[..2]);
        assert_eq!(
            classify_upload_text_bytes(&prefix, true),
            UploadTextClass::Utf8
        );
        // 非截断场景下同样的字节仍是非法 UTF-8 → 走待转码分类。
        assert_eq!(
            classify_upload_text_bytes(&prefix, false),
            UploadTextClass::NeedsTranscode
        );
    }

    #[test]
    fn classify_upload_text_file_tolerates_probe_boundary_split() {
        let temp = tempdir().expect("create temp dir");
        let path = temp.path().join("large-utf8.txt");
        // 让一个三字节汉字恰好跨越 32KiB 探测边界。
        let mut content = vec![b'a'; UPLOAD_TEXT_PROBE_BYTES - 1];
        content.extend_from_slice("界界界".as_bytes());
        fs::write(&path, &content).expect("write large utf8 file");

        assert_eq!(
            classify_upload_text_file(&path).expect("classify large utf8 file"),
            UploadTextClass::Utf8
        );
        assert_eq!(
            detect_upload_file_kind(&path)
                .expect("large utf8 txt must stay text")
                .kind,
            "text"
        );
    }

    #[test]
    fn transcode_upload_text_handles_gbk_and_utf16() {
        let gbk = gbk_sample(4);
        let transcoded = transcode_upload_text_to_utf8(&gbk);
        assert_eq!(
            String::from_utf8(transcoded).expect("transcoded output must be utf8"),
            "中文测试文本".repeat(4)
        );

        let utf16le = [0xFF, 0xFE, 0x60, 0x4F, 0x7D, 0x59];
        assert_eq!(
            String::from_utf8(transcode_upload_text_to_utf8(&utf16le)).expect("utf16 to utf8"),
            "你好"
        );

        // 合法 UTF-8 原样返回（分类可能来自截断前缀的误报）。
        let utf8 = "中文测试文本".as_bytes();
        assert_eq!(transcode_upload_text_to_utf8(utf8), utf8);
    }

    #[test]
    fn import_uploaded_gbk_text_is_transcoded_to_utf8() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");

        let response = system_import_uploaded_readable_files_sync(
            workdir.to_string_lossy().into_owned(),
            vec![SystemReadableFileUploadInput {
                file_name: "gbk-notes.txt".to_string(),
                mime_type: Some("text/plain".to_string()),
                content: gbk_sample(8),
            }],
        )
        .expect("import gbk upload");

        assert!(
            response.skipped.is_empty(),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].kind, "text");
        let staged =
            fs::read_to_string(&response.files[0].absolute_path).expect("staged copy must be utf8");
        assert_eq!(staged, "中文测试文本".repeat(8));
        assert_eq!(response.files[0].size_bytes, staged.len() as u64);

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn import_external_gbk_file_path_is_transcoded_to_utf8() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        let external = temp.path().join("external");
        fs::create_dir_all(&workdir).expect("create workdir");
        fs::create_dir_all(&external).expect("create external dir");
        let source = external.join("gbk-notes.txt");
        fs::write(&source, gbk_sample(8)).expect("write gbk source");

        let response = system_import_readable_file_paths_sync(
            workdir.to_string_lossy().into_owned(),
            vec![source.to_string_lossy().into_owned()],
            None,
        )
        .expect("import gbk file path");

        assert!(
            response.skipped.is_empty(),
            "skipped = {:?}",
            response.skipped
        );
        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].kind, "text");
        let staged =
            fs::read_to_string(&response.files[0].absolute_path).expect("staged copy must be utf8");
        assert_eq!(staged, "中文测试文本".repeat(8));
        // 原始文件保持原样，不被改写。
        assert_eq!(fs::read(&source).expect("read source"), gbk_sample(8));

        if let Some(parent) = Path::new(&response.files[0].absolute_path).parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn read_uploaded_native_attachment_transcodes_legacy_text() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");
        // 工作区内原地引用的 GBK 文件：导入时不改写，内联读取时转码。
        let inside = workdir.join("legacy.txt");
        fs::write(&inside, gbk_sample(8)).expect("write gbk workspace file");

        let response = system_read_uploaded_native_attachment_sync(
            workdir.to_string_lossy().into_owned(),
            Some(inside.to_string_lossy().into_owned()),
            Some("text".to_string()),
        )
        .expect("read gbk native attachment");

        assert_eq!(response.mime_type, "text/plain");
        let expected = "中文测试文本".repeat(8);
        assert_eq!(response.data, BASE64_STANDARD.encode(expected.as_bytes()));
        assert_eq!(response.size_bytes, expected.len() as u64);
    }
}
