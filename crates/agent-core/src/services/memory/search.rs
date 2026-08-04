impl MemoryStore {
    fn validate_scope_quota(
        &self,
        scope: &str,
        workdir_hash: &str,
        replacing_existing_file: bool,
    ) -> Result<(), String> {
        if replacing_existing_file {
            return Ok(());
        }
        let conn = self.lock_conn()?;
        let used = count_non_daily_entries(&conn, Some((scope, workdir_hash)))?;
        if used >= MAX_SCOPE_ENTRIES {
            return Err(error_json(
                "quota_exceeded",
                "memory scope quota exceeded",
                Some(json!({
                    "action": "list",
                    "scope": scope,
                    "includeDaily": false
                })),
                None,
            ));
        }
        Ok(())
    }

    fn resolve_entry(
        &self,
        slug_input: &str,
        scope_input: Option<&str>,
        workdir: Option<&str>,
        workdir_hash_input: Option<&str>,
    ) -> Result<ResolvedEntry, String> {
        let slug = if is_daily_slug(slug_input) {
            normalize_daily_slug(slug_input)?
        } else {
            normalize_slug(slug_input)?
        };
        let scope = normalize_scope_filter(scope_input)?.unwrap_or_else(|| "auto".to_string());
        let workdir_hash =
            normalize_workdir_hash_input(workdir_hash_input)?.or(optional_workdir_hash(workdir)?);
        let conn = self.lock_conn()?;
        let candidates = load_all_meta(&conn)?
            .into_iter()
            .filter(|entry| entry.slug == slug)
            .filter(|entry| {
                if scope == "global" {
                    entry.scope == "global"
                } else if scope == "project" {
                    entry.scope == "project"
                        && workdir_hash
                            .as_deref()
                            .is_some_and(|hash| hash == entry.workdir_hash)
                } else {
                    entry.scope == "global"
                        || (entry.scope == "project"
                            && workdir_hash
                                .as_deref()
                                .is_some_and(|hash| hash == entry.workdir_hash))
                }
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            let fuzzy = fuzzy_candidates(&conn, &slug)?;
            return Err(error_json(
                "slug_not_found",
                &format!("memory slug '{slug}' was not found"),
                Some(missing_slug_suggested_next_call(&slug)),
                Some(fuzzy),
            ));
        }
        if candidates.len() > 1 && scope == "auto" {
            let candidates_json = candidates
                .iter()
                .map(|entry| json!({ "slug": entry.slug, "scope": entry.scope }))
                .collect::<Vec<_>>();
            return Err(error_json(
                "scope_ambiguous",
                &format!("memory slug '{slug}' exists in multiple scopes"),
                None,
                Some(candidates_json),
            ));
        }
        let meta = candidates.into_iter().next().expect("candidate exists");
        let path = self.path_for_meta(&meta)?;
        if !path.exists() {
            return Err(error_json(
                "slug_not_found",
                &format!("memory file for slug '{}' is missing", meta.slug),
                Some(missing_slug_suggested_next_call(&meta.slug)),
                None,
            ));
        }
        let parsed = parse_memory_file(&path, meta.archived)?;
        Ok(ResolvedEntry { meta, path, parsed })
    }

    fn search_by_scanning(
        &self,
        meta_by_key: &HashMap<(String, String, String), MemoryMeta>,
        terms: &[String],
        type_filter: Option<&str>,
    ) -> Result<Vec<MemorySearchMatch>, String> {
        let mut out = Vec::new();
        for meta in meta_by_key.values() {
            if let Some(filter) = type_filter {
                if meta.memory_type != filter {
                    continue;
                }
            }
            let path = self.path_for_meta(meta)?;
            if !path.exists() {
                continue;
            }
            let parsed = parse_memory_file(&path, meta.archived)?;
            let haystack = format!(
                "{}\n{}\n{}\n{}",
                meta.slug, meta.description, meta.headline, parsed.body
            )
            .to_lowercase();
            let mut best_score = 0.0;
            for term in terms {
                let term_lower = term.to_lowercase();
                if term_lower.is_empty() {
                    continue;
                }
                if haystack.contains(&term_lower) {
                    best_score = f64::max(best_score, term_lower.len() as f64 / 10.0 + 1.0);
                }
            }
            if best_score > 0.0 {
                let (score, raw_score, age_days) = apply_daily_decay(best_score, meta);
                out.push(MemorySearchMatch {
                    slug: meta.slug.clone(),
                    scope: meta.scope.clone(),
                    workdir_hash: meta.workdir_hash.clone(),
                    memory_type: meta.memory_type.clone(),
                    description: meta.description.clone(),
                    headline: meta.headline.clone(),
                    snippet: build_snippet(&parsed.body, terms),
                    score,
                    raw_score,
                    age_days,
                    unreviewed: meta.unreviewed,
                    confidence: meta.confidence.clone(),
                });
            }
        }
        Ok(out)
    }


}

fn search_fts(
    conn: &Connection,
    term: &str,
    meta_by_key: &HashMap<(String, String, String), MemoryMeta>,
    type_filter: Option<&str>,
) -> Result<Vec<MemorySearchMatch>, String> {
    let query = fts_phrase(term);
    let mut out = Vec::new();
    search_fts_table(
        conn,
        "memory_fts",
        &query,
        meta_by_key,
        type_filter,
        &mut out,
        false,
    )?;
    if contains_cjk(term) || out.len() < DEFAULT_SEARCH_LIMIT {
        search_fts_table(
            conn,
            "memory_fts_tri",
            &query,
            meta_by_key,
            type_filter,
            &mut out,
            true,
        )?;
    }
    Ok(out)
}

fn search_fts_table(
    conn: &Connection,
    table: &str,
    query: &str,
    meta_by_key: &HashMap<(String, String, String), MemoryMeta>,
    type_filter: Option<&str>,
    out: &mut Vec<MemorySearchMatch>,
    tri: bool,
) -> Result<(), String> {
    let sql = if tri {
        format!(
            "SELECT slug, scope, workdir_hash, snippet({table}, 5, '[', ']', '...', 12), bm25({table}) FROM {table} WHERE {table} MATCH ?1 LIMIT 32"
        )
    } else {
        format!(
            "SELECT slug, scope, workdir_hash, snippet({table}, 6, '[', ']', '...', 12), bm25({table}) FROM {table} WHERE {table} MATCH ?1 LIMIT 32"
        )
    };
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备记忆 FTS 查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![query], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })
        .map_err(|e| format!("执行记忆 FTS 查询失败：{e}"))?;
    for row in rows {
        let (slug, scope, workdir_hash, snippet, bm25) =
            row.map_err(|e| format!("读取记忆 FTS 结果失败：{e}"))?;
        let Some(meta) = meta_by_key.get(&(scope, workdir_hash, slug)) else {
            continue;
        };
        if let Some(filter) = type_filter {
            if meta.memory_type != filter {
                continue;
            }
        }
        let raw = if bm25 <= 0.0 {
            -bm25
        } else {
            1.0 / (1.0 + bm25)
        };
        let (score, raw_score, age_days) = apply_daily_decay(raw, meta);
        out.push(MemorySearchMatch {
            slug: meta.slug.clone(),
            scope: meta.scope.clone(),
            workdir_hash: meta.workdir_hash.clone(),
            memory_type: meta.memory_type.clone(),
            description: meta.description.clone(),
            headline: meta.headline.clone(),
            snippet,
            score,
            raw_score,
            age_days,
            unreviewed: meta.unreviewed,
            confidence: meta.confidence.clone(),
        });
    }
    Ok(())
}

