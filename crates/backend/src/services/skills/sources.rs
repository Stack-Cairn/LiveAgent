//! 安装源准备：GitHub / HTTP / 本地目录 / 压缩包，含下载与安全解压。

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use zip::ZipArchive;

use super::*;

const MAX_SKILL_INSTALL_FILES: usize = 2000;
const MAX_SKILL_INSTALL_BYTES: u64 = 50 * 1024 * 1024;
pub(crate) const DEFAULT_GITHUB_REF: &str = "main";

pub(crate) fn is_archive_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("zip") | Some("skill")
    )
}

pub(crate) fn safe_extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Failed to create archive extraction directory: {e}"))?;
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open Skill archive {}: {e}", zip_path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Failed to read Skill archive {}: {e}", zip_path.display()))?;

    if archive.len() > MAX_SKILL_INSTALL_FILES {
        return Err(format!(
            "Skill archive contains too many files: {}",
            archive.len()
        ));
    }

    let mut total_bytes = 0u64;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read archive entry: {e}"))?;
        let Some(enclosed_name) = file.enclosed_name().map(PathBuf::from) else {
            return Err(format!(
                "Archive entry escapes extraction root: {}",
                file.name()
            ));
        };
        if enclosed_name.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        }) {
            return Err(format!("Archive entry has an unsafe path: {}", file.name()));
        }
        if file
            .unix_mode()
            .map(|mode| (mode & 0o170000) == 0o120000)
            .unwrap_or(false)
        {
            return Err(format!("Archive entry is a symlink: {}", file.name()));
        }
        total_bytes = total_bytes.saturating_add(file.size());
        if total_bytes > MAX_SKILL_INSTALL_BYTES {
            return Err(format!(
                "Skill archive is too large after extraction, over {} bytes",
                MAX_SKILL_INSTALL_BYTES
            ));
        }

        let out_path = dest_dir.join(enclosed_name);
        if file.name().ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create archive directory: {e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create archive parent directory: {e}"))?;
        }
        let mut out_file = fs::File::create(&out_path)
            .map_err(|e| format!("Failed to create archive output file: {e}"))?;
        io::copy(&mut file, &mut out_file)
            .map_err(|e| format!("Failed to extract archive entry: {e}"))?;
    }
    Ok(())
}

pub(crate) fn write_download_to_path_with_progress<F>(
    url: &str,
    target: &Path,
    mut on_progress: F,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String>
where
    F: FnMut(u64, Option<u64>),
{
    let client = crate::services::system_proxy::blocking_client_builder()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?
        .timeout(Duration::from_secs(30))
        .user_agent("liveagent-skill-installer")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("Failed to download Skill source: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        // 注册表错误响应体通常带修复指引（如 ClawHub 409 要求 ownerHandle），截断后回显。
        let mut raw = Vec::new();
        let _ = response.take(2048).read_to_end(&mut raw);
        let body = String::from_utf8_lossy(&raw);
        let snippet = body.trim();
        return Err(if snippet.is_empty() {
            format!("Skill source download failed with HTTP {status}")
        } else {
            format!("Skill source download failed with HTTP {status}: {snippet}")
        });
    }
    let total_bytes = response.content_length();
    if total_bytes
        .map(|value| value > MAX_SKILL_INSTALL_BYTES)
        .unwrap_or(false)
    {
        return Err(format!(
            "Downloaded Skill source is too large, over {} bytes",
            MAX_SKILL_INSTALL_BYTES
        ));
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Skill download directory: {e}"))?;
    }
    let mut output = fs::File::create(target)
        .map_err(|e| format!("Failed to stage downloaded Skill source: {e}"))?;
    let mut bytes = Vec::new();
    let mut downloaded = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    on_progress(downloaded, total_bytes);

    loop {
        if should_cancel() {
            return Err(INSTALL_CANCELLED_ERROR.to_string());
        }
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read Skill source response: {e}"))?;
        if read == 0 {
            break;
        }
        downloaded = downloaded.saturating_add(read as u64);
        if downloaded > MAX_SKILL_INSTALL_BYTES {
            return Err(format!(
                "Downloaded Skill source is too large, over {} bytes",
                MAX_SKILL_INSTALL_BYTES
            ));
        }
        output
            .write_all(&buffer[..read])
            .map_err(|e| format!("Failed to write downloaded Skill source: {e}"))?;
        bytes.extend_from_slice(&buffer[..read]);
        on_progress(downloaded, total_bytes);
    }
    output
        .flush()
        .map_err(|e| format!("Failed to flush downloaded Skill source: {e}"))?;
    Ok(bytes)
}

pub(crate) fn write_download_to_path(
    url: &str,
    target: &Path,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    write_download_to_path_with_progress(url, target, |_, _| {}, should_cancel)
}

pub(crate) fn is_github_source(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("github.com" | "www.github.com"))
}

