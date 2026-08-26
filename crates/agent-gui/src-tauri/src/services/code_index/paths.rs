//! 索引数据的磁盘布局。
//!
//! ```text
//! ~/.liveagent/code-index/
//! ├── models/                          fastembed 模型缓存（全 workspace 共享）
//! └── projects/<workdir_hash>/
//!     ├── code-index.sqlite3
//!     ├── .workdir.json                原始路径反查标记（memory 同款）
//!     └── .quarantine/corrupt-<ts>/    损坏库隔离
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const APP_DIR_NAME: &str = ".liveagent";
const CODE_INDEX_ROOT: &str = "code-index";
pub(crate) const DB_FILENAME: &str = "code-index.sqlite3";

pub(crate) fn code_index_root_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok(home.join(APP_DIR_NAME).join(CODE_INDEX_ROOT))
}

pub(crate) fn models_cache_dir() -> Result<PathBuf, String> {
    Ok(code_index_root_dir()?.join("models"))
}

/// memory/paths.rs 同款 per-workspace 身份：canonicalize 后 sha256 取前 16 hex。
pub(crate) fn workdir_hash(workdir: &str) -> String {
    let path = fs::canonicalize(workdir).unwrap_or_else(|_| PathBuf::from(workdir));
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    hex[..16].to_string()
}

pub(crate) fn project_dir(workdir: &str) -> Result<PathBuf, String> {
    Ok(code_index_root_dir()?
        .join("projects")
        .join(workdir_hash(workdir)))
}

pub(crate) fn project_db_path(workdir: &str) -> Result<PathBuf, String> {
    Ok(project_dir(workdir)?.join(DB_FILENAME))
}

/// disable 删除索引目录失败（如 Windows 上句柄未释放）时落盘的标记：
/// 在场即视为已关闭——watch sink 不再对残留库做增量；enable 时清除。
const DISABLED_MARKER: &str = ".disabled";

pub(crate) fn disabled_marker_exists(workdir: &str) -> bool {
    project_dir(workdir)
        .map(|dir| dir.join(DISABLED_MARKER).exists())
        .unwrap_or(false)
}

pub(crate) fn write_disabled_marker(workdir: &str) {
    if let Ok(dir) = project_dir(workdir) {
        if dir.exists() {
            if let Err(error) = fs::write(dir.join(DISABLED_MARKER), b"") {
                eprintln!("code index: write disabled marker failed: {error}");
            }
        }
    }
}

pub(crate) fn clear_disabled_marker(workdir: &str) {
    if let Ok(dir) = project_dir(workdir) {
        let marker = dir.join(DISABLED_MARKER);
        if marker.exists() {
            if let Err(error) = fs::remove_file(&marker) {
                eprintln!("code index: clear disabled marker failed: {error}");
            }
        }
    }
}

/// 按 `.workdir.json` 记录的原始路径反查并删除索引目录。
///
/// disable 的兜底：工作区目录已从磁盘消失时，canonicalize 失败退回原始拼写，
/// hash 与 enable 时（canonical 拼写）可能不同，正常删除会落空。只做精确
/// 字符串匹配——模糊匹配有误删他人索引的风险，宁可留下孤儿。
pub(crate) fn delete_project_dirs_recorded_for(workdir: &str) {
    let Ok(root) = code_index_root_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(root.join("projects")) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let dir = entry.path();
        let marker = dir.join(".workdir.json");
        let Ok(raw) = fs::read_to_string(&marker) else {
            continue;
        };
        let recorded = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| value.get("path").and_then(|path| path.as_str().map(String::from)));
        if recorded.as_deref() == Some(workdir) {
            if let Err(error) = fs::remove_dir_all(&dir) {
                eprintln!(
                    "code index: remove recorded index dir {} failed: {error}",
                    dir.display()
                );
            }
        }
    }
}

/// 建目录并写 `.workdir.json` 反查标记（幂等；键名与 memory 的标记一致）。
pub(crate) fn ensure_project_dir(workdir: &str) -> Result<PathBuf, String> {
    let dir = project_dir(workdir)?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建代码索引目录失败：{e}"))?;
    let marker = dir.join(".workdir.json");
    if !marker.exists() {
        let payload = serde_json::json!({ "path": workdir });
        fs::write(
            &marker,
            serde_json::to_vec_pretty(&payload).unwrap_or_default(),
        )
        .map_err(|e| format!("写入代码索引 workdir 标记失败：{e}"))?;
    }
    Ok(dir)
}

pub(crate) fn db_size_bytes(db_path: &Path) -> u64 {
    ["", "-wal", "-shm"]
        .iter()
        .filter_map(|suffix| {
            fs::metadata(format!("{}{suffix}", db_path.to_string_lossy()))
                .ok()
                .map(|meta| meta.len())
        })
        .sum()
}
