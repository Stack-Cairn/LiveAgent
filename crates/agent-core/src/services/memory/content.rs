fn parse_memory_file(path: &Path, archived: bool) -> Result<ParsedMemoryFile, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("读取记忆文件 {} 失败：{e}", path.display()))?;
    let (frontmatter, body) = split_frontmatter(&raw);
    let mut meta = parse_frontmatter(&frontmatter);
    if meta.name.is_empty() {
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_string();
        meta.name = if meta.memory_type == "daily" && !stem.starts_with("daily-") {
            format!("daily-{stem}")
        } else {
            stem
        };
    }
    if meta.memory_type.is_empty() {
        meta.memory_type = if meta.name.starts_with("daily-") {
            "daily".to_string()
        } else {
            "reference".to_string()
        };
    }
    if meta.scope.is_empty() {
        meta.scope = if path.components().any(|part| part.as_os_str() == "projects") {
            "project".to_string()
        } else {
            "global".to_string()
        };
    }
    if meta.memory_type == "daily" && meta.date.is_none() {
        meta.date = Some(meta.name.trim_start_matches("daily-").to_string());
    }
    Ok(ParsedMemoryFile {
        meta,
        body,
        path: path.to_path_buf(),
        archived,
    })
}

fn split_frontmatter(raw: &str) -> (String, String) {
    let normalized = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    if !normalized.starts_with("---\n") && !normalized.starts_with("---\r\n") {
        return (String::new(), normalized.to_string());
    }
    let mut lines = normalized.lines();
    let _ = lines.next();
    let mut frontmatter = Vec::new();
    let mut body = Vec::new();
    let mut in_frontmatter = true;
    for line in lines {
        if in_frontmatter && line.trim() == "---" {
            in_frontmatter = false;
            continue;
        }
        if in_frontmatter {
            frontmatter.push(line.to_string());
        } else {
            body.push(line.to_string());
        }
    }
    (
        frontmatter.join("\n"),
        body.join("\n").trim_start_matches('\n').to_string(),
    )
}

fn normalize_memory_confidence(value: &str) -> String {
    match value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_ascii_lowercase()
        .as_str()
    {
        "high" => "high".to_string(),
        "medium" => "medium".to_string(),
        "low" => "low".to_string(),
        _ => MEMORY_CONFIDENCE_UNKNOWN.to_string(),
    }
}

fn evidence_confidence_from_body(body: &str) -> String {
    let (frontmatter, _) = split_frontmatter(body);
    if frontmatter.trim().is_empty() {
        return MEMORY_CONFIDENCE_UNKNOWN.to_string();
    }
    for line in frontmatter.lines().take(20) {
        let trimmed = line.trim();
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        if key.trim() == "confidence" {
            return normalize_memory_confidence(value);
        }
    }
    MEMORY_CONFIDENCE_UNKNOWN.to_string()
}

fn is_evidence_only_body(body: &str) -> bool {
    let (frontmatter, content) = split_frontmatter(body);
    !frontmatter.trim().is_empty() && content.trim().is_empty()
}

fn source_json_with_confidence(source: Value, confidence: &str) -> Value {
    let confidence = normalize_memory_confidence(confidence);
    match source {
        Value::Object(mut object) => {
            object.insert("confidence".to_string(), Value::String(confidence));
            Value::Object(object)
        }
        _ => json!({ "confidence": confidence }),
    }
}

fn render_evidence_body(frontmatter: &str, body: &str) -> String {
    if frontmatter.trim().is_empty() {
        return body.trim().to_string();
    }
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        format!("---\n{}\n---", frontmatter.trim())
    } else {
        format!("---\n{}\n---\n\n{trimmed_body}", frontmatter.trim())
    }
}

fn merge_memory_body(existing: &str, incoming: &str) -> String {
    let (existing_frontmatter, existing_content) = split_frontmatter(existing);
    let (incoming_frontmatter, incoming_content) = split_frontmatter(incoming);
    let merged_content = merge_memory_content(&existing_content, &incoming_content);
    let frontmatter = if incoming_frontmatter.trim().is_empty() {
        existing_frontmatter
    } else {
        incoming_frontmatter
    };
    render_evidence_body(&frontmatter, &merged_content)
}

