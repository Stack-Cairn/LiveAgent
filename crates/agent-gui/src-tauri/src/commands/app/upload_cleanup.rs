use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::runtime::platform::expand_tilde_path;

const MANAGED_UPLOAD_BATCH_MARKER: &str = ".liveagent-upload-batch";
const MANAGED_UPLOAD_BATCH_MARKER_CONTENT: &[u8] = b"liveagent-managed-upload-v1\n";

fn create_managed_upload_batch_marker(batch_dir: &Path) -> std::io::Result<()> {
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(batch_dir.join(MANAGED_UPLOAD_BATCH_MARKER))?;
    marker.write_all(MANAGED_UPLOAD_BATCH_MARKER_CONTENT)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ManagedUploadCleanupResult {
    pub removed_files: usize,
    pub removed_batches: usize,
    pub skipped: Vec<String>,
}

pub(crate) fn canonicalize_upload_workdir(workdir: &str) -> Result<PathBuf, String> {
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

fn canonical_managed_uploads_root(workdir: &Path) -> Result<Option<PathBuf>, String> {
    let uploads_root = workdir.join("uploads");
    let metadata = match fs::symlink_metadata(&uploads_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "无法读取上传目录 {}: {error}",
                uploads_root.display()
            ));
        }
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "上传目录不是安全的普通目录：{}",
            uploads_root.display()
        ));
    }

    let canonical_root = fs::canonicalize(&uploads_root)
        .map_err(|e| format!("无法解析上传目录 {}: {e}", uploads_root.display()))?;
    if !canonical_root.starts_with(workdir) || canonical_root == workdir {
        return Err(format!(
            "上传目录超出工作目录：{}",
            canonical_root.display()
        ));
    }
    Ok(Some(canonical_root))
}

pub(crate) fn create_managed_upload_batch(workdir: &Path) -> Result<PathBuf, String> {
    let canonical_workdir = fs::canonicalize(workdir)
        .map_err(|e| format!("无法解析上传工作目录 {}: {e}", workdir.display()))?;
    let uploads_root = canonical_workdir.join("uploads");
    fs::create_dir_all(&uploads_root)
        .map_err(|e| format!("创建上传目录失败 {}: {e}", uploads_root.display()))?;
    let canonical_uploads_root = canonical_managed_uploads_root(&canonical_workdir)?
        .ok_or_else(|| format!("上传目录不存在：{}", uploads_root.display()))?;

    let mut batch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let root = loop {
        let candidate = canonical_uploads_root.join(batch.to_string());
        match fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                batch = batch.saturating_add(1);
            }
            Err(error) => {
                return Err(format!(
                    "创建上传批次目录失败 {}: {error}",
                    candidate.display()
                ));
            }
        }
    };

    if let Err(error) = create_managed_upload_batch_marker(&root) {
        let _ = fs::remove_file(root.join(MANAGED_UPLOAD_BATCH_MARKER));
        let _ = fs::remove_dir(&root);
        return Err(format!("创建上传批次标记失败 {}: {error}", root.display()));
    }
    Ok(root)
}

fn parse_managed_upload_relative_path(relative_path: &str) -> Option<(&str, &str)> {
    let normalized = relative_path.trim();
    if normalized.is_empty() || normalized.contains('\\') {
        return None;
    }

    let mut segments = normalized.split('/');
    if segments.next()? != "uploads" {
        return None;
    }
    let batch = segments.next()?;
    let file_name = segments.next()?;
    if segments.next().is_some()
        || batch.is_empty()
        || !batch.bytes().all(|byte| byte.is_ascii_digit())
        || file_name.is_empty()
        || file_name == MANAGED_UPLOAD_BATCH_MARKER
        || !file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return None;
    }
    Some((batch, file_name))
}

pub(crate) fn is_managed_upload_relative_path(relative_path: &str) -> bool {
    parse_managed_upload_relative_path(relative_path).is_some()
}

pub(crate) fn managed_upload_batch_for_relative_path(relative_path: &str) -> Option<&str> {
    parse_managed_upload_relative_path(relative_path).map(|(batch, _)| batch)
}

fn validate_managed_upload_batch(
    uploads_root: &Path,
    batch: &str,
) -> Result<Option<PathBuf>, String> {
    let batch_dir = uploads_root.join(batch);
    let metadata = match fs::symlink_metadata(&batch_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "无法读取上传批次目录 {}: {error}",
                batch_dir.display()
            ));
        }
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(None);
    }

    let canonical_batch = fs::canonicalize(&batch_dir)
        .map_err(|e| format!("无法解析上传批次目录 {}: {e}", batch_dir.display()))?;
    if canonical_batch.parent() != Some(uploads_root) {
        return Ok(None);
    }

    let marker = canonical_batch.join(MANAGED_UPLOAD_BATCH_MARKER);
    let marker_metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "无法读取上传批次标记 {}: {error}",
                marker.display()
            ));
        }
    };
    if !marker_metadata.is_file() || marker_metadata.file_type().is_symlink() {
        return Ok(None);
    }
    if marker_metadata.len() != MANAGED_UPLOAD_BATCH_MARKER_CONTENT.len() as u64 {
        return Ok(None);
    }
    let marker_content =
        fs::read(&marker).map_err(|e| format!("无法读取上传批次标记 {}: {e}", marker.display()))?;
    if marker_content != MANAGED_UPLOAD_BATCH_MARKER_CONTENT {
        return Ok(None);
    }
    Ok(Some(canonical_batch))
}

