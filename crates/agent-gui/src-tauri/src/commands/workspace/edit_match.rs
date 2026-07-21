//! Fallback matching for the Edit tool's `old_string` lookup.
//!
//! Models frequently reproduce file content with slightly different
//! whitespace than what is on disk: LF instead of the file's CRLF line
//! endings, missing trailing spaces, or a uniformly shifted indentation.
//! State-of-the-art coding agents tolerate these near-misses instead of
//! failing the edit (Claude Code runs a cascade of increasingly lenient
//! "replacers"; Codex CLI's `apply_patch` locates context with
//! exact → rstrip → trim passes). This module implements the same idea for
//! LiveAgent's exact-string Edit tool.
//!
//! Passes run strictest first, and the first pass that yields at least one
//! match wins, so a stricter interpretation always takes precedence:
//!
//! 1. [`EditMatchStrategy::Exact`] — byte-for-byte substring match (the
//!    historical behavior).
//! 2. [`EditMatchStrategy::LineEndings`] — match after normalizing CRLF to
//!    LF on both sides and ignoring a leading UTF-8 BOM. The replacement is
//!    re-rendered in the file's dominant line-ending style so a CRLF file
//!    stays CRLF.
//! 3. [`EditMatchStrategy::TrailingWhitespace`] — whole-line windows
//!    compared with per-line trailing whitespace ignored.
//! 4. [`EditMatchStrategy::Indentation`] — whole-line windows that match
//!    after shifting every non-blank line by one uniform leading-whitespace
//!    prefix. The same shift is applied to the replacement so the file's
//!    actual indentation is preserved (this deliberately avoids the known
//!    `apply_patch` foot-gun of trusting the model's indentation on fuzzy
//!    matches).
//!
//! The line-based passes (3 and 4) treat `old_string` as a block of whole
//! lines; fragments that start or end mid-line are only matched by passes
//! 1 and 2. Lone `\r` (classic Mac) line endings are not normalized.

const UTF8_BOM: &str = "\u{feff}";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditMatchStrategy {
    Exact,
    LineEndings,
    TrailingWhitespace,
    Indentation,
}

impl EditMatchStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::LineEndings => "line-endings",
            Self::TrailingWhitespace => "trailing-whitespace",
            Self::Indentation => "indentation",
        }
    }
}

/// One splice into the original text: replace `start..end` with `text`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditReplacement {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

#[derive(Debug)]
pub struct EditMatchOutcome {
    pub strategy: EditMatchStrategy,
    pub replacements: Vec<EditReplacement>,
}

/// Run the pass cascade. Returns `None` when no pass finds a match.
/// Replacements are sorted, non-overlapping ranges into `text`.
pub fn find_edit_matches(
    text: &str,
    old_string: &str,
    new_string: &str,
) -> Option<EditMatchOutcome> {
    if old_string.is_empty() {
        return None;
    }

    let exact = find_exact_ranges(text, old_string);
    if !exact.is_empty() {
        return Some(EditMatchOutcome {
            strategy: EditMatchStrategy::Exact,
            replacements: exact
                .into_iter()
                .map(|(start, end)| EditReplacement {
                    start,
                    end,
                    text: new_string.to_string(),
                })
                .collect(),
        });
    }

    let crlf = uses_crlf_dominantly(text);

    if let Some(replacements) = find_line_ending_matches(text, old_string, new_string, crlf) {
        return Some(EditMatchOutcome {
            strategy: EditMatchStrategy::LineEndings,
            replacements,
        });
    }

    let spans = index_line_spans(text);
    let pattern = split_pattern_lines(old_string)?;

    let windows = find_line_windows(text, &spans, &pattern, |file_line, pattern_line| {
        file_line.trim_end() == pattern_line.trim_end()
    });
    if !windows.is_empty() {
        let rendered = render_line_endings(new_string, crlf);
        return Some(EditMatchOutcome {
            strategy: EditMatchStrategy::TrailingWhitespace,
            replacements: windows
                .into_iter()
                .map(|window| {
                    let (start, end) = window_range(&spans, window, pattern.ends_with_newline);
                    EditReplacement {
                        start,
                        end,
                        text: rendered.clone(),
                    }
                })
                .collect(),
        });
    }

    let candidates = find_line_windows(text, &spans, &pattern, |file_line, pattern_line| {
        file_line.trim() == pattern_line.trim()
    });
    let replacements: Vec<EditReplacement> = candidates
        .into_iter()
        .filter_map(|window| {
            let shift = detect_uniform_shift(text, &spans, &pattern, window.0)?;
            let rendered = apply_shift_to_replacement(new_string, &shift, crlf)?;
            let (start, end) = window_range(&spans, window, pattern.ends_with_newline);
            Some(EditReplacement {
                start,
                end,
                text: rendered,
            })
        })
        .collect();
    if !replacements.is_empty() {
        return Some(EditMatchOutcome {
            strategy: EditMatchStrategy::Indentation,
            replacements,
        });
    }

    None
}

