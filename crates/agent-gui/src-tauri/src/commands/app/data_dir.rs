//! Relocating the LiveAgent data root (`~/.liveagent` by default) from settings.
//!
//! Migration stops K-brain, copies the current root into an empty target,
//! verifies every copied file, then records the target in the pointer file of
//! the default root. The new location takes effect after the app restarts; the
//! old directory is left untouched so a failed or interrupted move never loses
//! data, and the user can delete it once satisfied.
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::runtime::data_home::{
    data_root, data_root_env_override, default_data_root, write_pointer, POINTER_FILE_NAME,
};
use crate::services::kbrain_backend::KBrainBackendState;

/// Entries that always stay in the default root: the relocation pointer, the
/// browser extension (Chrome records its absolute path) and git worktrees
/// (repositories record their absolute paths).
const PINNED_TO_DEFAULT_ROOT: [&str; 3] = [POINTER_FILE_NAME, "extension", "worktree"];
/// Finder/Explorer metadata that does not make a target directory "non-empty".
const IGNORED_TARGET_ENTRIES: [&str; 2] = [".DS_Store", "desktop.ini"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirStatus {
    pub current: String,
    pub default: String,
    pub custom: bool,
    /// Environment variable that pins the data location, if any; relocation is
    /// disabled while it is set.
    pub env_override: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirMigrateResult {
    pub previous: String,
    pub target: String,
    pub files: u64,
    pub bytes: u64,
}

fn roots() -> Result<(PathBuf, PathBuf), String> {
    let current = data_root().ok_or_else(|| "无法定位用户目录".to_string())?;
    let default = default_data_root().ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok((current, default))
}

#[tauri::command]
pub fn data_dir_status() -> Result<DataDirStatus, String> {
    let (current, default) = roots()?;
    Ok(DataDirStatus {
        custom: current != default,
        current: current.to_string_lossy().into_owned(),
        default: default.to_string_lossy().into_owned(),
        env_override: data_root_env_override().map(str::to_string),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn data_dir_migrate(
    app: AppHandle,
    target: String,
) -> Result<DataDirMigrateResult, String> {
    if let Some(name) = data_root_env_override() {
        return Err(format!("数据目录由环境变量 {name} 指定，无法在设置中修改"));
    }
    let (source, default) = roots()?;
    let target = PathBuf::from(target.trim());
    validate_target(&source, &target, &default)?;

    let backend = app
        .try_state::<Arc<KBrainBackendState>>()
        .map(|state| Arc::clone(state.inner()));
    if let Some(backend) = backend.clone() {
        // While the copy runs, the app's reconnect attempts must not bring K-brain back on
        // the old root: whatever it wrote there would be missing after the restart. Stopping
        // waits for the process tree, so keep it off the async runtime.
        tauri::async_runtime::spawn_blocking(move || backend.suspend_and_shutdown())
            .await
            .map_err(|error| format!("停止本地服务失败：{error}"))?;
    }
    let (copy_source, copy_target, pointer_root) =
        (source.clone(), target.clone(), default.clone());
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let stats = migrate_sync(&copy_source, &copy_target, &pointer_root)?;
        Ok::<_, String>(stats)
    })
    .await
    .map_err(|error| format!("数据迁移任务异常退出：{error}"))
    .and_then(|result| result);

    match outcome {
        Ok((files, bytes)) => Ok(DataDirMigrateResult {
            previous: source.to_string_lossy().into_owned(),
            target: target.to_string_lossy().into_owned(),
            files,
            bytes,
        }),
        Err(error) => {
            // The old root is still authoritative: bring K-brain back on it.
            if let Some(backend) = backend {
                backend.resume_starts();
                let handle = app.clone();
                let _ =
                    tauri::async_runtime::spawn_blocking(move || backend.ensure_started(&handle))
                        .await;
            }
            Err(error)
        }
    }
}

/// Copies `source` into `target`, verifies it and switches the pointer. On any
/// failure the entries created in `target` are removed again.
fn migrate_sync(source: &Path, target: &Path, default_root: &Path) -> Result<(u64, u64), String> {
    fs::create_dir_all(target).map_err(|e| format!("创建目标目录失败：{e}"))?;
    let mut created = Vec::new();
    let result =
        copy_root(source, target, source == default_root, &mut created).and_then(|stats| {
            write_pointer(default_root, Some(target))
                .map_err(|e| format!("写入数据目录配置失败：{e}"))?;
            Ok(stats)
        });
    if result.is_err() {
        for entry in created {
            let _ = if entry.is_dir() && !entry.is_symlink() {
                fs::remove_dir_all(&entry)
            } else {
                fs::remove_file(&entry)
            };
        }
    }
    result
}

fn validate_target(source: &Path, target: &Path, default_root: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("请选择一个绝对路径".into());
    }
    if !source.is_dir() {
        return Err(format!("当前数据目录不存在：{}", source.display()));
    }
    let source_real = fs::canonicalize(source).map_err(|e| format!("解析当前数据目录失败：{e}"))?;
    let target_real = resolve_lexically(target)?;
    if target_real == source_real {
        return Err("新目录与当前数据目录相同".into());
    }
    if target_real.starts_with(&source_real) || source_real.starts_with(&target_real) {
        return Err("新目录不能位于当前数据目录之内，也不能包含当前数据目录".into());
    }
    match fs::metadata(target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("读取目标目录失败：{error}")),
        Ok(meta) if !meta.is_dir() => Err("目标路径不是目录".into()),
        Ok(_) => {
            let pinned_allowed = target == default_root;
            let entries = fs::read_dir(target).map_err(|e| format!("读取目标目录失败：{e}"))?;
            for entry in entries {
                let entry = entry.map_err(|e| format!("读取目标目录失败：{e}"))?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let ignorable = IGNORED_TARGET_ENTRIES.contains(&name.as_ref())
                    || (pinned_allowed && PINNED_TO_DEFAULT_ROOT.contains(&name.as_ref()));
                if !ignorable {
                    return Err(format!(
                        "目标目录不为空，请选择空目录（或先清理 {}）",
                        target.display()
                    ));
                }
            }
            Ok(())
        }
    }
}

/// Canonicalizes the nearest existing ancestor and re-appends the rest, so a
/// not-yet-created target can still be compared against the source.
fn resolve_lexically(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut resolved = fs::canonicalize(&existing).map_err(|e| format!("解析目标目录失败：{e}"))?;
    for name in rest.into_iter().rev() {
        if Path::new(&name)
            .components()
            .any(|c| matches!(c, Component::ParentDir))
        {
            return Err("目标路径不能包含 ..".into());
        }
        resolved.push(name);
    }
    Ok(resolved)
}

fn copy_root(
    source: &Path,
    target: &Path,
    skip_pinned: bool,
    created: &mut Vec<PathBuf>,
) -> Result<(u64, u64), String> {
    let mut stats = (0u64, 0u64);
    let entries = fs::read_dir(source).map_err(|e| format!("读取数据目录失败：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取数据目录失败：{e}"))?;
        let name = entry.file_name();
        if skip_pinned && PINNED_TO_DEFAULT_ROOT.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let dest = target.join(&name);
        if dest.symlink_metadata().is_ok() {
            // Only ignorable metadata files can pre-exist (see validate_target).
            continue;
        }
        created.push(dest.clone());
        copy_entry(&entry.path(), &dest, &mut stats)?;
    }
    Ok(stats)
}

