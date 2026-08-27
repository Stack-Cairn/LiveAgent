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

mod cjk_fts_tests {
    use crate::services::code_index::store::segment_cjk_for_fts;

    /// 纯 ASCII 快路径零拷贝：绝大多数代码块不付切分代价。
    #[test]
    fn ascii_text_passes_through_unchanged() {
        let text = "function loadConfig() { return readFile(); }";
        assert!(matches!(
            segment_cjk_for_fts(text),
            std::borrow::Cow::Borrowed(_)
        ));
        assert_eq!(segment_cjk_for_fts(text).as_ref(), text);
    }

    /// CJK 连续段展开为重叠 bigram；单字段保留单字。
    #[test]
    fn cjk_runs_become_overlapping_bigrams() {
        assert_eq!(segment_cjk_for_fts("监听失效").as_ref().trim(), "监听 听失 失效");
        assert_eq!(segment_cjk_for_fts("锁").as_ref().trim(), "锁");
        // 混排：ASCII 标识符原样保留，CJK 段独立切分。
        let mixed = segment_cjk_for_fts("调用notifyWorkspace后失效");
        let terms: Vec<&str> = mixed.split_whitespace().collect();
        assert_eq!(terms, ["调用", "notifyWorkspace", "后失", "失效"]);
    }

    /// 日文假名与谚文同样参与 bigram（跨语言词法路的最低保障）。
    #[test]
    fn kana_and_hangul_are_segmented() {
        let kana = segment_cjk_for_fts("インデックス");
        assert!(kana.split_whitespace().count() >= 2, "katakana bigrams: {kana}");
        let hangul = segment_cjk_for_fts("인덱스");
        assert!(hangul.split_whitespace().count() >= 2, "hangul bigrams: {hangul}");
    }
}

mod semantic_threshold_tests {
    use crate::services::code_index::search::{
        filter_semantic_candidates, SEMANTIC_GATE_DISTANCE, SEMANTIC_TAIL_DELTA,
    };

    /// 两级门控：best 过门 → 保留 best+delta 邻域截远尾；best 不过门 →
    /// 整路空（垃圾查询不凑 top-k）；空输入安全。
    #[test]
    fn candidates_beyond_threshold_are_dropped() {
        // best=0.50 过门，邻域 [0.50, 0.50+delta]；0.70 在界内，0.66? 看 delta。
        let kept = filter_semantic_candidates(vec![
            (1, 0.50),
            (2, 0.50 + SEMANTIC_TAIL_DELTA),
            (3, 0.50 + SEMANTIC_TAIL_DELTA + 0.01),
            (4, 1.20),
        ]);
        assert_eq!(kept, vec![1, 2], "tail beyond best+delta is dropped");

        // 垃圾查询：best 本身超过门槛 → 全空。
        let garbage = filter_semantic_candidates(vec![
            (9, SEMANTIC_GATE_DISTANCE + 0.02),
            (8, SEMANTIC_GATE_DISTANCE + 0.03),
        ]);
        assert!(garbage.is_empty(), "meaningless query must not fill top-k");

        assert!(filter_semantic_candidates(Vec::new()).is_empty());
    }

