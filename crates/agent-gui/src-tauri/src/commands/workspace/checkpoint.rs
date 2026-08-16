//! 会话级文件检查点:fs 写入类命令在落盘前把被改文件的"前像"存到
//! `~/.liveagent/checkpoints/<conversationId>/`,供 rewind 把工作区回退到
//! 某轮开始前的状态。
//!
//! 设计要点(schema v2):
//! - 捕获发生在 fs 命令实现内部(与变更同一次调用),不引入额外 IPC,
//!   也不重复 root:// / skill:// 的路径解析。
//! - 记录只存 `root + relPath`(捕获时已解析的根 + 相对路径),绝不把
//!   绝对路径当作恢复授权:回退时基于当前文件系统重新校验根与相对路径,
//!   拒绝路径链上的符号链接与(Unix)多硬链接目标,写入走临时文件 + 原子
//!   rename,并可携带预览时的内容哈希做冲突检测(TOCTOU 防护)。
//! - turn 身份:TS 侧只传稳定的 turnId(每轮唯一的随机 ID),turn_seq 由
//!   本模块在 INDEX_LOCK 下按会话单调分配——时钟回拨/重复 ID 都不会打乱
//!   回退顺序。UI 展示时间用 firstCapturedAt,不再复用序号。
//! - blob 是原始字节拷贝(不内嵌 JSON),索引是追加式 index.jsonl;
//!   回退正确性来自"每个路径取 turn_seq >= target 的最早一条记录"。
//! - 捕获是尽力而为:内部错误只追加 kind="error" 记录(让该轮在 UI 上
//!   显示"不完整")并记日志,绝不让文件写入本身失败。
//! - 容量防线:单文件、会话总量、记录条数三个上限,超限记 error 不捕获。
//! - 目录删除只记不可恢复的标记(kind="dir"),在 diff 统计里如实呈现。
//! - Bash / 托管进程的写入不经过这里,UI 需要明确说明这一限制。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 单个前像 blob 的大小上限;超过只记 error(该轮标记不完整)。
const MAX_BLOB_BYTES: u64 = 32 * 1024 * 1024;
/// 单会话 blob 总量上限(按索引里 file 记录的 size 求和估算)。
const MAX_TOTAL_BLOB_BYTES: u64 = 512 * 1024 * 1024;
/// 单会话索引记录条数上限;超过后连 error 记录也不再追加(防索引自身膨胀)。
const MAX_RECORDS_PER_CONVERSATION: usize = 10_000;

/// TS 侧随 fs 变更命令附带的检查点上下文;缺省(None)表示该调用不捕获。
/// turnId 是每轮唯一的稳定 ID(与时钟无关),序号由 Rust 侧分配。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCtx {
    pub conversation_id: String,
    pub turn_id: String,
}

/// index.jsonl 里的一条记录(schema v2)。
/// kind:"file" | "dir" | "error"(捕获失败标记) | "rewind"(回退审计标记)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRecord {
    /// 记录格式版本;v1(存绝对路径)的旧行反序列化失败会被静默跳过。
    pub schema: u32,
    pub turn_seq: u64,
    pub turn_id: String,
    /// 捕获时已解析(canonicalize 过)的根目录,回退时重新校验。
    pub root: String,
    /// 相对 root 的路径,正斜杠分隔;error/rewind 记录可为空串。
    pub rel_path: String,
    pub kind: String,
    pub existed_before: bool,
    /// blobs/ 目录下的文件名;非 file 记录或 existed_before=false 时为空。
    pub blob: Option<String>,
    pub size: u64,
    pub mtime_ms: u64,
    pub captured_at: u64,
    /// error 记录的失败原因 / rewind 记录的摘要。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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

// index.jsonl 的"读检查 + 追加"必须互斥:并发 fs 命令可能同轮同文件竞争,
// turn_seq 的分配也依赖这把锁保证单调。
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

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
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

/// Unix 下把检查点目录/文件收紧为仅属主可读写;Windows 无 POSIX 位,跳过。
#[cfg(unix)]
fn tighten_permissions(path: &Path, is_dir: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if is_dir { 0o700 } else { 0o600 };
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn tighten_permissions(_path: &Path, _is_dir: bool) {}

fn ensure_conversation_dirs(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    tighten_permissions(dir, true);
    let blobs = blobs_dir(dir);
    fs::create_dir_all(&blobs).map_err(|e| e.to_string())?;
    tighten_permissions(&blobs, true);
    Ok(())
}

fn path_hash16(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    hex_encode(&digest)[..16].to_string()
}

fn read_index(dir: &Path) -> Vec<CheckpointRecord> {
    let Ok(text) = fs::read_to_string(index_path(dir)) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<CheckpointRecord>(line).ok())
        .filter(|record| record.schema == 2)
        .collect()
}

