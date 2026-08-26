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

#[test]
fn cjk_heavy_windows_truncate_on_char_boundary_without_panic() {
    // 80 行 × 90 个 3 字节汉字 ≫ 6000 字节：截断点大概率落在多字节字符
    // 中间，回归 String::truncate 的 char boundary panic。
    let line = "设".repeat(90);
    let source = vec![line.as_str(); 200].join("\n");
    let chunks = chunk_source("docs/design.md", "plain", &source);
    assert!(!chunks.is_empty());
    for chunk in &chunks {
        assert!(chunk.content.len() <= 6_100, "chunk stays bounded");
        // 内容仍是合法 UTF-8 由 String 类型保证；只需确认没 panic 且非空。
        assert!(!chunk.content.trim().is_empty());
    }
}

#[test]
fn tiny_files_still_get_indexed() {
    // 1–2 行短文件低于碎片阈值，但整文件必须仍可检索。
    let chunks = chunk_source("VERSION", "plain", "1.2.3");
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].content.contains("1.2.3"));
}

#[test]
fn windows_verbatim_prefix_is_stripped_from_normalized_workdir() {
    use std::path::Path;

    use crate::services::code_index::service::strip_windows_verbatim_prefix;

    // verbatim 语义下 '/' 不是分隔符，与 POSIX 相对路径 join 后 stat 必败——
    // 归一化输出必须回到 Win32 常规拼写。
    assert_eq!(
        strip_windows_verbatim_prefix(Path::new(r"\\?\C:\ws")),
        r"C:\ws"
    );
    assert_eq!(
        strip_windows_verbatim_prefix(Path::new(r"\\?\UNC\server\share\ws")),
        r"\\server\share\ws"
    );
    assert_eq!(
        strip_windows_verbatim_prefix(Path::new("/Users/dev/ws")),
        "/Users/dev/ws"
    );
}

mod walker_tests {
    use std::collections::BTreeSet;
    use std::fs;

    use crate::services::code_index::walker::{walk_workspace, WatchPathFilter};