    /// 真模型阈值校准（`--ignored` 手动跑；依赖 ~/.liveagent 下已缓存的
    /// multilingual-e5-small，CI 无模型不跑）。验证两级门控落在真实距离
    /// 分布的正确一侧：
    /// - 相关查询（英文同语言、中文跨语言）best < GATE → 语义路存活
    /// - 无意义查询（乱敲键盘）best > GATE → 整路过滤
    /// 同时验证与真实语料的"最相关"排序一致。
    /// 实测分布（2026-08，e5-small）：EN best 0.52 / ZH best 0.59 /
    /// garbage best 0.64——门槛 0.62 落在 ZH 与 garbage 之间，余量 ~0.03/0.02，
    /// 换 embedding 模型必须重跑本测试重新校准。
    #[test]
    #[ignore = "requires locally cached embedding model"]
    fn real_model_distance_distribution_matches_threshold() {
        use crate::services::code_index::embedder;

        embedder::ensure_ready().expect("model cached locally");
        let passages = vec![
            // 0: 重试逻辑
            "// src/net/retry.ts:12 resolveRetryPolicy\nexport function resolveRetryPolicy(attempt: number): number {\n  const base = 200;\n  const jitter = Math.random() * 50;\n  return base * 2 ** attempt + jitter; // exponential backoff with jitter\n}".to_string(),
            // 1: 鉴权 token 刷新
            "// src/auth/token.ts:33 refreshAccessToken\nasync function refreshAccessToken(session: Session): Promise<Token> {\n  if (session.expiresAt > Date.now()) return session.token;\n  return await oauthClient.refresh(session.refreshToken);\n}".to_string(),
            // 2: 配置解析
            "// src/config/load.ts:8 loadConfig\nfunction loadConfig(path: string): Config {\n  const raw = fs.readFileSync(path, 'utf8');\n  return JSON.parse(raw);\n}".to_string(),
        ];
        let passage_vecs = embedder::embed_passages(&passages).expect("embed passages");

        let l2 = |a: &[f32], b: &[f32]| -> f64 {
            a.iter()
                .zip(b)
                .map(|(x, y)| ((x - y) as f64).powi(2))
                .sum::<f64>()
                .sqrt()
        };
        let distances = |query: &str| -> Vec<f64> {
            let q = embedder::embed_query(query).expect("embed query");
            passage_vecs.iter().map(|p| l2(&q, p)).collect()
        };

        // 英文同语言意图查询：最近的必须是重试块，且过门槛。
        let en = distances("where is the retry backoff logic");
        let en_best = en
            .iter()
            .enumerate()
            .min_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap();
        // 中文跨语言意图查询：同样必须指向重试块且过门槛（门槛过紧先杀伤它）。
        let zh = distances("重试退避逻辑在哪里");
        let zh_best = zh
            .iter()
            .enumerate()
            .min_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap();
        // 无意义查询：best 必须被门槛拦下（这正是修复的靶点）。
        let garbage = distances("asdkjfh qwpoeiru zxmcnvb 阿斯顿飞洒地方");
        let garbage_min = garbage.iter().cloned().fold(f64::INFINITY, f64::min);

        eprintln!("== real-model distance calibration ==");
        eprintln!("EN relevant:   {en:?}");
        eprintln!("ZH crosslang:  {zh:?}");
        eprintln!("garbage:       {garbage:?}");
        eprintln!("gate:          {SEMANTIC_GATE_DISTANCE} (+tail {SEMANTIC_TAIL_DELTA})");

        assert_eq!(en_best.0, 0, "retry query must rank retry chunk first: {en:?}");
        assert!(
            *en_best.1 < SEMANTIC_GATE_DISTANCE,
            "relevant EN query must pass gate: d={} vs {SEMANTIC_GATE_DISTANCE}",
            en_best.1
        );
        assert_eq!(zh_best.0, 0, "cross-lingual query must rank retry chunk first: {zh:?}");
        assert!(
            *zh_best.1 < SEMANTIC_GATE_DISTANCE,
            "cross-lingual ZH query must pass gate: d={} vs {SEMANTIC_GATE_DISTANCE}",
            zh_best.1
        );
        assert!(
            garbage_min > SEMANTIC_GATE_DISTANCE,
            "garbage query must be gated out: min d={garbage_min} vs {SEMANTIC_GATE_DISTANCE}; all={garbage:?}"
        );
    }
}
            *zh_best.1 < SEMANTIC_MAX_DISTANCE,
            "cross-lingual ZH query must survive threshold: d={} vs {SEMANTIC_MAX_DISTANCE}",
            zh_best.1
        );

        // 无意义查询：全部候选都必须被阈值拦下（这正是修复的靶点）。
        let garbage = distances("asdkjfh qwpoeiru zxmcnvb 阿斯顿飞洒地方");
        let garbage_min = garbage.iter().cloned().fold(f64::INFINITY, f64::min);

        eprintln!("== real-model distance calibration ==");
        eprintln!("EN relevant:   {en:?}");
        eprintln!("ZH crosslang:  {zh:?}");
        eprintln!("garbage:       {garbage:?}");
        eprintln!("threshold:     {SEMANTIC_MAX_DISTANCE}");

        assert!(
            garbage_min > SEMANTIC_MAX_DISTANCE,
            "garbage query must be fully filtered: min d={garbage_min} vs {SEMANTIC_MAX_DISTANCE}; all={garbage:?}"
        );
    }
}