fn dedupe_and_apply_project_shadow(matches: Vec<MemorySearchMatch>) -> Vec<MemorySearchMatch> {
    let mut by_key: HashMap<(String, String, String), MemorySearchMatch> = HashMap::new();
    for item in matches {
        let key = (
            item.scope.clone(),
            item.memory_type.clone(),
            item.slug.clone(),
        );
        by_key
            .entry(key)
            .and_modify(|existing| {
                if item.score > existing.score {
                    *existing = item.clone();
                }
            })
            .or_insert(item);
    }
    let mut items = by_key.into_values().collect::<Vec<_>>();
    let project_slugs = items
        .iter()
        .filter(|item| item.scope == "project" && item.memory_type != "daily")
        .map(|item| item.slug.clone())
        .collect::<HashSet<_>>();
    items.retain(|item| {
        item.memory_type == "daily" || item.scope != "global" || !project_slugs.contains(&item.slug)
    });
    items
}

fn scope_matches(
    entry: &MemorySearchMatch,
    scope_filter: Option<&str>,
    workdir_hash: Option<&str>,
) -> bool {
    match scope_filter {
        Some("global") => entry.scope == "global",
        Some("project") => {
            entry.scope == "project" && workdir_hash.is_some_and(|hash| entry.workdir_hash == hash)
        }
        _ => {
            entry.scope == "global"
                || (entry.scope == "project"
                    && workdir_hash.is_some_and(|hash| entry.workdir_hash == hash))
        }
    }
}
fn apply_daily_decay(raw_score: f64, meta: &MemoryMeta) -> (f64, Option<f64>, Option<f64>) {
    let weighted_score = raw_score * memory_priority_weight(meta);
    if meta.memory_type != "daily" {
        return (weighted_score, None, None);
    }
    let Some(date) = meta.date_local.as_deref() else {
        return (weighted_score, Some(raw_score), None);
    };
    let age_days = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .map(|entry_date| {
            let today = Local::now().date_naive();
            (today.signed_duration_since(entry_date).num_days().max(0)) as f64
        })
        .unwrap_or(0.0);
    let score = weighted_score * (-age_days / 30.0).exp();
    (score, Some(raw_score), Some(age_days))
}

