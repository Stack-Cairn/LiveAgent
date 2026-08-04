use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::sync::Semaphore;

use super::fs::spawn_workspace_open_command;
use crate::commands::chat_history;
use crate::runtime::platform::expand_tilde_path;

const TEXT_EXTENSIONS: &[&str] = &[
    "adoc",
    "astro",
    "bash",
    "bat",
    "c",
    "cc",
    "cfg",
    "clj",
    "cljc",
    "cljs",
    "cmake",
    "cmd",
    "conf",
    "cpp",
    "cs",
    "css",
    "cts",
    "cxx",
    "dart",
    "dockerfile",
    "editorconfig",
    "env",
    "erl",
    "ex",
    "exs",
    "fish",
    "fs",
    "fsx",
    "gitattributes",
    "gitignore",
    "go",
    "gradle",
    "graphql",
    "gql",
    "h",
    "hh",
    "hpp",
    "hrl",
    "hs",
    "htm",
    "html",
    "hxx",
    "ini",
    "java",
    "jl",
    "js",
    "json",
    "json5",
    "jsonc",
    "jsx",
    "kt",
    "kts",
    "less",
    "lhs",
    "log",
    "lua",
    "m",
    "md",
    "mdx",
    "mjs",
    "mm",
    "mts",
    "nim",
    "php",
    "pl",
    "pm",
    "properties",
    "proto",
    "ps1",
    "psd1",
    "psm1",
    "py",
    "pyi",
    "pyw",
    "r",
    "rb",
    "rs",
    "rst",
    "sass",
    "scala",
    "scss",
    "sh",
    "sol",
    "sql",
    "svelte",
    "swift",
    "tex",
    "toml",
    "ts",
    "tsx",
    "txt",
    "vb",
    "vbs",
    "vue",
    "wsf",
    "xhtml",
    "xml",
    "yaml",
    "yml",
    "zsh",
    "zig",
];
const SCRIPT_EXTENSIONS: &[&str] = &[
    "bash", "bat", "cmd", "command", "fish", "hta", "js", "jse", "mjs", "cjs", "msh", "msh1",
    "msh1xml", "msh2", "msh2xml", "mshxml", "ps1", "psd1", "psm1", "pssc", "py", "pyw", "rb",
    "sct", "sh", "vbe", "vbs", "ws", "wsc", "wsf", "wsh", "zsh",
];
const PREVIEW_EXTENSIONS: &[&str] = &[
    "avif", "bmp", "csv", "doc", "docx", "flac", "gif", "ico", "jpeg", "jpg", "m4a", "m4v", "mov",
    "mp3", "mp4", "ods", "oga", "ogg", "ogv", "pdf", "png", "rtf", "svg", "tsv", "wav", "webm",
    "webp", "xls", "xlsm", "xlsx", "xltm", "xltx",
];
const CHAT_FILE_OPEN_TIMEOUT: Duration = Duration::from_secs(25);
const CHAT_FILE_OPEN_CONCURRENCY: usize = 4;
static CHAT_FILE_OPEN_SEMAPHORE: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(CHAT_FILE_OPEN_CONCURRENCY)));