fn merge_memory_content(existing: &str, incoming: &str) -> String {
    let existing_trimmed = existing.trim();
    let incoming_trimmed = incoming.trim();
    if existing_trimmed.is_empty() {
        return incoming_trimmed.to_string();
    }
    if incoming_trimmed.is_empty() {
        return existing_trimmed.to_string();
    }

    let existing_units = split_merge_units(existing_trimmed);
    let incoming_units = split_merge_units(incoming_trimmed);
    if existing_units.is_empty() {
        return incoming_trimmed.to_string();
    }
    if incoming_units.is_empty() {
        return existing_trimmed.to_string();
    }

    let mut merged = existing_units.clone();
    let mut appended = Vec::new();
    for incoming_unit in &incoming_units {
        if let Some(index) = best_merge_match_index(&merged, incoming_unit) {
            merged[index] = incoming_unit.clone();
            continue;
        }
        if !merged
            .iter()
            .chain(appended.iter())
            .any(|existing_unit| merge_units_equivalent(existing_unit, incoming_unit))
        {
            appended.push(incoming_unit.clone());
        }
    }

    merged.extend(appended);
    dedupe_merge_units(merged).join("\n\n")
}

fn split_merge_units(body: &str) -> Vec<String> {
    let normalized = body.replace("\r\n", "\n");
    let mut units = Vec::new();
    for paragraph in normalized.split("\n\n") {
        let trimmed = paragraph.trim();
        if trimmed.is_empty() {
            continue;
        }
        if should_preserve_merge_block(trimmed) {
            units.push(trimmed.to_string());
            continue;
        }
        for raw_line in trimmed.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            if should_preserve_merge_line(line) {
                units.push(line.to_string());
                continue;
            }
            let sentences = split_sentence_like_units(line);
            if sentences.is_empty() {
                units.push(line.to_string());
            } else {
                units.extend(sentences);
            }
        }
    }
    units
}

fn should_preserve_merge_block(text: &str) -> bool {
    text.starts_with("```")
}

fn should_preserve_merge_line(text: &str) -> bool {
    text.starts_with('#')
        || text.starts_with("- ")
        || text.starts_with("* ")
        || text.starts_with("> ")
        || text.starts_with("|")
        || text.starts_with("```")
}

fn split_sentence_like_units(text: &str) -> Vec<String> {
    let mut units = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '。' | '！' | '？' | '；' | '.' | '!' | '?' | ';') {
            let sentence = current.trim();
            if !sentence.is_empty() {
                units.push(sentence.to_string());
            }
            current.clear();
        }
    }
    let tail = current.trim();
    if !tail.is_empty() {
        units.push(tail.to_string());
    }
    units
}

fn normalize_merge_unit_key(input: &str) -> String {
    input
        .trim()
        .to_lowercase()
        .chars()
        .filter_map(|ch| {
            if ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                Some(ch)
            } else if ch.is_whitespace() {
                Some(' ')
            } else {
                None
            }
        })
        .collect::<String>()
}

fn extract_merge_tokens(input: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let normalized = normalize_merge_unit_key(input);
    let mut ascii = String::new();

    for ch in normalized.chars() {
        if ch.is_ascii_alphanumeric() {
            ascii.push(ch);
            continue;
        }
        if !ascii.is_empty() {
            tokens.insert(ascii.clone());
            ascii.clear();
        }
        if ch == ' ' {
            continue;
        }
        tokens.insert(ch.to_string());
    }

    if !ascii.is_empty() {
        tokens.insert(ascii);
    }

    tokens
}

fn merge_units_equivalent(left: &str, right: &str) -> bool {
    let left_key = normalize_merge_unit_key(left);
    let right_key = normalize_merge_unit_key(right);
    left_key == right_key
        || (!left_key.is_empty()
            && !right_key.is_empty()
            && (left_key.contains(&right_key) || right_key.contains(&left_key)))
}

fn merge_unit_similarity(left: &str, right: &str) -> f64 {
    let left_tokens = extract_merge_tokens(left);
    let right_tokens = extract_merge_tokens(right);
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return 0.0;
    }
    let overlap = left_tokens.intersection(&right_tokens).count();
    if overlap == 0 {
        return 0.0;
    }
    let union = left_tokens.union(&right_tokens).count();
    overlap as f64 / union as f64
}