fn memory_priority_weight(meta: &MemoryMeta) -> f64 {
    if meta.memory_type == "daily" {
        return MEMORY_SCORE_WEIGHT_DAILY;
    }
    if meta.scope == "project" {
        return MEMORY_SCORE_WEIGHT_PROJECT;
    }
    match meta.memory_type.as_str() {
        "user" => MEMORY_SCORE_WEIGHT_USER,
        "feedback" => MEMORY_SCORE_WEIGHT_FEEDBACK,
        "reference" => MEMORY_SCORE_WEIGHT_REFERENCE,
        _ => MEMORY_SCORE_WEIGHT_REFERENCE,
    }
}

fn fts_phrase(input: &str) -> String {
    let escaped = input.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

fn expand_memory_search_terms(query: &str) -> Vec<String> {
    let mut terms = vec![query.trim().to_string()];
    let lower = query.to_lowercase();
    if lower.contains("我是谁")
        || lower.contains("我的名字")
        || lower.contains("我叫什么")
        || lower.contains("who am i")
        || lower.contains("my name")
    {
        terms.extend([
            "我叫".to_string(),
            "我的名字是".to_string(),
            "我是".to_string(),
            "身份".to_string(),
            "name".to_string(),
            "identity".to_string(),
            "profile".to_string(),
            "user".to_string(),
        ]);
    }
    if lower.contains("偏好") || lower.contains("习惯") || lower.contains("preference") {
        terms.extend([
            "偏好".to_string(),
            "习惯".to_string(),
            "prefer".to_string(),
            "feedback".to_string(),
        ]);
    }
    terms.sort();
    terms.dedup();
    terms
}

fn contains_cjk(input: &str) -> bool {
    input
        .chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

fn build_snippet(body: &str, terms: &[String]) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = compact.to_lowercase();
    for term in terms {
        let term_lower = term.to_lowercase();
        if let Some(pos) = lower.find(&term_lower) {
            let start = floor_char_boundary(&compact, pos.saturating_sub(80));
            let end = ceil_char_boundary(
                &compact,
                pos.saturating_add(term_lower.len()).saturating_add(160),
            );
            if start >= end {
                return truncate_chars(&compact, 240);
            }
            return compact[start..end].to_string();
        }
    }
    truncate_chars(&compact, 240)
}
fn floor_char_boundary(input: &str, index: usize) -> usize {
    let mut index = index.min(input.len());
    while index > 0 && !input.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(input: &str, index: usize) -> usize {
    let mut index = index.min(input.len());
    while index < input.len() && !input.is_char_boundary(index) {
        index += 1;
    }
    index
}
