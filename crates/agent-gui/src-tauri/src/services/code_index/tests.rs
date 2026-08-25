//! Chunker / walker / store 的纯逻辑测试（不触网、不依赖模型）。

use super::chunker::{chunk_source, language_for_path};

#[test]
fn language_detection_covers_first_batch() {
    assert_eq!(language_for_path("src/App.tsx"), "tsx");
    assert_eq!(language_for_path("src/main.ts"), "typescript");
    assert_eq!(language_for_path("lib/index.mjs"), "javascript");
    assert_eq!(language_for_path("src-tauri/src/lib.rs"), "rust");
    assert_eq!(language_for_path("cmd/main.go"), "go");
    assert_eq!(language_for_path("scripts/build.py"), "python");
    assert_eq!(language_for_path("App.java"), "java");
    assert_eq!(language_for_path("README.md"), "plain");
    assert_eq!(language_for_path("Makefile"), "plain");
}

#[test]
fn typescript_function_becomes_syntax_chunk() {
    let source = r#"import { x } from "./x";

export function computeTotal(items: number[]): number {
  let total = 0;
  for (const item of items) {
    total += item;
  }
  return total;
}
"#;
    let chunks = chunk_source("src/total.ts", "typescript", source);
    let function_chunk = chunks
        .iter()
        .find(|chunk| chunk.kind == "function")
        .expect("expected a function chunk");
    assert_eq!(function_chunk.symbol, "computeTotal");
    assert!(function_chunk.content.contains("computeTotal"));
    assert!(function_chunk
        .content
        .starts_with("// src/total.ts:3 computeTotal"));
    assert_eq!(function_chunk.start_line, 3);
    assert_eq!(function_chunk.end_line, 9);
}

#[test]
fn rust_impl_methods_get_their_own_chunks() {
    let source = r#"pub struct Counter {
    value: i64,
}

impl Counter {
    pub fn increment(&mut self) {
        self.value += 1;
        self.value += 0;
    }

    pub fn reset(&mut self) {
        self.value = 0;
        self.value += 0;
    }
}
"#;
    let chunks = chunk_source("src/counter.rs", "rust", source);
    let symbols: Vec<&str> = chunks.iter().map(|chunk| chunk.symbol.as_str()).collect();
    assert!(
        symbols.contains(&"Counter"),
        "impl block chunk: {symbols:?}"
    );
    assert!(
        symbols.contains(&"increment") && symbols.contains(&"reset"),
        "methods should be independent chunks: {symbols:?}"
    );
}

#[test]
fn plain_text_falls_back_to_windows() {
    let lines: Vec<String> = (1..=200)
        .map(|index| format!("line number {index}"))
        .collect();
    let source = lines.join("\n");
    let chunks = chunk_source("notes.txt", "plain", &source);
    assert!(
        chunks.len() >= 2,
        "200 lines should produce multiple windows"
    );
    assert!(chunks.iter().all(|chunk| chunk.kind == "window"));
    // 相邻窗口应有重叠。
    assert!(chunks[1].start_line < chunks[0].end_line);
}

#[test]
fn empty_source_produces_no_chunks() {
    assert!(chunk_source("empty.ts", "typescript", "").is_empty());
}

mod store_tests {
    use crate::services::code_index::chunker::CodeChunk;
    use crate::services::code_index::schema::open_code_index_connection;

    fn sample_chunk(start: u32, end: u32, symbol: &str, content: &str) -> CodeChunk {
        CodeChunk {
            start_line: start,
            end_line: end,
            kind: "function",
            symbol: symbol.to_string(),
            content: content.to_string(),
        }
    }

    /// 直接在临时目录上验证 schema + FTS 写读闭环（不经 service 单例）。
    #[test]
    fn schema_roundtrip_with_fts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("code-index.sqlite3");
        let conn = open_code_index_connection(&db_path).expect("open");

        conn.execute(
            "INSERT INTO files (path, mtime_ms, size_bytes, content_hash, language, indexed_at)
             VALUES ('src/a.ts', 1, 10, 'hash', 'typescript', 1)",
            [],
        )
        .expect("insert file");
        let file_id = conn.last_insert_rowid();
        let chunk = sample_chunk(
            1,
            5,
            "loadConfig",
            "function loadConfig() { return readFile(); }",
        );
        conn.execute(
            "INSERT INTO chunks (file_id, start_line, end_line, kind, symbol)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                file_id,
                chunk.start_line,
                chunk.end_line,
                chunk.kind,
                chunk.symbol
            ],
        )
        .expect("insert chunk");
        let chunk_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO chunks_fts (content, symbol, path, chunk_id) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![chunk.content, chunk.symbol, "src/a.ts", chunk_id],
        )
        .expect("insert fts");

        let hit: i64 = conn
            .query_row(
                "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH '\"loadConfig\"'",
                [],
                |row| row.get(0),
            )
            .expect("fts hit");
        assert_eq!(hit, chunk_id);
    }

    /// sqlite-vec 扩展注册生效：vec0 虚表可插可查（KNN）。
    #[test]
    fn vec_extension_knn_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("code-index.sqlite3");
        let conn = open_code_index_connection(&db_path).expect("open");

        let make_vec = |seed: f32| -> Vec<u8> {
            let mut bytes = Vec::new();
            for index in 0..384u32 {
                let value = if index == 0 {
                    seed
                } else {
                    0.001 * index as f32
                };
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes
        };
        conn.execute(
            "INSERT INTO chunks_vec (rowid, embedding) VALUES (1, ?1)",
            [make_vec(1.0)],
        )
        .expect("insert vec 1");
        conn.execute(
            "INSERT INTO chunks_vec (rowid, embedding) VALUES (2, ?1)",
            [make_vec(-1.0)],
        )
        .expect("insert vec 2");

        let nearest: i64 = conn
            .query_row(
                "SELECT rowid FROM chunks_vec WHERE embedding MATCH ?1 AND k = 1",
                [make_vec(0.9)],
                |row| row.get(0),
            )
            .expect("knn");
        assert_eq!(nearest, 1);
    }
}

