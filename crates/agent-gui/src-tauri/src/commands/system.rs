use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::settings::{
    append_cron_task, delete_cron_task, load_cron, load_cron_task, open_db, update_cron_task,
};
use crate::runtime::platform::expand_tilde_path;
use crate::services::cron::{list_logs_for_task, CronExecutionLogRecord, CronManager};
use crate::services::gateway::GatewayController;
use crate::services::power_activity::PowerActivityManager;
pub use crate::services::skills::{
    SystemListSkillFilesResponse, SystemManageSkillResponse, SystemReadSkillMetadataResponse,
    SystemReadSkillTextResponse,
};

const UPLOADED_IMAGE_PREVIEW_MAX_BYTES: usize = 5 * 1024 * 1024; // 5MB
const UPLOADED_NATIVE_ATTACHMENT_MAX_BYTES: u64 = 25 * 1024 * 1024; // 25MB

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
pub struct SystemCronTaskSelectedModelResponse {
    pub custom_provider_id: String,
    pub model: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCronTaskHttpRequestResponse {
    pub id: String,
    pub url: String,
    pub method: String,
    pub headers: Option<Map<String, Value>>,
    pub body: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCronTaskResponse {
    pub task_id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub task_type: String,
    pub cron: String,
    pub enabled: bool,
    pub remaining_executions: Option<u64>,
    pub script: Option<String>,
    pub requests: Option<Vec<SystemCronTaskHttpRequestResponse>>,
    pub prompt: Option<String>,
    pub selected_model: Option<SystemCronTaskSelectedModelResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemManageCronTaskResponse {
    pub action: String,
    pub task: Option<SystemCronTaskResponse>,
    pub tasks: Option<Vec<SystemCronTaskResponse>>,
    pub logs: Option<Vec<CronExecutionLogRecord>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAddCronTaskResponse {
    pub task_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub task_type: String,
    pub cron: String,
    pub enabled: bool,
    pub remaining_executions: Option<u64>,
    pub selected_model: Option<SystemCronTaskSelectedModelResponse>,
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

fn required_object_string(
    payload: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("{label} 缺少 {key}"))
}

fn optional_object_string(payload: &Map<String, Value>, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn optional_object_u64(
    payload: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<u64>, String> {
    match payload.get(key) {
        Some(Value::Number(number)) => number
            .as_u64()
            .ok_or_else(|| format!("{label}.{key} 必须是非负整数"))
            .map(Some),
        Some(Value::Null) | None => Ok(None),
        Some(_) => Err(format!("{label}.{key} 必须是非负整数")),
    }
}

fn parse_system_cron_selected_model_response(
    payload: &Map<String, Value>,
    label: &str,
) -> Result<SystemCronTaskSelectedModelResponse, String> {
    let custom_provider_id = required_object_string(payload, "customProviderId", label)?;
    let model = required_object_string(payload, "model", label)?;
    Ok(SystemCronTaskSelectedModelResponse {
        custom_provider_id,
        model,
    })
}

fn parse_system_cron_task_response(
    task_id: String,
    payload: &Map<String, Value>,
    label: &str,
) -> Result<SystemCronTaskResponse, String> {
    let name = required_object_string(payload, "name", label)?;
    let description = payload
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let task_type = required_object_string(payload, "type", label)?;
    let cron = required_object_string(payload, "cron", label)?;
    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("{label} 缺少 enabled"))?;
    let remaining_executions = optional_object_u64(payload, "remainingExecutions", label)?;

    let script = optional_object_string(payload, "script");

    let requests = match payload.get("requests") {
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let item_label = format!("{label}.requests[{index}]");
                let request = item
                    .as_object()
                    .ok_or_else(|| format!("{item_label} 必须是对象"))?;
                let id = required_object_string(request, "id", &item_label)?;
                let url = required_object_string(request, "url", &item_label)?;
                let method = required_object_string(request, "method", &item_label)?;
                let headers = match request.get("headers") {
                    Some(Value::Object(headers)) => Some(headers.clone()),
                    Some(Value::Null) | None => None,
                    Some(_) => return Err(format!("{item_label}.headers 必须是对象")),
                };
                let body = request
                    .get("body")
                    .filter(|value| !value.is_null())
                    .cloned();
                out.push(SystemCronTaskHttpRequestResponse {
                    id,
                    url,
                    method,
                    headers,
                    body,
                });
            }
            Some(out)
        }
        Some(Value::Null) | None => None,
        Some(_) => return Err(format!("{label}.requests 必须是对象数组")),
    };

    let selected_model = match payload.get("selectedModel") {
        Some(Value::Object(selected_model)) => Some(parse_system_cron_selected_model_response(
            selected_model,
            &format!("{label}.selectedModel"),
        )?),
        Some(Value::Null) | None => None,
        Some(_) => return Err(format!("{label}.selectedModel 必须是对象")),
    };

    Ok(SystemCronTaskResponse {
        task_id,
        name,
        description,
        task_type,
        cron,
        enabled,
        remaining_executions,
        script,
        requests,
        prompt: optional_object_string(payload, "prompt"),
        selected_model,
    })
}

fn parse_system_cron_task_response_from_value(
    value: Value,
    label: &str,
) -> Result<SystemCronTaskResponse, String> {
    let task = value
        .as_object()
        .ok_or_else(|| format!("{label} 必须是对象"))?;
    let task_id = required_object_string(task, "id", label)?;
    parse_system_cron_task_response(task_id, task, label)
}

fn parse_system_add_cron_task_response(
    task_id: String,
    payload: &Map<String, Value>,
) -> Result<SystemAddCronTaskResponse, String> {
    let task = parse_system_cron_task_response(task_id, payload, "system_add_cron_task 响应")?;
    Ok(SystemAddCronTaskResponse {
        task_id: task.task_id,
        name: task.name,
        task_type: task.task_type,
        cron: task.cron,
        enabled: task.enabled,
        remaining_executions: task.remaining_executions,
        selected_model: task.selected_model,
    })
}

fn extract_system_manage_action(payload: &Map<String, Value>) -> Result<String, String> {
    let action = required_object_string(payload, "action", "system_manage_cron_task payload")?;
    match action.as_str() {
        "create" | "read" | "update" | "delete" | "list_logs" => Ok(action),
        _ => Err(format!(
            "system_manage_cron_task payload.action 不支持：{action}"
        )),
    }
}

fn extract_system_manage_task_id(
    payload: &Map<String, Value>,
    required: bool,
) -> Result<Option<String>, String> {
    let task_id = payload
        .get("taskId")
        .or_else(|| payload.get("task_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    if required && task_id.is_none() {
        return Err("system_manage_cron_task payload.task_id 不能为空".to_string());
    }
    Ok(task_id)
}

fn extract_system_manage_logs_limit(payload: &Map<String, Value>) -> Result<usize, String> {
    let value = payload
        .get("limit")
        .or_else(|| payload.get("logsLimit"))
        .or_else(|| payload.get("logs_limit"));
    let Some(value) = value else {
        return Ok(100);
    };

    let Some(limit) = value.as_u64().filter(|limit| *limit > 0) else {
        return Err("system_manage_cron_task payload.limit 必须是正整数".to_string());
    };
    Ok((limit as usize).clamp(1, 500))
}

#[derive(Debug)]
pub(crate) struct SystemManageCronTaskSyncResult {
    pub(crate) response: SystemManageCronTaskResponse,
    pub(crate) should_reload: bool,
}

pub(crate) fn system_manage_cron_task_sync(
    conn: &mut rusqlite::Connection,
    payload: Value,
) -> Result<SystemManageCronTaskSyncResult, String> {
    let payload = payload
        .as_object()
        .ok_or_else(|| "system_manage_cron_task payload 必须是对象".to_string())?;
    let action = extract_system_manage_action(payload)?;

    match action.as_str() {
        "create" => {
            let task_payload = payload
                .get("task")
                .cloned()
                .ok_or_else(|| "system_manage_cron_task payload.task 不能为空".to_string())?;
            let validated = append_cron_task(conn, task_payload)?;
            let task_id = validated
                .task_id
                .clone()
                .ok_or_else(|| "system_manage_cron_task create 未返回 task_id".to_string())?;
            let task = parse_system_cron_task_response(
                task_id,
                &validated.payload,
                "system_manage_cron_task create 响应",
            )?;
            Ok(SystemManageCronTaskSyncResult {
                response: SystemManageCronTaskResponse {
                    action,
                    task: Some(task),
                    tasks: None,
                    logs: None,
                },
                should_reload: true,
            })
        }
        "read" => {
            let task = if let Some(task_id) = extract_system_manage_task_id(payload, false)? {
                let task = load_cron_task(conn, &task_id)?
                    .ok_or_else(|| format!("cron_settings.task_id 不存在：{task_id}"))?;
                Some(parse_system_cron_task_response_from_value(
                    task,
                    "system_manage_cron_task read 响应.task",
                )?)
            } else {
                None
            };

            let tasks = if task.is_none() {
                let all_tasks = load_cron(conn)?.unwrap_or(Value::Array(Vec::new()));
                let items = all_tasks.as_array().ok_or_else(|| {
                    "system_manage_cron_task read 响应.tasks 必须是数组".to_string()
                })?;
                let mut parsed = Vec::with_capacity(items.len());
                for (index, item) in items.iter().cloned().enumerate() {
                    parsed.push(parse_system_cron_task_response_from_value(
                        item,
                        &format!("system_manage_cron_task read 响应.tasks[{index}]"),
                    )?);
                }
                Some(parsed)
            } else {
                None
            };

            Ok(SystemManageCronTaskSyncResult {
                response: SystemManageCronTaskResponse {
                    action,
                    task,
                    tasks,
                    logs: None,
                },
                should_reload: false,
            })
        }
        "list_logs" => {
            let task_id = extract_system_manage_task_id(payload, true)?
                .ok_or_else(|| "system_manage_cron_task payload.task_id 不能为空".to_string())?;
            load_cron_task(conn, &task_id)?
                .ok_or_else(|| format!("cron_settings.task_id 不存在：{task_id}"))?;
            let limit = extract_system_manage_logs_limit(payload)?;
            let logs = list_logs_for_task(conn, &task_id, limit)?;

            Ok(SystemManageCronTaskSyncResult {
                response: SystemManageCronTaskResponse {
                    action,
                    task: None,
                    tasks: None,
                    logs: Some(logs),
                },
                should_reload: false,
            })
        }
        "update" => {
            let task_id = extract_system_manage_task_id(payload, true)?
                .ok_or_else(|| "system_manage_cron_task payload.task_id 不能为空".to_string())?;
            let task_payload = payload
                .get("task")
                .cloned()
                .ok_or_else(|| "system_manage_cron_task payload.task 不能为空".to_string())?;
            let validated = update_cron_task(conn, &task_id, task_payload)?;
            let task = parse_system_cron_task_response(
                validated
                    .task_id
                    .clone()
                    .ok_or_else(|| "system_manage_cron_task update 未返回 task_id".to_string())?,
                &validated.payload,
                "system_manage_cron_task update 响应",
            )?;
            Ok(SystemManageCronTaskSyncResult {
                response: SystemManageCronTaskResponse {
                    action,
                    task: Some(task),
                    tasks: None,
                    logs: None,
                },
                should_reload: true,
            })
        }
        "delete" => {
            let task_id = extract_system_manage_task_id(payload, true)?
                .ok_or_else(|| "system_manage_cron_task payload.task_id 不能为空".to_string())?;
            let deleted = delete_cron_task(conn, &task_id)?;
            let task = parse_system_cron_task_response_from_value(
                deleted,
                "system_manage_cron_task delete 响应.task",
            )?;
            Ok(SystemManageCronTaskSyncResult {
                response: SystemManageCronTaskResponse {
                    action,
                    task: Some(task),
                    tasks: None,
                    logs: None,
                },
                should_reload: true,
            })
        }
        _ => unreachable!(),
    }
}

fn system_add_cron_task_sync(
    conn: &mut rusqlite::Connection,
    payload: Value,
) -> Result<SystemAddCronTaskResponse, String> {
    let validated = append_cron_task(conn, payload)?;
    let task_id = validated
        .task_id
        .ok_or_else(|| "system_add_cron_task 未返回 task_id".to_string())?;
    parse_system_add_cron_task_response(task_id, &validated.payload)
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

#[tauri::command(rename_all = "snake_case")]
pub async fn system_add_cron_task(
    payload: Value,
    cron_manager: tauri::State<'_, Arc<CronManager>>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<SystemAddCronTaskResponse, String> {
    let response = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        system_add_cron_task_sync(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("system_add_cron_task join 失败：{e}"))??;
    cron_manager.request_reload();
    if let Err(error) = gateway_controller.refresh_settings_sync_from_db().await {
        eprintln!("refresh gateway settings sync after system_add_cron_task failed: {error}");
    }
    Ok(response)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_manage_cron_task(
    payload: Value,
    cron_manager: tauri::State<'_, Arc<CronManager>>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<SystemManageCronTaskResponse, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        system_manage_cron_task_sync(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("system_manage_cron_task join 失败：{e}"))??;
    if result.should_reload {
        cron_manager.request_reload();
        if let Err(error) = gateway_controller.refresh_settings_sync_from_db().await {
            eprintln!(
                "refresh gateway settings sync after system_manage_cron_task failed: {error}"
            );
        }
    }
    Ok(result.response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::settings::initialize_schema;
    use rusqlite::params;
    use serde_json::json;
    use tempfile::tempdir;

    fn open_memory_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory sqlite");
        initialize_schema(&conn).expect("initialize schema");
        conn
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
    fn system_add_cron_task_appends_bash_task_after_existing_rows() {
        let mut conn = open_memory_db();
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                "existing-task",
                r#"{"name":"Existing","description":"","cron":"0 0 * * * *","enabled":true,"type":"bash","script":"echo existing"}"#,
                0_i64,
                1_i64
            ],
        )
        .expect("seed existing cron task");

        let response = system_add_cron_task_sync(
            &mut conn,
            json!({
                "name": "Build",
                "description": "Run build",
                "cron": "0 * * * * *",
                "type": "bash",
                "script": "npm run build"
            }),
        )
        .expect("append bash task");

        assert_eq!(response.name, "Build");
        assert_eq!(response.task_type, "bash");
        assert_eq!(response.cron, "0 * * * * *");
        assert!(response.enabled, "enabled should default to true");

        let rows = {
            let mut stmt = conn
                .prepare("SELECT task_id, sort_index, payload_json FROM cron_settings ORDER BY sort_index ASC")
                .expect("prepare cron query");
            let iter = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .expect("query cron rows");
            iter.map(|row| row.expect("cron row")).collect::<Vec<_>>()
        };

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "existing-task");
        assert_eq!(rows[1].1, 1);
        assert_eq!(rows[1].0, response.task_id);
        assert!(
            rows[1].2.contains(r#""script":"npm run build""#),
            "bash payload should be persisted"
        );
    }

    #[test]
    fn system_add_cron_task_persists_http_and_prompt_tasks() {
        let mut conn = open_memory_db();

        let http_response = system_add_cron_task_sync(
            &mut conn,
            json!({
                "name": "Webhook",
                "description": "",
                "cron": "0 */5 * * * *",
                "enabled": false,
                "type": "http",
                "requests": [{
                    "id": "request-1",
                    "url": "https://example.com/webhook",
                    "method": "POST",
                    "headers": { "content-type": "application/json" },
                    "body": { "event": "ping" }
                }]
            }),
        )
        .expect("append http task");

        assert_eq!(http_response.task_type, "http");
        assert!(!http_response.enabled);

        let prompt_response = system_add_cron_task_sync(
            &mut conn,
            json!({
                "name": "Daily Summary",
                "description": "Summarize changes",
                "cron": "0 0 9 * * *",
                "type": "prompt",
                "prompt": "Summarize yesterday's important changes.",
                "selectedModel": {
                    "customProviderId": "builtin-codex",
                    "model": "gpt-5"
                }
            }),
        )
        .expect("append prompt task");

        assert_eq!(prompt_response.task_type, "prompt");
        assert_eq!(
            prompt_response
                .selected_model
                .as_ref()
                .expect("selected model")
                .custom_provider_id,
            "builtin-codex"
        );

        let count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron tasks");
        assert_eq!(count, 2);
    }

    #[test]
    fn system_manage_cron_task_reads_all_and_single_tasks() {
        let mut conn = open_memory_db();
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                "cron-a",
                r#"{"name":"Build","description":"Run build","cron":"0 * * * * *","enabled":true,"type":"bash","script":"npm run build"}"#,
                0_i64,
                1_i64
            ],
        )
        .expect("seed bash task");
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                "cron-b",
                r#"{"name":"Daily Summary","description":"","cron":"0 0 9 * * *","enabled":true,"type":"prompt","prompt":"Summarize changes","selectedModel":{"customProviderId":"builtin-codex","model":"gpt-5"}}"#,
                1_i64,
                2_i64
            ],
        )
        .expect("seed prompt task");

        let read_all = system_manage_cron_task_sync(&mut conn, json!({ "action": "read" }))
            .expect("read all cron tasks");
        assert!(!read_all.should_reload);
        assert_eq!(read_all.response.action, "read");
        assert_eq!(read_all.response.tasks.as_ref().expect("tasks").len(), 2);

        let read_single = system_manage_cron_task_sync(
            &mut conn,
            json!({
                "action": "read",
                "task_id": "cron-b"
            }),
        )
        .expect("read single cron task");
        let task = read_single.response.task.expect("task");
        assert_eq!(task.task_id, "cron-b");
        assert_eq!(task.task_type, "prompt");
        assert_eq!(task.selected_model.expect("selected model").model, "gpt-5");
    }

    #[test]
    fn system_manage_cron_task_lists_logs_for_single_task() {
        let mut conn = open_memory_db();
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                "cron-a",
                r#"{"name":"Build","description":"","cron":"0 * * * * *","enabled":true,"type":"bash","script":"npm run build"}"#,
                0_i64,
                1_i64
            ],
        )
        .expect("seed cron task");
        conn.execute(
            "INSERT INTO cron_execution_logs (log_id, task_id, started_at, success, duration_ms, exit_code, output) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params!["log-old", "cron-a", 100_i64, 1_i64, 20_i64, 0_i64, "old ok"],
        )
        .expect("seed old cron log");
        conn.execute(
            "INSERT INTO cron_execution_logs (log_id, task_id, started_at, success, duration_ms, exit_code, output) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params!["log-new", "cron-a", 200_i64, 0_i64, 30_i64, 1_i64, "new fail"],
        )
        .expect("seed new cron log");
        conn.execute(
            "INSERT INTO cron_execution_logs (log_id, task_id, started_at, success, duration_ms, exit_code, output) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params!["log-other", "cron-b", 300_i64, 1_i64, 40_i64, 0_i64, "other"],
        )
        .expect("seed other cron log");

