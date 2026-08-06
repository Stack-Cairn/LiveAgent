fn history_fts_phrase(input: &str) -> String {
    let escaped = input.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

fn history_fts_score(bm25: f64) -> f64 {
    if bm25 <= 0.0 {
        -bm25
    } else {
        1.0 / (1.0 + bm25)
    }
}

fn escape_history_like(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        match ch {
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    format!("%{out}%")
}

fn history_plain_snippet(text: &str) -> String {
    let normalized = normalize_history_search_text(text);
    if normalized.chars().count() <= 160 {
        normalized
    } else {
        format!("{}...", normalized.chars().take(160).collect::<String>())
    }
}

fn parse_history_time_mode(input: Option<&str>) -> Result<HistorySearchTimeMode, String> {
    match input.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(HistorySearchTimeMode::Message),
        Some("message") => Ok(HistorySearchTimeMode::Message),
        Some("updated") | Some("segment") => Ok(HistorySearchTimeMode::Updated),
        Some("conversation") => Ok(HistorySearchTimeMode::Conversation),
        Some(other) => Err(format!(
            "historyTimeMode 只能是 message、updated 或 conversation，当前是 {other}"
        )),
    }
}

#[cfg(test)]
fn default_history_search_filter() -> HistorySearchFilter {
    HistorySearchFilter {
        since: None,
        until: None,
        time_mode: HistorySearchTimeMode::Message,
    }
}

fn local_datetime_to_ms(value: chrono::NaiveDateTime, latest: bool) -> Result<i64, String> {
    match Local.from_local_datetime(&value) {
        LocalResult::Single(datetime) => Ok(datetime.timestamp_millis()),
        LocalResult::Ambiguous(first, second) => {
            let timestamp = if latest {
                first.timestamp_millis().max(second.timestamp_millis())
            } else {
                first.timestamp_millis().min(second.timestamp_millis())
            };
            Ok(timestamp)
        }
        LocalResult::None => Err("本地日期边界无效，无法转换为时间戳".to_string()),
    }
}

fn local_date_bounds_ms(date: &str) -> Result<(i64, i64), String> {
    let date = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| "historyDateLocal 必须是 YYYY-MM-DD".to_string())?;
    let start = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "historyDateLocal 起始时间无效".to_string())?;
    let next_date = date
        .succ_opt()
        .ok_or_else(|| "historyDateLocal 结束日期无效".to_string())?;
    let end = next_date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "historyDateLocal 结束时间无效".to_string())?;
    Ok((
        local_datetime_to_ms(start, false)?,
        local_datetime_to_ms(end, true)?,
    ))
}

fn resolve_history_search_filter(
    history_since: Option<i64>,
    history_until: Option<i64>,
    history_date_local: Option<&str>,
    history_time_mode: Option<&str>,
) -> Result<HistorySearchFilter, String> {
    let mut since = history_since;
    let mut until = history_until;
    if let Some(date) = history_date_local
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let (date_since, date_until) = local_date_bounds_ms(date)?;
        since = Some(since.map_or(date_since, |value| value.max(date_since)));
        until = Some(until.map_or(date_until, |value| value.min(date_until)));
    }
    if let (Some(since), Some(until)) = (since, until) {
        if since >= until {
            return Err("历史搜索时间范围无效：historySince 必须早于 historyUntil".to_string());
        }
    }
    Ok(HistorySearchFilter {
        since,
        until,
        time_mode: parse_history_time_mode(history_time_mode)?,
    })
}

fn history_message_time_column(filter: &HistorySearchFilter) -> &'static str {
    match filter.time_mode {
        HistorySearchTimeMode::Message => "message_updated_at",
        HistorySearchTimeMode::Updated => "segment_updated_at",
        HistorySearchTimeMode::Conversation => "conversation_updated_at",
    }
}

fn history_segment_time_column(filter: &HistorySearchFilter) -> &'static str {
    match filter.time_mode {
        HistorySearchTimeMode::Conversation => "conversation_updated_at",
        HistorySearchTimeMode::Message | HistorySearchTimeMode::Updated => "segment_updated_at",
    }
}