mod pipeline_tests {
    use std::fs;

    use crate::services::code_index::chunker::{chunk_source, language_for_path};
    use crate::services::code_index::search;
    use crate::services::code_index::store::CodeIndexStore;
    use crate::services::code_index::types::CodeIndexSearchArgs;
    use crate::services::code_index::walker::sha256_hex;

    /// 切块 → replace_file → 词法检索 → remove_file 全链路（语义路留空，
    /// 不依赖 embedding 模型）。片段现读，所以源文件要真实落盘。
    #[test]
    fn chunk_store_search_remove_roundtrip() {
        let workdir = tempfile::tempdir().expect("workdir");
        let source = r#"export function resolveRetryPolicy(attempt: number): number {
  const base = 200;
  const jitter = Math.random() * 50;
  return base * 2 ** attempt + jitter;
}

export function unrelatedHelper(): void {
  console.log("nothing to see");
}
"#;
        let rel_path = "src/retry.ts";
        let abs_path = workdir.path().join(rel_path);
        fs::create_dir_all(abs_path.parent().unwrap()).expect("mkdir");
        fs::write(&abs_path, source).expect("write source");

        let db_dir = tempfile::tempdir().expect("db dir");
        let store = CodeIndexStore::open_at(
            workdir.path().to_str().unwrap(),
            db_dir.path().join("code-index.sqlite3"),
        )
        .expect("open store");

        let language = language_for_path(rel_path);
        let chunks = chunk_source(rel_path, language, source);
        assert!(chunks
            .iter()
            .any(|chunk| chunk.symbol == "resolveRetryPolicy"));
        store
            .replace_file(
                rel_path,
                1,
                source.len() as u64,
                &sha256_hex(source.as_bytes()),
                language,
                &chunks,
                &[],
            )
            .expect("replace_file");

        let (file_count, chunk_count, _) = store.stats().expect("stats");
        assert_eq!(file_count, 1);
        assert_eq!(chunk_count, chunks.len() as u64);

        let response = search::search(
            &store,
            &CodeIndexSearchArgs {
                workdir: store.workdir.clone(),
                query: "resolveRetryPolicy".to_string(),
                mode: Some("lexical".to_string()),
                path: None,
                max_results: None,
            },
        )
        .expect("search");
        assert_eq!(response.mode, "lexical");
        let top = response.matches.first().expect("top match");
        assert_eq!(top.path, rel_path);
        assert_eq!(top.symbol, "resolveRetryPolicy");
        assert!(
            top.snippet.contains("resolveRetryPolicy"),
            "snippet reads from disk"
        );

        // 路径前缀过滤：不匹配的前缀应过滤掉全部结果。
        let filtered = search::search(
            &store,
            &CodeIndexSearchArgs {
                workdir: store.workdir.clone(),
                query: "resolveRetryPolicy".to_string(),
                mode: Some("lexical".to_string()),
                path: Some("other/".to_string()),
                max_results: None,
            },
        )
        .expect("filtered search");
        assert!(filtered.matches.is_empty());

        // 重索引同一文件不产生重复行。
        store
            .replace_file(
                rel_path,
                2,
                source.len() as u64,
                &sha256_hex(source.as_bytes()),
                language,
                &chunks,
                &[],
            )
            .expect("replace again");
        let (_, chunk_count_after, _) = store.stats().expect("stats after");
        assert_eq!(chunk_count_after, chunks.len() as u64);

        store.remove_file(rel_path).expect("remove_file");
        let (file_count, chunk_count, _) = store.stats().expect("stats after remove");
        assert_eq!(file_count, 0);
        assert_eq!(chunk_count, 0);
        let empty = search::search(
            &store,
            &CodeIndexSearchArgs {
                workdir: store.workdir.clone(),
                query: "resolveRetryPolicy".to_string(),
                mode: Some("lexical".to_string()),
                path: None,
                max_results: None,
            },
        )
        .expect("search after remove");
        assert!(empty.matches.is_empty());
    }
}
