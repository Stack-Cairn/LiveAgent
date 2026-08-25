//! Chunker：tree-sitter 按函数/类/方法切块；无 grammar 语言与超长节点回退滑窗。
//!
//! 首批语言（路线图钦定）：TS/TSX/JS、Rust、Go、Python、Java。其余语言与
//! Markdown/纯文本走固定滑窗（80 行窗口、20 行重叠）。

use tree_sitter::{Node, Parser};

/// 单块字符上限：≈ e5-small 512 token 上下文的安全余量；超长语法节点内部再滑窗。
const MAX_CHUNK_CHARS: usize = 6_000;
/// 滑窗参数（行）。
const WINDOW_LINES: usize = 80;
const WINDOW_OVERLAP_LINES: usize = 20;
/// 语法块的最小行数：更小的（单行 getter 等）并入滑窗兜底反而检索噪声低。
const MIN_SYNTAX_CHUNK_LINES: usize = 3;

#[derive(Debug, Clone)]
pub(crate) struct CodeChunk {
    /// 1-based 起止行（含）。
    pub(crate) start_line: u32,
    pub(crate) end_line: u32,
    /// "function" | "class" | "method" | "window"
    pub(crate) kind: &'static str,
    pub(crate) symbol: String,
    /// 进 FTS 与 embedding 的正文（头部带 `// path:line symbol` 上下文行）。
    pub(crate) content: String,
}

pub(crate) fn language_for_path(rel_path: &str) -> &'static str {
    let lower = rel_path.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or_default();
    match ext {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "rs" => "rust",
        "go" => "go",
        "py" | "pyi" => "python",
        "java" => "java",
        _ => "plain",
    }
}

fn parser_for_language(language: &str) -> Option<Parser> {
    let grammar = match language {
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX,
        "javascript" => tree_sitter_javascript::LANGUAGE,
        "rust" => tree_sitter_rust::LANGUAGE,
        "go" => tree_sitter_go::LANGUAGE,
        "python" => tree_sitter_python::LANGUAGE,
        "java" => tree_sitter_java::LANGUAGE,
        _ => return None,
    };
    let mut parser = Parser::new();
    parser.set_language(&grammar.into()).ok()?;
    Some(parser)
}

/// 语言无关的“可切块节点”判定。命名覆盖七种语法的函数/方法/类声明节点。
fn chunkable_kind(node_kind: &str) -> Option<&'static str> {
    match node_kind {
        // TS/JS 家族（function_declaration 同时是 Go 的函数声明节点名）
        "function_declaration" | "generator_function_declaration" | "arrow_function" => {
            Some("function")
        }
        "method_definition" => Some("method"),
        "class_declaration" | "abstract_class_declaration" => Some("class"),
        // Rust
        "function_item" => Some("function"),
        "impl_item" | "trait_item" => Some("class"),
        // Go
        "method_declaration" => Some("method"),
        // Python
        "function_definition" => Some("function"),
        "class_definition" => Some("class"),
        // Java
        "constructor_declaration" => Some("method"),
        "interface_declaration" | "enum_declaration" => Some("class"),
        _ => None,
    }
}