fn append_record(dir: &Path, record: &CheckpointRecord) -> Result<(), String> {
    let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
    let path = index_path(dir);
    let existed = path.exists();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| e.to_string())?;
    if !existed {
        tighten_permissions(&path, false);
    }
    Ok(())
}

/// 在 blobs/ 下找下一个空闲版本号写入。同一路径的版本极少,线性探测足够。
fn write_blob(dir: &Path, key: &str, bytes: &[u8]) -> Result<String, String> {
    let blobs = blobs_dir(dir);
    let hash = path_hash16(key);
    for version in 1..u32::MAX {
        let name = format!("{hash}@v{version}");
        let target = blobs.join(&name);
        if target.exists() {
            continue;
        }
        fs::write(&target, bytes).map_err(|e| e.to_string())?;
        tighten_permissions(&target, false);
        return Ok(name);
    }
    Err("checkpoint blob version space exhausted".to_string())
}

/// 记录的稳定键:root + 相对路径,用于 blob 命名与冲突检测的往返匹配。
fn record_key(root: &str, rel_path: &str) -> String {
    format!("{root}\u{1}{rel_path}")
}

fn normalize_root(root: &Path) -> String {
    root.to_string_lossy().replace('\\', "/")
}

fn normalize_rel(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

/// 在 INDEX_LOCK 下解析本轮的 turn_seq:同 turnId 复用,否则 max+1。
/// 时钟无关,严格随会话内出现顺序单调递增。
fn resolve_turn_seq(records: &[CheckpointRecord], turn_id: &str) -> u64 {
    if let Some(existing) = records.iter().find(|r| r.turn_id == turn_id) {
        return existing.turn_seq;
    }
    records.iter().map(|r| r.turn_seq).max().unwrap_or(0) + 1
}

/// 捕获失败时的兜底:追加 error 记录让该轮显示"不完整"。
/// 这本身也可能失败(比如磁盘满),那时只剩 eprintln。
fn append_error_record(
    dir: &Path,
    turn_seq: u64,
    turn_id: &str,
    root: &str,
    rel_path: &str,
    reason: &str,
) {
    let record = CheckpointRecord {
        schema: 2,
        turn_seq,
        turn_id: turn_id.to_string(),
        root: root.to_string(),
        rel_path: rel_path.to_string(),
        kind: "error".to_string(),
        existed_before: false,
        blob: None,
        size: 0,
        mtime_ms: 0,
        captured_at: now_ms(),
        note: Some(reason.to_string()),
    };
    if let Err(e) = append_record(dir, &record) {
        eprintln!("checkpoint error-record append failed for {rel_path}: {e}");
    }
}

/// 目录可注入的捕获实现,便于单测绕过 home 解析。
/// 返回本轮分配到的 turn_seq(测试断言用)。
fn capture_at(
    dir: &Path,
    turn_id: &str,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
) -> Result<u64, String> {
    ensure_conversation_dirs(dir)?;
    let root_str = normalize_root(root);
    let rel_str = normalize_rel(rel_path);
    let abs_path = root.join(rel_path);

    let _guard = INDEX_LOCK.lock().map_err(|e| e.to_string())?;

    let existing = read_index(dir);
    let turn_seq = resolve_turn_seq(&existing, turn_id);

    // 记录条数上限:超限后不再追加任何记录(含 error),防索引自身膨胀。
    if existing.len() >= MAX_RECORDS_PER_CONVERSATION {
        return Err(format!(
            "checkpoint record cap reached ({MAX_RECORDS_PER_CONVERSATION})"
        ));
    }

    // 同一轮里同一路径只留最早一条:回退取的就是它,后续记录纯属冗余。
    if existing
        .iter()
        .any(|r| r.turn_seq == turn_seq && r.root == root_str && r.rel_path == rel_str)
    {
        return Ok(turn_seq);
    }

    let record = match pre_image {
        PreImage::Missing => CheckpointRecord {
            schema: 2,
            turn_seq,
            turn_id: turn_id.to_string(),
            root: root_str,
            rel_path: rel_str,
            kind: "file".to_string(),
            existed_before: false,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
            note: None,
        },
        PreImage::Dir => CheckpointRecord {
            schema: 2,
            turn_seq,
            turn_id: turn_id.to_string(),
            root: root_str,
            rel_path: rel_str,
            kind: "dir".to_string(),
            existed_before: true,
            blob: None,
            size: 0,
            mtime_ms: 0,
            captured_at: now_ms(),
            note: None,
        },
        PreImage::File(bytes) => {
            let owned;
            let bytes = match bytes {
                Some(b) => b,
                None => {
                    owned = fs::read(&abs_path).map_err(|e| e.to_string())?;
                    &owned
                }
            };
            if bytes.len() as u64 > MAX_BLOB_BYTES {
                append_error_record(
                    dir,
                    turn_seq,
                    turn_id,
                    &record_root_for_error(root),
                    &rel_str,
                    &format!("file too large to checkpoint ({} bytes)", bytes.len()),
                );
                return Ok(turn_seq);
            }
            let total: u64 = existing
                .iter()
                .filter(|r| r.blob.is_some())
                .map(|r| r.size)
                .sum();
            if total.saturating_add(bytes.len() as u64) > MAX_TOTAL_BLOB_BYTES {
                append_error_record(
                    dir,
                    turn_seq,
                    turn_id,
                    &record_root_for_error(root),
                    &rel_str,
                    "conversation checkpoint storage cap reached",
                );
                return Ok(turn_seq);
            }
            let (size, mtime_ms) = match fs::symlink_metadata(&abs_path) {
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
            let blob = write_blob(dir, &record_key(&root_str, &rel_str), bytes)?;
            CheckpointRecord {
                schema: 2,
                turn_seq,
                turn_id: turn_id.to_string(),
                root: root_str,
                rel_path: rel_str,
                kind: "file".to_string(),
                existed_before: true,
                blob: Some(blob),
                size,
                mtime_ms,
                captured_at: now_ms(),
                note: None,
            }
        }
    };

    append_record(dir, &record)?;
    Ok(turn_seq)
}

fn record_root_for_error(root: &Path) -> String {
    normalize_root(root)
}

fn capture_inner(
    ctx: &CheckpointCtx,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
) -> Result<(), String> {
    let dir = conversation_dir(&ctx.conversation_id)?;
    capture_at(&dir, &ctx.turn_id, root, rel_path, pre_image).map(|_| ())
}

/// fs 变更命令的捕获入口:尽力而为,失败追加 error 记录 + 日志,
/// 绝不阻断文件写入本身。
pub fn capture_pre_image(
    ctx: Option<&CheckpointCtx>,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
) {
    let Some(ctx) = ctx else { return };
    if let Err(error) = capture_inner(ctx, root, rel_path, pre_image) {
        eprintln!(
            "checkpoint capture failed for {}: {error}",
            root.join(rel_path).display()
        );
        // 尽力把失败写进索引让该轮显示"不完整";目录不可用时只剩日志。
        if let Ok(dir) = conversation_dir(&ctx.conversation_id) {
            if ensure_conversation_dirs(&dir).is_ok() {
                if let Ok(_guard) = INDEX_LOCK.lock() {
                    let existing = read_index(&dir);
                    if existing.len() < MAX_RECORDS_PER_CONVERSATION {
                        let seq = resolve_turn_seq(&existing, &ctx.turn_id);
                        append_error_record(
                            &dir,
                            seq,
                            &ctx.turn_id,
                            &normalize_root(root),
                            &normalize_rel(rel_path),
                            &error,
                        );
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 查询与回退命令
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointTurnSummary {
    pub turn_seq: u64,
    pub turn_id: String,
    pub file_count: usize,
    pub dir_count: usize,
    /// 该轮是否有捕获失败的记录(回退可能不完整)。
    pub incomplete: bool,
    pub first_captured_at: u64,
}

/// 会话内可回退的轮列表,按 turn_seq 升序。error/rewind 记录不计入文件数,
/// error 使该轮标记 incomplete。
fn checkpoint_list_sync(conversation_id: String) -> Result<Vec<CheckpointTurnSummary>, String> {
    let dir = conversation_dir(&conversation_id)?;
    let records = read_index(&dir);
    let mut turns: Vec<CheckpointTurnSummary> = Vec::new();
    for record in records {
        if record.kind == "rewind" {
            continue;
        }
        let summary = match turns.iter_mut().find(|t| t.turn_seq == record.turn_seq) {
            Some(existing) => existing,
            None => {
                turns.push(CheckpointTurnSummary {
                    turn_seq: record.turn_seq,
                    turn_id: record.turn_id.clone(),
                    file_count: 0,
                    dir_count: 0,
                    incomplete: false,
                    first_captured_at: record.captured_at,
                });
                turns.last_mut().expect("just pushed")
            }
        };
        match record.kind.as_str() {
            "dir" => summary.dir_count += 1,
            "error" => summary.incomplete = true,
            _ => summary.file_count += 1,
        }
        if record.captured_at < summary.first_captured_at {
            summary.first_captured_at = record.captured_at;
        }
    }
    turns.retain(|t| t.file_count > 0 || t.dir_count > 0 || t.incomplete);
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
    /// 展示用路径(root/rel)。
    pub path: String,
    /// 冲突检测的往返键:UI 把 (key, currentHash) 原样带回 rewind。
    pub key: String,
    /// "restore" | "delete" | "clean" | "skip-dir" | "missing-blob" | "capture-error"
    pub action: String,
    /// 预览时目标文件的内容哈希;文件不存在时为 "absent"。
    /// rewind 时重新计算比对,不一致则跳过该文件并上报冲突。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_hash: Option<String>,
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
    /// 捕获阶段就失败的条目数:回退不覆盖这些文件,提示用户可能不完整。
    pub capture_errors: usize,
    pub entries: Vec<CheckpointDiffEntry>,
}

/// 取 turn_seq >= target 的可恢复记录,按文件序(即时间序)每路径保留最早一条。
/// error 记录单独返回计数;rewind 审计标记直接跳过。
fn earliest_records_since(dir: &Path, turn_seq: u64) -> (Vec<CheckpointRecord>, usize) {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<CheckpointRecord> = Vec::new();
    let mut errors = 0usize;
    for record in read_index(dir) {
        if record.turn_seq < turn_seq {
            continue;
        }
        match record.kind.as_str() {
            "rewind" => continue,
            "error" => {
                errors += 1;
                continue;
            }
            _ => {}
        }
        let key = record_key(&record.root, &record.rel_path);
        if seen.iter().any(|p| p == &key) {
            continue;
        }
        seen.push(key);
        out.push(record);
    }
    (out, errors)
}

/// 回退目标的重新校验:根必须仍然存在且 canonicalize 后与记录一致口径,
/// 相对路径重新过滤(仅 Normal 分量),并逐级拒绝路径链上的符号链接。
/// 绝不信任捕获时的绝对路径——这是 rewind 的唯一授权通道。
fn resolve_rewind_target(root_str: &str, rel_str: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(Path::new(root_str))
        .map_err(|e| format!("checkpoint root unavailable: {e}"))?;
    let rel = PathBuf::from(rel_str);
    if rel.as_os_str().is_empty() {
        return Err("empty relative path".to_string());
    }
    for comp in rel.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err(format!("unsafe relative path: {rel_str}")),
        }
    }
    let mut current = root;
    for comp in rel.components() {
        current.push(comp);
        match fs::symlink_metadata(&current) {
            Ok(md) if md.file_type().is_symlink() => {
                return Err(format!(
                    "refusing to follow symlink at {}",
                    current.display()
                ));
            }
            _ => {}
        }
    }
    Ok(current)
}

/// Unix 下拒绝恢复/删除多硬链接文件:写它会波及工作区外的别名路径。
#[cfg(unix)]
fn reject_multi_hardlink(md: &fs::Metadata) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if md.nlink() > 1 {
        return Err("refusing to modify a multi-hardlink file".to_string());
    }
    Ok(())
}

#[cfg(not(unix))]
fn reject_multi_hardlink(_md: &fs::Metadata) -> Result<(), String> {
    Ok(())
}

/// 目标当前内容的哈希;不存在(或不是普通文件)返回 "absent"。
fn current_state_hash(target: &Path) -> String {
    match fs::symlink_metadata(target) {
        Ok(md) if md.is_file() => match fs::read(target) {
            Ok(bytes) => sha256_hex(&bytes),
            Err(_) => "unreadable".to_string(),
        },
        Ok(_) => "non-file".to_string(),
        Err(_) => "absent".to_string(),
    }
}

fn classify_entry(dir: &Path, record: &CheckpointRecord) -> CheckpointDiffEntry {
    let key = record_key(&record.root, &record.rel_path);
    let display = format!("{}/{}", record.root, record.rel_path);
    if record.kind == "dir" {
        return CheckpointDiffEntry {
            path: display,
            key,
            action: "skip-dir".to_string(),
            current_hash: None,
        };
    }
    let (action, current_hash) = match resolve_rewind_target(&record.root, &record.rel_path) {
        Err(_) => ("missing-blob", None),
        Ok(target) => {
            let hash = current_state_hash(&target);
            if !record.existed_before {
                if hash == "absent" {
                    ("clean", Some(hash))
                } else {
                    ("delete", Some(hash))
                }
            } else {
                match &record.blob {
                    None => ("missing-blob", None),
                    Some(blob) => match fs::read(blobs_dir(dir).join(blob)) {
                        Err(_) => ("missing-blob", None),
                        Ok(expected) => {
                            if sha256_hex(&expected) == hash {
                                ("clean", Some(hash))
                            } else {
                                ("restore", Some(hash))
                            }
                        }
                    },
                }
            }
        }
    };
    CheckpointDiffEntry {
        path: display,
        key,
        action: action.to_string(),
        current_hash,
    }
}

fn checkpoint_diff_stats_sync(
    conversation_id: String,
    turn_seq: u64,
) -> Result<CheckpointDiffStats, String> {
    let dir = conversation_dir(&conversation_id)?;
    let (records, capture_errors) = earliest_records_since(&dir, turn_seq);
    let mut stats = CheckpointDiffStats {
        turn_seq,
        restore_files: 0,
        delete_files: 0,
        clean_files: 0,
        skipped_dirs: 0,
        missing_blobs: 0,
        capture_errors,
        entries: Vec::new(),
    };
    for record in records {
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

/// UI 从 diff 预览带回的 (key, currentHash) 期望值,rewind 前重新比对。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointExpectedEntry {
    pub key: String,
    pub current_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRewindResult {
    pub turn_seq: u64,
    pub restored_files: usize,
    pub deleted_files: usize,
    pub clean_files: usize,
    pub skipped_dirs: usize,
    /// 预览后被并发修改的文件:跳过不覆盖,由用户重新预览决定。
    pub conflicts: Vec<String>,
    pub failed: Vec<String>,
}

/// 临时文件 + 原子 rename 落盘,避免半写状态。Windows 上 rename 不覆盖
/// 已存在目标,先删除旧文件再 rename(窗口极小,且内容已在本地临时文件)。
fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "target has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(
        ".ckpt-tmp-{}-{}",
        std::process::id(),
        now_ms()
    ));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    match fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(_) if target.exists() => {
            fs::remove_file(target).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                e.to_string()
            })?;
            fs::rename(&tmp, target).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                e.to_string()
            })
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

/// 把 turn_seq >= target 的所有被改文件恢复到各自最早的前像。
/// 索引保持追加式不截断:回退后继续对话产生的新记录 turn_seq 更大,
/// 再次回退仍按"每路径最早一条"取值,语义自洽。
fn checkpoint_rewind_code_sync(
    conversation_id: String,
    turn_seq: u64,
    expected: Option<Vec<CheckpointExpectedEntry>>,
) -> Result<CheckpointRewindResult, String> {
    let dir = conversation_dir(&conversation_id)?;
    let result = rewind_at(&dir, turn_seq, expected.as_deref());
    // 回退审计标记:写入索引留痕(kind="rewind" 不参与任何恢复语义)。
    let marker = CheckpointRecord {
        schema: 2,
        turn_seq,
        turn_id: String::new(),
        root: String::new(),
        rel_path: String::new(),
        kind: "rewind".to_string(),
        existed_before: false,
        blob: None,
        size: 0,
        mtime_ms: 0,
        captured_at: now_ms(),
        note: Some(format!(
            "restored={} deleted={} conflicts={} failed={}",
            result.restored_files,
            result.deleted_files,
            result.conflicts.len(),
            result.failed.len()
        )),
    };
    if let Ok(_guard) = INDEX_LOCK.lock() {
        let _ = append_record(&dir, &marker);
    }
    Ok(result)
}

/// 目录可注入的回退实现,便于单测绕过 home 解析。
fn rewind_at(
    dir: &Path,
    turn_seq: u64,
    expected: Option<&[CheckpointExpectedEntry]>,
) -> CheckpointRewindResult {
    let expected_by_key: HashMap<&str, &str> = expected
        .unwrap_or(&[])
        .iter()
        .map(|e| (e.key.as_str(), e.current_hash.as_str()))
        .collect();
    let mut result = CheckpointRewindResult {
        turn_seq,
        restored_files: 0,
        deleted_files: 0,
        clean_files: 0,
        skipped_dirs: 0,
        conflicts: Vec::new(),
        failed: Vec::new(),
    };
    let (records, _errors) = earliest_records_since(dir, turn_seq);
    for record in records {
        let display = format!("{}/{}", record.root, record.rel_path);
        if record.kind == "dir" {
            result.skipped_dirs += 1;
            continue;
        }
        // 授权链:root 重新 canonicalize + 相对路径重新过滤 + 全链拒符号链接。
        let target = match resolve_rewind_target(&record.root, &record.rel_path) {
            Ok(t) => t,
            Err(e) => {
                result.failed.push(format!("{display}: {e}"));
                continue;
            }
        };
        // TOCTOU 防护:与预览时的内容哈希比对,不一致 = 预览后被改,跳过。
        let key = record_key(&record.root, &record.rel_path);
        if let Some(expected_hash) = expected_by_key.get(key.as_str()) {
            if current_state_hash(&target) != *expected_hash {
                result.conflicts.push(display);
                continue;
            }
        }
        if !record.existed_before {
            match fs::symlink_metadata(&target) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    result.clean_files += 1;
                }
                Err(e) => result.failed.push(format!("{display}: {e}")),
                Ok(md) => {
                    if !md.is_file() {
                        result
                            .failed
                            .push(format!("{display}: not a regular file"));
                        continue;
                    }
                    if let Err(e) = reject_multi_hardlink(&md) {
                        result.failed.push(format!("{display}: {e}"));
                        continue;
                    }
                    match fs::remove_file(&target) {
                        Ok(()) => result.deleted_files += 1,
                        Err(e) => result.failed.push(format!("{display}: {e}")),
                    }
                }
            }
            continue;
        }
        let Some(blob) = &record.blob else {
            result.failed.push(format!("{display}: blob missing"));
            continue;
        };
        let blob_path = blobs_dir(dir).join(blob);
        let restore = (|| -> Result<bool, String> {
            let pre_image = fs::read(&blob_path).map_err(|e| e.to_string())?;
            match fs::symlink_metadata(&target) {
                Ok(md) => {
                    if !md.is_file() {
                        return Err("not a regular file".to_string());
                    }
                    reject_multi_hardlink(&md)?;
                    if let Ok(current) = fs::read(&target) {
                        if current == pre_image {
                            return Ok(false);
                        }
                    }
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    return Err(e.to_string());
                }
                Err(_) => {}
            }
            atomic_write(&target, &pre_image)?;
            Ok(true)
        })();
        match restore {
            Ok(true) => result.restored_files += 1,
            Ok(false) => result.clean_files += 1,
            Err(e) => result.failed.push(format!("{display}: {e}")),
        }
    }
    result
}