/// Splice sorted, non-overlapping replacements into `text`.
///
/// The ranges must be ascending and non-overlapping, exactly as produced by
/// [`find_edit_matches`]. This contract is only verified by `debug_assert!`;
/// in release builds a violating range panics on the inverted slice below
/// instead of writing corrupted output.
pub fn apply_edit_replacements(text: &str, replacements: &[EditReplacement]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for replacement in replacements {
        debug_assert!(replacement.start >= cursor && replacement.end >= replacement.start);
        out.push_str(&text[cursor..replacement.start]);
        out.push_str(&replacement.text);
        cursor = replacement.end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// Non-overlapping occurrences of `needle`, mirroring `str::matches` counts.
fn find_exact_ranges(haystack: &str, needle: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    if needle.is_empty() {
        return ranges;
    }
    let mut from = 0usize;
    while let Some(offset) = haystack[from..].find(needle) {
        let start = from + offset;
        ranges.push((start, start + needle.len()));
        from = start + needle.len();
    }
    ranges
}

struct NormalizedView {
    text: String,
    /// Byte offset in the original text for every normalized byte.
    map: Vec<usize>,
}

/// Drop a leading UTF-8 BOM and collapse CRLF to LF, keeping a byte-level
/// offset map back into the original text.
fn normalize_with_map(original: &str) -> NormalizedView {
    let bytes = original.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut map = Vec::with_capacity(bytes.len());
    let mut i = if original.starts_with(UTF8_BOM) {
        UTF8_BOM.len()
    } else {
        0
    };
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        map.push(i);
        out.push(bytes[i]);
        i += 1;
    }
    NormalizedView {
        text: String::from_utf8(out).expect("removing whole ASCII bytes keeps UTF-8 valid"),
        map,
    }
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix(UTF8_BOM).unwrap_or(text)
}

fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// True when CRLF is the file's dominant line-ending style.
fn uses_crlf_dominantly(text: &str) -> bool {
    let crlf = text.matches("\r\n").count();
    if crlf == 0 {
        return false;
    }
    let lone_lf = text.matches('\n').count() - crlf;
    crlf >= lone_lf
}

/// Re-render replacement text in the file's dominant line-ending style.
fn render_line_endings(text: &str, crlf: bool) -> String {
    let normalized = normalize_line_endings(text);
    if crlf {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    }
}

fn find_line_ending_matches(
    text: &str,
    old_string: &str,
    new_string: &str,
    crlf: bool,
) -> Option<Vec<EditReplacement>> {
    let view = normalize_with_map(text);
    let needle = normalize_line_endings(strip_bom(old_string));
    if needle.is_empty() {
        return None;
    }
    let ranges = find_exact_ranges(&view.text, &needle);
    if ranges.is_empty() {
        return None;
    }
    let rendered = render_line_endings(new_string, crlf);
    Some(
        ranges
            .into_iter()
            .map(|(start, end)| {
                // Every normalized byte maps 1:1 onto an original byte, so the
                // end boundary is the byte after the last matched byte. Skipped
                // `\r` bytes inside the range are covered automatically.
                let mut start = view.map[start];
                let end = view.map[end - 1] + 1;
                // A match that begins at the `\n` of a CRLF pair must also
                // consume the preceding `\r`: the replacement is re-rendered
                // from scratch (`\r\n` in a CRLF file), so leaving that lone
                // `\r` behind would corrupt the file with `\r\r\n`.
                if text.as_bytes()[start] == b'\n'
                    && start > 0
                    && text.as_bytes()[start - 1] == b'\r'
                {
                    start -= 1;
                }
                EditReplacement {
                    start,
                    end,
                    text: rendered.clone(),
                }
            })
            .collect(),
    )
}

#[derive(Debug, Clone, Copy)]
struct LineSpan {
    /// Start of the line's content; skips a leading UTF-8 BOM on the first
    /// line so replacements leave the BOM in place.
    content_start: usize,
    /// End of the line's content, excluding its EOL bytes.
    content_end: usize,
    /// End of the line including its EOL (start of the next line).
    line_end: usize,
}

fn index_line_spans(text: &str) -> Vec<LineSpan> {
    let bytes = text.as_bytes();
    let bom_len = if text.starts_with(UTF8_BOM) {
        UTF8_BOM.len()
    } else {
        0
    };
    let mut spans = Vec::new();
    let mut start = 0usize;
    for (i, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let content_end = if i > start && bytes[i - 1] == b'\r' {
            i - 1
        } else {
            i
        };
        spans.push(LineSpan {
            content_start: if start == 0 { bom_len } else { start },
            content_end,
            line_end: i + 1,
        });
        start = i + 1;
    }
    if start < bytes.len() {
        spans.push(LineSpan {
            content_start: if start == 0 { bom_len } else { start },
            content_end: bytes.len(),
            line_end: bytes.len(),
        });
    }
    spans
}

fn line_content<'a>(text: &'a str, span: &LineSpan) -> &'a str {
    &text[span.content_start..span.content_end]
}

