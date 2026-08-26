//! 混合检索：FTS5 BM25（词法路）+ sqlite-vec KNN（语义路）→ RRF 融合。
//! 片段现读文件（索引可能落后磁盘几秒，现读保证与真实内容一致）。

use std::collections::HashMap;
use std::path::Path;

use rusqlite::params;

use super::embedder;
use super::store::{embedding_bytes, escape_like, CodeIndexStore};
use super::types::{CodeIndexSearchArgs, CodeIndexSearchMatch, CodeIndexSearchResponse};

/// 每路候选数：融合前 top-K。
const PER_ROUTE_LIMIT: usize = 50;
/// RRF 经典常数。
const RRF_K: f64 = 60.0;
const DEFAULT_RESULTS: usize = 8;
const MAX_RESULTS: usize = 20;
/// 返回片段的字符截断上限。
const SNIPPET_MAX_CHARS: usize = 1_200;

struct ChunkRow {
    chunk_id: i64,
    path: String,
    start_line: u32,
    end_line: u32,
    kind: String,
    symbol: String,
}

pub(crate) fn search(
    store: &CodeIndexStore,
    args: &CodeIndexSearchArgs,
) -> Result<CodeIndexSearchResponse, String> {
    let query = args.query.trim();
    if query.is_empty() {
        return Err("query 不能为空".to_string());
    }
    let requested_mode = match args.mode.as_deref() {
        None | Some("hybrid") => "hybrid",
        Some("semantic") => "semantic",
        Some("lexical") => "lexical",
        Some(other) => {
            return Err(format!(
                "未知检索模式：{other}（可选 hybrid/semantic/lexical）"
            ))
        }
    };
    let limit = args
        .max_results
        .unwrap_or(DEFAULT_RESULTS)
        .clamp(1, MAX_RESULTS);
    let path_prefix = args
        .path
        .as_deref()
        .map(str::trim)
        .map(|value| {
            value
                .trim_start_matches("./")
                .trim_end_matches('/')
                .to_string()
        })
        // "./"、"/"、"." 都归一为“无过滤”——归一后的空串若进入 SQL 会变成
        // `path = '' OR LIKE '/%'`，一条都匹配不上。
        .filter(|value| !value.is_empty() && value != ".");

    // 语义路可用性判定：非阻塞探测——模型在下载/加载中也立即降级词法返回，
    // 绝不让检索挂在首启的模型下载上。
    let mut degraded = None;
    let semantic_wanted = requested_mode != "lexical";
    let availability = embedder::availability();
    let mut semantic_active =
        semantic_wanted && matches!(availability, embedder::EmbedderAvailability::Ready);
    if semantic_wanted && !semantic_active {
        let reason = match availability {
            embedder::EmbedderAvailability::Initializing => {
                "embedding 模型正在准备（首次使用需下载）".to_string()
            }
            embedder::EmbedderAvailability::Unavailable(reason) => reason,
            embedder::EmbedderAvailability::Ready => unreachable!(),
        };
        if requested_mode == "semantic" {
            // 错误直达模型（Agent）：给出可操作的重试路径，别让它撞死在 semantic 上。
            return Err(format!(
                "语义检索不可用：{reason}。可改用 hybrid 或 lexical 模式重试"
            ));
        }
        degraded = Some(format!("语义路不可用，已降级纯词法检索：{reason}"));
    }
    // 词法降级期入库的文件没有向量：语义结果对它们是盲的，如实告知
    //（回填由 service 层的检索自愈按节流安排，不保证本次已触发）。
    if semantic_active {
        let vectorless = store.vectorless_file_count()?;
        if vectorless > 0 {
            degraded = Some(format!(
                "{vectorless} 个文件尚无语义向量（索引早于模型就绪），本次语义命中可能不完整；待后台回填或手动重建补齐"
            ));
        }
    }

    // 两路各自产出 chunk_id 的有序候选（rank 从 0 起）。
    let lexical_ranked: Vec<i64> = if requested_mode != "semantic" {
        lexical_route(store, query, path_prefix.as_deref())?
    } else {
        Vec::new()
    };
    let semantic_ranked: Vec<i64> = if semantic_active {
        match semantic_route(store, query, path_prefix.as_deref()) {
            Ok(ranked) => ranked,
            Err(error) if requested_mode == "semantic" => {
                return Err(format!(
                    "语义检索不可用：{error}。可改用 hybrid 或 lexical 模式重试"
                ))
            }
            Err(error) => {
                // hybrid 下语义路临时失败（如模型被索引批量占用超时）：降级词法。
                degraded = Some(format!("语义路本次不可用，已降级纯词法检索：{error}"));
                semantic_active = false;
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let effective_mode = if semantic_active {
        requested_mode
    } else {
        "lexical"
    };

    // RRF：score(c) = Σ_r 1 / (RRF_K + rank_r(c))。
    let mut scores: HashMap<i64, (f64, bool, bool)> = HashMap::new();
    for (rank, chunk_id) in lexical_ranked.iter().enumerate() {
        let entry = scores.entry(*chunk_id).or_insert((0.0, false, false));
        entry.0 += 1.0 / (RRF_K + rank as f64);
        entry.1 = true;
    }
    for (rank, chunk_id) in semantic_ranked.iter().enumerate() {
        let entry = scores.entry(*chunk_id).or_insert((0.0, false, false));
        entry.0 += 1.0 / (RRF_K + rank as f64);
        entry.2 = true;
    }

    let mut ranked: Vec<(i64, f64, bool, bool)> = scores
        .into_iter()
        .map(|(chunk_id, (score, lexical, semantic))| (chunk_id, score, lexical, semantic))
        .collect();
    // 同分按 chunk_id 决胜，保证结果顺序确定（HashMap 迭代序不稳定）。
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    ranked.truncate(limit);

    let rows = load_chunk_rows(store, ranked.iter().map(|item| item.0))?;
    let workdir = Path::new(&store.workdir);
    let matches = ranked
        .into_iter()
        .filter_map(|(chunk_id, score, lexical, semantic)| {
            let row = rows.get(&chunk_id)?;
            Some(CodeIndexSearchMatch {
                path: row.path.clone(),
                start_line: row.start_line,
                end_line: row.end_line,
                kind: row.kind.clone(),
                symbol: row.symbol.clone(),
                snippet: read_snippet(workdir, &row.path, row.start_line, row.end_line),
                score,
                source: match (lexical, semantic) {
                    (true, true) => "both",
                    (true, false) => "lexical",
                    _ => "semantic",
                }
                .to_string(),
            })
        })
        .collect();

    Ok(CodeIndexSearchResponse {
        matches,
        mode: effective_mode.to_string(),
        degraded,
    })
}

/// FTS5 词法路。查询词逐词加引号转义（memory-index 同款），OR 连接：
/// 代码检索里“任一词命中”召回优先，排序交给 bm25。
/// 路径过滤按目录边界：`src` 命中 `src/**` 与文件 `src` 本身，不吞 `src2/`。
fn lexical_route(
    store: &CodeIndexStore,
    query: &str,
    path_prefix: Option<&str>,
) -> Result<Vec<i64>, String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(quote_fts_term)
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let match_expr = terms.join(" OR ");
    let conn = store.lock_conn()?;
    match path_prefix {
        Some(prefix) => {
            let like = format!("{}/%", escape_like(prefix));
            let mut stmt = conn
                .prepare(
                    "SELECT chunk_id, bm25(chunks_fts) AS score FROM chunks_fts
                     WHERE chunks_fts MATCH ?1
                       AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')
                     ORDER BY score LIMIT ?4",
                )
                .map_err(|e| format!("准备词法检索失败：{e}"))?;
            let rows = stmt
                .query_map(
                    params![match_expr, prefix, like, PER_ROUTE_LIMIT as i64],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|e| format!("词法检索失败：{e}"))?
                .collect::<Result<Vec<_>, _>>();
            rows.map_err(|e| format!("读取词法检索结果失败：{e}"))
        }
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT chunk_id, bm25(chunks_fts) AS score FROM chunks_fts
                     WHERE chunks_fts MATCH ?1
                     ORDER BY score LIMIT ?2",
                )
                .map_err(|e| format!("准备词法检索失败：{e}"))?;
            let rows = stmt
                .query_map(params![match_expr, PER_ROUTE_LIMIT as i64], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|e| format!("词法检索失败：{e}"))?
                .collect::<Result<Vec<_>, _>>();
            rows.map_err(|e| format!("读取词法检索结果失败：{e}"))
        }
    }
}

