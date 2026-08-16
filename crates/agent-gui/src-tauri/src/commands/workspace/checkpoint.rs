//! 会话级文件检查点:fs 写入类命令在落盘前把被改文件的"前像"存到
//! `~/.liveagent/checkpoints/<conversationId>/`,供 rewind 把工作区回退到
//! 某轮开始前的状态。
//!
//! 设计要点:
//! - 捕获发生在 fs 命令实现内部(与变更同一次调用),不引入额外 IPC,
//!   也不重复 root:// / skill:// 的路径解析。
//! - blob 是原始字节拷贝(不内嵌 JSON),索引是追加式 index.jsonl;
//!   回退正确性来自"每个 (turn, path) 取最早一条记录",去重只是省空间。
//! - 捕获是尽力而为:任何内部错误只记日志,绝不让文件写入本身失败。
//! - 目录删除只记不可恢复的标记(kind="dir"),在 diff 统计里如实呈现。
//! - Bash / 托管进程的写入不经过这里,UI 需要明确说明这一限制。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// TS 侧随 fs 变更命令附带的检查点上下文;缺省(None)表示该调用不捕获。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCtx {
    pub conversation_id: String,
    pub turn_seq: u64,
}

/// index.jsonl 里的一条前像记录。path 为绝对路径(捕获时已解析完毕)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRecord {
    pub turn_seq: u64,
    pub path: String,
    /// "file" | "dir";dir 只是删除标记,无法恢复。
    pub kind: String,
    pub existed_before: bool,
    /// blobs/ 目录下的文件名;existed_before=false 或 kind="dir" 时为空。
    pub blob: Option<String>,
    pub size: u64,
    pub mtime_ms: u64,
    pub captured_at: u64,
}

/// 捕获时携带的前像内容,避免调用方(如 Edit)已读过的字节被二次读取。
pub enum PreImage<'a> {
    /// 变更前文件不存在(回退 = 删除该文件)。
    Missing,
    /// 变更前是普通文件;None 表示由捕获方自行从磁盘读取。
    File(Option<&'a [u8]>),
    /// 变更前是目录(递归删除);只能记标记,无法恢复。
    Dir,
}

// index.jsonl 的"读检查 + 追加"必须互斥:并发 fs 命令可能同轮同文件竞争。
static INDEX_LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// conversationId 会成为目录名,防御性过滤到安全字符集。
fn sanitize_conversation_id(id: &str) -> Option<String> {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn checkpoints_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to locate the user home directory".to_string())?;
    Ok(home.join(".liveagent").join("checkpoints"))
}

fn conversation_dir(conversation_id: &str) -> Result<PathBuf, String> {
    let safe = sanitize_conversation_id(conversation_id)
        .ok_or_else(|| "checkpoint conversationId is empty".to_string())?;
    Ok(checkpoints_root()?.join(safe))
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.jsonl")
}

fn blobs_dir(dir: &Path) -> PathBuf {
    dir.join("blobs")
}

fn path_hash16(abs_path: &str) -> String {
    let digest = Sha256::digest(abs_path.as_bytes());
    hex_encode(&digest)[..16].to_string()
}

fn read_index(dir: &Path) -> Vec<CheckpointRecord> {
    let Ok(text) = fs::read_to_string(index_path(dir)) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<CheckpointRecord>(line).ok())
        .collect()
}

fn append_record(dir: &Path, record: &CheckpointRecord) -> Result<(), String> {
    let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(index_path(dir))
        .map_err(|e| e.to_string())?;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| e.to_string())
}

/// 在 blobs/ 下找下一个空闲版本号写入。同一路径的版本极少,线性探测足够。
fn write_blob(dir: &Path, abs_path: &str, bytes: &[u8]) -> Result<String, String> {
    let blobs = blobs_dir(dir);
    fs::create_dir_all(&blobs).map_err(|e| e.to_string())?;
    let hash = path_hash16(abs_path);
    for version in 1..u32::MAX {
        let name = format!("{hash}@v{version}");
        let target = blobs.join(&name);
        if target.exists() {
            continue;
        }
        fs::write(&target, bytes).map_err(|e| e.to_string())?;
        return Ok(name);
    }
    Err("checkpoint blob version space exhausted".to_string())
}