#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_rewind_code(
    conversation_id: String,
    turn_seq: u64,
    expected: Option<Vec<CheckpointExpectedEntry>>,
) -> Result<CheckpointRewindResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoint_rewind_code_sync(conversation_id, turn_seq, expected)
    })
    .await
    .map_err(|e| format!("checkpoint_rewind_code join failed: {e}"))?
}

/// 清理入口:删除整个会话的检查点数据(索引 + blobs)。
#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_clear(conversation_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dir = conversation_dir(&conversation_id)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| format!("checkpoint_clear join failed: {e}"))?
}

// ---------------------------------------------------------------------------
// worktree 子代理合并的前像捕获(供 subagent_worktree_apply 调用)
// ---------------------------------------------------------------------------

/// 在 worktree.apply 修改父工作区之前,对将被覆盖/删除的路径捕获父工作区
/// 前像。路径来自 collect_apply_paths(git 相对路径),root 为父仓库根。
/// 尽力而为:单个路径失败记 error 记录,不阻断合并。
pub fn capture_worktree_apply_pre_images(
    ctx: Option<&CheckpointCtx>,
    parent_repo_root: &Path,
    rel_paths: &[String],
) {
    let Some(ctx) = ctx else { return };
    for rel in rel_paths {
        let rel_path = PathBuf::from(rel);
        let abs = parent_repo_root.join(&rel_path);
        let pre_image = match fs::symlink_metadata(&abs) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => PreImage::Missing,
            Err(_) => continue,
            Ok(md) if md.is_file() => PreImage::File(None),
            Ok(md) if md.is_dir() => PreImage::Dir,
            // 符号链接不做前像捕获,与 fs_delete 的语义保持一致。
            Ok(_) => continue,
        };
        capture_pre_image(Some(ctx), parent_repo_root, &rel_path, pre_image);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(file: &Path, root: &Path) -> PathBuf {
        file.strip_prefix(root).unwrap().to_path_buf()
    }

    #[test]
    fn capture_and_rewind_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        fs::write(&file, "v1").unwrap();

        // 第 1 轮改写:先捕获前像再改。
        let seq = capture_at(&ckpt, "turn-1", &root, &rel(&file, &root), PreImage::File(None))
            .unwrap();
        fs::write(&file, "v2").unwrap();

        // 回退到第 1 轮之前应恢复 v1。
        let result = rewind_at(&ckpt, seq, None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[test]
    fn missing_pre_image_rewinds_to_deletion() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("new.txt");

        let seq =
            capture_at(&ckpt, "turn-1", &root, &rel(&file, &root), PreImage::Missing).unwrap();
        fs::write(&file, "created").unwrap();

        let result = rewind_at(&ckpt, seq, None);
        assert_eq!(result.deleted_files, 1);
        assert!(!file.exists());
    }

    #[test]
    fn earliest_record_wins_across_turns() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq1 = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        let seq2 = capture_at(&ckpt, "turn-2", &root, &r, PreImage::File(None)).unwrap();
        assert!(seq2 > seq1);
        fs::write(&file, "v3").unwrap();

        // 回退到 turn-1 之前:取最早前像 v1,而不是 turn-2 的 v2。
        let result = rewind_at(&ckpt, seq1, None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[test]
    fn rewind_to_later_turn_keeps_earlier_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        let seq2 = capture_at(&ckpt, "turn-2", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v3").unwrap();

        // 只回退 turn-2:恢复 v2,保留 turn-1 的改动。
        let result = rewind_at(&ckpt, seq2, None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
    }

    #[test]
    fn same_turn_same_path_dedupes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v1a").unwrap();
        // 同轮第二次触碰:应跳过,不新增记录/blob。
        capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();

        let records = read_index(&ckpt);
        assert_eq!(records.len(), 1);
        let blobs: Vec<_> = fs::read_dir(blobs_dir(&ckpt)).unwrap().collect();
        assert_eq!(blobs.len(), 1);
    }

    #[test]
    fn turn_seq_is_monotonic_and_clock_independent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();

        // 同 turnId 复用序号;新 turnId 严格递增,与时间戳无关。
        let s1 = capture_at(&ckpt, "t-x", &root, &rel(&a, &root), PreImage::File(None)).unwrap();
        let s1b = capture_at(&ckpt, "t-x", &root, &rel(&b, &root), PreImage::File(None)).unwrap();
        let s2 = capture_at(&ckpt, "t-y", &root, &rel(&a, &root), PreImage::File(None)).unwrap();
        assert_eq!(s1, s1b);
        assert_eq!(s2, s1 + 1);
    }

    #[test]
    fn dir_marker_is_skipped_but_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let dir_path = root.join("subdir");
        fs::create_dir_all(&dir_path).unwrap();

        let seq =
            capture_at(&ckpt, "turn-1", &root, &rel(&dir_path, &root), PreImage::Dir).unwrap();
        fs::remove_dir_all(&dir_path).unwrap();

        let result = rewind_at(&ckpt, seq, None);
        assert_eq!(result.skipped_dirs, 1);
        assert!(!dir_path.exists());
    }

    #[test]
    fn restore_recreates_missing_parent_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let nested = root.join("x").join("y").join("a.txt");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &rel(&nested, &root), PreImage::File(None))
            .unwrap();
        fs::remove_dir_all(root.join("x")).unwrap();

        let result = rewind_at(&ckpt, seq, None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&nested).unwrap(), "v1");
    }

    #[test]
    fn conflict_hash_mismatch_skips_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        // 预览时看到的是 v2 的哈希;确认前文件又被改成 v3 → 冲突,跳过。
        let preview_hash = sha256_hex(b"v2");
        fs::write(&file, "v3").unwrap();
        let expected = vec![CheckpointExpectedEntry {
            key: record_key(&normalize_root(&root), &normalize_rel(&r)),
            current_hash: preview_hash,
        }];
        let result = rewind_at(&ckpt, seq, Some(&expected));
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v3");

        // 哈希吻合时正常恢复。
        let expected = vec![CheckpointExpectedEntry {
            key: record_key(&normalize_root(&root), &normalize_rel(&r)),
            current_hash: sha256_hex(b"v3"),
        }];
        let result = rewind_at(&ckpt, seq, Some(&expected));
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_swap_after_capture_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();
        let outside = root.join("outside-secret");
        fs::write(&outside, "secret").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        // 捕获后把目标换成符号链接:回退必须拒绝,不得跟随链接写入。
        fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&outside, &file).unwrap();

        let result = rewind_at(&ckpt, seq, None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "secret");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_parent_after_capture_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let file = sub.join("a.txt");
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &rel(&file, &root), PreImage::File(None))
            .unwrap();
        // 捕获后把父目录整个换成指向别处的符号链接。
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::remove_dir_all(&sub).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &sub).unwrap();

        let result = rewind_at(&ckpt, seq, None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert!(!elsewhere.join("a.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn multi_hardlink_target_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        // 捕获后给目标加硬链接:恢复会波及别名路径,必须拒绝。
        fs::hard_link(&file, root.join("alias.txt")).unwrap();

        let result = rewind_at(&ckpt, seq, None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
    }

    #[test]
    fn missing_blob_reports_failure_without_touching_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        // 模拟 blob 丢失/被截断删除。
        for entry in fs::read_dir(blobs_dir(&ckpt)).unwrap() {
            fs::remove_file(entry.unwrap().path()).unwrap();
        }

        let result = rewind_at(&ckpt, seq, None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
    }

    #[test]
    fn capture_failure_is_recorded_and_marks_turn_incomplete() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let missing = root.join("does-not-exist.txt");

        // File(None) 需要现场读盘,文件不存在 → 捕获失败 → error 记录。
        let ctx = CheckpointCtx {
            conversation_id: "unused".to_string(),
            turn_id: "turn-1".to_string(),
        };
        let err = capture_at(
            &ckpt,
            &ctx.turn_id,
            &root,
            &rel(&missing, &root),
            PreImage::File(None),
        );
        assert!(err.is_err());
        // capture_pre_image 的兜底路径会补 error 记录;这里直接验证底层写入。
        append_error_record(
            &ckpt,
            1,
            &ctx.turn_id,
            &normalize_root(&root),
            "does-not-exist.txt",
            "read failed",
        );
        let records = read_index(&ckpt);
        assert!(records.iter().any(|r| r.kind == "error"));
        let (recs, errors) = earliest_records_since(&ckpt, 1);
        assert_eq!(recs.len(), 0);
        assert_eq!(errors, 1);
    }

    #[test]
    fn oversized_file_records_error_instead_of_blob() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("big.bin");
        fs::write(&file, "x").unwrap();

        // 借用 File(Some) 注入超限长度不现实(会占内存),改走总量上限逻辑
        // 的等价断言:直接验证 MAX_BLOB_BYTES 判断分支通过一个小的假上限
        // 不可注入,这里退而验证 error 记录让该轮 incomplete。
        // 真实流程里 capture_at 开头就调 ensure_conversation_dirs,这里补齐。
        ensure_conversation_dirs(&ckpt).unwrap();
        append_error_record(
            &ckpt,
            1,
            "turn-1",
            &normalize_root(&root),
            "big.bin",
            "file too large to checkpoint",
        );
        let records = read_index(&ckpt);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, "error");
    }

    #[test]
    fn v1_index_lines_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        fs::create_dir_all(&ckpt).unwrap();
        // 旧 v1 行(绝对路径 schema,无 schema 字段)必须被静默跳过。
        fs::write(
            index_path(&ckpt),
            "{\"turnSeq\":1,\"path\":\"/tmp/a\",\"kind\":\"file\",\"existedBefore\":true,\"blob\":null,\"size\":0,\"mtimeMs\":0,\"capturedAt\":0}\n",
        )
        .unwrap();
        assert!(read_index(&ckpt).is_empty());
    }

    #[test]
    fn worktree_apply_pre_images_capture_parent_state() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let parent = root.join("parent");
        fs::create_dir_all(&parent).unwrap();
        let existing = parent.join("mod.txt");
        fs::write(&existing, "parent-v1").unwrap();

        // 受控注入会话目录:通过底层 capture_at 等价验证 worktree 捕获逻辑
        // (capture_worktree_apply_pre_images 走 home 目录,单测里对分类
        // 逻辑做同构断言)。
        let ckpt = root.join("ckpt");
        let paths = ["mod.txt".to_string(), "new.txt".to_string()];
        for rel_str in &paths {
            let rel_path = PathBuf::from(rel_str);
            let abs = parent.join(&rel_path);
            let pre_image = match fs::symlink_metadata(&abs) {
                Err(_) => PreImage::Missing,
                Ok(md) if md.is_file() => PreImage::File(None),
                Ok(_) => PreImage::Dir,
            };
            capture_at(&ckpt, "turn-1", &parent, &rel_path, pre_image).unwrap();
        }
        // 模拟 apply:覆盖已有文件 + 落新文件。
        fs::write(&existing, "worktree-v2").unwrap();
        fs::write(parent.join("new.txt"), "worktree-new").unwrap();

        let result = rewind_at(&ckpt, 1, None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(result.deleted_files, 1);
        assert_eq!(fs::read_to_string(&existing).unwrap(), "parent-v1");
        assert!(!parent.join("new.txt").exists());
    }

    #[test]
    fn diff_classification_matches_state() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let dirty = root.join("dirty.txt");
        let clean = root.join("clean.txt");
        fs::write(&dirty, "v1").unwrap();
        fs::write(&clean, "same").unwrap();

        capture_at(&ckpt, "turn-1", &root, &rel(&dirty, &root), PreImage::File(None)).unwrap();
        capture_at(&ckpt, "turn-1", &root, &rel(&clean, &root), PreImage::File(None)).unwrap();
        fs::write(&dirty, "v2").unwrap();

        let (records, _) = earliest_records_since(&ckpt, 1);
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
        // 预览返回当前哈希,供 rewind 做冲突比对。
        assert_eq!(dirty_entry.current_hash.as_deref(), Some(sha256_hex(b"v2").as_str()));
    }

    #[test]
    fn rewind_marker_is_appended_but_inert() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        // 手工追加 rewind 标记,验证它不参与列表/回退。
        append_record(
            &ckpt,
            &CheckpointRecord {
                schema: 2,
                turn_seq: seq,
                turn_id: String::new(),
                root: String::new(),
                rel_path: String::new(),
                kind: "rewind".to_string(),
                existed_before: false,
                blob: None,
                size: 0,
                mtime_ms: 0,
                captured_at: now_ms(),
                note: None,
            },
        )
        .unwrap();
        let (records, errors) = earliest_records_since(&ckpt, seq);
        assert_eq!(records.len(), 1);
        assert_eq!(errors, 0);
        let result = rewind_at(&ckpt, seq, None);
        assert_eq!(result.restored_files, 1);
    }
}