    #[test]
    fn walking_missing_root_is_an_error_not_an_empty_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("gone");
        let result = walk_workspace(&missing, &|| false);
        assert!(result.is_err(), "missing root must not look like empty repo");
    }

    /// 非 git 目录同样尊重 .gitignore（require_git(false)）：隐私优先，且与
    /// watch 增量的过滤行为一致（否则会出现 job 收录、watch 排除的振荡）。
    #[test]
    fn walk_honors_gitignore_without_git_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join(".gitignore"), ".env\n").expect("gitignore");
        fs::write(dir.path().join(".env"), "SECRET=1\n").expect("env");
        fs::write(dir.path().join("kept.txt"), "hello\n").expect("kept");
        let outcome = walk_workspace(dir.path(), &|| false).expect("walk");
        let paths: Vec<&str> = outcome
            .files
            .iter()
            .map(|file| file.rel_path.as_str())
            .collect();
        assert!(!paths.contains(&".env"), "gitignored secret excluded: {paths:?}");
        assert!(paths.contains(&"kept.txt"));
    }

    #[test]
    fn watch_filter_applies_gitignore_and_builtin_excludes() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join(".gitignore"), ".env\nsecrets/\n").expect("gitignore");
        fs::create_dir_all(dir.path().join("src")).expect("mkdir");

        let mut rel_paths = BTreeSet::new();
        for path in [".env", "secrets/key.pem", "node_modules/x.js", "a.png", "src/main.rs"] {
            rel_paths.insert(path.to_string());
        }
        let filter = WatchPathFilter::new(dir.path(), &rel_paths);
        assert!(!filter.allows(".env"), "gitignored secret file");
        assert!(!filter.allows("secrets/key.pem"), "gitignored directory");
        assert!(!filter.allows("node_modules/x.js"), "builtin excluded dir");
        assert!(!filter.allows("a.png"), "excluded extension");
        assert!(filter.allows("src/main.rs"), "normal source file");
    }

    #[test]
    fn watch_filter_respects_nested_gitignore() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(dir.path().join("sub")).expect("mkdir");
        fs::write(dir.path().join("sub/.gitignore"), "generated/\n").expect("nested gitignore");

        let mut rel_paths = BTreeSet::new();
        rel_paths.insert("sub/generated/out.ts".to_string());
        rel_paths.insert("sub/src.ts".to_string());
        let filter = WatchPathFilter::new(dir.path(), &rel_paths);
        assert!(!filter.allows("sub/generated/out.ts"));
        assert!(filter.allows("sub/src.ts"));
    }

    /// 同批次变更横跨多个各带 .gitignore 的兄弟目录：matcher 只能应用于自己
    /// 根下的路径（matched_path_or_any_parents 对根外路径 assert panic）。
    #[test]
    fn watch_filter_handles_sibling_dirs_with_own_gitignores() {
        let dir = tempfile::tempdir().expect("tempdir");
        for sub in ["a", "b"] {
            fs::create_dir_all(dir.path().join(sub)).expect("mkdir");
        }
        fs::write(dir.path().join("a/.gitignore"), "ignored-a.ts\n").expect("gitignore a");
        fs::write(dir.path().join("b/.gitignore"), "ignored-b.ts\n").expect("gitignore b");

        let mut rel_paths = BTreeSet::new();
        rel_paths.insert("a/ignored-a.ts".to_string());
        rel_paths.insert("b/kept.ts".to_string());
        let filter = WatchPathFilter::new(dir.path(), &rel_paths);
        assert!(!filter.allows("a/ignored-a.ts"));
        assert!(!filter.allows("b/ignored-b.ts"));
        assert!(filter.allows("a/kept.ts"));
        assert!(filter.allows("b/kept.ts"));
    }
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

    /// 路径过滤按目录边界：`src` 不得吞掉 `src2/`。
    #[test]
    fn path_prefix_filter_respects_directory_boundary() {
        let workdir = tempfile::tempdir().expect("workdir");
        let write_source = |rel: &str| {
            let abs = workdir.path().join(rel);
            fs::create_dir_all(abs.parent().unwrap()).expect("mkdir");
            let source = format!(
                "export function marker_{}(): void {{\n  console.log(\"shared_marker\");\n  console.log(\"tail\");\n}}\n",
                rel.replace(['/', '.'], "_")
            );
            fs::write(&abs, &source).expect("write");
            source
        };
        let db_dir = tempfile::tempdir().expect("db dir");
        let store = CodeIndexStore::open_at(
            workdir.path().to_str().unwrap(),
            db_dir.path().join("code-index.sqlite3"),
        )
        .expect("open store");
        for rel in ["src/a.ts", "src2/b.ts"] {
            let source = write_source(rel);
            let chunks = chunk_source(rel, language_for_path(rel), &source);
            store
                .replace_file(rel, 1, source.len() as u64, &sha256_hex(source.as_bytes()), "typescript", &chunks, &[])
                .expect("replace_file");
        }

        let response = search::search(
            &store,
            &CodeIndexSearchArgs {
                workdir: store.workdir.clone(),
                query: "shared_marker".to_string(),
                mode: Some("lexical".to_string()),
                path: Some("src".to_string()),
                max_results: None,
            },
        )
        .expect("filtered search");
        assert!(!response.matches.is_empty());
        assert!(
            response.matches.iter().all(|m| m.path.starts_with("src/")),
            "src2/ must not leak into src filter: {:?}",
            response.matches.iter().map(|m| m.path.as_str()).collect::<Vec<_>>()
        );

        // "./"、"." 归一为无过滤（空串前缀进 SQL 会一条都匹配不上）。
        for noop_filter in ["./", ".", "/"] {
            let unfiltered = search::search(
                &store,
                &CodeIndexSearchArgs {
                    workdir: store.workdir.clone(),
                    query: "shared_marker".to_string(),
                    mode: Some("lexical".to_string()),
                    path: Some(noop_filter.to_string()),
                    max_results: None,
                },
            )
            .expect("noop-filtered search");
            assert_eq!(
                unfiltered.matches.len(),
                2,
                "'{noop_filter}' should behave as no filter"
            );
        }
    }

    /// 目录删除/重命名后按前缀清幽灵行；变空文件也清旧块。
    #[test]
    fn directory_prefix_removal_clears_ghost_rows() {
        let db_dir = tempfile::tempdir().expect("db dir");
        let store = CodeIndexStore::open_at("/tmp/ghost-ws", db_dir.path().join("code-index.sqlite3"))
            .expect("open store");
        let chunk = crate::services::code_index::chunker::CodeChunk {
            start_line: 1,
            end_line: 3,
            kind: "function",
            symbol: "f".to_string(),
            content: "function f() { legacy_marker(); }".to_string(),
        };
        for rel in ["src/legacy/a.ts", "src/legacy/deep/b.ts", "src/live.ts", "src/legacy.ts"] {
            store
                .replace_file(rel, 1, 10, "hash", "typescript", std::slice::from_ref(&chunk), &[])
                .expect("replace_file");
        }
        let removed = store.remove_files_under_dir("src/legacy").expect("remove prefix");
        assert_eq!(removed, 2, "only files under src/legacy/ removed");
        let (file_count, chunk_count, _) = store.stats().expect("stats");
        assert_eq!(file_count, 2, "src/live.ts and src/legacy.ts survive");
        assert_eq!(chunk_count, 2);
    }

    /// 词法降级期入库的文件计入缺向量统计；带向量入库则不计。
    #[test]
    fn vectorless_files_are_tracked_for_backfill() {
        let db_dir = tempfile::tempdir().expect("db dir");
        let store = CodeIndexStore::open_at("/tmp/vec-ws", db_dir.path().join("code-index.sqlite3"))
            .expect("open store");
        let chunk = crate::services::code_index::chunker::CodeChunk {
            start_line: 1,
            end_line: 3,
            kind: "function",
            symbol: "f".to_string(),
            content: "function f() {}".to_string(),
        };
        store
            .replace_file("lex.ts", 1, 10, "h1", "typescript", std::slice::from_ref(&chunk), &[])
            .expect("lexical-only file");
        let embedding = vec![vec![0.5f32; 384]];
        store
            .replace_file("vec.ts", 1, 10, "h2", "typescript", std::slice::from_ref(&chunk), &embedding)
            .expect("embedded file");
        assert_eq!(store.vectorless_file_count().expect("count"), 1);
        assert!(store.file_meta("vec.ts").expect("meta").expect("row").has_vectors);
        assert!(!store.file_meta("lex.ts").expect("meta").expect("row").has_vectors);
        // 同文件补上向量后不再计数（回填路径）。
        store
            .replace_file("lex.ts", 2, 10, "h1b", "typescript", std::slice::from_ref(&chunk), &embedding)
            .expect("backfill");
        assert_eq!(store.vectorless_file_count().expect("count"), 0);
    }
}