fn capture_inner(ctx: &CheckpointCtx, abs_path: &Path, pre_image: PreImage) -> Result<(), String> {
    let dir = conversation_dir(&ctx.conversation_id)?;
    capture_at(&dir, ctx.turn_seq, abs_path, pre_image)
}

/// 目录可注入的捕获实现,便于单测绕过 home 解析。
fn capture_at(
    dir: &Path,
    turn_seq: u64,
    abs_path: &Path,
    pre_image: PreImage,
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path_str = abs_path.to_string_lossy().replace('\\', "/");

    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;

    // 同一轮里同一路径只留最早一条:回退取的就是它,后续记录纯属冗余。
    let existing = read_index(dir);
    if existing
        .iter()
        .any(|r| r.turn_seq == turn_seq && r.path == path_str)
    {
        return Ok(());
    }

    let record = match pre_image {
        PreImage::Missing => CheckpointRecord {
            turn_seq,
            path: path_str,
            kind: "file".to_string(),
            existed_before: false,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
        },
        PreImage::Dir => CheckpointRecord {
            turn_seq,
            path: path_str,
            kind: "dir".to_string(),
            existed_before: true,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
        },
        PreImage::File(bytes) => {
            let owned;
            let bytes = match bytes {
                Some(b) => b,
                None => {
                    owned = fs::read(abs_path).map_err(|e| e.to_string())?;
                    &owned
                }
            };
            let (size, mtime_ms) = match fs::symlink_metadata(abs_path) {
                Ok(md) => {
                    let mtime = md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
                        .unwrap_or(0);
                    (md.len(), mtime)
                }
                Err(_) => (bytes.len() as u64, 0),
            };
            let blob = write_blob(dir, &path_str, bytes)?;
            CheckpointRecord {
                turn_seq,
                path: path_str,
                kind: "file".to_string(),
                existed_before: true,
                blob: Some(blob),
                size,
                mtime_ms,
                captured_at: now_ms(),
            }
        }
    };

    append_record(dir, &record)
}

/// fs 变更命令的捕获入口:尽力而为,失败只记日志,绝不阻断文件写入。
pub fn capture_pre_image(ctx: Option<&CheckpointCtx>, abs_path: &Path, pre_image: PreImage) {
    let Some(ctx) = ctx else { return };
    if let Err(error) = capture_inner(ctx, abs_path, pre_image) {
        eprintln!(
            "checkpoint capture failed for {}: {error}",
            abs_path.display()
        );
    }
}

// ---------------------------------------------------------------------------
// 查询与回退命令
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointTurnSummary {
    pub turn_seq: u64,
    pub file_count: usize,
    pub dir_count: usize,
    pub first_captured_at: u64,
}

/// 会话内可回退的轮列表,按 turn_seq 升序。
fn checkpoint_list_sync(conversation_id: String) -> Result<Vec<CheckpointTurnSummary>, String> {
    let dir = conversation_dir(&conversation_id)?;
    let records = read_index(&dir);
    let mut turns: Vec<CheckpointTurnSummary> = Vec::new();
    for record in records {
        match turns.iter_mut().find(|t| t.turn_seq == record.turn_seq) {
            Some(turn) => {
                if record.kind == "dir" {
                    turn.dir_count += 1;
                } else {
                    turn.file_count += 1;
                }
                if record.captured_at < turn.first_captured_at {
                    turn.first_captured_at = record.captured_at;
                }
            }
            None => turns.push(CheckpointTurnSummary {
                turn_seq: record.turn_seq,
                file_count: usize::from(record.kind != "dir"),
                dir_count: usize::from(record.kind == "dir"),
                first_captured_at: record.captured_at,
            }),
        }
    }
    turns.sort_by_key(|t| t.turn_seq);
    Ok(turns)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_list(
    conversation_id: String,
) -> Result<Vec<CheckpointTurnSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoint_list_sync(conversation_id))
        .await
        .map_err(|e| format!("checkpoint_list join failed: {e}"))?
}