pub(crate) fn is_http_source(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
}

pub(crate) fn parse_github_url(value: &str, default_ref: &str) -> Result<GithubSource, String> {
    let url = reqwest::Url::parse(value).map_err(|e| format!("Invalid GitHub URL: {e}"))?;
    if !matches!(url.host_str(), Some("github.com" | "www.github.com")) {
        return Err("Only github.com URLs are supported".to_string());
    }
    let parts = url
        .path_segments()
        .ok_or_else(|| "GitHub URL must include owner and repo".to_string())?
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err("GitHub URL must include owner and repo".to_string());
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    let mut git_ref = default_ref.trim();
    if git_ref.is_empty() {
        git_ref = DEFAULT_GITHUB_REF;
    }
    let mut subpath = None;

    if parts.len() > 2 {
        let marker = parts[2];
        if marker == "tree" || marker == "blob" {
            if parts.len() < 4 {
                return Err("GitHub tree/blob URL must include a ref".to_string());
            }
            git_ref = parts[3];
            if parts.len() > 4 {
                subpath = Some(parts[4..].join("/"));
            }
        } else {
            subpath = Some(parts[2..].join("/"));
        }
    }

    Ok(GithubSource {
        owner,
        repo,
        git_ref: git_ref.to_string(),
        subpath,
    })
}

pub(crate) fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut command = Command::new("git");
    crate::runtime::process::configure_child_process_group(&mut command);
    command.args(args);
    for (key, value) in crate::services::system_proxy::shell_proxy_envs()? {
        command.env(key, value);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .map_err(|e| format!("Failed to start git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git command failed".to_string()
        } else {
            stderr
        });
    }
    Ok(())
}

pub(crate) fn prepare_github_source(
    value: &str,
    method: &str,
    default_ref: &str,
    tmp_root: &Path,
    should_cancel: &dyn Fn() -> bool,
) -> Result<PathBuf, String> {
    let source = parse_github_url(value, default_ref)?;
    let mut repo_root = None;
    if method == "auto" || method == "download" {
        let archive = tmp_root.join("github-repo.zip");
        let zip_url = format!(
            "https://codeload.github.com/{}/{}/zip/{}",
            source.owner, source.repo, source.git_ref
        );
        match write_download_to_path(&zip_url, &archive, should_cancel).and_then(|_| {
            let extract_dir = tmp_root.join("github-download");
            safe_extract_zip(&archive, &extract_dir)?;
            let mut top_levels = fs::read_dir(&extract_dir)
                .map_err(|e| format!("Failed to inspect GitHub archive: {e}"))?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect::<Vec<_>>();
            top_levels.sort();
            if top_levels.len() != 1 {
                return Err("Unexpected GitHub archive layout".to_string());
            }
            Ok(top_levels.remove(0))
        }) {
            Ok(path) => repo_root = Some(path),
            Err(error) if error == INSTALL_CANCELLED_ERROR => return Err(error),
            Err(error) if method == "download" => {
                return Err(format!("GitHub download failed: {error}"));
            }
            Err(_) => {}
        }
    }
    if should_cancel() {
        return Err(INSTALL_CANCELLED_ERROR.to_string());
    }

    if repo_root.is_none() {
        let repo_dir = tmp_root.join("github-repo");
        let repo_url = format!("https://github.com/{}/{}.git", source.owner, source.repo);
        let repo_dir_str = repo_dir
            .to_str()
            .ok_or_else(|| "Temporary git path is not valid UTF-8".to_string())?;
        let mut clone_args = vec![
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--branch",
            source.git_ref.as_str(),
        ];
        if source.subpath.is_some() {
            clone_args.push("--filter=blob:none");
            clone_args.push("--sparse");
        }
        clone_args.push(repo_url.as_str());
        clone_args.push(repo_dir_str);
        run_git(&clone_args, None)?;
        if let Some(subpath) = source.subpath.as_deref() {
            run_git(&["sparse-checkout", "set", subpath], Some(&repo_dir))?;
            run_git(&["checkout", source.git_ref.as_str()], Some(&repo_dir))?;
        }
        repo_root = Some(repo_dir);
    }

    let repo_root = repo_root.ok_or_else(|| "Failed to prepare GitHub source".to_string())?;
    if let Some(subpath) = source.subpath {
        let selected = repo_root.join(&subpath);
        if !selected.exists() {
            return Err(format!("GitHub path not found: {subpath}"));
        }
        return Ok(selected);
    }
    Ok(repo_root)
}