fn expand_history_search_terms(query: &str) -> Vec<String> {
    let trimmed = query.trim();
    let mut terms = Vec::new();
    if !trimmed.is_empty() {
        terms.push(trimmed.to_string());
    }

    let lower = trimmed.to_lowercase();
    if lower.contains("我是谁")
        || lower.contains("我的名字")
        || lower.contains("我叫什么")
        || lower.contains("who am i")
        || lower.contains("my name")
    {
        terms.extend([
            "我叫".to_string(),
            "叫我".to_string(),
            "称呼我".to_string(),
            "我的名字是".to_string(),
            "my name is".to_string(),
            "call me".to_string(),
        ]);
    }
    if lower.contains("偏好") || lower.contains("习惯") || lower.contains("preference") {
        terms.extend(["偏好".to_string(), "习惯".to_string(), "prefer".to_string()]);
    }

    let mut deduped = Vec::new();
    for term in terms {
        let term = term.trim();
        if term.is_empty() || deduped.iter().any(|existing| existing == term) {
            continue;
        }
        deduped.push(term.to_string());
    }
    deduped
}

fn should_scan_history_plain_text(term: &str, current_matches: usize, limit: usize) -> bool {
    current_matches < limit || term.chars().count() < 3
}

fn history_match_key(match_item: &MemoryHistorySearchMatch) -> String {
    format!(
        "{}:{}:{}:{}",
        match_item.source,
        match_item.conversation_id,
        match_item.segment_index,
        match_item.message_index.unwrap_or(-1)
    )
}

fn push_history_search_match(
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
    match_item: MemoryHistorySearchMatch,
) {
    let key = history_match_key(&match_item);
    match out.get(&key) {
        Some(existing) if existing.score >= match_item.score => {}
        _ => {
            out.insert(key, match_item);
        }
    }
}

fn search_chat_history_message_plain(
    conn: &Connection,
    term: &str,
    limit: usize,
    filter: &HistorySearchFilter,
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
) -> Result<(), String> {
    let pattern = escape_history_like(term);
    let time_column = history_message_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            message_index,
            message_id,
            role,
            body,
            CAST(message_updated_at AS INTEGER)
        FROM chatHistoryMessageFts
        WHERE (body LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) >= ?2)
          AND (?3 IS NULL OR CAST({time_column} AS INTEGER) < ?3)
        LIMIT ?4
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史消息纯文本回退查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![pattern, filter.since, filter.until, limit as i64],
            |row| {
                Ok(MemoryHistorySearchMatch {
                    source: "message".to_string(),
                    conversation_id: row.get("conversation_id")?,
                    title: row.get("title")?,
                    cwd: row.get("cwd")?,
                    segment_index: row.get("segment_index")?,
                    segment_id: row.get("segment_id")?,
                    message_index: row.get("message_index")?,
                    message_id: row.get("message_id")?,
                    role: row.get("role")?,
                    snippet: history_plain_snippet(&row.get::<_, String>(8)?),
                    score: 0.000_000_1,
                    raw_score: Some(0.000_000_1),
                    updated_at: row.get(9)?,
                })
            },
        )
        .map_err(|e| format!("执行历史消息纯文本回退查询失败：{e}"))?;
    for row in rows {
        push_history_search_match(
            out,
            row.map_err(|e| format!("读取历史消息纯文本回退结果失败：{e}"))?,
        );
    }
    Ok(())
}

fn search_chat_history_segment_plain(
    conn: &Connection,
    term: &str,
    limit: usize,
    filter: &HistorySearchFilter,
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
) -> Result<(), String> {
    let pattern = escape_history_like(term);
    let time_column = history_segment_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            body,
            CAST(segment_updated_at AS INTEGER)
        FROM chatHistorySegmentFts
        WHERE (body LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) >= ?2)
          AND (?3 IS NULL OR CAST({time_column} AS INTEGER) < ?3)
        LIMIT ?4
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史分段纯文本回退查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![pattern, filter.since, filter.until, limit as i64],
            |row| {
                Ok(MemoryHistorySearchMatch {
                    source: "segment".to_string(),
                    conversation_id: row.get("conversation_id")?,
                    title: row.get("title")?,
                    cwd: row.get("cwd")?,
                    segment_index: row.get("segment_index")?,
                    segment_id: row.get("segment_id")?,
                    message_index: None,
                    message_id: None,
                    role: None,
                    snippet: history_plain_snippet(&row.get::<_, String>(5)?),
                    score: 0.000_000_08,
                    raw_score: Some(0.000_000_08),
                    updated_at: row.get(6)?,
                })
            },
        )
        .map_err(|e| format!("执行历史分段纯文本回退查询失败：{e}"))?;
    for row in rows {
        push_history_search_match(
            out,
            row.map_err(|e| format!("读取历史分段纯文本回退结果失败：{e}"))?,
        );
    }
    Ok(())
}