struct PatternLines<'a> {
    lines: Vec<&'a str>,
    ends_with_newline: bool,
}

/// Split `old_string` into EOL-agnostic whole lines for the line-based
/// passes. Returns `None` for content that has no usable lines.
fn split_pattern_lines(old_string: &str) -> Option<PatternLines<'_>> {
    let stripped = strip_bom(old_string);
    if stripped.is_empty() {
        return None;
    }
    let ends_with_newline = stripped.ends_with('\n');
    let mut lines: Vec<&str> = stripped
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    if ends_with_newline {
        lines.pop();
    }
    if lines.is_empty() {
        return None;
    }
    Some(PatternLines {
        lines,
        ends_with_newline,
    })
}

/// Slide a whole-line window over the file and collect non-overlapping
/// `(first_line, last_line)` index pairs where every line satisfies
/// `line_matches`.
fn find_line_windows(
    text: &str,
    spans: &[LineSpan],
    pattern: &PatternLines<'_>,
    line_matches: impl Fn(&str, &str) -> bool,
) -> Vec<(usize, usize)> {
    let window_len = pattern.lines.len();
    let mut windows = Vec::new();
    if window_len == 0 || spans.len() < window_len {
        return windows;
    }
    let mut i = 0usize;
    while i + window_len <= spans.len() {
        let matched = (0..window_len)
            .all(|j| line_matches(line_content(text, &spans[i + j]), pattern.lines[j]));
        if matched {
            windows.push((i, i + window_len - 1));
            i += window_len;
        } else {
            i += 1;
        }
    }
    windows
}

fn window_range(
    spans: &[LineSpan],
    (first, last): (usize, usize),
    include_final_eol: bool,
) -> (usize, usize) {
    let start = spans[first].content_start;
    let end = if include_final_eol {
        spans[last].line_end
    } else {
        spans[last].content_end
    };
    (start, end)
}

/// One uniform leading-whitespace shift between the pattern and the file.
enum IndentShift {
    /// The file is indented deeper: `file_line == prefix + pattern_line`.
    Add(String),
    /// The file is indented shallower: `pattern_line == prefix + file_line`.
    Remove(String),
}

