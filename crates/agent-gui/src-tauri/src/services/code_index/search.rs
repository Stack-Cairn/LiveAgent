//! 混合检索：FTS5 BM25（词法路）+ sqlite-vec KNN（语义路）→ RRF 融合。
//! 片段现读文件（索引可能落后磁盘几秒，现读保证与真实内容一致）。

use std::collections::HashMap;
use std::path::Path;

use rusqlite::params;

use super::embedder;
use super::store::{embedding_bytes, CodeIndexStore};
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
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .trim_start_matches("./")
                .trim_end_matches('/')
                .to_string()
        });

    // 语义路可用性判定：请求了语义/混合但模型不可用 → 降级并说明。
    let mut degraded = None;
    let semantic_wanted = requested_mode != "lexical";
    let semantic_active = semantic_wanted && embedder::embedder_available();
    if semantic_wanted && !semantic_active {
        let reason =
            embedder::embedder_error().unwrap_or_else(|| "embedding 模型未就绪".to_string());
        if requested_mode == "semantic" {
            return Err(format!("语义检索不可用：{reason}"));
        }
        degraded = Some(format!("语义路不可用，已降级纯词法检索：{reason}"));
    }
    let effective_mode = if semantic_active {
        requested_mode
    } else {
        "lexical"
    };

    // 两路各自产出 chunk_id 的有序候选（rank 从 0 起）。
    let lexical_ranked: Vec<i64> = if effective_mode != "semantic" {
        lexical_route(store, query, path_prefix.as_deref())?
    } else {
        Vec::new()
    };
    let semantic_ranked: Vec<i64> = if effective_mode != "lexical" {
        semantic_route(store, query, path_prefix.as_deref())?
    } else {
        Vec::new()
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
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
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
    let (sql, use_prefix) = match path_prefix {
        Some(_) => (
            "SELECT chunk_id, bm25(chunks_fts) AS score FROM chunks_fts
             WHERE chunks_fts MATCH ?1 AND path LIKE ?2 ESCAPE '\\'
             ORDER BY score LIMIT ?3",
            true,
        ),
        None => (
            "SELECT chunk_id, bm25(chunks_fts) AS score FROM chunks_fts
             WHERE chunks_fts MATCH ?1
             ORDER BY score LIMIT ?2",
            false,
        ),
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("准备词法检索失败：{e}"))?;
    let map_row = |row: &rusqlite::Row<'_>| row.get::<_, i64>(0);
    let rows = if use_prefix {
        let like = format!("{}%", escape_like(path_prefix.unwrap_or_default()));
        stmt.query_map(params![match_expr, like, PER_ROUTE_LIMIT as i64], map_row)
            .map_err(|e| format!("词法检索失败：{e}"))?
            .collect::<Result<Vec<_>, _>>()
    } else {
        stmt.query_map(params![match_expr, PER_ROUTE_LIMIT as i64], map_row)
            .map_err(|e| format!("词法检索失败：{e}"))?
            .collect::<Result<Vec<_>, _>>()
    };
    rows.map_err(|e| format!("读取词法检索结果失败：{e}"))
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
    // 后置路径过滤：按候选顺序保留命中前缀的块。
    let like = format!("{}%", escape_like(prefix));
    let mut filtered = Vec::new();
    let mut path_stmt = conn
        .prepare(
            "SELECT 1 FROM chunks JOIN files ON files.id = chunks.file_id
             WHERE chunks.id = ?1 AND files.path LIKE ?2 ESCAPE '\\'",
        )
        .map_err(|e| format!("准备语义路径过滤失败：{e}"))?;
    for chunk_id in candidates {
        let hit: Option<i64> = path_stmt
            .query_row(params![chunk_id, like], |row| row.get(0))
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

/// LIKE 通配符转义（前缀过滤输入来自模型参数，防御 % 与 _）。
fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