fn best_merge_match_index(existing_units: &[String], incoming_unit: &str) -> Option<usize> {
    let incoming_tokens = extract_merge_tokens(incoming_unit);
    if incoming_tokens.is_empty() {
        return None;
    }

    let mut best: Option<(usize, f64, usize)> = None;
    for (index, existing_unit) in existing_units.iter().enumerate() {
        if merge_units_equivalent(existing_unit, incoming_unit) {
            return Some(index);
        }
        let existing_tokens = extract_merge_tokens(existing_unit);
        if existing_tokens.is_empty() {
            continue;
        }
        let overlap = existing_tokens.intersection(&incoming_tokens).count();
        if overlap < 4 {
            continue;
        }
        let similarity = merge_unit_similarity(existing_unit, incoming_unit);
        if similarity < 0.32 {
            continue;
        }
        match best {
            Some((_, best_similarity, best_overlap))
                if similarity < best_similarity
                    || (similarity == best_similarity && overlap <= best_overlap) => {}
            _ => best = Some((index, similarity, overlap)),
        }
    }

    best.map(|(index, _, _)| index)
}

fn dedupe_merge_units(units: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for unit in units {
        let key = normalize_merge_unit_key(&unit);
        if key.is_empty() {
            continue;
        }
        if seen.insert(key) {
            deduped.push(unit);
        }
    }
    deduped
}

fn parse_frontmatter(raw: &str) -> ParsedFrontmatter {
    let mut meta = ParsedFrontmatter::default();
    let mut in_source = false;
    let mut in_sources = false;
    let mut source = serde_json::Map::new();
    let mut sources = Vec::new();
    let mut current_daily_source: Option<serde_json::Map<String, Value>> = None;

    fn normalize_scalar(value: &str) -> String {
        value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string()
    }

    fn push_daily_source(
        current: &mut Option<serde_json::Map<String, Value>>,
        sources: &mut Vec<Value>,
    ) {
        if let Some(item) = current.take() {
            if !item.is_empty() {
                sources.push(Value::Object(item));
            }
        }
    }

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let is_indented = line.starts_with(' ') || line.starts_with('\t');
        if !is_indented {
            in_source = false;
            if in_sources && !trimmed.starts_with("sources:") {
                push_daily_source(&mut current_daily_source, &mut sources);
                in_sources = false;
            }
        }

        if in_sources && trimmed.starts_with("- ") {
            push_daily_source(&mut current_daily_source, &mut sources);
            let mut item = serde_json::Map::new();
            if let Some((key, value)) = trimmed.trim_start_matches("- ").split_once(':') {
                let value = normalize_scalar(value);
                if !value.is_empty() {
                    item.insert(key.trim().to_string(), Value::String(value));
                }
            }
            current_daily_source = Some(item);
            continue;
        }

        if in_sources && is_indented {
            if let Some((key, value)) = trimmed.split_once(':') {
                let value = normalize_scalar(value);
                if !value.is_empty() {
                    current_daily_source
                        .get_or_insert_with(serde_json::Map::new)
                        .insert(key.trim().to_string(), Value::String(value));
                }
            }
            continue;
        }

        if let Some((key, value)) = trimmed.split_once(':') {
            let value = normalize_scalar(value);
            match key.trim() {
                "name" => meta.name = value,
                "type" => meta.memory_type = value,
                "scope" => meta.scope = value,
                "description" => meta.description = value,
                "headline" => meta.headline = value,
                "date" => meta.date = Some(value),
                "appendCount" => meta.append_count = value.parse::<i64>().unwrap_or(0),
                "createdAt" => meta.created_at = Some(value),
                "updatedAt" => meta.updated_at = Some(value),
                "source" => {
                    in_source = true;
                    meta.source_json = Value::Object(serde_json::Map::new());
                }
                "sources" => {
                    in_sources = true;
                    meta.source_json = Value::Array(Vec::new());
                }
                "links" => meta.links_json = Value::Array(Vec::new()),
                _ if in_source => {
                    if key.trim() == "unreviewed" {
                        let flag = value == "true";
                        meta.unreviewed = flag;
                        source.insert("unreviewed".to_string(), Value::Bool(flag));
                    } else if !value.is_empty() {
                        source.insert(key.trim().to_string(), Value::String(value));
                    }
                }
                _ => {}
            }
        }
    }
    push_daily_source(&mut current_daily_source, &mut sources);
    if !source.is_empty() {
        meta.source_json = Value::Object(source);
    } else if !sources.is_empty() {
        meta.source_json = Value::Array(sources);
    }
    meta
}

