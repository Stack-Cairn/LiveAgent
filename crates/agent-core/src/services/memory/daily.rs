impl MemoryStore {
    pub fn today_local_date(&self, rollover_hour: Option<u32>) -> String {
        today_local(rollover_hour.unwrap_or(DEFAULT_ROLLOVER_HOUR)).to_string()
    }

    pub fn today_daily(
        &self,
        rollover_hour: Option<u32>,
    ) -> Result<Option<MemoryReadResponse>, String> {
        let slug = format!("daily-{}", self.today_local_date(rollover_hour));
        match self.read(MemoryReadArgs {
            slug,
            scope: Some("global".to_string()),
            workdir: None,
            workdir_hash: None,
            offset: None,
            length: None,
        }) {
            Ok(resp) => Ok(Some(resp)),
            Err(error) if error.contains("\"slug_not_found\"") => Ok(None),
            Err(error) => Err(error),
        }
    }

}

impl MemoryStore {
    fn append_daily(
        &self,
        slug_input: String,
        bullet: String,
        options: WriteOptions,
    ) -> Result<MemoryMutationResponse, String> {
        let slug = normalize_daily_slug(&slug_input)?;
        validate_body_limit(&bullet, MAX_DAILY_BODY_BYTES, &slug)?;
        let _mutation_guard = self.lock_mutation()?;
        let date = slug.trim_start_matches("daily-").to_string();
        let path = self.global_daily_dir().join(format!("{date}.md"));
        let existing = if path.exists() {
            Some(parse_memory_file(&path, false)?)
        } else {
            None
        };
        let now = now_ms();
        let mut meta = existing
            .as_ref()
            .map(|entry| entry.meta.clone())
            .unwrap_or_else(|| ParsedFrontmatter {
                name: slug.clone(),
                memory_type: "daily".to_string(),
                scope: "global".to_string(),
                description: String::new(),
                headline: String::new(),
                date: Some(date.clone()),
                append_count: 0,
                created_at: Some(format_rfc3339(now)),
                updated_at: Some(format_rfc3339(now)),
                source_json: Value::Null,
                links_json: Value::Array(Vec::new()),
                unreviewed: false,
            });
        meta.name = slug.clone();
        meta.memory_type = "daily".to_string();
        meta.scope = "global".to_string();
        meta.date = Some(date.clone());
        meta.headline = daily_title_for_date(&date);
        meta.append_count += 1;
        meta.updated_at = Some(format_rfc3339(now));
        meta.source_json = append_daily_source(
            meta.source_json,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
        );

        let previous_body = existing
            .map(|entry| entry.body.trim_end().to_string())
            .unwrap_or_default();
        let normalized_bullet = bullet.trim();
        let body = if previous_body.is_empty() {
            normalized_bullet.to_string()
        } else if normalized_bullet.is_empty() {
            previous_body
        } else {
            format!("{previous_body}\n\n{normalized_bullet}")
        };
        if body.as_bytes().len() > MAX_DAILY_BODY_BYTES {
            return Err(error_json(
                "body_too_large",
                "daily memory body exceeds 32 KB",
                Some(json!({
                    "action": "update",
                    "slug": slug,
                    "mode": "append",
                    "body": "<consolidated daily summary>"
                })),
                None,
            ));
        }
        let warning = if body.as_bytes().len() >= DAILY_NEAR_LIMIT_BYTES {
            Some(format!(
                "{slug} is near the 32 KB daily limit; consolidate soon"
            ))
        } else {
            None
        };
        let content = render_memory_markdown(&meta, &body);
        let created = !path.exists();
        self.atomic_replace_entry_file(&path, &content)?;
        let parsed = ParsedMemoryFile {
            meta,
            body,
            path: path.clone(),
            archived: false,
        };
        let mut conn = self.lock_conn()?;
        index_parsed_file(&mut conn, &parsed, &path, false)?;
        insert_audit_log(
            &mut conn,
            if created { "write" } else { "update" },
            "global",
            "",
            &slug,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            json!({ "type": "daily", "append": true }),
        )?;
        drop(conn);
        self.refresh_memory_indexes()?;
        Ok(MemoryMutationResponse {
            slug,
            scope: "global".to_string(),
            created,
            updated: !created,
            deleted: false,
            index_updated: true,
            warning,
            applied_confidence: None,
            auto_downgraded: None,
        })
    }


}

fn missing_slug_suggested_next_call(slug: &str) -> Value {
    if let Some(local_date) = daily_slug_local_date(slug) {
        return json!({
            "action": "search",
            "query": local_date,
            "include_history": true,
            "history_date_local": local_date,
            "history_time_mode": "message",
            "limit": DEFAULT_SEARCH_LIMIT
        });
    }
    json!({ "action": "search", "query": slug.replace('-', " ") })
}

fn daily_slug_local_date(slug: &str) -> Option<&str> {
    let date = slug.strip_prefix("daily-")?;
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .map(|_| date)
}

fn daily_title_for_date(date: &str) -> String {
    date.to_string()
}

fn daily_title_for_meta(slug: &str, date_local: Option<&str>) -> String {
    date_local
        .or_else(|| daily_slug_local_date(slug))
        .map(daily_title_for_date)
        .unwrap_or_else(|| slug.trim_start_matches("daily-").to_string())
}
fn today_local(rollover_hour: u32) -> NaiveDate {
    let now = Local::now();
    let hour = rollover_hour.min(23);
    let mut date = now.date_naive();
    if now.hour() < hour {
        date = date.pred_opt().unwrap_or(date);
    }
    date
}
fn append_daily_source(
    existing: Value,
    conversation_id: Option<&str>,
    trigger: Option<&str>,
    model: Option<&str>,
) -> Value {
    let mut items = existing.as_array().cloned().unwrap_or_default();
    items.push(json!({
        "conversationId": conversation_id.unwrap_or(""),
        "appendedAt": format_rfc3339(now_ms()),
        "trigger": trigger.unwrap_or("end"),
        "model": model.unwrap_or("")
    }));
    Value::Array(items)
}