/// sqlite-vec 语义路。vec0 的 KNN 语法：`embedding MATCH ? AND k = ?`。
/// 路径过滤在 KNN 之后 JOIN 过滤（vec0 不支持 WHERE 前置过滤），k 放大补偿。
fn semantic_route(
    store: &CodeIndexStore,
    query: &str,
    path_prefix: Option<&str>,
) -> Result<Vec<i64>, String> {
    let query_embedding = embedder::embed_query(query)?;
    let k = if path_prefix.is_some() {
        PER_ROUTE_LIMIT * 4
    } else {
        PER_ROUTE_LIMIT
    };
    let conn = store.lock_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT chunks_vec.rowid, distance FROM chunks_vec
             WHERE embedding MATCH ?1 AND k = ?2
             ORDER BY distance",
        )
        .map_err(|e| format!("准备语义检索失败：{e}"))?;
    let candidates: Vec<i64> = stmt
        .query_map(
            params![embedding_bytes(&query_embedding), k as i64],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("语义检索失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取语义检索结果失败：{e}"))?;

    let Some(prefix) = path_prefix else {
        return Ok(candidates);
    };
    // 后置路径过滤：按候选顺序保留命中前缀的块（目录边界语义同词法路）。
    let like = format!("{}/%", escape_like(prefix));
    let mut filtered = Vec::new();
    let mut path_stmt = conn
        .prepare(
            "SELECT 1 FROM chunks JOIN files ON files.id = chunks.file_id
             WHERE chunks.id = ?1
               AND (files.path = ?2 OR files.path LIKE ?3 ESCAPE '\\')",
        )
        .map_err(|e| format!("准备语义路径过滤失败：{e}"))?;
    for chunk_id in candidates {
        let hit: Option<i64> = path_stmt
            .query_row(params![chunk_id, prefix, like], |row| row.get(0))
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("语义路径过滤失败：{other}")),
            })?;
        if hit.is_some() {
            filtered.push(chunk_id);
            if filtered.len() >= PER_ROUTE_LIMIT {
                break;
            }
        }
    }
    Ok(filtered)
}

