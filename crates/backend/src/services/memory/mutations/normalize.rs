fn normalize_slug(input: &str) -> Result<String, String> {
    let slug = input.trim().to_lowercase().replace('_', "-");
    let re = Regex::new(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$").expect("valid slug regex");
    if re.is_match(&slug) {
        Ok(slug)
    } else {
        Err(error_json(
            "slug_invalid",
            "memory slug must be kebab-case and match [a-z0-9-]{3,64}",
            Some(json!({
                "action": "write",
                "slug": normalize_slug_suggestion(input)
            })),
            None,
        ))
    }
}

fn normalize_daily_slug(input: &str) -> Result<String, String> {
    let slug = input.trim().to_lowercase();
    let re = Regex::new(r"^daily-\d{4}-\d{2}-\d{2}$").expect("valid daily slug regex");
    if re.is_match(&slug) {
        Ok(slug)
    } else {
        Err(error_json(
            "slug_invalid",
            "daily memory slug must be daily-YYYY-MM-DD",
            Some(
                json!({ "action": "update", "slug": format!("daily-{}", today_local(DEFAULT_ROLLOVER_HOUR)), "mode": "append" }),
            ),
            None,
        ))
    }
}

fn normalize_slug_suggestion(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.len() < 3 {
        "memory-note".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn is_daily_slug(input: &str) -> bool {
    input.trim().to_lowercase().starts_with("daily-")
}

fn normalize_write_scope(input: &str) -> Result<String, String> {
    match input.trim() {
        "global" => Ok("global".to_string()),
        "project" => Ok("project".to_string()),
        other => Err(error_json(
            "invalid_scope",
            &format!("invalid memory scope: {other}"),
            None,
            None,
        )),
    }
}

fn normalize_scope_filter(input: Option<&str>) -> Result<Option<String>, String> {
    match input.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("auto") => Ok(None),
        Some("global") => Ok(Some("global".to_string())),
        Some("project") => Ok(Some("project".to_string())),
        Some(other) => Err(error_json(
            "invalid_scope",
            &format!("invalid memory scope: {other}"),
            None,
            None,
        )),
    }
}

fn normalize_memory_type(input: &str) -> Result<String, String> {
    match input.trim() {
        "user" | "feedback" | "project" | "reference" => Ok(input.trim().to_string()),
        other => Err(error_json(
            "invalid_type",
            &format!("invalid memory type: {other}"),
            None,
            None,
        )),
    }
}

fn normalize_type_filter(input: &str) -> Result<String, String> {
    match input.trim() {
        "daily" => Ok("daily".to_string()),
        other => normalize_memory_type(other),
    }
}

fn normalize_search_type_filter(input: &str) -> Result<String, String> {
    match input.trim() {
        "daily" => Ok("daily".to_string()),
        other => normalize_memory_type(other),
    }
}

fn normalize_description(input: &str) -> Result<String, String> {
    let value = input.trim();
    if value.is_empty() {
        return Err(error_json(
            "description_required",
            "memory description is required",
            None,
            None,
        ));
    }
    Ok(truncate_chars(value, MAX_DESCRIPTION_CHARS))
}

fn validate_body_limit(body: &str, max: usize, slug: &str) -> Result<(), String> {
    if body.as_bytes().len() <= max {
        return Ok(());
    }
    Err(error_json(
        "body_too_large",
        &format!("memory body for '{slug}' exceeds {} bytes", max),
        Some(json!({
            "action": "update",
            "slug": slug,
            "body": "<consolidated shorter body>"
        })),
        None,
    ))
}

fn push_batch_warning(
    warnings: &mut Vec<String>,
    warning_details: &mut Vec<MemoryBatchWarning>,
    raw: String,
    decision: Option<&MemoryDecisionArgs>,
    decision_index: Option<usize>,
    fallback_code: &str,
) {
    warning_details.push(batch_warning_from_raw(
        &raw,
        decision,
        decision_index,
        fallback_code,
    ));
    warnings.push(raw);
}

fn batch_warning_from_raw(
    raw: &str,
    decision: Option<&MemoryDecisionArgs>,
    decision_index: Option<usize>,
    fallback_code: &str,
) -> MemoryBatchWarning {
    let parsed = serde_json::from_str::<Value>(raw).ok();
    let code = parsed
        .as_ref()
        .and_then(|value| value.get("error").or_else(|| value.get("code")))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_code)
        .to_string();
    let message = parsed
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw)
        .to_string();
    let suggested_slug = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("suggested_next_call")
                .or_else(|| value.get("suggestedNextCall"))
        })
        .and_then(Value::as_object)
        .and_then(|value| value.get("slug"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string);
    MemoryBatchWarning {
        code,
        message,
        slug: suggested_slug.or_else(|| decision.map(|item| item.slug.clone())),
        op: decision.map(|item| item.op.clone()),
        group_id: decision.and_then(|item| item.group_id.clone()),
        decision_index,
        details: parsed.unwrap_or_else(|| json!({ "raw": raw })),
    }
}