/// 回退到某轮开始前的状态时,每个受影响路径的动作与当前脏度。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffEntry {
    pub path: String,
    /// "restore" | "delete" | "clean" | "skip-dir" | "missing-blob"
    pub action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffStats {
    pub turn_seq: u64,
    pub restore_files: usize,
    pub delete_files: usize,
    pub clean_files: usize,
    pub skipped_dirs: usize,
    pub missing_blobs: usize,
    pub entries: Vec<CheckpointDiffEntry>,
}

/// 取 turn_seq >= target 的记录,按文件序(即时间序)每路径保留最早一条。
fn earliest_records_since(dir: &Path, turn_seq: u64) -> Vec<CheckpointRecord> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<CheckpointRecord> = Vec::new();
    for record in read_index(dir) {
        if record.turn_seq < turn_seq {
            continue;
        }
        if seen.iter().any(|p| p == &record.path) {
            continue;
        }
        seen.push(record.path.clone());
        out.push(record);
    }
    out
}

fn classify_entry(dir: &Path, record: &CheckpointRecord) -> CheckpointDiffEntry {
    let action = if record.kind == "dir" {
        "skip-dir"
    } else if !record.existed_before {
        if Path::new(&record.path).exists() {
            "delete"
        } else {
            "clean"
        }
    } else {
        match &record.blob {
            None => "missing-blob",
            Some(blob) => {
                let blob_path = blobs_dir(dir).join(blob);
                match (fs::read(&blob_path), fs::read(&record.path)) {
                    (Ok(expected), Ok(current)) if expected == current => "clean",
                    (Ok(_), _) => "restore",
                    (Err(_), _) => "missing-blob",
                }
            }
        }
    };
    CheckpointDiffEntry {
        path: record.path.clone(),
        action: action.to_string(),
    }
}