pub(crate) fn prepare_http_source_with_progress<F>(
    value: &str,
    tmp_root: &Path,
    mut on_progress: F,
    should_cancel: &dyn Fn() -> bool,
) -> Result<PathBuf, String>
where
    F: FnMut(SkillInstallProgressUpdate),
{
    let url = reqwest::Url::parse(value).map_err(|e| format!("Invalid source URL: {e}"))?;
    let lower_path = url.path().to_ascii_lowercase();
    let download_path = tmp_root.join("downloaded-skill-source");
    on_progress(SkillInstallProgressUpdate {
        phase: "downloading",
        downloaded_bytes: Some(0),
        total_bytes: None,
        message: Some("Downloading Skill archive".to_string()),
    });
    let bytes = write_download_to_path_with_progress(
        value,
        &download_path,
        |downloaded, total| {
            on_progress(SkillInstallProgressUpdate {
                phase: "downloading",
                downloaded_bytes: Some(downloaded),
                total_bytes: total,
                message: Some("Downloading Skill archive".to_string()),
            });
        },
        should_cancel,
    )?;
    let is_zip = lower_path.ends_with(".zip")
        || lower_path.ends_with(".skill")
        || bytes.starts_with(b"PK\x03\x04");

    if is_zip {
        let extract_dir = tmp_root.join("downloaded-archive");
        on_progress(SkillInstallProgressUpdate {
            phase: "extracting",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Extracting Skill archive".to_string()),
        });
        safe_extract_zip(&download_path, &extract_dir)?;
        return Ok(extract_dir);
    }

    if lower_path.ends_with("skill.json")
        || lower_path.ends_with("skill.md")
        || lower_path.ends_with("skill")
        || strip_utf8_bom(&String::from_utf8_lossy(&bytes))
            .trim_start()
            .starts_with("---")
        || strip_utf8_bom(&String::from_utf8_lossy(&bytes))
            .trim_start()
            .starts_with('{')
    {
        let single_dir = tmp_root.join("downloaded-single-skill");
        on_progress(SkillInstallProgressUpdate {
            phase: "validating",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Preparing downloaded Skill file".to_string()),
        });
        fs::create_dir_all(&single_dir)
            .map_err(|e| format!("Failed to stage downloaded Skill: {e}"))?;
        let file_name = if lower_path.ends_with("skill.json")
            || strip_utf8_bom(&String::from_utf8_lossy(&bytes))
                .trim_start()
                .starts_with('{')
        {
            "skill.json"
        } else {
            "SKILL.md"
        };
        fs::write(single_dir.join(file_name), bytes)
            .map_err(|e| format!("Failed to write downloaded Skill file: {e}"))?;
        return Ok(single_dir);
    }

    Err(
        "HTTP(S) Skill sources must be .zip/.skill archives or a SKILL.md/skill.json file"
            .to_string(),
    )
}

pub(crate) fn prepare_local_or_archive_source(
    source: &str,
    tmp_root: &Path,
) -> Result<PathBuf, String> {
    let source_path = crate::runtime::platform::expand_tilde_path(source);
    if !source_path.exists() {
        return Err(format!("Source not found: {source}"));
    }
    let source_path = fs::canonicalize(&source_path).map_err(|e| {
        format!(
            "Failed to resolve source path {}: {e}",
            source_path.display()
        )
    })?;

    if source_path.is_dir() {
        return Ok(source_path);
    }

    if source_path.is_file() && is_archive_path(&source_path) {
        let extract_dir = tmp_root.join("archive");
        safe_extract_zip(&source_path, &extract_dir)?;
        return Ok(extract_dir);
    }

    if source_path.is_file() && is_skill_metadata_candidate(&source_path) {
        return source_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Source Skill file has no parent directory".to_string());
    }

    Err("Source must be a skill directory, .zip/.skill archive, GitHub URL, or HTTP(S) Skill download URL".to_string())
}