fn render_memory_markdown(meta: &ParsedFrontmatter, body: &str) -> String {
    let mut lines = Vec::new();
    let headline = if meta.memory_type == "daily" {
        daily_title_for_meta(&meta.name, meta.date.as_deref())
    } else {
        meta.headline.clone()
    };
    lines.push("---".to_string());
    lines.push(format!("name: {}", meta.name));
    if !meta.description.is_empty() {
        lines.push(format!("description: {}", yaml_scalar(&meta.description)));
    }
    lines.push(format!("type: {}", meta.memory_type));
    lines.push(format!("scope: {}", meta.scope));
    if !headline.is_empty() || meta.memory_type == "daily" {
        lines.push(format!("headline: {}", yaml_scalar(&headline)));
    }
    if let Some(date) = &meta.date {
        lines.push(format!("date: {date}"));
    }
    lines.push(format!(
        "createdAt: {}",
        meta.created_at
            .clone()
            .unwrap_or_else(|| format_rfc3339(now_ms()))
    ));
    lines.push(format!(
        "updatedAt: {}",
        meta.updated_at
            .clone()
            .unwrap_or_else(|| format_rfc3339(now_ms()))
    ));
    if meta.memory_type == "daily" {
        lines.push(format!("appendCount: {}", meta.append_count.max(0)));
        lines.push("sources:".to_string());
        if let Some(items) = meta.source_json.as_array() {
            for item in items {
                let obj = item.as_object();
                lines.push(format!(
                    "  - conversationId: {}",
                    obj.and_then(|v| v.get("conversationId"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                ));
                if let Some(appended_at) = obj
                    .and_then(|v| v.get("appendedAt"))
                    .and_then(Value::as_str)
                {
                    lines.push(format!("    appendedAt: {appended_at}"));
                }
                if let Some(trigger) = obj.and_then(|v| v.get("trigger")).and_then(Value::as_str) {
                    lines.push(format!("    trigger: {trigger}"));
                }
                if let Some(model) = obj.and_then(|v| v.get("model")).and_then(Value::as_str) {
                    lines.push(format!("    model: {}", yaml_scalar(model)));
                }
            }
        }
    } else {
        lines.push("source:".to_string());
        let source = meta.source_json.as_object();
        lines.push(format!(
            "  trigger: {}",
            source
                .and_then(|value| value.get("trigger"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
        ));
        if let Some(conversation_id) = source
            .and_then(|value| value.get("conversationId"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("  conversationId: {conversation_id}"));
        }
        if let Some(model) = source
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("  model: {}", yaml_scalar(model)));
        }
        if let Some(risk_flag) = source
            .and_then(|value| value.get("risk_flag"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("  risk_flag: {}", yaml_scalar(risk_flag)));
        }
        lines.push(format!("  unreviewed: {}", meta.unreviewed));
    }
    lines.push("links: []".to_string());
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push(body.trim().to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn yaml_scalar(value: &str) -> String {
    if value.is_empty() {
        "\"\"".to_string()
    } else if value.contains(':')
        || value.contains('#')
        || value.starts_with(' ')
        || value.ends_with(' ')
    {
        format!("{:?}", value)
    } else {
        value.to_string()
    }
}
fn normalize_source_json(
    existing: Value,
    unreviewed: bool,
    actor: &str,
    conversation_id: Option<&str>,
    trigger: Option<&str>,
    model: Option<&str>,
    risk_flag: Option<&str>,
) -> Value {
    let mut obj = existing.as_object().cloned().unwrap_or_default();
    obj.insert("trigger".to_string(), Value::String(actor.to_string()));
    obj.insert("unreviewed".to_string(), Value::Bool(unreviewed));
    if let Some(conversation_id) = conversation_id.filter(|value| !value.is_empty()) {
        obj.insert(
            "conversationId".to_string(),
            Value::String(conversation_id.to_string()),
        );
    }
    if let Some(trigger) = trigger.filter(|value| !value.is_empty()) {
        obj.insert("lifecycle".to_string(), Value::String(trigger.to_string()));
    }
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        obj.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(risk_flag) = risk_flag.filter(|value| !value.is_empty()) {
        obj.insert(
            "risk_flag".to_string(),
            Value::String(risk_flag.to_string()),
        );
    } else {
        obj.remove("risk_flag");
    }
    Value::Object(obj)
}