fn checkpoint_diff_stats_sync(
    conversation_id: String,
    turn_seq: u64,
) -> Result<CheckpointDiffStats, String> {
    let dir = conversation_dir(&conversation_id)?;
    let mut stats = CheckpointDiffStats {
        turn_seq,
        restore_files: 0,
        delete_files: 0,
        clean_files: 0,
        skipped_dirs: 0,
        missing_blobs: 0,
        entries: Vec::new(),
    };
    for record in earliest_records_since(&dir, turn_seq) {
        let entry = classify_entry(&dir, &record);
        match entry.action.as_str() {
            "restore" => stats.restore_files += 1,
            "delete" => stats.delete_files += 1,
            "clean" => stats.clean_files += 1,
            "skip-dir" => stats.skipped_dirs += 1,
            "missing-blob" => stats.missing_blobs += 1,
            _ => {}
        }
        stats.entries.push(entry);
    }
    Ok(stats)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_diff_stats(
    conversation_id: String,
    turn_seq: u64,
) -> Result<CheckpointDiffStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoint_diff_stats_sync(conversation_id, turn_seq)
    })
    .await
    .map_err(|e| format!("checkpoint_diff_stats join failed: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRewindResult {
    pub turn_seq: u64,
    pub restored_files: usize,
    pub deleted_files: usize,
    pub clean_files: usize,
    pub skipped_dirs: usize,
    pub failed: Vec<String>,
}

/// 把 turn_seq >= target 的所有被改文件恢复到各自最早的前像。
/// 索引保持追加式不截断:回退后继续对话产生的新记录 turn_seq 更大,
/// 再次回退仍按"每路径最早一条"取值,语义自洽。
fn checkpoint_rewind_code_sync(
    conversation_id: String,
    turn_seq: u64,
) -> Result<CheckpointRewindResult, String> {
    let dir = conversation_dir(&conversation_id)?;
    Ok(rewind_at(&dir, turn_seq))
}

/// 目录可注入的回退实现,便于单测绕过 home 解析。
fn rewind_at(dir: &Path, turn_seq: u64) -> CheckpointRewindResult {
    let mut result = CheckpointRewindResult {
        turn_seq,
        restored_files: 0,
        deleted_files: 0,
        clean_files: 0,
        skipped_dirs: 0,
        failed: Vec::new(),
    };
    for record in earliest_records_since(dir, turn_seq) {
        if record.kind == "dir" {
            result.skipped_dirs += 1;
            continue;
        }
        let target = PathBuf::from(&record.path);
        if !record.existed_before {
            match fs::remove_file(&target) {
                Ok(()) => result.deleted_files += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => result.clean_files += 1,
                Err(e) => result.failed.push(format!("{}: {e}", record.path)),
            }
            continue;
        }
        let Some(blob) = &record.blob else {
            result.failed.push(format!("{}: blob missing", record.path));
            continue;
        };
        let blob_path = blobs_dir(dir).join(blob);
        let restore = (|| -> Result<bool, String> {
            let expected = fs::read(&blob_path).map_err(|e| e.to_string())?;
            if let Ok(current) = fs::read(&target) {
                if current == expected {
                    return Ok(false);
                }
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&target, &expected).map_err(|e| e.to_string())?;
            Ok(true)
        })();
        match restore {
            Ok(true) => result.restored_files += 1,
            Ok(false) => result.clean_files += 1,
            Err(e) => result.failed.push(format!("{}: {e}", record.path)),
        }
    }
    result
}

#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_rewind_code(
    conversation_id: String,
    turn_seq: u64,
) -> Result<CheckpointRewindResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoint_rewind_code_sync(conversation_id, turn_seq)
    })
    .await
    .map_err(|e| format!("checkpoint_rewind_code join failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_and_rewind_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let ckpt = tmp.path().join("ckpt");
        let file = tmp.path().join("a.txt");
        fs::write(&file, "v1").unwrap();

        // 第 1 轮改写:先捕获前像再改。
        capture_at(&ckpt, 100, &file, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        // 回退到第 1 轮之前应恢复 v1。
        let result = rewind_at(&ckpt, 100);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[test]
    fn missing_pre_image_rewinds_to_deletion() {
        let tmp = tempfile::tempdir().unwrap();
        let ckpt = tmp.path().join("ckpt");
        let file = tmp.path().join("new.txt");

        capture_at(&ckpt, 100, &file, PreImage::Missing).unwrap();
        fs::write(&file, "created").unwrap();

        let result = rewind_at(&ckpt, 100);
        assert_eq!(result.deleted_files, 1);
        assert!(!file.exists());
    }

    #[test]
    fn earliest_record_wins_across_turns() {
        let tmp = tempfile::tempdir().unwrap();
        let ckpt = tmp.path().join("ckpt");
        let file = tmp.path().join("a.txt");
        fs::write(&file, "v1").unwrap();

        capture_at(&ckpt, 100, &file, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        capture_at(&ckpt, 200, &file, PreImage::File(None)).unwrap();
        fs::write(&file, "v3").unwrap();

        // 回退到 turn 100 之前:取最早前像 v1,而不是 turn 200 的 v2。
        let result = rewind_at(&ckpt, 100);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[test]
    fn rewind_to_later_turn_keeps_earlier_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let ckpt = tmp.path().join("ckpt");
        let file = tmp.path().join("a.txt");
        fs::write(&file, "v1").unwrap();

        capture_at(&ckpt, 100, &file, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        capture_at(&ckpt, 200, &file, PreImage::File(None)).unwrap();
        fs::write(&file, "v3").unwrap();

        // 只回退 turn 200:恢复 v2,保留 turn 100 的改动。
        let result = rewind_at(&ckpt, 200);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
    }

    #[test]
    fn same_turn_same_path_dedupes() {
        let tmp = tempfile::tempdir().unwrap();
        let ckpt = tmp.path().join("ckpt");
        let file = tmp.path().join("a.txt");
        fs::write(&file, "v1").unwrap();

        capture_at(&ckpt, 100, &file, PreImage::File(None)).unwrap();
        fs::write(&file, "v1a").unwrap();
        // 同轮第二次触碰:应跳过,不新增记录/blob。
        capture_at(&ckpt, 100, &file, PreImage::File(None)).unwrap();

        let records = read_index(&ckpt);
        assert_eq!(records.len(), 1);
        let blobs: Vec<_> = fs::read_dir(blobs_dir(&ckpt)).unwrap().collect();
        assert_eq!(blobs.len(), 1);
    }

    #[test]
    fn dir_marker_is_skipped_but_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let ckpt = tmp.path().join("ckpt");
        let dir_path = tmp.path().join("subdir");
        fs::create_dir_all(&dir_path).unwrap();

        capture_at(&ckpt, 100, &dir_path, PreImage::Dir).unwrap();
        fs::remove_dir_all(&dir_path).unwrap();

        let result = rewind_at(&ckpt, 100);
        assert_eq!(result.skipped_dirs, 1);
        assert!(!dir_path.exists());
    }

    #[test]
    fn restore_recreates_missing_parent_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let ckpt = tmp.path().join("ckpt");
        let nested = tmp.path().join("x").join("y").join("a.txt");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, "v1").unwrap();

        capture_at(&ckpt, 100, &nested, PreImage::File(None)).unwrap();
        fs::remove_dir_all(tmp.path().join("x")).unwrap();

        let result = rewind_at(&ckpt, 100);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&nested).unwrap(), "v1");
    }

    #[test]
    fn list_groups_records_by_turn() {
        let tmp = tempfile::tempdir().unwrap();
        let ckpt = tmp.path().join("ckpt");
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();

        capture_at(&ckpt, 200, &a, PreImage::File(None)).unwrap();
        capture_at(&ckpt, 100, &b, PreImage::File(None)).unwrap();
        capture_at(&ckpt, 100, &a, PreImage::Dir).unwrap();

        // checkpoint_list_sync 走 home 目录,这里直接对 read_index 分组逻辑做等价断言。
        let records = read_index(&ckpt);
        assert_eq!(records.len(), 3);
        let turn100: Vec<_> = records.iter().filter(|r| r.turn_seq == 100).collect();
        assert_eq!(turn100.len(), 2);
    }

    #[test]
    fn diff_classification_matches_state() {
        let tmp = tempfile::tempdir().unwrap();
        let ckpt = tmp.path().join("ckpt");
        let dirty = tmp.path().join("dirty.txt");
        let clean = tmp.path().join("clean.txt");
        fs::write(&dirty, "v1").unwrap();
        fs::write(&clean, "same").unwrap();

        capture_at(&ckpt, 100, &dirty, PreImage::File(None)).unwrap();
        capture_at(&ckpt, 100, &clean, PreImage::File(None)).unwrap();
        fs::write(&dirty, "v2").unwrap();

        let records = earliest_records_since(&ckpt, 100);
        let entries: Vec<_> = records.iter().map(|r| classify_entry(&ckpt, r)).collect();
        let dirty_entry = entries
            .iter()
            .find(|e| e.path.ends_with("dirty.txt"))
            .unwrap();
        let clean_entry = entries
            .iter()
            .find(|e| e.path.ends_with("clean.txt"))
            .unwrap();
        assert_eq!(dirty_entry.action, "restore");
        assert_eq!(clean_entry.action, "clean");
    }
}