fn copy_entry(source: &Path, dest: &Path, stats: &mut (u64, u64)) -> Result<(), String> {
    let meta =
        fs::symlink_metadata(source).map_err(|e| format!("读取 {} 失败：{e}", source.display()))?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        let link = fs::read_link(source)
            .map_err(|e| format!("读取链接 {} 失败：{e}", source.display()))?;
        create_symlink(&link, dest, source)
            .map_err(|e| format!("复制链接 {} 失败：{e}", source.display()))?;
        stats.0 += 1;
    } else if file_type.is_dir() {
        fs::create_dir_all(dest).map_err(|e| format!("创建目录 {} 失败：{e}", dest.display()))?;
        let entries =
            fs::read_dir(source).map_err(|e| format!("读取 {} 失败：{e}", source.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取 {} 失败：{e}", source.display()))?;
            copy_entry(&entry.path(), &dest.join(entry.file_name()), stats)?;
        }
    } else if is_special_file(&file_type) {
        // Sockets, FIFOs and device nodes (a crashed browser's singleton socket, say) are
        // runtime state, not data: opening a FIFO to copy it blocks until a writer appears,
        // which would hang the migration with K-brain stopped.
    } else {
        let copied =
            fs::copy(source, dest).map_err(|e| format!("复制 {} 失败：{e}", source.display()))?;
        // Verify against the bytes actually copied: files that are appended to
        // concurrently (logs) may legitimately grow in the source meanwhile.
        let written = fs::metadata(dest)
            .map_err(|e| format!("校验 {} 失败：{e}", dest.display()))?
            .len();
        if written != copied || copied < meta.len() {
            return Err(format!("校验 {} 失败：大小不一致", dest.display()));
        }
        stats.0 += 1;
        stats.1 += copied;
    }
    Ok(())
}