        let listed = system_manage_cron_task_sync(
            &mut conn,
            json!({
                "action": "list_logs",
                "task_id": "cron-a",
                "limit": 1
            }),
        )
        .expect("list cron logs");

        assert!(!listed.should_reload);
        assert_eq!(listed.response.action, "list_logs");
        let logs = listed.response.logs.expect("logs");
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].id, "log-new");
        assert_eq!(logs[0].task_id, "cron-a");
        assert!(!logs[0].success);
        assert_eq!(logs[0].exit_code, Some(1));
        assert_eq!(logs[0].output, "new fail");
    }

    #[test]
    fn system_manage_cron_task_updates_existing_task_with_patch() {
        let mut conn = open_memory_db();
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                "cron-a",
                r#"{"name":"Daily Summary","description":"Original","cron":"0 0 9 * * *","enabled":true,"type":"prompt","prompt":"Summarize changes","selectedModel":{"customProviderId":"builtin-codex","model":"gpt-5"}}"#,
                0_i64,
                1_i64
            ],
        )
        .expect("seed prompt task");

        let updated = system_manage_cron_task_sync(
            &mut conn,
            json!({
                "action": "update",
                "task_id": "cron-a",
                "task": {
                    "cron": "0 30 9 * * *",
                    "enabled": false,
                    "description": "Updated"
                }
            }),
        )
        .expect("update cron task");
        assert!(updated.should_reload);
        let task = updated.response.task.expect("updated task");
        assert_eq!(task.task_id, "cron-a");
        assert_eq!(task.cron, "0 30 9 * * *");
        assert!(!task.enabled);
        assert_eq!(task.description, "Updated");
        assert_eq!(task.name, "Daily Summary");
        assert_eq!(task.prompt.as_deref(), Some("Summarize changes"));
        assert_eq!(
            task.selected_model
                .expect("selected model")
                .custom_provider_id,
            "builtin-codex"
        );
    }

    #[test]
    fn system_manage_cron_task_updates_remaining_executions() {
        let mut conn = open_memory_db();
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                "cron-a",
                r#"{"name":"Finite","description":"","cron":"0 0 9 * * *","enabled":true,"remainingExecutions":1,"type":"bash","script":"echo finite"}"#,
                0_i64,
                1_i64
            ],
        )
        .expect("seed finite task");

        let exhausted = system_manage_cron_task_sync(
            &mut conn,
            json!({
                "action": "update",
                "task_id": "cron-a",
                "task": {
                    "remainingExecutions": 0,
                    "enabled": true
                }
            }),
        )
        .expect("exhaust cron task");
        assert!(exhausted.should_reload);
        let task = exhausted.response.task.expect("exhausted task");
        assert_eq!(task.remaining_executions, Some(0));
        assert!(!task.enabled);

        let unlimited = system_manage_cron_task_sync(
            &mut conn,
            json!({
                "action": "update",
                "task_id": "cron-a",
                "task": {
                    "remainingExecutions": null,
                    "enabled": true
                }
            }),
        )
        .expect("clear run count");
        let task = unlimited.response.task.expect("unlimited task");
        assert_eq!(task.remaining_executions, None);
        assert!(task.enabled);
    }

    #[test]
    fn system_manage_cron_task_deletes_task_and_logs() {
        let mut conn = open_memory_db();
        conn.execute(
            "INSERT INTO cron_settings (task_id, payload_json, sort_index, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                "cron-a",
                r#"{"name":"Build","description":"","cron":"0 * * * * *","enabled":true,"type":"bash","script":"npm run build"}"#,
                0_i64,
                1_i64
            ],
        )
        .expect("seed cron task");
        conn.execute(
            "INSERT INTO cron_execution_logs (log_id, task_id, started_at, success, duration_ms, exit_code, output) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                "log-a",
                "cron-a",
                1_i64,
                1_i64,
                20_i64,
                0_i64,
                "ok"
            ],
        )
        .expect("seed cron log");

        let deleted = system_manage_cron_task_sync(
            &mut conn,
            json!({
                "action": "delete",
                "task_id": "cron-a"
            }),
        )
        .expect("delete cron task");
        assert!(deleted.should_reload);
        assert_eq!(
            deleted.response.task.expect("deleted task").task_id,
            "cron-a"
        );

        let cron_count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron tasks");
        let log_count = conn
            .query_row("SELECT COUNT(*) FROM cron_execution_logs", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron logs");
        assert_eq!(cron_count, 0);
        assert_eq!(log_count, 0);
    }

    #[test]
    fn system_add_cron_task_rejects_invalid_payloads_without_writing_rows() {
        let invalid_payloads = [
            json!({
                "name": "Bad Cron",
                "cron": "* * * * *",
                "type": "bash",
                "script": "echo bad"
            }),
            json!({
                "name": "Missing Script",
                "cron": "0 * * * * *",
                "type": "bash"
            }),
            json!({
                "name": "Legacy Commands",
                "cron": "0 * * * * *",
                "type": "bash",
                "commands": [["echo", "legacy"]]
            }),
            json!({
                "name": "Missing Requests",
                "cron": "0 * * * * *",
                "type": "http",
                "requests": []
            }),
            json!({
                "name": "Invalid Url",
                "cron": "0 * * * * *",
                "type": "http",
                "requests": [{
                    "id": "request-1",
                    "url": "/relative",
                    "method": "POST"
                }]
            }),
            json!({
                "name": "Missing Prompt Model",
                "cron": "0 * * * * *",
                "type": "prompt",
                "prompt": "Do the thing"
            }),
        ];

        for payload in invalid_payloads {
            let mut conn = open_memory_db();
            let error = system_add_cron_task_sync(&mut conn, payload).expect_err("invalid payload");
            assert!(
                !error.trim().is_empty(),
                "error message should not be empty"
            );
            let count = conn
                .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count cron tasks");
            assert_eq!(count, 0, "invalid payload must not write rows");
        }
    }

    #[test]
    fn system_manage_cron_task_rejects_missing_task_id_for_required_actions() {
        let mut conn = open_memory_db();
        for payload in [
            json!({
                "action": "update",
                "task": {
                    "name": "Build"
                }
            }),
            json!({
                "action": "delete"
            }),
            json!({
                "action": "list_logs"
            }),
        ] {
            let error =
                system_manage_cron_task_sync(&mut conn, payload).expect_err("missing task id");
            assert!(error.contains("task_id"));
        }
    }
}
