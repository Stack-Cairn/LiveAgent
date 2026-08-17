//! 会话级文件检查点:fs 写入类命令在落盘前把被改文件的"前像"存到
//! `~/.liveagent/checkpoints/<conversationId>/`,供 rewind 把工作区回退到
//! 某轮开始前的状态。
//!
//! 设计要点(schema v2):
//! - 捕获发生在 fs 命令实现内部(与变更同一次调用),不引入额外 IPC,
//!   也不重复 root:// / skill:// 的路径解析。
//! - 记录只存 `root + relPath`(捕获时已解析的根 + 相对路径),绝不把
//!   绝对路径当作恢复授权:回退时要求 root 仍属于当前授权根集合、root 自身
//!   不是符号链接,再重新过滤相对路径并逐级拒绝链上的符号链接与(Unix)多
//!   硬链接目标;写入前紧邻再校验一次整条链(窗口期防护),落盘走临时文件 +
//!   原子 rename,并携带预览时的状态指纹(内容哈希 + Unix 权限位)做冲突
//!   检测(TOCTOU 防护,缺指纹一律判冲突而非覆盖)。
//! - 授权根集合 = 调用方给出的当前工作区根与仍 active 的额外授权根,加上
//!   后端自行推导的两类自有根:Skills 根(skill:// 写入记在这里)与各授权根
//!   所在的 git 仓库根(subagent worktree apply 把父工作区前像记在那里)。
//!   后两类不接受调用方传入,所以不构成新的授权入口;仓库根的向上推导在
//!   主目录与文件系统根处封顶,避免"主目录本身是 dotfiles 仓库"时把整个
//!   主目录变成可写的回退目标。
//! - turn 身份:TS 侧只传稳定的 turnId(每轮唯一的随机 ID),turn_seq 由
//!   本模块在 INDEX_LOCK 下按会话单调分配——时钟回拨/重复 ID 都不会打乱
//!   回退顺序。UI 展示时间用 firstCapturedAt,不再复用序号。
//! - blob 是原始字节拷贝(不内嵌 JSON),索引是追加式 index.jsonl;
//!   回退正确性来自"每个路径取 turn_seq >= target 的最早一条记录"。
//! - 索引物理上只追加不截断,但语义上会剪枝:一次完整成功的回退会写下
//!   turn_seq=target 的 kind="rewind" 标记,读取侧据此丢弃 >= target 的
//!   "陈旧未来"记录,避免回退后菜单里还留着已被撤销的轮次。部分成功
//!   (有冲突/失败)的回退写 turn_seq=0 的标记,只审计、不剪枝。
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

/// 条数上限里给 error 记录预留的尾部名额:普通捕获先停,失败仍能如实写进
/// 索引,撞上限的轮次才不会在 UI 上被显示成"完整"。
const RECORD_CAP_ERROR_RESERVE: usize = 64;

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
    /// Unix 权限位(仅 file 记录、仅 Unix 捕获时写入)。内容对了但 +x 丢了
    /// 的脚本仍然是坏的,所以回退时一并还原。可选字段:v2 老记录读出来是
    /// None,跳过还原即可,不需要升 schema。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
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
// turn_seq 的分配也依赖这把锁保证单调。回退期间也要一直持有,否则新落盘的
// 捕获会被随后写下的剪枝标记连带埋掉。
//
// 守的是 `()`,没有任何被保护的不变量会因 panic 而损坏,所以各处都用
// `into_inner()` 从中毒里恢复——一次无关的 panic 不该把整个检查点子系统
// 变成"再也捕获不了、也再也回退不了"。
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

/// 捕获前像时记下 Unix 权限位;Windows 没有 POSIX 位,恒为 None。
#[cfg(unix)]
fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).ok().map(|md| md.permissions().mode())
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Option<u32> {
    None
}

/// 回退写回内容后还原权限位。老记录没有这个字段就保持现状。
#[cfg(unix)]
fn restore_file_mode(path: &Path, mode: Option<u32>) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
}

