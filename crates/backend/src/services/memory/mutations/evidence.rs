// Single enforcement point for the memory evidence contract.
//
// The TS layer passes structured `MemoryEvidenceArgs`; this module renders the
// canonical evidence frontmatter block that `evidence_confidence_from_body`
// (content.rs) later reads back when indexing. Nothing else in either language
// may serialize or re-derive this format.

fn normalize_evidence_confidence(raw: Option<&str>) -> String {
    match raw
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("high") => "high".to_string(),
        Some("medium") => "medium".to_string(),
        _ => "low".to_string(),
    }
}

/// high requires a source quote of >=5 chars, medium requires a non-empty one;
/// violations downgrade one step at a time (high -> medium -> low).
fn apply_confidence_contract(raw: Option<&str>, source_quote: &str) -> (String, bool) {
    let mut confidence = normalize_evidence_confidence(raw);
    let quote_len = source_quote.trim().chars().count();
    let mut auto_downgraded = false;
    if confidence == "high" && quote_len < 5 {
        confidence = "medium".to_string();
        auto_downgraded = true;
    }
    if confidence == "medium" && quote_len == 0 {
        confidence = "low".to_string();
        auto_downgraded = true;
    }
    (confidence, auto_downgraded)
}

fn evidence_args_present(evidence: &MemoryEvidenceArgs) -> bool {
    let has_text = |value: &Option<String>| {
        value
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    };
    let has_list = |value: &Option<Vec<String>>| {
        value
            .as_deref()
            .is_some_and(|items| items.iter().any(|item| !item.trim().is_empty()))
    };
    has_text(&evidence.confidence)
        || has_text(&evidence.source_quote)
        || has_text(&evidence.reasoning)
        || has_text(&evidence.supersedes)
        || has_text(&evidence.override_reject)
        || has_list(&evidence.aliases)
        || has_list(&evidence.conflicts_with)
}

fn evidence_frontmatter_string(value: &str, max_chars: usize) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace("\r\n", " ")
        .replace(['\r', '\n'], " ")
        .chars()
        .take(max_chars)
        .collect()
}

fn evidence_frontmatter_array(values: Option<&[String]>) -> String {
    let items: Vec<String> = values
        .unwrap_or_default()
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .take(8)
        .map(|value| format!("\"{}\"", evidence_frontmatter_string(value, 240)))
        .collect();
    format!("[{}]", items.join(", "))
}

/// Render the canonical evidence frontmatter and splice it onto `body`.
/// Frontmatter already present on the incoming body is replaced, never doubled.
/// Returns (new_body, applied_confidence, auto_downgraded).
fn apply_evidence_to_body(
    body: &str,
    evidence: &MemoryEvidenceArgs,
) -> (String, String, bool) {
    let (_, content) = split_frontmatter(body);
    let source_quote = evidence.source_quote.as_deref().unwrap_or("").trim();
    let (confidence, auto_downgraded) =
        apply_confidence_contract(evidence.confidence.as_deref(), source_quote);
    let mut lines = vec![format!("confidence: {confidence}")];
    if auto_downgraded {
        lines.push("auto_downgraded: true".to_string());
    }
    lines.push(format!(
        "source_quote: \"{}\"",
        evidence_frontmatter_string(source_quote, 80)
    ));
    lines.push(format!(
        "reasoning: \"{}\"",
        evidence_frontmatter_string(evidence.reasoning.as_deref().unwrap_or("").trim(), 240)
    ));
    lines.push(format!(
        "aliases: {}",
        evidence_frontmatter_array(evidence.aliases.as_deref())
    ));
    lines.push(format!(
        "conflicts_with: {}",
        evidence_frontmatter_array(evidence.conflicts_with.as_deref())
    ));
    lines.push(format!(
        "supersedes: \"{}\"",
        evidence_frontmatter_string(evidence.supersedes.as_deref().unwrap_or("").trim(), 240)
    ));
    lines.push(format!(
        "override_reject: \"{}\"",
        evidence_frontmatter_string(
            evidence.override_reject.as_deref().unwrap_or("").trim(),
            240
        )
    ));
    let frontmatter = lines.join("\n");
    (
        render_evidence_body(&frontmatter, &content),
        confidence,
        auto_downgraded,
    )
}