fn is_history_time_overview_query(query: &str) -> bool {
    let trimmed = query.trim().to_lowercase();
    if trimmed.is_empty() {
        return false;
    }
    let has_date = Regex::new(r"\b\d{4}-\d{2}-\d{2}\b")
        .expect("valid date regex")
        .is_match(&trimmed);
    has_date
        || [
            "今天",
            "昨天",
            "前天",
            "当天",
            "那天",
            "最近",
            "做了什么",
            "干了什么",
            "活动",
            "回顾",
            "时间线",
            "工作",
            "进展",
            "timeline",
            "activity",
            "review",
            "what did",
        ]
        .iter()
        .any(|needle| trimmed.contains(needle))
}

fn search_chat_history_time_window(
    conn: &Connection,
    limit: usize,
    filter: &HistorySearchFilter,
) -> Result<Vec<MemoryHistorySearchMatch>, String> {
    if filter.since.is_none() && filter.until.is_none() {
        return Ok(Vec::new());
    }
    let time_column = history_segment_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            body,
            CAST(segment_updated_at AS INTEGER)
        FROM chatHistorySegmentFts
        WHERE (?1 IS NULL OR CAST({time_column} AS INTEGER) >= ?1)
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) < ?2)
        ORDER BY CAST({time_column} AS INTEGER) DESC, conversation_id ASC, segment_index ASC
        LIMIT ?3
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史时间窗口查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![filter.since, filter.until, limit as i64], |row| {
            Ok(MemoryHistorySearchMatch {
                source: "segment".to_string(),
                conversation_id: row.get("conversation_id")?,
                title: row.get("title")?,
                cwd: row.get("cwd")?,
                segment_index: row.get("segment_index")?,
                segment_id: row.get("segment_id")?,
                message_index: None,
                message_id: None,
                role: None,
                snippet: history_plain_snippet(&row.get::<_, String>(5)?),
                score: 0.000_000_05,
                raw_score: Some(0.000_000_05),
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("执行历史时间窗口查询失败：{e}"))?;
    let mut matches = Vec::new();
    for row in rows {
        matches.push(row.map_err(|e| format!("读取历史时间窗口结果失败：{e}"))?);
    }
    Ok(matches)
}

fn search_chat_history_message_fts(
    conn: &Connection,
    query: &str,
    limit: usize,
    filter: &HistorySearchFilter,
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
) -> Result<(), String> {
    let time_column = history_message_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            message_index,
            message_id,
            role,
            snippet(chatHistoryMessageFts, 8, '[', ']', '...', 20),
            bm25(chatHistoryMessageFts),
            CAST(message_updated_at AS INTEGER)
        FROM chatHistoryMessageFts
        WHERE chatHistoryMessageFts MATCH ?1
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) >= ?2)
          AND (?3 IS NULL OR CAST({time_column} AS INTEGER) < ?3)
        LIMIT ?4
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史消息 FTS 查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![query, filter.since, filter.until, limit as i64],
            |row| {
                let bm25 = row.get::<_, f64>(9)?;
                let score = history_fts_score(bm25);
                Ok(MemoryHistorySearchMatch {
                    source: "message".to_string(),
                    conversation_id: row.get("conversation_id")?,
                    title: row.get("title")?,
                    cwd: row.get("cwd")?,
                    segment_index: row.get("segment_index")?,
                    segment_id: row.get("segment_id")?,
                    message_index: row.get("message_index")?,
                    message_id: row.get("message_id")?,
                    role: row.get("role")?,
                    snippet: row.get(8)?,
                    score,
                    raw_score: Some(score),
                    updated_at: row.get(10)?,
                })
            },
        )
        .map_err(|e| format!("执行历史消息 FTS 查询失败：{e}"))?;

    for row in rows {
        push_history_search_match(
            out,
            row.map_err(|e| format!("读取历史消息 FTS 结果失败：{e}"))?,
        );
    }
    Ok(())
}