fn leading_whitespace(line: &str) -> &str {
    &line[..line.len() - line.trim_start().len()]
}

/// Detect a single whitespace prefix that maps every non-blank pattern line
/// onto its file line. Returns `None` when the shift is not uniform.
fn detect_uniform_shift(
    text: &str,
    spans: &[LineSpan],
    pattern: &PatternLines<'_>,
    first_line: usize,
) -> Option<IndentShift> {
    let mut shift: Option<IndentShift> = None;
    for (j, pattern_line) in pattern.lines.iter().enumerate() {
        let file_line = line_content(text, &spans[first_line + j]).trim_end();
        let pattern_line = pattern_line.trim_end();
        if file_line.trim_start().is_empty() && pattern_line.trim_start().is_empty() {
            continue;
        }
        let file_indent = leading_whitespace(file_line);
        let pattern_indent = leading_whitespace(pattern_line);
        let line_shift = if let Some(prefix) = file_indent.strip_suffix(pattern_indent) {
            IndentShift::Add(prefix.to_string())
        } else if let Some(prefix) = pattern_indent.strip_suffix(file_indent) {
            IndentShift::Remove(prefix.to_string())
        } else {
            return None;
        };
        // The prefix must be identical on every non-blank line. A line whose
        // indentation already matches yields an empty `Add` prefix, which is
        // deliberately incompatible with any non-empty shift: mixing shifted
        // and unshifted lines is not a uniform block move.
        match (&shift, &line_shift) {
            (None, _) => shift = Some(line_shift),
            (Some(IndentShift::Add(a)), IndentShift::Add(b)) if a == b => {}
            (Some(IndentShift::Remove(a)), IndentShift::Remove(b)) if a == b => {}
            _ => return None,
        }
    }
    shift.or(Some(IndentShift::Add(String::new())))
}