fn remove_managed_upload_batch(batch_dir: &Path) -> Result<Option<usize>, String> {
    let marker = batch_dir.join(MANAGED_UPLOAD_BATCH_MARKER);
    let entries = fs::read_dir(batch_dir)
        .map_err(|e| format!("无法读取上传批次目录 {}: {e}", batch_dir.display()))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("无法读取上传批次目录项：{e}"))?;
        let path = entry.path();
        if path == marker {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|e| format!("无法读取上传批次文件 {}: {e}", path.display()))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Ok(None);
        }
        let canonical_file = fs::canonicalize(&path)
            .map_err(|e| format!("无法解析上传批次文件 {}: {e}", path.display()))?;
        if canonical_file.parent() != Some(batch_dir) {
            return Ok(None);
        }
        files.push(canonical_file);
    }

    files.sort();
    for file in &files {
        fs::remove_file(file).map_err(|e| format!("删除上传文件失败 {}: {e}", file.display()))?;
    }
    fs::remove_file(&marker)
        .map_err(|e| format!("删除上传批次标记失败 {}: {e}", marker.display()))?;
    if let Err(error) = fs::remove_dir(batch_dir) {
        let _ = create_managed_upload_batch_marker(batch_dir);
        return Err(format!(
            "删除空上传批次目录失败 {}: {error}",
            batch_dir.display()
        ));
    }
    Ok(Some(files.len()))
}

pub(crate) fn cleanup_managed_upload_batches_sync(
    workdir: &str,
    batches: &[String],
) -> Result<ManagedUploadCleanupResult, String> {
    let canonical_workdir = canonicalize_upload_workdir(workdir)?;
    let Some(uploads_root) = canonical_managed_uploads_root(&canonical_workdir)? else {
        return Ok(ManagedUploadCleanupResult::default());
    };

    let mut result = ManagedUploadCleanupResult::default();
    let mut seen_batches = std::collections::BTreeSet::new();
    for batch in batches {
        let batch = batch.trim();
        if !seen_batches.insert(batch.to_string()) {
            continue;
        }
        if batch.is_empty() || !batch.bytes().all(|byte| byte.is_ascii_digit()) {
            result.skipped.push(batch.to_string());
            continue;
        }
        let Some(batch_dir) = validate_managed_upload_batch(&uploads_root, batch)? else {
            result.skipped.push(batch.to_string());
            continue;
        };
        match remove_managed_upload_batch(&batch_dir)? {
            Some(removed_files) => {
                result.removed_files += removed_files;
                result.removed_batches += 1;
            }
            None => result.skipped.push(batch.to_string()),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn chat_history_managed_batch_cleanup_removes_owned_files() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        fs::create_dir_all(&workdir).expect("create workdir");
        let batch_dir = create_managed_upload_batch(&workdir).expect("create managed batch");
        fs::write(batch_dir.join("first.txt"), "first").expect("write first upload");
        fs::write(batch_dir.join("second.txt"), "second").expect("write second upload");
        let batch = batch_dir
            .file_name()
            .and_then(|name| name.to_str())
            .expect("batch name")
            .to_string();

        let result = cleanup_managed_upload_batches_sync(&workdir.to_string_lossy(), &[batch])
            .expect("cleanup managed batch");

        assert_eq!(result.removed_files, 2);
        assert_eq!(result.removed_batches, 1);
        assert!(result.skipped.is_empty());
        assert!(!batch_dir.exists());
    }

    #[test]
    fn chat_history_managed_batch_cleanup_rejects_unowned_and_unsafe_batches() {
        let temp = tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        let unowned_batch = workdir.join("uploads").join("1234567890123");
        fs::create_dir_all(&unowned_batch).expect("create unowned batch");
        let unowned_file = unowned_batch.join("keep.txt");
        fs::write(&unowned_file, "keep").expect("write unowned file");

        let unsafe_batch = workdir.join("uploads").join("1234567890124");
        fs::create_dir_all(unsafe_batch.join("nested")).expect("create unsafe nested directory");
        fs::write(
            unsafe_batch.join(MANAGED_UPLOAD_BATCH_MARKER),
            MANAGED_UPLOAD_BATCH_MARKER_CONTENT,
        )
        .expect("write managed marker");
        let nested_file = unsafe_batch.join("nested").join("keep.txt");
        fs::write(&nested_file, "keep").expect("write nested file");
        let batches = vec![
            "1234567890123".to_string(),
            "1234567890124".to_string(),
            "../outside.txt".to_string(),
        ];

        let result = cleanup_managed_upload_batches_sync(&workdir.to_string_lossy(), &batches)
            .expect("reject unsafe batches");

        assert_eq!(result.removed_files, 0);
        assert_eq!(result.removed_batches, 0);
        assert_eq!(result.skipped.len(), batches.len());
        assert!(unowned_file.is_file());
        assert!(nested_file.is_file());
    }
}