fn search_chat_history_segment_fts(
    conn: &Connection,
    query: &str,
    limit: usize,
    filter: &HistorySearchFilter,
    out: &mut HashMap<String, MemoryHistorySearchMatch>,
) -> Result<(), String> {
    let time_column = history_segment_time_column(filter);
    let sql = format!(
        "
        SELECT
            conversation_id,
            title,
            cwd,
            segment_index,
            segment_id,
            snippet(chatHistorySegmentFts, 5, '[', ']', '...', 24),
            bm25(chatHistorySegmentFts),
            CAST(segment_updated_at AS INTEGER)
        FROM chatHistorySegmentFts
        WHERE chatHistorySegmentFts MATCH ?1
          AND (?2 IS NULL OR CAST({time_column} AS INTEGER) >= ?2)
          AND (?3 IS NULL OR CAST({time_column} AS INTEGER) < ?3)
        LIMIT ?4
        "
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备历史分段 FTS 查询失败：{e}"))?;
    let rows = stmt
        .query_map(
            params![query, filter.since, filter.until, limit as i64],
            |row| {
                let bm25 = row.get::<_, f64>(6)?;
                let score = history_fts_score(bm25);
                Ok(MemoryHistorySearchMatch {
                    source: "segment".to_string(),
                    conversation_id: row.get("conversation_id")?,
                    title: row.get("title")?,
                    cwd: row.get("cwd")?,
                    segment_index: row.get("segment_index")?,
                    segment_id: row.get("segment_id")?,
                    message_index: None,
                    message_id: None,
                    role: None,
                    snippet: row.get(5)?,
                    score,
                    raw_score: Some(score),
                    updated_at: row.get(7)?,
                })
            },
        )
        .map_err(|e| format!("执行历史分段 FTS 查询失败：{e}"))?;

    for row in rows {
        push_history_search_match(
            out,
            row.map_err(|e| format!("读取历史分段 FTS 结果失败：{e}"))?,
        );
    }
    Ok(())
}

fn search_chat_history_fts(
    conn: &Connection,
    query: &str,
    limit: usize,
    filter: &HistorySearchFilter,
) -> Result<Vec<MemoryHistorySearchMatch>, String> {
    let terms = expand_history_search_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let per_table_limit = limit
        .saturating_mul(2)
        .clamp(1, MAX_HISTORY_SEARCH_LIMIT * 2);
    let mut by_key = HashMap::new();
    for term in terms {
        let fts_query = history_fts_phrase(&term);
        search_chat_history_message_fts(conn, &fts_query, per_table_limit, filter, &mut by_key)?;
        search_chat_history_segment_fts(conn, &fts_query, per_table_limit, filter, &mut by_key)?;
        if should_scan_history_plain_text(&term, by_key.len(), limit) {
            search_chat_history_message_plain(conn, &term, per_table_limit, filter, &mut by_key)?;
            search_chat_history_segment_plain(conn, &term, per_table_limit, filter, &mut by_key)?;
        }
    }

    let mut matches = by_key.into_values().collect::<Vec<_>>();
    matches.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.conversation_id.cmp(&b.conversation_id))
    });
    matches.truncate(limit);
    Ok(matches)
}

fn search_chat_history_fts_with_refresh(
    conn: &Connection,
    query: &str,
    limit: usize,
    filter: &HistorySearchFilter,
) -> Result<Vec<MemoryHistorySearchMatch>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    refresh_chat_history_fts(conn, filter)?;
    let matches = search_chat_history_fts(conn, query, limit, filter)?;
    if matches.is_empty() && is_history_time_overview_query(query) {
        return search_chat_history_time_window(conn, limit, filter);
    }
    Ok(matches)
}

fn should_include_history_for_memory_search(args: &MemorySearchArgs) -> bool {
    args.include_history.unwrap_or(false)
}

pub fn search_chat_history_for_memory_sync(
    args: &MemorySearchArgs,
) -> Result<Vec<MemoryHistorySearchMatch>, String> {
    if !should_include_history_for_memory_search(args) {
        return Ok(Vec::new());
    }
    let limit = args
        .limit
        .unwrap_or(DEFAULT_HISTORY_SEARCH_LIMIT)
        .clamp(1, MAX_HISTORY_SEARCH_LIMIT);
    let filter = resolve_history_search_filter(
        args.history_since,
        args.history_until,
        args.history_date_local.as_deref(),
        args.history_time_mode.as_deref(),
    )?;
    let conn = open_db()?;
    search_chat_history_fts_with_refresh(&conn, &args.query, limit, &filter)
}
