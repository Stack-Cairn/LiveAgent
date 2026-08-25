//! Walker：`ignore` crate 遍历（尊重 .gitignore/.ignore）+ 内置排除 + 配额。
//! 增量判定在 service 层结合 store 完成；这里只产出候选文件清单。

use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use sha2::{Digest, Sha256};

/// 单文件上限：超过基本是生成物/数据文件，索引价值低且拖慢嵌入。
pub(crate) const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// 单仓库文件数配额（防止把 home 目录当工作区拖垮机器）。
pub(crate) const MAX_FILES: usize = 50_000;
/// 单仓库源码总量配额。
pub(crate) const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;

/// `ignore` 之外的内置排除目录（.gitignore 缺失/不全时兜底）。
const EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    "vendor",
    "Pods",
];

/// 明确的二进制/媒体扩展名，避免浪费一次 UTF-8 探测读。
const EXCLUDED_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "bmp", "tiff", "avif", "mp3", "mp4", "mov",
    "avi", "mkv", "wav", "flac", "ogg", "zip", "tar", "gz", "zst", "br", "7z", "rar", "jar",
    "class", "pyc", "wasm", "so", "dylib", "dll", "exe", "bin", "dat", "pdf", "woff", "woff2",
    "ttf", "otf", "eot", "sqlite", "sqlite3", "db", "lock", "min.js", "map",
];

#[derive(Debug, Clone)]
pub(crate) struct WalkedFile {
    /// workspace 相对路径，POSIX 分隔符。
    pub(crate) rel_path: String,
    pub(crate) abs_path: PathBuf,
    pub(crate) mtime_ms: i64,
    pub(crate) size_bytes: u64,
}

pub(crate) struct WalkOutcome {
    pub(crate) files: Vec<WalkedFile>,
}

fn extension_excluded(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    EXCLUDED_EXTENSIONS
        .iter()
        .any(|ext| name.ends_with(&format!(".{ext}")))
}

pub(crate) fn relativize(workdir: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(workdir).ok()?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() {
        None
    } else {
        Some(rel)
    }
}

/// 全量遍历。`should_cancel` 为协作式取消探针（jobs 同款）。
pub(crate) fn walk_workspace(
    workdir: &Path,
    should_cancel: &dyn Fn() -> bool,
) -> Result<WalkOutcome, String> {
    let mut files = Vec::new();
    let mut total_bytes: u64 = 0;

    let walker = WalkBuilder::new(workdir)
        .hidden(false) // 允许 .github 等点目录进入，靠 EXCLUDED_DIRS 与 gitignore 兜排除
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .follow_links(false)
        .filter_entry(|entry| {
            // depth 0 是 workdir 根自身：即使名字撞上排除表（如仓库就叫
            // build）也必须放行，否则整棵树消失。
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !EXCLUDED_DIRS.iter().any(|dir| name == *dir)
        })
        .build();

    for entry in walker {
        if should_cancel() {
            return Err(super::jobs::INDEX_CANCELLED_ERROR.to_string());
        }
        let Ok(entry) = entry else { continue };
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if extension_excluded(path) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let size = metadata.len();
        if size == 0 || size > MAX_FILE_BYTES {
            continue;
        }
        let Some(rel_path) = relativize(workdir, path) else {
            continue;
        };
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);

        total_bytes = total_bytes.saturating_add(size);
        files.push(WalkedFile {
            rel_path,
            abs_path: path.to_path_buf(),
            mtime_ms,
            size_bytes: size,
        });

        if files.len() > MAX_FILES {
            return Err(format!(
                "工作区文件数超过索引配额（{MAX_FILES}）。请用 .gitignore/.ignore 排除生成物目录后重试。"
            ));
        }
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(format!(
                "工作区源码量超过索引配额（{} MiB）。请用 .gitignore/.ignore 排除大目录后重试。",
                MAX_TOTAL_BYTES / (1024 * 1024)
            ));
        }
    }

    Ok(WalkOutcome { files })
}

/// 读文件正文；非 UTF-8（含 BOM 之外的二进制）返回 None 跳过。
pub(crate) fn read_text_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8(bytes).ok()
}

pub(crate) fn sha256_hex(input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