#[cfg(unix)]
fn is_special_file(file_type: &fs::FileType) -> bool {
    use std::os::unix::fs::FileTypeExt;
    file_type.is_socket()
        || file_type.is_fifo()
        || file_type.is_block_device()
        || file_type.is_char_device()
}

#[cfg(not(unix))]
fn is_special_file(_file_type: &fs::FileType) -> bool {
    false
}

#[cfg(unix)]
fn create_symlink(link: &Path, dest: &Path, _source: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(link, dest)
}

#[cfg(windows)]
fn create_symlink(link: &Path, dest: &Path, source: &Path) -> std::io::Result<()> {
    if fs::metadata(source).map(|m| m.is_dir()).unwrap_or(false) {
        std::os::windows::fs::symlink_dir(link, dest)
    } else {
        std::os::windows::fs::symlink_file(link, dest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::data_home::read_pointer;

    fn seed(root: &Path) {
        fs::create_dir_all(root.join("sessions/a")).unwrap();
        fs::write(root.join("sessions/a/session.jsonl"), b"{\"x\":1}\n").unwrap();
        fs::write(root.join("config.sqlite"), vec![7u8; 4096]).unwrap();
        fs::create_dir_all(root.join("extension")).unwrap();
        fs::write(root.join("extension/manifest.json"), b"{}").unwrap();
        fs::create_dir_all(root.join("worktree/repo")).unwrap();
    }

    #[test]
    fn migration_copies_data_and_switches_pointer() {
        let temp = tempfile::tempdir().unwrap();
        let default_root = temp.path().join(".liveagent");
        seed(&default_root);
        let target = temp.path().join("data").join("liveagent");

        validate_target(&default_root, &target, &default_root).unwrap();
        let (files, bytes) = migrate_sync(&default_root, &target, &default_root).unwrap();

        assert_eq!(files, 2);
        assert_eq!(bytes, 4096 + 8);
        assert_eq!(
            fs::read(target.join("sessions/a/session.jsonl")).unwrap(),
            b"{\"x\":1}\n"
        );
        assert!(
            !target.join("extension").exists(),
            "extension stays in the default root"
        );
        assert!(
            !target.join("worktree").exists(),
            "worktrees stay in the default root"
        );
        assert_eq!(read_pointer(&default_root), Some(target));
        assert!(
            default_root.join("config.sqlite").exists(),
            "old data is kept"
        );
    }

    #[test]
    fn moving_back_to_default_requires_cleared_default_root() {
        let temp = tempfile::tempdir().unwrap();
        let default_root = temp.path().join(".liveagent");
        let custom = temp.path().join("custom");
        seed(&custom);
        fs::create_dir_all(default_root.join("extension")).unwrap();
        write_pointer(&default_root, Some(&custom)).unwrap();

        // Only pinned entries left in the default root: allowed.
        validate_target(&custom, &default_root, &default_root).unwrap();
        migrate_sync(&custom, &default_root, &default_root).unwrap();
        assert_eq!(read_pointer(&default_root), None);
        assert!(default_root.join("sessions/a/session.jsonl").exists());

        // Stale data in the default root blocks the move.
        let elsewhere = temp.path().join("elsewhere");
        seed(&elsewhere);
        let error = validate_target(&elsewhere, &default_root, &default_root).unwrap_err();
        assert!(error.contains("不为空"), "{error}");
    }

    #[test]
    fn rejects_nested_relative_and_non_empty_targets() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join(".liveagent");
        seed(&source);
        let default_root = source.clone();

        for target in [
            source.join("inner"),
            temp.path().to_path_buf(),
            PathBuf::from("relative"),
        ] {
            assert!(
                validate_target(&source, &target, &default_root).is_err(),
                "{}",
                target.display()
            );
        }
        let busy = temp.path().join("busy");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join("file.txt"), b"x").unwrap();
        assert!(validate_target(&source, &busy, &default_root).is_err());

        let finder_only = temp.path().join("finder");
        fs::create_dir_all(&finder_only).unwrap();
        fs::write(finder_only.join(".DS_Store"), b"x").unwrap();
        validate_target(&source, &finder_only, &default_root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn migration_skips_sockets_and_fifos_and_keeps_symlinks_unresolved() {
        use std::os::unix::net::UnixListener;
        let temp = tempfile::tempdir().unwrap();
        let default_root = temp.path().join(".liveagent");
        seed(&default_root);
        let profile = default_root.join("browser-profile");
        fs::create_dir_all(&profile).unwrap();
        // Unix socket paths are short-limited; keep the live socket outside the deep root.
        let sockets = tempfile::Builder::new()
            .prefix("s")
            .tempdir_in("/tmp")
            .unwrap();
        let _live = UnixListener::bind(sockets.path().join("sock")).unwrap();
        std::os::unix::fs::symlink(sockets.path().join("sock"), profile.join("SingletonSocket"))
            .unwrap();
        let _direct = UnixListener::bind(sockets.path().join("direct")).unwrap();
        fs::rename(sockets.path().join("direct"), profile.join("direct.sock")).unwrap();
        let fifo = profile.join("pipe");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let target = temp.path().join("moved");

        // Before the fix the FIFO's open() blocked forever; bound the test instead of hanging.
        let (tx, rx) = std::sync::mpsc::channel();
        let (source, dest, root) = (default_root.clone(), target.clone(), default_root.clone());
        std::thread::spawn(move || {
            let _ = tx.send(migrate_sync(&source, &dest, &root));
        });
        let (files, _) = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("migration must not block on special files")
            .unwrap();

        assert_eq!(files, 3, "two data files plus the symlink");
        let link = target.join("browser-profile/SingletonSocket");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&link).unwrap(), sockets.path().join("sock"));
        assert!(fs::symlink_metadata(target.join("browser-profile/pipe")).is_err());
        assert!(fs::symlink_metadata(target.join("browser-profile/direct.sock")).is_err());
        assert_eq!(read_pointer(&default_root), Some(target));
    }

    #[test]
    fn failed_copy_removes_partial_target() {
        let temp = tempfile::tempdir().unwrap();
        let default_root = temp.path().join(".liveagent");
        seed(&default_root);
        // A pointer that cannot be written (a directory in its place) fails the
        // final step after the copy succeeded.
        fs::create_dir_all(default_root.join(POINTER_FILE_NAME).join("blocker")).unwrap();
        let target = temp.path().join("target");

        assert!(migrate_sync(&default_root, &target, &default_root).is_err());
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        assert!(default_root.join("config.sqlite").exists());
    }
}