const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "app",
    "appimage",
    "appref-ms",
    "application",
    "apk",
    "bin",
    "chm",
    "com",
    "cpl",
    "crx",
    "deb",
    "desktop",
    "dmg",
    "exe",
    "gadget",
    "inf",
    "ins",
    "isp",
    "jar",
    "lnk",
    "msc",
    "msi",
    "msp",
    "pif",
    "pkg",
    "reg",
    "rpm",
    "scf",
    "scr",
    "shb",
    "shs",
    "url",
    "webloc",
    "workflow",
    "xbap",
    "xpi",
];

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatFileLinkErrorCode {
    InvalidRequest,
    InvalidWorkdir,
    NotFound,
    UnsupportedTarget,
    OpenFailed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFileLinkError {
    pub code: ChatFileLinkErrorCode,
    pub message: String,
}

impl ChatFileLinkError {
    fn new(code: ChatFileLinkErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFileLinkOpenResponse {
    pub action: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub outside_workspace: bool,
}

#[derive(Debug)]
struct ChatFileLinkPlan {
    response: ChatFileLinkOpenResponse,
    target: PathBuf,
    system_mode: Option<&'static str>,
}

fn display_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    normalized
        .strip_prefix("//?/")
        .unwrap_or(&normalized)
        .to_string()
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    let ext = extension(path);
    extensions.iter().any(|candidate| *candidate == ext)
}

#[cfg(target_os = "macos")]
fn is_active_directory(path: &Path) -> bool {
    has_extension(path, EXECUTABLE_EXTENSIONS)
}

#[cfg(not(target_os = "macos"))]
fn is_active_directory(_path: &Path) -> bool {
    false
}

fn has_shebang(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut prefix = [0_u8; 2];
    file.read_exact(&mut prefix).is_ok() && prefix == *b"#!"
}

fn is_probably_text(path: &Path) -> bool {
    if has_extension(path, TEXT_EXTENSIONS) || has_shebang(path) {
        return true;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut sample = vec![0_u8; 8192];
    let Ok(read) = file.read(&mut sample) else {
        return false;
    };
    sample.truncate(read);
    !sample.contains(&0) && std::str::from_utf8(&sample).is_ok()
}

#[cfg(unix)]
fn has_executable_permission(path: &Path, metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let _ = path;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_executable_permission(_path: &Path, _metadata: &fs::Metadata) -> bool {
    false
}

fn normalized_location(
    line: Option<u32>,
    end_line: Option<u32>,
    column: Option<u32>,
) -> Result<(Option<u32>, Option<u32>, Option<u32>), ChatFileLinkError> {
    if line == Some(0)
        || end_line == Some(0)
        || column == Some(0)
        || (line.is_none() && (end_line.is_some() || column.is_some()))
        || matches!((line, end_line), (Some(start), Some(end)) if end < start)
    {
        return Err(ChatFileLinkError::new(
            ChatFileLinkErrorCode::InvalidRequest,
            "The linked file location is invalid.",
        ));
    }
    Ok((line, end_line, column))
}

fn preview_target(
    conversation_workdir: &Path,
    target: &Path,
) -> Result<(String, String, bool), ChatFileLinkError> {
    if let Ok(relative) = target.strip_prefix(conversation_workdir) {
        if !relative.as_os_str().is_empty() {
            return Ok((
                display_path(conversation_workdir),
                display_path(relative),
                false,
            ));
        }
    }
    let parent = target.parent().ok_or_else(|| {
        ChatFileLinkError::new(
            ChatFileLinkErrorCode::UnsupportedTarget,
            "The linked file cannot be opened safely.",
        )
    })?;
    let name = target.file_name().ok_or_else(|| {
        ChatFileLinkError::new(
            ChatFileLinkErrorCode::UnsupportedTarget,
            "The linked file cannot be opened safely.",
        )
    })?;
    Ok((
        display_path(parent),
        name.to_string_lossy().into_owned(),
        true,
    ))
}

fn build_chat_file_link_plan(
    conversation_id: &str,
    workdir: &str,
    path: &str,
    source: &str,
    line: Option<u32>,
    end_line: Option<u32>,
    column: Option<u32>,
    open_in_file_manager: bool,
) -> Result<ChatFileLinkPlan, ChatFileLinkError> {
    if conversation_id.trim().is_empty() || conversation_id.len() > 256 {
        return Err(ChatFileLinkError::new(
            ChatFileLinkErrorCode::InvalidRequest,
            "The conversation is unavailable.",
        ));
    }
    if path.trim().is_empty() || path.contains('\0') {
        return Err(ChatFileLinkError::new(
            ChatFileLinkErrorCode::InvalidRequest,
            "The linked file path is invalid.",
        ));
    }
    let (line, end_line, column) = normalized_location(line, end_line, column)?;

    let raw_workdir = expand_tilde_path(workdir.trim());
    if !raw_workdir.is_absolute() {
        return Err(ChatFileLinkError::new(
            ChatFileLinkErrorCode::InvalidWorkdir,
            "The conversation working directory is unavailable.",
        ));
    }
    let conversation_workdir = fs::canonicalize(raw_workdir).map_err(|_| {
        ChatFileLinkError::new(
            ChatFileLinkErrorCode::InvalidWorkdir,
            "The conversation working directory is unavailable.",
        )
    })?;
    if !conversation_workdir.is_dir() {
        return Err(ChatFileLinkError::new(
            ChatFileLinkErrorCode::InvalidWorkdir,
            "The conversation working directory is unavailable.",
        ));
    }

    let raw_target = PathBuf::from(path.trim());
    let candidate = match source {
        "relative" if !raw_target.is_absolute() => conversation_workdir.join(raw_target),
        "absolute" | "file-url" if raw_target.is_absolute() => raw_target,
        "relative" | "absolute" | "file-url" => {
            return Err(ChatFileLinkError::new(
                ChatFileLinkErrorCode::InvalidRequest,
                "The linked path is not valid on this device.",
            ));
        }
        _ => {
            return Err(ChatFileLinkError::new(
                ChatFileLinkErrorCode::InvalidRequest,
                "The linked file source is invalid.",
            ));
        }
    };
    let target = fs::canonicalize(candidate).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            ChatFileLinkErrorCode::NotFound
        } else {
            ChatFileLinkErrorCode::UnsupportedTarget
        };
        let message = if code == ChatFileLinkErrorCode::NotFound {
            "The linked file does not exist."
        } else {
            "The linked file cannot be accessed."
        };
        ChatFileLinkError::new(code, message)
    })?;
    let metadata = fs::metadata(&target).map_err(|_| {
        ChatFileLinkError::new(
            ChatFileLinkErrorCode::UnsupportedTarget,
            "The linked file cannot be accessed.",
        )
    })?;

    if metadata.is_dir() {
        if is_active_directory(&target) {
            return Err(ChatFileLinkError::new(
                ChatFileLinkErrorCode::UnsupportedTarget,
                "The linked directory cannot be opened safely.",
            ));
        }
        let inside_workspace =
            target.starts_with(&conversation_workdir) && target != conversation_workdir;
        if inside_workspace && !open_in_file_manager {
            let (response_workdir, response_path, outside_workspace) =
                preview_target(&conversation_workdir, &target)?;
            return Ok(ChatFileLinkPlan {
                response: ChatFileLinkOpenResponse {
                    action: "directory".to_string(),
                    kind: "directory".to_string(),
                    workdir: Some(response_workdir),
                    path: Some(response_path),
                    line: None,
                    end_line: None,
                    column: None,
                    outside_workspace,
                },
                target,
                system_mode: None,
            });
        }
        return Ok(ChatFileLinkPlan {
            response: ChatFileLinkOpenResponse {
                action: "opened".to_string(),
                kind: "directory".to_string(),
                workdir: None,
                path: None,
                line: None,
                end_line: None,
                column: None,
                outside_workspace: true,
            },
            target,
            system_mode: Some("reveal"),
        });
    }
    if !metadata.is_file() {
        return Err(ChatFileLinkError::new(
            ChatFileLinkErrorCode::UnsupportedTarget,
            "The linked path is not a regular file or directory.",
        ));
    }

    let script = has_extension(&target, SCRIPT_EXTENSIONS) || has_shebang(&target);
    let executable = has_extension(&target, EXECUTABLE_EXTENSIONS)
        || (has_executable_permission(&target, &metadata) && !script);
    let action = if script || has_extension(&target, TEXT_EXTENSIONS) {
        "editor"
    } else if has_extension(&target, PREVIEW_EXTENSIONS) {
        "preview"
    } else if executable {
        "revealed"
    } else if is_probably_text(&target) {
        "editor"
    } else {
        return Err(ChatFileLinkError::new(
            ChatFileLinkErrorCode::UnsupportedTarget,
            "The linked file type cannot be opened safely.",
        ));
    };

    if action == "editor" || action == "preview" {
        let (response_workdir, response_path, outside_workspace) =
            preview_target(&conversation_workdir, &target)?;
        return Ok(ChatFileLinkPlan {
            response: ChatFileLinkOpenResponse {
                action: action.to_string(),
                kind: "file".to_string(),
                workdir: Some(response_workdir),
                path: Some(response_path),
                line,
                end_line,
                column,
                outside_workspace,
            },
            target,
            system_mode: None,
        });
    }

    Ok(ChatFileLinkPlan {
        response: ChatFileLinkOpenResponse {
            action: action.to_string(),
            kind: "file".to_string(),
            workdir: None,
            path: None,
            line: None,
            end_line: None,
            column: None,
            outside_workspace: !target.starts_with(&conversation_workdir),
        },
        target,
        system_mode: Some("reveal"),
    })
}

pub(crate) fn open_chat_file_link_sync(
    conversation_id: String,
    workdir: String,
    path: String,
    source: String,
    line: Option<u32>,
    end_line: Option<u32>,
    column: Option<u32>,
    open_in_file_manager: bool,
) -> Result<ChatFileLinkOpenResponse, ChatFileLinkError> {
    let plan = build_chat_file_link_plan(
        &conversation_id,
        &workdir,
        &path,
        &source,
        line,
        end_line,
        column,
        open_in_file_manager,
    )?;
    if let Some(mode) = plan.system_mode {
        spawn_workspace_open_command(&plan.target, mode).map_err(|_| {
            ChatFileLinkError::new(
                ChatFileLinkErrorCode::OpenFailed,
                "The linked file could not be opened on the host device.",
            )
        })?;
    }
    Ok(plan.response)
}

pub(crate) async fn open_chat_file_link_for_conversation(
    conversation_id: String,
    requested_workdir: String,
    path: String,
    source: String,
    line: Option<u32>,
    end_line: Option<u32>,
    column: Option<u32>,
    open_in_file_manager: bool,
) -> Result<ChatFileLinkOpenResponse, ChatFileLinkError> {
    tokio::time::timeout(CHAT_FILE_OPEN_TIMEOUT, async move {
        // Finding the id in the target agent's own history database is the
        // conversation/worker ownership check. The request-supplied workdir is
        // never used as the base for a relative path.
        let summary = chat_history::chat_history_get_summary_inner(conversation_id.clone())
            .await
            .map_err(|_| {
                ChatFileLinkError::new(
                    ChatFileLinkErrorCode::InvalidRequest,
                    "The conversation is unavailable on this device.",
                )
            })?;
        let workdir = summary
            .cwd
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ChatFileLinkError::new(
                    ChatFileLinkErrorCode::InvalidWorkdir,
                    "The conversation working directory is unavailable.",
                )
            })?;
        let _ = requested_workdir;
        let permit = Arc::clone(&CHAT_FILE_OPEN_SEMAPHORE)
            .acquire_owned()
            .await
            .map_err(|_| {
                ChatFileLinkError::new(
                    ChatFileLinkErrorCode::OpenFailed,
                    "The linked file request did not complete.",
                )
            })?;

        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            open_chat_file_link_sync(
                conversation_id,
                workdir,
                path,
                source,
                line,
                end_line,
                column,
                open_in_file_manager,
            )
        })
        .await
        .map_err(|_| {
            ChatFileLinkError::new(
                ChatFileLinkErrorCode::OpenFailed,
                "The linked file request did not complete.",
            )
        })?
    })
    .await
    .map_err(|_| {
        ChatFileLinkError::new(
            ChatFileLinkErrorCode::OpenFailed,
            "The linked file request timed out.",
        )
    })?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn open_chat_file_link(
    conversation_id: String,
    workdir: String,
    path: String,
    source: String,
    line: Option<u32>,
    end_line: Option<u32>,
    column: Option<u32>,
    open_in_file_manager: Option<bool>,
) -> Result<ChatFileLinkOpenResponse, ChatFileLinkError> {
    open_chat_file_link_for_conversation(
        conversation_id,
        workdir,
        path,
        source,
        line,
        end_line,
        column,
        open_in_file_manager.unwrap_or(false),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("liveagent-chat-file-links-{suffix}"));
        fs::create_dir_all(root.join("src")).expect("create temp workspace");
        root
    }

    fn plan(root: &Path, path: &str, source: &str) -> ChatFileLinkPlan {
        build_chat_file_link_plan(
            "conversation-test",
            &root.to_string_lossy(),
            path,
            source,
            None,
            None,
            None,
            false,
        )
        .expect("build plan")
    }

    #[test]
    fn classifies_text_and_preview_files_but_rejects_unknown_binary_types() {
        let root = temp_workspace();
        fs::write(root.join("src/a.ts"), "const value = 1;\n").expect("write source");
        fs::write(root.join("document.pdf"), b"%PDF-test").expect("write pdf");
        fs::write(root.join("opaque.custom"), [0_u8, 1, 2, 3]).expect("write opaque");
        fs::write(root.join("macro.docm"), [0_u8, 1, 2, 3]).expect("write macro document");

        assert_eq!(
            plan(&root, "src/a.ts", "relative").response.action,
            "editor"
        );
        assert_eq!(
            plan(&root, "document.pdf", "relative").response.action,
            "preview"
        );
        for path in ["opaque.custom", "macro.docm"] {
            let error = build_chat_file_link_plan(
                "conversation-test",
                &root.to_string_lossy(),
                path,
                "relative",
                None,
                None,
                None,
                false,
            )
            .expect_err("unknown binary file must fail closed");
            assert_eq!(error.code, ChatFileLinkErrorCode::UnsupportedTarget);
        }

        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[test]
    fn scripts_edit_and_executables_reveal_instead_of_running() {
        let root = temp_workspace();
        fs::write(root.join("request.ps1"), "Write-Output safe\n").expect("write ps1");
        fs::write(root.join("page.hta"), "<script>safe()</script>\n").expect("write hta");
        fs::write(root.join("setup.exe"), [0_u8, 1, 2, 3]).expect("write exe");
        fs::write(
            root.join("settings.reg"),
            "Windows Registry Editor Version 5.00\n",
        )
        .expect("write reg");

        let script = plan(&root, "request.ps1", "relative");
        assert_eq!(script.response.action, "editor");
        assert_eq!(script.system_mode, None);
        assert_eq!(
            plan(&root, "page.hta", "relative").response.action,
            "editor"
        );
        let executable = plan(&root, "setup.exe", "relative");
        assert_eq!(executable.response.action, "revealed");
        assert_eq!(executable.system_mode, Some("reveal"));
        assert_eq!(
            plan(&root, "settings.reg", "relative").response.action,
            "revealed"
        );

        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[test]
    fn workspace_directories_use_file_tree_first_and_support_a_safe_manager_fallback() {
        let root = temp_workspace();
        fs::create_dir(root.join("scripts.ps1")).expect("create script-suffixed directory");
        let directory = plan(&root, "src", "relative");
        assert_eq!(directory.response.action, "directory");
        assert_eq!(directory.system_mode, None);
        let suffixed_directory = plan(&root, "scripts.ps1", "relative");
        assert_eq!(suffixed_directory.response.action, "directory");
        assert_eq!(suffixed_directory.response.kind, "directory");
        assert_eq!(suffixed_directory.system_mode, None);

        let fallback = build_chat_file_link_plan(
            "conversation-test",
            &root.to_string_lossy(),
            "src",
            "relative",
            None,
            None,
            None,
            true,
        )
        .expect("build manager fallback");
        assert_eq!(fallback.response.action, "opened");
        assert_eq!(fallback.response.kind, "directory");
        assert_eq!(fallback.system_mode, Some("reveal"));

        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_active_directory_packages_are_rejected_instead_of_launched() {
        let root = temp_workspace();
        for path in ["Dangerous.app", "Dangerous.workflow", "Dangerous.pkg"] {
            fs::create_dir(root.join(path)).expect("create active directory package");
            let error = build_chat_file_link_plan(
                "conversation-test",
                &root.to_string_lossy(),
                path,
                "relative",
                None,
                None,
                None,
                false,
            )
            .expect_err("active directory package must fail closed");
            assert_eq!(error.code, ChatFileLinkErrorCode::UnsupportedTarget);
        }
        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_other_directory_packages_are_revealed_instead_of_launched() {
        let root = temp_workspace();
        for path in [
            "Dangerous.prefPane",
            "Dangerous.saver",
            "Dangerous.bundle",
            "Dangerous.plugin",
        ] {
            fs::create_dir(root.join(path)).expect("create directory package");
            let planned = build_chat_file_link_plan(
                "conversation-test",
                &root.to_string_lossy(),
                path,
                "relative",
                None,
                None,
                None,
                true,
            )
            .expect("directory package must use safe reveal");
            assert_eq!(planned.response.action, "opened");
            assert_eq!(planned.response.kind, "directory");
            assert_eq!(planned.system_mode, Some("reveal"));
        }
        fs::remove_dir_all(root).expect("remove temp workspace");
    }

    #[test]
    fn resolves_outside_files_to_a_safe_preview_root_and_preserves_location() {
        let root = temp_workspace();
        let outside_dir = root.parent().expect("parent").join(format!(
            "{}-outside",
            root.file_name().expect("name").to_string_lossy()
        ));
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        let outside = outside_dir.join("outside.md");
        fs::write(&outside, "# outside\n").expect("write outside file");

        let planned = build_chat_file_link_plan(
            "conversation-test",
            &root.to_string_lossy(),
            &outside.to_string_lossy(),
            "absolute",
            Some(12),
            Some(20),
            Some(4),
            false,
        )
        .expect("build outside plan");
        assert_eq!(planned.response.action, "editor");
        assert!(planned.response.outside_workspace);
        assert_eq!(planned.response.path.as_deref(), Some("outside.md"));
        assert_eq!(planned.response.line, Some(12));
        assert_eq!(planned.response.end_line, Some(20));
        assert_eq!(planned.response.column, Some(4));

        fs::remove_dir_all(root).expect("remove temp workspace");
        fs::remove_dir_all(outside_dir).expect("remove outside dir");
    }

    #[test]
    fn nonexistent_files_fail_before_any_system_open() {
        let root = temp_workspace();
        let error = build_chat_file_link_plan(
            "conversation-test",
            &root.to_string_lossy(),
            "missing.txt",
            "relative",
            None,
            None,
            None,
            false,
        )
        .expect_err("missing file must fail");
        assert_eq!(error.code, ChatFileLinkErrorCode::NotFound);
        assert_eq!(error.message, "The linked file does not exist.");
        assert!(!error.message.contains(&root.to_string_lossy().to_string()));

        fs::remove_dir_all(root).expect("remove temp workspace");
    }
}