#[cfg(not(unix))]
fn restore_file_mode(_path: &Path, _mode: Option<u32>) {}

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
///
/// rewind 标记的 turn_id 恒为空串,且部分回退时 turn_seq 记 0(哨兵)。若调用
/// 方也传空 turnId 进来,就会复用到标记的 seq——尤其是复用到 0,让整轮捕获落在
/// 合法 seq 之下、永远回退不到。标记不参与 turnId 复用。
fn resolve_turn_seq(records: &[CheckpointRecord], turn_id: &str) -> u64 {
    if let Some(existing) = records
        .iter()
        .find(|r| r.kind != "rewind" && r.turn_id == turn_id)
    {
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
        mode: None,
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
    capture_at_with_limits(
        dir,
        turn_id,
        root,
        rel_path,
        pre_image,
        MAX_BLOB_BYTES,
        MAX_TOTAL_BLOB_BYTES,
    )
}

/// 上限可注入的捕获实现:单测用小上限真实走超限分支,免得为了覆盖
/// 32MB 判断真的造一个 32MB 文件。
fn capture_at_with_limits(
    dir: &Path,
    turn_id: &str,
    root: &Path,
    rel_path: &Path,
    pre_image: PreImage,
    max_blob_bytes: u64,
    max_total_blob_bytes: u64,
) -> Result<u64, String> {
    ensure_conversation_dirs(dir)?;
    let root_str = normalize_root(root);
    let rel_str = normalize_rel(rel_path);
    let abs_path = root.join(rel_path);

    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let existing = read_index(dir);
    let turn_seq = resolve_turn_seq(&existing, turn_id);

    // 记录条数上限:普通捕获提前 RECORD_CAP_ERROR_RESERVE 条停住,把尾部
    // 名额留给 error 记录。否则撞上限的那些轮次连"不完整"都写不进去,UI 上
    // 会假装这一轮完好无损。
    if existing.len() + RECORD_CAP_ERROR_RESERVE >= MAX_RECORDS_PER_CONVERSATION {
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
            mode: None,
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
            mode: None,
        },
        PreImage::File(bytes) => {
            let owned;
            let bytes = match bytes {
                Some(b) => b,
                None => {
                    // 先看元数据再读盘:超限文件不该为了记一条 error
                    // 而被整个读进内存。
                    let len = fs::metadata(&abs_path).map_err(|e| e.to_string())?.len();
                    if len > max_blob_bytes {
                        append_error_record(
                            dir,
                            turn_seq,
                            turn_id,
                            &root_str,
                            &rel_str,
                            &format!("file too large to checkpoint ({len} bytes)"),
                        );
                        return Ok(turn_seq);
                    }
                    owned = fs::read(&abs_path).map_err(|e| e.to_string())?;
                    &owned
                }
            };
            if bytes.len() as u64 > max_blob_bytes {
                append_error_record(
                    dir,
                    turn_seq,
                    turn_id,
                    &root_str,
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
            if total.saturating_add(bytes.len() as u64) > max_total_blob_bytes {
                append_error_record(
                    dir,
                    turn_seq,
                    turn_id,
                    &root_str,
                    &rel_str,
                    "conversation checkpoint storage cap reached",
                );
                return Ok(turn_seq);
            }
            // size 就是这条记录实际占用的 blob 字节数,配额只按它求和。用
            // metadata().len() 会在"调用方直接给 bytes"或读盘后文件又被改
            // 的情况下与落盘量对不上,配额跟着失真。
            let mtime_ms = fs::symlink_metadata(&abs_path)
                .ok()
                .and_then(|md| md.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or(0);
            let size = bytes.len() as u64;
            let mode = file_mode(&abs_path);
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
                mode,
            }
        }
    };

    append_record(dir, &record)?;
    Ok(turn_seq)
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

/// 把"这个路径没能拿到前像"如实写进索引:该轮在 UI 上显示 ⚠ 不完整,
/// diff 里也能定位到具体路径。索引目录不可用时只剩日志。
fn record_capture_skip(ctx: &CheckpointCtx, root: &Path, rel_path: &Path, reason: &str) {
    let Ok(dir) = conversation_dir(&ctx.conversation_id) else {
        return;
    };
    if ensure_conversation_dirs(&dir).is_err() {
        return;
    }
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let existing = read_index(&dir);
    if existing.len() >= MAX_RECORDS_PER_CONVERSATION {
        eprintln!(
            "checkpoint record cap reached; dropping skip record for {}",
            root.join(rel_path).display()
        );
        return;
    }
    let seq = resolve_turn_seq(&existing, &ctx.turn_id);
    append_error_record(
        &dir,
        seq,
        &ctx.turn_id,
        &normalize_root(root),
        &normalize_rel(rel_path),
        reason,
    );
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
        record_capture_skip(ctx, root, rel_path, &error);
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

/// 索引的"活记录"视图:剔除被回退作废的陈旧未来轮。
/// 一条 turn_seq=t(t>0)的 rewind 标记表示 t 及之后的改动已被完整撤销,
/// 那些轮不该再出现在时间线里,也不该参与下一次回退的聚合;标记自身只作
/// 审计,永不返回。turn_seq=0 的标记来自部分成功的回退,不剪枝。
/// 注意:capture 侧的 turn_seq 分配与同轮去重仍读原始索引,保证序号在
/// 剪枝后依然单调,不会和陈旧记录撞号。
fn live_records(records: Vec<CheckpointRecord>) -> Vec<CheckpointRecord> {
    let mut out: Vec<CheckpointRecord> = Vec::new();
    for record in records {
        if record.kind == "rewind" {
            if record.turn_seq > 0 {
                out.retain(|r| r.turn_seq < record.turn_seq);
            }
            continue;
        }
        out.push(record);
    }
    out
}

/// 会话内可回退的轮列表,按 turn_seq 升序。error 记录不计入文件数,
/// 但使该轮标记 incomplete;被回退作废的陈旧轮已由 live_records 剔除。
fn checkpoint_list_sync(conversation_id: String) -> Result<Vec<CheckpointTurnSummary>, String> {
    let dir = conversation_dir(&conversation_id)?;
    let records = live_records(read_index(&dir));
    let mut turns: Vec<CheckpointTurnSummary> = Vec::new();
    for record in records {
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
    /// "restore" | "delete" | "clean" | "skip-dir" | "missing-blob" | "unresolvable"
    pub action: String,
    /// 预览时目标文件的状态指纹(内容哈希 + Unix 权限位);文件不存在时为
    /// "absent"。目标不可解析(根未授权 / 路径链有符号链接)或目录标记时
    /// 为 None。rewind 时重新计算比对,不一致或缺失则跳过该文件并上报冲突。
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
    /// 根已不在授权工作区集合内、或路径链上出现符号链接的条目:一律不回退。
    pub unresolvable_files: usize,
    /// 捕获阶段就失败的条目数:回退不覆盖这些文件,提示用户可能不完整。
    pub capture_errors: usize,
    pub entries: Vec<CheckpointDiffEntry>,
}

/// 取 turn_seq >= target 的可恢复记录,按文件序(即时间序)每路径保留最早一条。
/// error 记录单独返回计数;陈旧未来轮与 rewind 标记已由 live_records 剔除。
fn earliest_records_since(dir: &Path, turn_seq: u64) -> (Vec<CheckpointRecord>, usize) {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<CheckpointRecord> = Vec::new();
    let mut errors = 0usize;
    for record in live_records(read_index(dir)) {
        if record.turn_seq < turn_seq {
            continue;
        }
        if record.kind == "error" {
            errors += 1;
            continue;
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

/// 调用方给出的"当前仍然授权的工作区根"归一化:自身是符号链接的根不予采信,
/// 其余 canonicalize 后去重。空集合意味着任何记录都无法回退(fail-closed)。
fn canonical_authorized_roots(roots: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |candidate: PathBuf| {
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    };
    for raw in roots {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = Path::new(trimmed);
        if matches!(fs::symlink_metadata(path), Ok(md) if md.file_type().is_symlink()) {
            continue;
        }
        let Ok(canonical) = fs::canonicalize(path) else {
            continue;
        };
        // subagent worktree 的 apply 把父工作区前像记在父仓库根下(见
        // subagent_worktree.rs),那个根不在调用方给出的列表里。它由已授权
        // 的根自身向上推导得到,不接受调用方传入,因此不构成新的授权入口。
        if let Some(repo_root) = enclosing_repo_root(&canonical) {
            push(repo_root);
        }
        push(canonical);
    }
    // skill:// 写入的前像记在 Skills 根下,该根由后端自有配置决定,
    // 前端无从提供;漏掉它会让写过技能文件的轮次永远回退不了。
    if let Ok(skills_root) = crate::services::skills::skills_root_dir() {
        push(skills_root);
    }
    out
}

/// 从已授权的根向上找最近的 git 仓库根(`.git` 可能是目录也可能是 worktree
/// 的文件)。找不到就说明这个根不在仓库里,没有额外根需要放行。
///
/// 向上走必须封顶:主目录本身常常就是个 dotfiles 仓库,盘符/文件系统根也可能
/// 被 `git init` 过。无界地走上去会把整个主目录(乃至整块盘)变成可写的回退
/// 目标,等于把授权根开成通配符,所以这两类候选一律不采信。
fn enclosing_repo_root(start: &Path) -> Option<PathBuf> {
    let home = dirs::home_dir().and_then(|h| fs::canonicalize(h).ok());
    let mut cursor = Some(start);
    while let Some(dir) = cursor {
        // 没有 parent 说明已经到文件系统/盘符根,不能当仓库根。
        let parent = dir.parent()?;
        if home.as_deref() == Some(dir) {
            return None;
        }
        if dir.join(".git").exists() {
            return fs::canonicalize(dir).ok();
        }
        cursor = Some(parent);
    }
    None
}

/// 回退授权链的第一环:记录里的 root 必须仍是当前授权工作区根之一。
/// 先用 symlink_metadata 拒绝"根自身是符号链接"——工作区被改名后在原路径
/// 挂一个指向别处的链接,canonicalize 会跟随它把回退写到工作区外。
fn resolve_authorized_root(
    root_str: &str,
    authorized_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let raw = Path::new(root_str);
    match fs::symlink_metadata(raw) {
        Ok(md) if md.file_type().is_symlink() => {
            return Err("refusing to follow a symlinked checkpoint root".to_string());
        }
        Ok(md) if !md.is_dir() => {
            return Err("checkpoint root is no longer a directory".to_string());
        }
        Ok(_) => {}
        Err(e) => return Err(format!("checkpoint root unavailable: {e}")),
    }
    let root = fs::canonicalize(raw).map_err(|e| format!("checkpoint root unavailable: {e}"))?;
    if !authorized_roots.iter().any(|allowed| allowed == &root) {
        return Err("checkpoint root is not an authorized workspace root".to_string());
    }
    Ok(root)
}

/// 回退目标的重新校验:根必须仍在授权集合内且不是符号链接,相对路径重新
/// 过滤(仅 Normal 分量),并逐级拒绝路径链上的符号链接。
/// 绝不信任捕获时的绝对路径——这是 rewind 的唯一授权通道。
fn resolve_rewind_target(
    root_str: &str,
    rel_str: &str,
    authorized_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let root = resolve_authorized_root(root_str, authorized_roots)?;
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

/// 目标当前状态的指纹:内容哈希 + (Unix)权限位;不存在(或不是普通文件)
/// 返回哨兵。权限位必须参与 TOCTOU 比对——确认框停留期间的 chmod 和内容
/// 改动一样是"预览后被外部修改",只比内容会让回退把它静默覆盖回捕获时的
/// 权限。Windows 没有 POSIX 位,指纹退化为纯内容哈希。
fn current_state_hash(target: &Path) -> String {
    match fs::symlink_metadata(target) {
        Ok(md) if md.is_file() => match fs::read(target) {
            Ok(bytes) => match file_mode(target) {
                Some(mode) => format!("{}@{:o}", sha256_hex(&bytes), mode),
                None => sha256_hex(&bytes),
            },
            Err(_) => "unreadable".to_string(),
        },
        Ok(_) => "non-file".to_string(),
        Err(_) => "absent".to_string(),
    }
}

/// 记录的 mode 与目标现状是否不一致。mode 没记录(老记录/Windows)或现状
/// 取不到时视为一致——没有基线就谈不上漂移,回退侧也不会去改权限。
fn mode_differs(recorded: Option<u32>, target: &Path) -> bool {
    match recorded {
        Some(want) => matches!(file_mode(target), Some(have) if have != want),
        None => false,
    }
}

fn classify_entry(
    dir: &Path,
    record: &CheckpointRecord,
    authorized_roots: &[PathBuf],
) -> CheckpointDiffEntry {
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
    // 目标解析不通过(根未授权 / 路径链有符号链接)时没有可比对的现状哈希;
    // rewind 侧会在同一处再次失败并计入 failed,不会走到冲突检测。
    let target = match resolve_rewind_target(&record.root, &record.rel_path, authorized_roots) {
        Ok(target) => target,
        Err(_) => {
            return CheckpointDiffEntry {
                path: display,
                key,
                action: "unresolvable".to_string(),
                current_hash: None,
            };
        }
    };
    let hash = current_state_hash(&target);
    let action = if !record.existed_before {
        if hash == "absent" {
            "clean"
        } else {
            "delete"
        }
    } else {
        match &record.blob {
            None => "missing-blob",
            Some(blob) => match fs::read(blobs_dir(dir).join(blob)) {
                Err(_) => "missing-blob",
                Ok(expected) => {
                    // 指纹的内容部分与前像比对;内容一致但权限位漂移也不是
                    // clean——回退会把权限还原回去,必须以 restore 呈现在预览
                    // 里,不能藏在"已一致"里静默改权限。
                    let current_content = hash.split_once('@').map_or(hash.as_str(), |(c, _)| c);
                    if sha256_hex(&expected) == current_content
                        && !mode_differs(record.mode, &target)
                    {
                        "clean"
                    } else {
                        "restore"
                    }
                }
            },
        }
    };
    // 目标可解析的条目一律回传现状哈希(含 clean / missing-blob):
    // rewind 侧对缺哈希的条目一律判冲突,少回传一个就等于放弃一条防线。
    CheckpointDiffEntry {
        path: display,
        key,
        action: action.to_string(),
        current_hash: Some(hash),
    }
}

fn checkpoint_diff_stats_sync(
    conversation_id: String,
    turn_seq: u64,
    authorized_roots: Vec<String>,
) -> Result<CheckpointDiffStats, String> {
    let dir = conversation_dir(&conversation_id)?;
    let authorized = canonical_authorized_roots(&authorized_roots);
    let (records, capture_errors) = earliest_records_since(&dir, turn_seq);
    let mut stats = CheckpointDiffStats {
        turn_seq,
        restore_files: 0,
        delete_files: 0,
        clean_files: 0,
        skipped_dirs: 0,
        missing_blobs: 0,
        unresolvable_files: 0,
        capture_errors,
        entries: Vec::new(),
    };
    for record in records {
        let entry = classify_entry(&dir, &record, &authorized);
        match entry.action.as_str() {
            "restore" => stats.restore_files += 1,
            "delete" => stats.delete_files += 1,
            "clean" => stats.clean_files += 1,
            "skip-dir" => stats.skipped_dirs += 1,
            "missing-blob" => stats.missing_blobs += 1,
            "unresolvable" => stats.unresolvable_files += 1,
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
    authorized_roots: Vec<String>,
) -> Result<CheckpointDiffStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoint_diff_stats_sync(conversation_id, turn_seq, authorized_roots)
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
    /// 目标范围内捕获阶段就失败的记录数:这些文件没有前像,回退没有碰它们,
    /// 现场并没有真正复原。
    pub capture_errors: usize,
    /// 预览后被并发修改的文件:跳过不覆盖,由用户重新预览决定。
    pub conflicts: Vec<String>,
    pub failed: Vec<String>,
}

/// 一次回退是否"完整":没有冲突/失败/不可恢复目录/捕获失败。只有完整回退
/// 才允许写 turn_seq=target 的剪枝标记。捕获失败的轮次即使其余文件都恢复了
/// 也不完整——缺前像的文件仍停在改动后的状态,按完整剪枝会把 error 记录连同
/// "这轮没回退干净"的事实一起从时间线上藏掉。
fn rewind_is_complete(result: &CheckpointRewindResult) -> bool {
    result.conflicts.is_empty()
        && result.failed.is_empty()
        && result.skipped_dirs == 0
        && result.capture_errors == 0
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
        // Windows 上目标被占用(编辑器/杀软持有句柄)时 rename 会失败。原先
        // 的兜底是 remove 目标再 rename,但 remove 成功而 rename 仍失败时,
        // 旧内容和新内容会同时消失——回退反而把文件弄丢了。改为先把旧文件
        // 挪到备份名:第二次 rename 失败就把备份挪回来,任何一步失败都至少
        // 保住一份完整内容。
        Err(_) if target.exists() => {
            let backup = parent.join(format!(".ckpt-bak-{}-{}", std::process::id(), now_ms()));
            if let Err(e) = fs::rename(target, &backup) {
                let _ = fs::remove_file(&tmp);
                return Err(e.to_string());
            }
            match fs::rename(&tmp, target) {
                Ok(()) => {
                    let _ = fs::remove_file(&backup);
                    Ok(())
                }
                Err(e) => {
                    let _ = fs::rename(&backup, target);
                    let _ = fs::remove_file(&tmp);
                    Err(e.to_string())
                }
            }
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

/// 把 turn_seq >= target 的所有被改文件恢复到各自最早的前像。
/// 索引物理上仍然只追加,但完整成功的回退会写下 turn_seq=target 的 rewind
/// 标记,读取侧据此把 >= target 的陈旧未来记录剪掉,菜单不再残留已撤销的
/// 轮次;有冲突/失败/捕获缺口(error 记录)时写 turn_seq=0 的标记,只审计
/// 不剪枝,以免把还没回退成功的路径与"这轮不完整"的证据一并埋掉。
fn checkpoint_rewind_code_sync(
    conversation_id: String,
    turn_seq: u64,
    authorized_roots: Vec<String>,
    expected: Vec<CheckpointExpectedEntry>,
) -> Result<CheckpointRewindResult, String> {
    let dir = conversation_dir(&conversation_id)?;
    let authorized = canonical_authorized_roots(&authorized_roots);
    // 整段(读索引 → 逐个恢复 → 写标记)持锁:回退期间若有工具捕获落盘,新
    // 记录的 turn_seq 会落在 target 之上,随后写下的剪枝标记会把这些刚发生
    // 的改动一并当作"陈旧未来"埋掉,前像就再也找不回来了。锁守的是 `()`,
    // 中毒不代表数据不一致,直接取回内部值,不因此让回退失败。
    let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(rewind_and_mark_at(&dir, turn_seq, &authorized, Some(&expected)))
}

/// 锁内的"回退 + 写审计/剪枝标记":目录可注入,便于单测覆盖完整/部分
/// 标记的分界。调用方必须已持有 INDEX_LOCK。
fn rewind_and_mark_at(
    dir: &Path,
    turn_seq: u64,
    authorized: &[PathBuf],
    expected: Option<&[CheckpointExpectedEntry]>,
) -> CheckpointRewindResult {
    let result = rewind_at(dir, turn_seq, authorized, expected);
    // skipped_dirs 和 capture_errors 都算没回退干净:恢复不了的目录/没有
    // 前像的文件让这一轮的现场没有真正复原,不能剪掉时间线让用户以为已经
    // 撤销(剪枝还会把 error 记录一起埋掉,"不完整"从此不可见)。
    let complete = rewind_is_complete(&result);
    // 回退审计标记:turn_seq>0 时同时承担"剪掉陈旧未来轮"的语义。
    let marker = CheckpointRecord {
        schema: 2,
        turn_seq: if complete { turn_seq } else { 0 },
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
            "target={} restored={} deleted={} conflicts={} failed={} capture_errors={} complete={}",
            turn_seq,
            result.restored_files,
            result.deleted_files,
            result.conflicts.len(),
            result.failed.len(),
            result.capture_errors,
            complete
        )),
        mode: None,
    };
    // 调用方持锁中,直接追加即可。
    let _ = append_record(dir, &marker);
    result
}

/// 目录可注入的回退实现,便于单测绕过 home 解析。
/// `expected` = Some 时进入 fail-closed 模式:任何可解析目标都必须带上预览
/// 时的现状哈希且比对一致,否则判冲突跳过。None 只保留给内部/单测调用。
fn rewind_at(
    dir: &Path,
    turn_seq: u64,
    authorized_roots: &[PathBuf],
    expected: Option<&[CheckpointExpectedEntry]>,
) -> CheckpointRewindResult {
    let expected_by_key: Option<HashMap<&str, &str>> = expected.map(|entries| {
        entries
            .iter()
            .map(|e| (e.key.as_str(), e.current_hash.as_str()))
            .collect()
    });
    let (records, capture_errors) = earliest_records_since(dir, turn_seq);
    let mut result = CheckpointRewindResult {
        turn_seq,
        restored_files: 0,
        deleted_files: 0,
        clean_files: 0,
        skipped_dirs: 0,
        capture_errors,
        conflicts: Vec::new(),
        failed: Vec::new(),
    };
    for record in records {
        let display = format!("{}/{}", record.root, record.rel_path);
        if record.kind == "dir" {
            result.skipped_dirs += 1;
            continue;
        }
        // 授权链:root 仍在授权集合内且非符号链接 + 相对路径重新过滤 +
        // 全链拒符号链接。
        let target = match resolve_rewind_target(&record.root, &record.rel_path, authorized_roots) {
            Ok(t) => t,
            Err(e) => {
                result.failed.push(format!("{display}: {e}"));
                continue;
            }
        };
        // TOCTOU 防护:与预览时的内容哈希比对。缺失该键说明预览与本次执行
        // 对不上(旧版前端 / 被裁剪的请求),一律判冲突,绝不 fail-open。
        // "unreadable" 是"这次没读到内容"的哨兵而不是内容摘要,两次都没读到
        // 并不等于内容没变,拿它比相等同样是 fail-open,所以直接判冲突。
        let key = record_key(&record.root, &record.rel_path);
        if let Some(map) = &expected_by_key {
            let current = current_state_hash(&target);
            match map.get(key.as_str()) {
                Some(expected) if current != "unreadable" && current == **expected => {}
                _ => {
                    result.conflicts.push(display);
                    continue;
                }
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
                    // 检查与写入之间的窗口:紧邻动作再走一遍授权链。
                    if let Err(e) = reverify_target(&record, &target, authorized_roots) {
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
                            // 内容一致,但权限位可能与前像不同。这种情况预览
                            // 已按 restore 披露,确认期间的 chmod 也会被状态
                            // 指纹判成冲突拦下,走到这里的权限还原都是用户
                            // 确认过的;按是否真的改了权限计 restored/clean。
                            let mode_changed = mode_differs(record.mode, &target);
                            restore_file_mode(&target, record.mode);
                            return Ok(mode_changed);
                        }
                    }
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    return Err(e.to_string());
                }
                Err(_) => {}
            }
            // 检查与写入之间的窗口:紧邻落盘再走一遍授权链。
            reverify_target(&record, &target, authorized_roots)?;
            atomic_write(&target, &pre_image)?;
            // atomic_write 走的是新建临时文件 + rename,新文件带的是默认权限,
            // 不还原的话可执行脚本回退完就没了 +x。
            restore_file_mode(&target, record.mode);
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

/// 校验与动作之间存在窗口期(攻击者可在此把 root 或某级父目录换成符号
/// 链接),所以在真正写/删之前紧邻重跑一次授权链并确认目标没有漂移。
fn reverify_target(
    record: &CheckpointRecord,
    target: &Path,
    authorized_roots: &[PathBuf],
) -> Result<(), String> {
    let again = resolve_rewind_target(&record.root, &record.rel_path, authorized_roots)?;
    if again != target {
        return Err("checkpoint target changed during rewind".to_string());
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn checkpoint_rewind_code(
    conversation_id: String,
    turn_seq: u64,
    authorized_roots: Vec<String>,
    expected: Vec<CheckpointExpectedEntry>,
) -> Result<CheckpointRewindResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checkpoint_rewind_code_sync(conversation_id, turn_seq, authorized_roots, expected)
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

/// worktree.apply 的前像分类。Err 表示这个路径拿不到可回退的前像,
/// 调用方必须把原因写成 error 记录,而不是静默跳过。
fn classify_worktree_pre_image(abs: &Path) -> Result<PreImage<'static>, String> {
    match fs::symlink_metadata(abs) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PreImage::Missing),
        Err(e) => Err(format!("pre-image stat failed: {e}")),
        // 符号链接不做前像捕获,与 fs_delete 的语义保持一致。
        Ok(md) if md.file_type().is_symlink() => {
            Err("symlink pre-image not captured".to_string())
        }
        Ok(md) if md.is_file() => Ok(PreImage::File(None)),
        Ok(md) if md.is_dir() => Ok(PreImage::Dir),
        Ok(_) => Err("unsupported file type; pre-image not captured".to_string()),
    }
}

/// 在 worktree.apply 修改父工作区之前,对将被覆盖/删除的路径捕获父工作区
/// 前像。路径来自 collect_apply_paths(git 相对路径),root 为父仓库根。
///
/// 返回没能拿到前像的路径及原因:这些是捕获缺口,但此刻还不知道 apply 会
/// 不会真的改动父工作区。若最终是 already_applied / fallback_noop,父仓库
/// 一个字节都没动,把缺口记成 error 会让一个什么都没发生的轮次在 UI 上标
/// ⚠"回退可能不完整"。所以缺口交由调用方在确认 apply 生效后再落账
/// (见 record_worktree_capture_skips)。
///
/// 成功的前像仍然必须在这里立刻落盘——它们是内容备份,过了这一行父工作区
/// 就要被覆盖了,延后就没得捕获了。
#[must_use = "捕获缺口必须由调用方按 apply 结果决定是否落账"]
pub fn capture_worktree_apply_pre_images(
    ctx: Option<&CheckpointCtx>,
    parent_repo_root: &Path,
    rel_paths: &[String],
) -> Vec<(PathBuf, String)> {
    let Some(ctx) = ctx else {
        return Vec::new();
    };
    let mut skipped = Vec::new();
    for rel in rel_paths {
        let rel_path = PathBuf::from(rel);
        let abs = parent_repo_root.join(&rel_path);
        match classify_worktree_pre_image(&abs) {
            Ok(pre_image) => capture_pre_image(Some(ctx), parent_repo_root, &rel_path, pre_image),
            Err(reason) => {
                eprintln!(
                    "checkpoint worktree pre-image skipped for {}: {reason}",
                    abs.display()
                );
                skipped.push((rel_path, reason));
            }
        }
    }
    skipped
}

/// 把 capture_worktree_apply_pre_images 攒下的捕获缺口写成 error 记录。
/// 只在 apply 真的改动了父工作区时调用:轮次被标成不完整,前提是这一轮
/// 确实动过东西。
pub fn record_worktree_capture_skips(
    ctx: Option<&CheckpointCtx>,
    parent_repo_root: &Path,
    skipped: &[(PathBuf, String)],
) {
    let Some(ctx) = ctx else { return };
    for (rel_path, reason) in skipped {
        record_capture_skip(ctx, parent_repo_root, rel_path, reason);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(file: &Path, root: &Path) -> PathBuf {
        file.strip_prefix(root).unwrap().to_path_buf()
    }

    /// 单测里的"当前授权工作区根"集合:等价于前端把工作区根传回后端。
    fn roots(root: &Path) -> Vec<PathBuf> {
        vec![root.to_path_buf()]
    }

    fn expected_from_diff(ckpt: &Path, turn_seq: u64, root: &Path) -> Vec<CheckpointExpectedEntry> {
        let (records, _) = earliest_records_since(ckpt, turn_seq);
        records
            .iter()
            .map(|r| classify_entry(ckpt, r, &roots(root)))
            .filter_map(|entry| {
                entry.current_hash.map(|hash| CheckpointExpectedEntry {
                    key: entry.key,
                    current_hash: hash,
                })
            })
            .collect()
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
        let result = rewind_at(&ckpt, seq, &roots(&root), None);
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

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
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
        let result = rewind_at(&ckpt, seq1, &roots(&root), None);
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
        let result = rewind_at(&ckpt, seq2, &roots(&root), None);
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
    fn rewind_marker_is_never_reused_as_a_turn_seq() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let a = root.join("a.txt");
        fs::write(&a, "a").unwrap();
        let s1 = capture_at(&ckpt, "t-x", &root, &rel(&a, &root), PreImage::File(None)).unwrap();
        // 部分回退写下的哨兵标记:turn_id 为空、turn_seq 为 0。
        append_rewind_marker(&ckpt, 0);

        // 调用方也传空 turnId 时不能复用到标记的 0,否则这一轮永远回退不到。
        let records = read_index(&ckpt);
        assert_eq!(resolve_turn_seq(&records, ""), s1 + 1);
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

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
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

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
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

        // 预览时看到的是 v2 的状态指纹;确认前文件又被改成 v3 → 冲突,跳过。
        let preview_hash = current_state_hash(&file);
        fs::write(&file, "v3").unwrap();
        let expected = vec![CheckpointExpectedEntry {
            key: record_key(&normalize_root(&root), &normalize_rel(&r)),
            current_hash: preview_hash,
        }];
        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&expected));
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v3");

        // 指纹吻合时正常恢复。
        let expected = vec![CheckpointExpectedEntry {
            key: record_key(&normalize_root(&root), &normalize_rel(&r)),
            current_hash: current_state_hash(&file),
        }];
        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&expected));
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

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
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

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
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

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
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

        let result = rewind_at(&ckpt, seq, &roots(&root), None);
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
        let big = root.join("big.bin");
        let small = root.join("small.bin");
        fs::write(&big, "0123456789").unwrap();
        fs::write(&small, "ok").unwrap();

        // File(None):元数据即判定超限,不读盘就记 error,不产出 blob。
        capture_at_with_limits(
            &ckpt,
            "turn-1",
            &root,
            &rel(&big, &root),
            PreImage::File(None),
            4,
            MAX_TOTAL_BLOB_BYTES,
        )
        .unwrap();
        // File(Some):调用方已持有字节时同样受同一个上限约束。
        capture_at_with_limits(
            &ckpt,
            "turn-1",
            &root,
            &rel(&small, &root),
            PreImage::File(Some(b"too-long-for-cap")),
            4,
            MAX_TOTAL_BLOB_BYTES,
        )
        .unwrap();

        let records = read_index(&ckpt);
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|r| r.kind == "error"));
        assert!(records.iter().all(|r| r.blob.is_none()));
        assert!(records[0].note.as_deref().unwrap().contains("10 bytes"));
        let blobs: Vec<_> = fs::read_dir(blobs_dir(&ckpt)).unwrap().collect();
        assert!(blobs.is_empty());

        // 上限之内仍然正常落 blob。
        capture_at_with_limits(
            &ckpt,
            "turn-2",
            &root,
            &rel(&small, &root),
            PreImage::File(None),
            4,
            MAX_TOTAL_BLOB_BYTES,
        )
        .unwrap();
        assert_eq!(fs::read_dir(blobs_dir(&ckpt)).unwrap().count(), 1);
    }

    #[test]
    fn total_storage_cap_records_error_instead_of_blob() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        fs::write(&a, "aaaa").unwrap();
        fs::write(&b, "bbbb").unwrap();

        capture_at_with_limits(&ckpt, "t-1", &root, &rel(&a, &root), PreImage::File(None), 64, 6)
            .unwrap();
        capture_at_with_limits(&ckpt, "t-2", &root, &rel(&b, &root), PreImage::File(None), 64, 6)
            .unwrap();

        let records = read_index(&ckpt);
        assert_eq!(records.len(), 2);
        assert!(records[0].blob.is_some());
        assert_eq!(records[1].kind, "error");
        assert!(records[1]
            .note
            .as_deref()
            .unwrap()
            .contains("storage cap reached"));
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

        let result = rewind_at(&ckpt, 1, &roots(&parent), None);
        assert_eq!(result.restored_files, 1);
        assert_eq!(result.deleted_files, 1);
        assert_eq!(fs::read_to_string(&existing).unwrap(), "parent-v1");
        assert!(!parent.join("new.txt").exists());
    }

    /// worktree.apply 的前像捕获发生在任何 apply 分支之前,所以 fallback 判定
    /// already_applied / fallback_noop(父仓库一个字节没动)时,这些记录已经落库
    /// 了。契约是:它们不会造成错误回退——前像等于当前内容,一律判 clean。
    ///
    /// 锁住这个契约,后续若有人改动 classify_entry 的相等判定或捕获时机,
    /// 冗余记录就会立刻升级成"回退删掉用户没碰过的文件"。
    #[test]
    fn worktree_noop_apply_records_rewind_as_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let parent = root.join("parent");
        fs::create_dir_all(&parent).unwrap();
        let ckpt = root.join("ckpt");

        // 父仓库里已存在、且内容已等于 worktree 目标内容(already_applied)。
        let already = parent.join("same.txt");
        fs::write(&already, "identical").unwrap();
        capture_at(
            &ckpt,
            "turn-1",
            &parent,
            &PathBuf::from("same.txt"),
            PreImage::File(None),
        )
        .unwrap();

        // 父仓库里不存在的路径:捕获记 Missing。fallback 若什么都没拷,
        // 这个文件始终不会出现,回退不该把它当成"本轮新建"去删。
        capture_at(
            &ckpt,
            "turn-1",
            &parent,
            &PathBuf::from("never-created.txt"),
            PreImage::Missing,
        )
        .unwrap();

        // apply 是 noop:父工作区不做任何改动。
        let result = rewind_at(&ckpt, 1, &roots(&parent), None);
        assert_eq!(result.restored_files, 0, "内容未变不该被当成 restore 写回");
        assert_eq!(
            result.deleted_files, 0,
            "本轮没创建过文件,不该被当成新建去删"
        );
        assert_eq!(result.clean_files, 2);
        assert!(result.failed.is_empty());
        assert!(result.conflicts.is_empty());
        // 最关键的一条:noop 轮次回退后,父工作区必须原样不动。
        assert_eq!(fs::read_to_string(&already).unwrap(), "identical");
        assert!(!parent.join("never-created.txt").exists());
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
        let entries: Vec<_> = records.iter().map(|r| classify_entry(&ckpt, r, &roots(&root))).collect();
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
        // 预览返回当前状态指纹(内容 + 权限位),供 rewind 做冲突比对。
        assert_eq!(
            dirty_entry.current_hash.as_deref(),
            Some(current_state_hash(&dirty).as_str())
        );
    }

    #[test]
    fn authorized_roots_include_backend_owned_repo_and_skills_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let repo = base.join("repo");
        let workspace = repo.join("crates").join("app");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();

        let authorized = canonical_authorized_roots(&[workspace.to_string_lossy().to_string()]);
        assert!(authorized.contains(&workspace));
        // worktree apply 把前像记在父仓库根下,漏了它那些轮次永远回退不了。
        assert!(authorized.contains(&fs::canonicalize(&repo).unwrap()));
        // skill:// 写入记在 Skills 根下,同理必须在集合里。
        let skills_root = crate::services::skills::skills_root_dir().unwrap();
        assert!(authorized.contains(&skills_root));
    }

    #[test]
    fn worktree_records_under_parent_repo_root_stay_rewindable() {
        let tmp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let repo = base.join("repo");
        let workspace = repo.join("crates").join("app");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();
        let ckpt = base.join("ckpt");

        // 模拟 capture_worktree_apply_pre_images:前像记在父仓库根下。
        let file = repo.join("shared.txt");
        fs::write(&file, "v1").unwrap();
        let seq = capture_at(
            &ckpt,
            "turn-1",
            &fs::canonicalize(&repo).unwrap(),
            &rel(&file, &repo),
            PreImage::File(None),
        )
        .unwrap();
        fs::write(&file, "v2").unwrap();

        // 前端只给得出工作区根,父仓库根靠后端推导补上。
        let authorized = canonical_authorized_roots(&[workspace.to_string_lossy().to_string()]);
        let result = rewind_at(&ckpt, seq, &authorized, None);
        assert!(result.failed.is_empty(), "failed: {:?}", result.failed);
        assert_eq!(result.restored_files, 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
    }

    #[test]
    fn rewind_marker_cuts_stale_future_turns() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 1);

        // 完整成功的回退写 turn_seq=target 的标记:turn-1 属于"已撤销的
        // 未来",既不该再出现在菜单里,也不该参与下一次聚合。
        append_rewind_marker(&ckpt, seq);
        assert!(live_records(read_index(&ckpt)).is_empty());
        let (records, errors) = earliest_records_since(&ckpt, 1);
        assert!(records.is_empty());
        assert_eq!(errors, 0);

        // 剪枝只影响读取侧:新一轮仍拿到更大的 turn_seq,不会和陈旧记录撞号。
        fs::write(&file, "v3").unwrap();
        let next = capture_at(&ckpt, "turn-2", &root, &r, PreImage::File(None)).unwrap();
        assert!(next > seq);
        let (records, _) = earliest_records_since(&ckpt, next);
        assert_eq!(records.len(), 1);
    }

    #[test]
    fn partial_rewind_marker_does_not_cut_timeline() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();
        // 部分成功(有冲突/失败)时标记 turn_seq=0:只审计,不剪枝,
        // 否则没回退成功的路径会被永久埋掉。
        append_rewind_marker(&ckpt, 0);
        let (records, _) = earliest_records_since(&ckpt, seq);
        assert_eq!(records.len(), 1);
        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 1);
    }

    fn append_rewind_marker(ckpt: &Path, turn_seq: u64) {
        append_record(
            ckpt,
            &CheckpointRecord {
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
                note: None,
                mode: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn missing_expected_hash_is_treated_as_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let dirty = root.join("dirty.txt");
        let untouched = root.join("clean.txt");
        fs::write(&dirty, "v1").unwrap();
        fs::write(&untouched, "same").unwrap();

        let seq =
            capture_at(&ckpt, "turn-1", &root, &rel(&dirty, &root), PreImage::File(None)).unwrap();
        capture_at(
            &ckpt,
            "turn-1",
            &root,
            &rel(&untouched, &root),
            PreImage::File(None),
        )
        .unwrap();
        fs::write(&dirty, "v2").unwrap();

        // 预览时 clean.txt 是 clean;确认对话框期间被手改。只带回 restore
        // 条目的哈希(旧前端行为)时,后端必须判冲突而不是照旧覆盖。
        let only_restore: Vec<CheckpointExpectedEntry> = expected_from_diff(&ckpt, seq, &root)
            .into_iter()
            .filter(|e| e.key.ends_with("dirty.txt"))
            .collect();
        assert_eq!(only_restore.len(), 1);
        fs::write(&untouched, "hand-edited").unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&only_restore));
        assert_eq!(result.restored_files, 1);
        assert_eq!(result.conflicts.len(), 1);
        assert!(result.conflicts[0].ends_with("clean.txt"));
        assert_eq!(fs::read_to_string(&untouched).unwrap(), "hand-edited");

        // 完整回传所有可解析条目的哈希时才会真正覆盖。
        let full = expected_from_diff(&ckpt, seq, &root);
        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&full));
        assert!(result.conflicts.is_empty());
        assert_eq!(fs::read_to_string(&untouched).unwrap(), "same");
    }

    #[test]
    fn unauthorized_root_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        // 授权集合为空(或不含该根)时一律拒绝,文件保持原样。
        let result = rewind_at(&ckpt, seq, &[], None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert!(result.failed[0].contains("authorized workspace root"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");

        // diff 预览侧同口径:标 unresolvable 且不回传哈希。
        let (records, _) = earliest_records_since(&ckpt, seq);
        let entry = classify_entry(&ckpt, &records[0], &[]);
        assert_eq!(entry.action, "unresolvable");
        assert!(entry.current_hash.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_root_after_rename_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(tmp.path()).unwrap();
        let root = base.join("workspace");
        fs::create_dir_all(&root).unwrap();
        let ckpt = base.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        // 把工作区整体改名,再在原路径挂一个指向区外目录的符号链接:
        // 直接 canonicalize 会跟随链接把回退写到工作区外。
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("a.txt"), "outside-secret").unwrap();
        fs::rename(&root, base.join("workspace-moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();

        // 前端把("当前的")工作区根原样传回来也不行:根自身是符号链接就拒绝。
        let result = rewind_at(&ckpt, seq, &roots(&root), None);
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.failed.len(), 1);
        assert!(result.failed[0].contains("symlinked checkpoint root"));
        assert_eq!(
            fs::read_to_string(outside.join("a.txt")).unwrap(),
            "outside-secret"
        );

        // canonical_authorized_roots 也不采信符号链接根:它不会出现在集合里。
        let authorized = canonical_authorized_roots(&[root.to_string_lossy().to_string()]);
        assert!(!authorized.contains(&root));
    }

    #[cfg(unix)]
    #[test]
    fn worktree_pre_image_classification_reports_skips() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let file = root.join("a.txt");
        fs::write(&file, "v1").unwrap();
        let dir_path = root.join("sub");
        fs::create_dir_all(&dir_path).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();

        assert!(matches!(
            classify_worktree_pre_image(&file),
            Ok(PreImage::File(None))
        ));
        assert!(matches!(
            classify_worktree_pre_image(&dir_path),
            Ok(PreImage::Dir)
        ));
        assert!(matches!(
            classify_worktree_pre_image(&root.join("nope.txt")),
            Ok(PreImage::Missing)
        ));
        // 符号链接不静默跳过:返回原因,由调用方写成 error 记录。
        // 用 let-else 而非 unwrap_err():后者要求 PreImage: Debug,而 PreImage::File
        // 里就是文件内容,不该为了一句测试断言让它可以被打印进 panic 信息。
        let Err(err) = classify_worktree_pre_image(&link) else {
            panic!("符号链接不能被当成可捕获的前像");
        };
        assert!(err.contains("symlink"));
    }

    #[test]
    fn capture_error_marks_rewind_partial_and_keeps_timeline() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        // 同轮另一个文件捕获失败:只有 error 记录,没有前像可回退。
        append_error_record(
            &ckpt,
            seq,
            "turn-1",
            &normalize_root(&root),
            "big.bin",
            "file too large to checkpoint",
        );
        fs::write(&file, "v2").unwrap();

        let result = {
            let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            rewind_and_mark_at(&ckpt, seq, &roots(&root), None)
        };
        // 有前像的文件照常恢复,但结果必须上报捕获缺口,且不算完整回退。
        assert_eq!(result.restored_files, 1);
        assert_eq!(result.capture_errors, 1);
        assert!(!rewind_is_complete(&result));
        // 标记必须是 turn_seq=0(只审计不剪枝):该轮连同 error 记录仍然
        // 可见,而不是"回退成功"后把不完整的事实一起从时间线上藏掉。
        let live = live_records(read_index(&ckpt));
        assert!(live.iter().any(|rec| rec.kind == "error"));
        assert!(live.iter().any(|rec| rec.kind == "file"));
    }

    #[test]
    fn complete_rewind_marker_prunes_timeline() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        let result = {
            let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            rewind_and_mark_at(&ckpt, seq, &roots(&root), None)
        };
        assert!(rewind_is_complete(&result));
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
        // 无缺口的完整回退才允许剪枝,菜单不再残留已撤销的轮次。
        assert!(live_records(read_index(&ckpt)).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn chmod_between_preview_and_rewind_is_a_conflict() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("a.txt");
        let r = rel(&file, &root);
        fs::write(&file, "v1").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        fs::write(&file, "v2").unwrap();

        // 预览(带走状态指纹)之后、确认之前用户 chmod:必须判冲突跳过,
        // 内容与权限都保持原样,不得静默把权限改回捕获时的值。
        let expected = expected_from_diff(&ckpt, seq, &root);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();

        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&expected));
        assert_eq!(result.restored_files, 0);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
        assert_eq!(file_mode(&file).unwrap() & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn mode_only_drift_previews_as_restore_and_is_restored() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ckpt = root.join("ckpt");
        let file = root.join("run.sh");
        let r = rel(&file, &root);
        fs::write(&file, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();

        let seq = capture_at(&ckpt, "turn-1", &root, &r, PreImage::File(None)).unwrap();
        // 内容没变但权限位漂移:预览必须按 restore 披露,不能伪装成 clean
        // 再顺手改权限。
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();

        let (records, _) = earliest_records_since(&ckpt, seq);
        let entry = classify_entry(&ckpt, &records[0], &roots(&root));
        assert_eq!(entry.action, "restore");

        let expected = expected_from_diff(&ckpt, seq, &root);
        let result = rewind_at(&ckpt, seq, &roots(&root), Some(&expected));
        assert_eq!(result.restored_files, 1);
        assert_eq!(file_mode(&file).unwrap() & 0o777, 0o755);
        assert_eq!(fs::read_to_string(&file).unwrap(), "#!/bin/sh\n");
    }
}