/// 从节点提取符号名：找 name/identifier 类字段。
fn node_symbol(node: &Node, source: &str) -> String {
    for field in ["name", "declarator"] {
        if let Some(child) = node.child_by_field_name(field) {
            if let Ok(text) = child.utf8_text(source.as_bytes()) {
                let text = text.trim();
                if !text.is_empty() && text.len() <= 200 {
                    return text.to_string();
                }
            }
        }
    }
    // Rust impl_item 等无 name 字段：取 type 字段（impl Foo）。
    if let Some(child) = node.child_by_field_name("type") {
        if let Ok(text) = child.utf8_text(source.as_bytes()) {
            let text = text.trim();
            if !text.is_empty() && text.len() <= 200 {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn context_header(rel_path: &str, start_line: u32, symbol: &str) -> String {
    if symbol.is_empty() {
        format!("// {rel_path}:{start_line}\n")
    } else {
        format!("// {rel_path}:{start_line} {symbol}\n")
    }
}

/// 主入口：语法切块，覆盖不到的行落进滑窗兜底；非受支持语言全滑窗。
pub(crate) fn chunk_source(rel_path: &str, language: &str, source: &str) -> Vec<CodeChunk> {
    let lines: Vec<&str> = source.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }

    let syntax_chunks = parser_for_language(language)
        .and_then(|mut parser| parser.parse(source, None))
        .map(|tree| collect_syntax_chunks(rel_path, source, &lines, tree.root_node()))
        .unwrap_or_default();

    // 语法块行覆盖图：没被覆盖的行（顶层语句、导入、常量表等）交给滑窗。
    let mut covered = vec![false; lines.len()];
    for chunk in &syntax_chunks {
        let start = (chunk.start_line as usize).saturating_sub(1);
        let end = (chunk.end_line as usize).min(lines.len());
        for flag in &mut covered[start..end] {
            *flag = true;
        }
    }

    let mut chunks = syntax_chunks;
    chunks.extend(window_uncovered(rel_path, &lines, &covered));
    chunks.sort_by_key(|chunk| chunk.start_line);
    chunks
}

fn collect_syntax_chunks(
    rel_path: &str,
    source: &str,
    lines: &[&str],
    root: Node,
) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    let mut cursor = root.walk();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        let mut descend = true;
        if let Some(kind) = chunkable_kind(node.kind()) {
            let start_line = node.start_position().row as u32 + 1;
            let end_line = node.end_position().row as u32 + 1;
            let line_count = (end_line - start_line + 1) as usize;
            if line_count >= MIN_SYNTAX_CHUNK_LINES {
                let symbol = node_symbol(&node, source);
                if node.byte_range().len() <= MAX_CHUNK_CHARS {
                    if let Some(content) =
                        slice_lines(lines, start_line as usize, end_line as usize)
                    {
                        chunks.push(CodeChunk {
                            start_line,
                            end_line,
                            kind,
                            symbol: symbol.clone(),
                            content: format!(
                                "{}{content}",
                                context_header(rel_path, start_line, &symbol)
                            ),
                        });
                        // 类/impl 内的方法作为独立块继续下探，其余不再重复切。
                        descend = matches!(kind, "class");
                    }
                } else {
                    // 超长节点：内部滑窗，符号名沿用，便于语义路命中大函数。
                    chunks.extend(window_range(
                        rel_path,
                        lines,
                        start_line as usize,
                        end_line as usize,
                        &symbol,
                    ));
                    descend = false;
                }
            }
        }
        if descend {
            for child in node.children(&mut cursor) {
                stack.push(child);
            }
        }
    }
    chunks
}

fn slice_lines(lines: &[&str], start_line: usize, end_line: usize) -> Option<String> {
    if start_line == 0 || start_line > lines.len() {
        return None;
    }
    let end = end_line.min(lines.len());
    Some(lines[start_line - 1..end].join("\n"))
}

/// 对未被语法块覆盖的行做滑窗，连续未覆盖区间独立成窗。
fn window_uncovered(rel_path: &str, lines: &[&str], covered: &[bool]) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    let mut cursor = 0usize;
    while cursor < lines.len() {
        if covered[cursor] {
            cursor += 1;
            continue;
        }
        let start = cursor;
        while cursor < lines.len() && !covered[cursor] {
            cursor += 1;
        }
        // [start, cursor) 是未覆盖区间（0-based）。太短的碎片（空隙）跳过。
        if cursor - start >= MIN_SYNTAX_CHUNK_LINES {
            chunks.extend(window_range(rel_path, lines, start + 1, cursor, ""));
        }
    }
    chunks
}

/// 对 1-based 行区间 [start_line, end_line] 滑窗。
fn window_range(
    rel_path: &str,
    lines: &[&str],
    start_line: usize,
    end_line: usize,
    symbol: &str,
) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    let mut window_start = start_line;
    while window_start <= end_line {
        let window_end = (window_start + WINDOW_LINES - 1).min(end_line);
        if let Some(mut content) = slice_lines(lines, window_start, window_end) {
            // 极端长行（压缩产物漏网）截断，保证 embedding 输入有界。
            if content.len() > MAX_CHUNK_CHARS {
                content.truncate(MAX_CHUNK_CHARS);
            }
            if !content.trim().is_empty() {
                chunks.push(CodeChunk {
                    start_line: window_start as u32,
                    end_line: window_end as u32,
                    kind: "window",
                    symbol: symbol.to_string(),
                    content: format!(
                        "{}{content}",
                        context_header(rel_path, window_start as u32, symbol)
                    ),
                });
            }
        }
        if window_end >= end_line {
            break;
        }
        window_start = window_end + 1 - WINDOW_OVERLAP_LINES.min(window_end - window_start);
    }
    chunks
}