fn load_chunk_rows(
    store: &CodeIndexStore,
    chunk_ids: impl Iterator<Item = i64>,
) -> Result<HashMap<i64, ChunkRow>, String> {
    let conn = store.lock_conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT chunks.id, files.path, chunks.start_line, chunks.end_line,
                    chunks.kind, chunks.symbol
             FROM chunks JOIN files ON files.id = chunks.file_id
             WHERE chunks.id = ?1",
        )
        .map_err(|e| format!("准备代码块查询失败：{e}"))?;
    let mut rows = HashMap::new();
    for chunk_id in chunk_ids {
        let row = stmt
            .query_row([chunk_id], |row| {
                Ok(ChunkRow {
                    chunk_id: row.get(0)?,
                    path: row.get(1)?,
                    start_line: row.get::<_, i64>(2)? as u32,
                    end_line: row.get::<_, i64>(3)? as u32,
                    kind: row.get(4)?,
                    symbol: row.get(5)?,
                })
            })
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("读取代码块失败：{other}")),
            })?;
        if let Some(row) = row {
            rows.insert(row.chunk_id, row);
        }
    }
    Ok(rows)
}

/// 现读片段：索引落后磁盘时行号可能越界，尽力而为，读不到返回空串。
fn read_snippet(workdir: &Path, rel_path: &str, start_line: u32, end_line: u32) -> String {
    let abs = workdir.join(rel_path);
    let Some(content) = super::walker::read_text_file(&abs) else {
        return String::new();
    };
    let lines: Vec<&str> = content.lines().collect();
    let start = (start_line as usize).saturating_sub(1);
    if start >= lines.len() {
        return String::new();
    }
    let end = (end_line as usize).min(lines.len());
    let mut snippet = lines[start..end].join("\n");
    if snippet.len() > SNIPPET_MAX_CHARS {
        // 按字符边界截断，避免切在 UTF-8 中间。
        let mut cut = SNIPPET_MAX_CHARS;
        while cut > 0 && !snippet.is_char_boundary(cut) {
            cut -= 1;
        }
        snippet.truncate(cut);
        snippet.push_str("\n…");
    }
    snippet
}

/// FTS5 词转义：双引号包裹 + 内部引号翻倍（memory-index 同款），防 MATCH 注入。
fn quote_fts_term(term: &str) -> String {
    let escaped = term.replace('"', "\"\"");
    format!("\"{escaped}\"")
}