/// Re-render `new_string` with the detected shift applied to every non-blank
/// line, so the replacement adopts the file's real indentation. Returns
/// `None` when a line cannot absorb a `Remove` shift.
fn apply_shift_to_replacement(new_string: &str, shift: &IndentShift, crlf: bool) -> Option<String> {
    let normalized = normalize_line_endings(new_string);
    let mut shifted_lines = Vec::new();
    for line in normalized.split('\n') {
        if line.trim().is_empty() {
            shifted_lines.push(line.to_string());
            continue;
        }
        match shift {
            IndentShift::Add(prefix) => shifted_lines.push(format!("{prefix}{line}")),
            IndentShift::Remove(prefix) => {
                shifted_lines.push(line.strip_prefix(prefix)?.to_string())
            }
        }
    }
    let joined = shifted_lines.join("\n");
    Some(if crlf {
        joined.replace('\n', "\r\n")
    } else {
        joined
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply_first(text: &str, old: &str, new: &str) -> (String, EditMatchStrategy, usize) {
        let outcome = find_edit_matches(text, old, new).expect("expected a match");
        let count = outcome.replacements.len();
        let next = apply_edit_replacements(text, &outcome.replacements[..1]);
        (next, outcome.strategy, count)
    }

    fn apply_all(text: &str, old: &str, new: &str) -> (String, EditMatchStrategy, usize) {
        let outcome = find_edit_matches(text, old, new).expect("expected a match");
        let count = outcome.replacements.len();
        let next = apply_edit_replacements(text, &outcome.replacements);
        (next, outcome.strategy, count)
    }

    #[test]
    fn exact_match_replaces_single_occurrence() {
        let (next, strategy, count) = apply_first("let x = 1;\nlet y = 2;\n", "x = 1", "x = 9");
        assert_eq!(next, "let x = 9;\nlet y = 2;\n");
        assert_eq!(strategy, EditMatchStrategy::Exact);
        assert_eq!(count, 1);
    }

    #[test]
    fn exact_match_counts_non_overlapping_occurrences() {
        let outcome = find_edit_matches("aaa", "aa", "b").expect("match");
        assert_eq!(outcome.strategy, EditMatchStrategy::Exact);
        assert_eq!(outcome.replacements.len(), 1);
    }

    #[test]
    fn exact_match_replace_all() {
        let (next, strategy, count) = apply_all("foo bar foo", "foo", "baz");
        assert_eq!(next, "baz bar baz");
        assert_eq!(strategy, EditMatchStrategy::Exact);
        assert_eq!(count, 2);
    }

    #[test]
    fn exact_match_wins_over_fuzzier_passes() {
        // "b" matches exactly once; a trailing-whitespace pass would also
        // match, but the exact pass must take precedence.
        let text = "a\nb \nb\n";
        let (next, strategy, count) = apply_first(text, "b\n", "c\n");
        assert_eq!(strategy, EditMatchStrategy::Exact);
        assert_eq!(count, 1);
        assert_eq!(next, "a\nb \nc\n");
    }

    #[test]
    fn no_match_returns_none() {
        assert!(find_edit_matches("hello", "absent", "x").is_none());
        assert!(find_edit_matches("hello", "", "x").is_none());
    }

    #[test]
    fn crlf_file_matches_lf_old_string() {
        let text = "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n";
        let (next, strategy, count) = apply_first(
            text,
            "const b = 2;\nconst c = 3;\n",
            "const b = 20;\nconst c = 30;\n",
        );
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(count, 1);
        assert_eq!(next, "const a = 1;\r\nconst b = 20;\r\nconst c = 30;\r\n");
    }

    #[test]
    fn crlf_file_keeps_crlf_in_replacement() {
        let text = "one\r\ntwo\r\n";
        let (next, _, _) = apply_first(text, "one\ntwo\n", "first\nsecond\nthird\n");
        assert_eq!(next, "first\r\nsecond\r\nthird\r\n");
    }

    #[test]
    fn lf_file_matches_crlf_old_string() {
        let text = "one\ntwo\nthree\n";
        let (next, strategy, _) = apply_first(text, "one\r\ntwo\r\n", "uno\r\ndos\r\n");
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(next, "uno\ndos\nthree\n");
    }

    #[test]
    fn crlf_fragment_within_line_matches() {
        // Mid-line fragments must still work in the line-ending pass.
        let text = "alpha beta\r\ngamma\r\n";
        let (next, strategy, _) = apply_first(text, "beta\ngamma", "BETA\nGAMMA");
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(next, "alpha BETA\r\nGAMMA\r\n");
    }

    #[test]
    fn bom_file_matches_old_string_anchored_at_start() {
        let text = "\u{feff}first\r\nsecond\r\n";
        let (next, strategy, _) = apply_first(text, "first\nsecond\n", "FIRST\nSECOND\n");
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(
            next, "\u{feff}FIRST\r\nSECOND\r\n",
            "the BOM must survive the edit"
        );
    }

    #[test]
    fn bom_prefixed_old_string_matches_plain_file() {
        let text = "first\nsecond\n";
        let (next, strategy, _) = apply_first(text, "\u{feff}first\r\n", "FIRST\n");
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(next, "FIRST\nsecond\n");
    }

    #[test]
    fn leading_newline_old_string_consumes_full_crlf_pair() {
        // The match starts at the `\n` of a CRLF pair; the preceding `\r`
        // must be absorbed into the replaced range or the re-rendered
        // replacement would produce a corrupt `\r\r\n` sequence.
        let text = "foo()\r\nbar()\r\nbaz()\r\n";
        let (next, strategy, _) = apply_first(text, "\nbar()\n", "\nBAR()\n");
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(
            next, "foo()\r\nBAR()\r\nbaz()\r\n",
            "no orphan \\r may remain before the replacement"
        );
    }

    #[test]
    fn leading_newline_removed_by_replacement_joins_crlf_lines() {
        // Replacing a leading newline with a space must remove the whole
        // CRLF pair, not just its `\n` half.
        let text = "a\r\nb\r\nc\r\n";
        let (next, strategy, _) = apply_first(text, "\nb\n", " b\n");
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(next, "a b\r\nc\r\n");
    }

    #[test]
    fn leading_newline_after_bom_consumes_crlf_pair() {
        let text = "\u{feff}\r\nbody\r\n";
        let (next, strategy, _) = apply_first(text, "\nbody\n", "\nBODY\n");
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(next, "\u{feff}\r\nBODY\r\n");
    }

    #[test]
    fn mixed_line_endings_prefer_dominant_style() {
        // Two CRLF lines vs one LF line: replacements are rendered CRLF.
        let text = "a\r\nb\r\nc\nd";
        let (next, strategy, _) = apply_first(text, "c\r\nd", "x\ny");
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(next, "a\r\nb\r\nx\r\ny");
    }

    #[test]
    fn trailing_whitespace_tolerant_match() {
        let text = "fn main() {  \n    body();\t\n}\n";
        let (next, strategy, count) = apply_first(
            text,
            "fn main() {\n    body();\n}\n",
            "fn main() {\n    other();\n}\n",
        );
        assert_eq!(strategy, EditMatchStrategy::TrailingWhitespace);
        assert_eq!(count, 1);
        assert_eq!(next, "fn main() {\n    other();\n}\n");
    }

    #[test]
    fn trailing_whitespace_in_old_string_matches_clean_file() {
        let text = "line one\nline two\n";
        let (next, strategy, _) = apply_first(text, "line one  \nline two\n", "line 1\nline 2\n");
        assert_eq!(strategy, EditMatchStrategy::TrailingWhitespace);
        assert_eq!(next, "line 1\nline 2\n");
    }

    #[test]
    fn trailing_whitespace_pass_respects_crlf() {
        let text = "alpha  \r\nbeta\r\n";
        let (next, strategy, _) = apply_first(text, "alpha\nbeta\n", "a\nb\n");
        assert_eq!(strategy, EditMatchStrategy::TrailingWhitespace);
        assert_eq!(next, "a\r\nb\r\n");
    }

    #[test]
    fn trailing_whitespace_does_not_match_mid_line_fragment() {
        // Line-based passes require whole-line windows.
        assert!(find_edit_matches("prefix core suffix\n", "core extra", "x").is_none());
    }

    #[test]
    fn last_line_without_newline_matches() {
        let text = "a\nfinal line";
        let (next, strategy, _) = apply_first(text, "final line  ", "the end");
        assert_eq!(strategy, EditMatchStrategy::TrailingWhitespace);
        assert_eq!(next, "a\nthe end");
    }

    #[test]
    fn indentation_shift_add_is_applied_to_replacement() {
        let text = "if ready {\n        launch();\n        wait();\n}\n";
        // The model dropped one indentation level on both lines.
        let (next, strategy, count) = apply_first(
            text,
            "    launch();\n    wait();\n",
            "    launch();\n    hold();\n",
        );
        assert_eq!(strategy, EditMatchStrategy::Indentation);
        assert_eq!(count, 1);
        assert_eq!(next, "if ready {\n        launch();\n        hold();\n}\n");
    }

    #[test]
    fn indentation_shift_remove_is_applied_to_replacement() {
        let text = "fn f() {\n    a();\n    b();\n}\n";
        // The model added an extra indentation level.
        let (next, strategy, _) = apply_first(
            text,
            "        a();\n        b();\n",
            "        a();\n        c();\n",
        );
        assert_eq!(strategy, EditMatchStrategy::Indentation);
        assert_eq!(next, "fn f() {\n    a();\n    c();\n}\n");
    }

    #[test]
    fn indentation_shift_preserves_relative_indentation() {
        let text = "    if x {\n        y();\n    }\n";
        let (next, strategy, _) = apply_first(
            text,
            "if x {\n    y();\n}\n",
            "if x {\n    y();\n    z();\n}\n",
        );
        assert_eq!(strategy, EditMatchStrategy::Indentation);
        assert_eq!(next, "    if x {\n        y();\n        z();\n    }\n");
    }

    #[test]
    fn indentation_shift_works_with_tabs() {
        let text = "\t\tif x {\n\t\t\tgo();\n\t\t}\n";
        let (next, strategy, _) = apply_first(
            text,
            "\tif x {\n\t\tgo();\n\t}\n",
            "\tif x {\n\t\tstop();\n\t}\n",
        );
        assert_eq!(strategy, EditMatchStrategy::Indentation);
        assert_eq!(next, "\t\tif x {\n\t\t\tstop();\n\t\t}\n");
    }

    #[test]
    fn indentation_shift_skips_blank_lines() {
        let text = "    a();\n\n    b();\n";
        let (next, strategy, _) = apply_first(text, "a();\n\nb();\n", "a();\n\nc();\n");
        assert_eq!(strategy, EditMatchStrategy::Indentation);
        assert_eq!(next, "    a();\n\n    c();\n");
    }

    #[test]
    fn non_uniform_indentation_shift_is_rejected() {
        // First line shifted by 4, second by 2: not a uniform block shift.
        let text = "    a();\n  b();\n";
        assert!(find_edit_matches(text, "a();\nb();\n", "x();\ny();\n").is_none());
    }

    #[test]
    fn partially_shifted_window_is_rejected() {
        // The pattern over-indents line one but line two already matches;
        // re-indenting the whole replacement would corrupt line two.
        let text = "  launch();\n  keep();\n";
        assert!(
            find_edit_matches(text, "    launch();\n  keep();\n", "    x();\n  keep();\n")
                .is_none()
        );
    }

    #[test]
    fn opposite_direction_shifts_are_rejected() {
        // Line one is deeper in the file, line two is shallower: not uniform.
        let text = "        a();\nb();\n";
        assert!(find_edit_matches(text, "    a();\n    b();\n", "    x();\n    y();\n").is_none());
    }

    #[test]
    fn mixed_tab_space_indent_mismatch_is_rejected() {
        let text = "\tcall();\n";
        assert!(find_edit_matches(text, "  call();\n", "  other();\n").is_none());
    }

    #[test]
    fn remove_shift_that_replacement_cannot_absorb_is_rejected() {
        let text = "fn f() {\n    a();\n}\n";
        // Pattern is one level deeper than the file (Remove shift), but the
        // replacement line does not start with that prefix.
        assert!(find_edit_matches(text, "        a();\n", "b();\n").is_none());
    }

    #[test]
    fn ambiguous_matches_are_all_reported() {
        let text = "call()  \nother\ncall()\t\n";
        let outcome = find_edit_matches(text, "call()\n", "done()\n").expect("match");
        assert_eq!(outcome.strategy, EditMatchStrategy::TrailingWhitespace);
        assert_eq!(outcome.replacements.len(), 2);
        let next = apply_edit_replacements(text, &outcome.replacements);
        assert_eq!(next, "done()\nother\ndone()\n");
    }

    #[test]
    fn fuzzy_windows_do_not_overlap() {
        let text = "x \nx \nx \n";
        let outcome = find_edit_matches(text, "x\nx\n", "y\ny\n").expect("match");
        assert_eq!(outcome.replacements.len(), 1, "windows must not overlap");
    }

    #[test]
    fn single_line_with_trailing_whitespace_drift_matches() {
        let text = "keep\nvalue = 1  \nkeep\n";
        let (next, strategy, _) = apply_first(text, "value = 1\n", "value = 2\n");
        assert_eq!(strategy, EditMatchStrategy::TrailingWhitespace);
        assert_eq!(next, "keep\nvalue = 2\nkeep\n");
    }

    #[test]
    fn unicode_content_survives_normalization() {
        let text = "版本 = 一\r\n名字 = 二\r\n";
        let (next, strategy, _) = apply_first(text, "名字 = 二\n", "名字 = 三\n");
        assert_eq!(strategy, EditMatchStrategy::LineEndings);
        assert_eq!(next, "版本 = 一\r\n名字 = 三\r\n");
    }

    #[test]
    fn apply_replacements_handles_adjacent_ranges() {
        let replacements = vec![
            EditReplacement {
                start: 0,
                end: 1,
                text: "A".to_string(),
            },
            EditReplacement {
                start: 1,
                end: 2,
                text: "B".to_string(),
            },
        ];
        assert_eq!(apply_edit_replacements("ab-rest", &replacements), "AB-rest");
    }
}
