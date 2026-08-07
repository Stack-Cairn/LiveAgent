use rfd::FileDialog;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use backend::runtime::platform::expand_tilde_path;
use backend::runtime::project_path::validate_project_folder_name;
use backend::services::power_activity::PowerActivityManager;
pub use backend::services::skills::{
    SystemListSkillFilesResponse, SystemManageSkillResponse, SystemReadSkillMetadataResponse,
    SystemReadSkillTextResponse,
};
// 上传暂存 / 附件读取 / 调试日志的实现已下沉 backend（services::uploads），
// headless 后端与桌面壳共用同一份；这里只剩 Tauri 薄包装与桌面专属对话框。
pub use backend::services::uploads::{
    gc_upload_staging_on_startup, SystemCreateProjectFolderResponse, SystemPastedTextInput,
    SystemPickReadableFilesResponse, SystemReadableFileUploadInput,
    SystemUploadedImagePreviewResponse, SystemUploadedNativeAttachmentResponse,
    SystemUploadedReadableFileInput,
};
use backend::services::uploads::{
    canonicalize_upload_workdir, import_readable_file_paths_into_workdir,
    system_import_readable_file_paths_sync, system_import_uploaded_readable_files_from_base64_sync,
    system_import_uploaded_readable_files_sync, system_read_uploaded_image_preview_sync,
};

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

pub(crate) fn system_list_skill_files_sync() -> Result<SystemListSkillFilesResponse, String> {
    backend::services::skills::system_list_skill_files_sync()
}

pub(crate) fn system_read_skill_metadata_sync(
    path: String,
) -> Result<SystemReadSkillMetadataResponse, String> {
    backend::services::skills::system_read_skill_metadata_sync(path)
}

pub(crate) fn system_read_skill_text_sync(
    path: String,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    backend::services::skills::system_read_skill_text_sync(path, offset, length)
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

/// Mirror of the fs command layer's `display_path`: strip the Windows `\\?\`
/// verbatim prefix and use forward slashes so the returned path matches the
/// shape `fs_roots` hands to the WebUI picker (a mismatched
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
    tokio::task::spawn_blocking(move || {
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
    tokio::task::spawn_blocking(move || {
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
    tokio::task::spawn_blocking(move || system_create_project_folder_sync(parent, name))
        .await
        .map_err(|e| format!("system_create_project_folder join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_pick_readable_files(
    workdir: String,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tokio::task::spawn_blocking(move || system_pick_readable_files_sync(workdir, max_files))
        .await
        .map_err(|e| format!("system_pick_readable_files join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_import_readable_file_paths(
    workdir: String,
    paths: Vec<String>,
    max_files: Option<usize>,
) -> Result<SystemPickReadableFilesResponse, String> {
    tokio::task::spawn_blocking(move || {
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
    tokio::task::spawn_blocking(move || {
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
    tokio::task::spawn_blocking(move || {
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
    tokio::task::spawn_blocking(move || {
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
    tokio::task::spawn_blocking(move || {
        backend::services::uploads::system_read_uploaded_native_attachment_sync(workdir, absolute_path, kind)
    })
    .await
    .map_err(|e| format!("system_read_uploaded_native_attachment join failed: {e}"))?
}

#[tauri::command]
pub async fn system_list_skill_files() -> Result<SystemListSkillFilesResponse, String> {
    tokio::task::spawn_blocking(system_list_skill_files_sync)
        .await
        .map_err(|e| format!("system_list_skill_files join 失败：{e}"))?
}

#[tauri::command]
pub async fn system_ensure_builtin_skills(
) -> Result<Vec<backend::services::skills::SystemBuiltinSkillSeedResponse>, String> {
    tokio::task::spawn_blocking(backend::services::skills::ensure_builtin_agent_skills_sync)
        .await
        .map_err(|e| format!("system_ensure_builtin_skills join failed: {e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_manage_skill(payload: Value) -> Result<SystemManageSkillResponse, String> {
    tokio::task::spawn_blocking(move || {
        backend::services::skills::system_manage_skill_sync(payload)
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
    tokio::task::spawn_blocking(move || system_read_skill_text_sync(path, offset, length))
        .await
        .map_err(|e| format!("system_read_skill_text join failed: {e}"))?
}

#[tauri::command]
pub async fn system_read_skill_metadata(
    path: String,
) -> Result<SystemReadSkillMetadataResponse, String> {
    tokio::task::spawn_blocking(move || system_read_skill_metadata_sync(path))
        .await
        .map_err(|e| format!("system_read_skill_metadata join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn system_append_debug_jsonl(
    conversation_id: String,
    entry: Value,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        backend::services::uploads::system_append_debug_jsonl_sync(conversation_id, entry)
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
    tokio::task::spawn_blocking(system_clipboard_read_text_sync)
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

}