mod generated_detection_tests {
    use crate::services::code_index::walker::looks_generated;

    #[test]
    fn generator_head_markers_are_detected() {
        assert!(looks_generated("/* Generated by Cython 0.29.30 */\n#include <stdio.h>\n"));
        assert!(looks_generated(
            "// Code generated by protoc-gen-go. DO NOT EDIT.\npackage pb\n"
        ));
        assert!(looks_generated("# @generated\nfrom x import y\n"));
        assert!(looks_generated(
            "<!-- This file is auto-generated from templates -->\n<html></html>\n"
        ));
    }

    /// 标记不在头部（正文提及"do not edit"字样）不误伤；普通源码放行。
    #[test]
    fn normal_sources_are_not_flagged() {
        assert!(!looks_generated(
            "function invalidate() {\n  // watch 失效后自动重建索引\n}\n"
        ));
        let marker_deep_in_body = format!(
            "{}\n// tip: generated code usually says do not edit\n",
            "// normal line\n".repeat(20)
        );
        assert!(!looks_generated(&marker_deep_in_body));
    }

    /// 前 5 行出现超长行（minified/数据 blob）按生成物处理。
    #[test]
    fn oversized_head_line_counts_as_generated() {
        let minified = format!("var a={};", "x".repeat(5_000));
        assert!(looks_generated(&minified));
        let long_but_late = format!("{}{}", "short\n".repeat(6), "y".repeat(5_000));
        assert!(!looks_generated(&long_but_late), "长行在第 6 行之后不触发");
    }
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

    /// 纯中文查询走词法路必须能命中中文注释/文档（评审 #630 条目 2 回归）：
    /// unicode61 连续 CJK 成单 token，修复前 "监听失效" 永远 0 结果。
    #[test]
    fn pure_chinese_lexical_query_hits_chinese_comment() {
        let workdir = tempfile::tempdir().expect("workdir");
        let source = "export function rebuildIndex(): void {\n  // 工作区监听失效后自动重建索引\n  console.log(\"rebuild\");\n  console.log(\"done\");\n}\n";
        let rel_path = "src/rebuild.ts";
        let abs_path = workdir.path().join(rel_path);
        fs::create_dir_all(abs_path.parent().unwrap()).expect("mkdir");
        fs::write(&abs_path, source).expect("write source");

        let db_dir = tempfile::tempdir().expect("db dir");
        let store = CodeIndexStore::open_at(
            workdir.path().to_str().unwrap(),
            db_dir.path().join("code-index.sqlite3"),
        )
        .expect("open store");
        let chunks = chunk_source(rel_path, language_for_path(rel_path), source);
        store
            .replace_file(
                rel_path,
                1,
                source.len() as u64,
                &sha256_hex(source.as_bytes()),
                "typescript",
                &chunks,
                &[],
            )
            .expect("replace_file");

        // 词内子串（跨词边界 bigram）、整词、单字前缀三种形态都要能命中。
        for query in ["监听失效", "重建索引", "索"] {
            let response = search::search(
                &store,
                &CodeIndexSearchArgs {
                    workdir: store.workdir.clone(),
                    query: query.to_string(),
                    mode: Some("lexical".to_string()),
                    path: None,
                    max_results: None,
                },
            )
            .expect("chinese lexical search");
            assert!(
                response.matches.iter().any(|m| m.path == rel_path),
                "query '{query}' should hit the chinese comment"
            );
        }

        // 英文标识符查询在同一份 bigram 化索引上不受影响。
        let english = search::search(
            &store,
            &CodeIndexSearchArgs {
                workdir: store.workdir.clone(),
                query: "rebuildIndex".to_string(),
                mode: Some("lexical".to_string()),
                path: None,
                max_results: None,
            },
        )
        .expect("english lexical search");
        assert!(english.matches.iter().any(|m| m.path == rel_path));
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
