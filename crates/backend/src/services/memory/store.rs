impl MemoryStore {
    pub fn open() -> Result<Self, String> {
        let root = memory_root_dir()?;
        ensure_root_dirs(&root)?;
        let db_path = root.join(DB_FILENAME);
        let conn = open_memory_connection(&db_path)?;
        let store = Self {
            root,
            db_path,
            conn: Mutex::new(conn),
            mutation_lock: Mutex::new(()),
        };
        store.reconcile()?;
        store.gc_old_wipe_backups()?;
        store.gc_old_organize_snapshots()?;
        Ok(store)
    }

    pub fn list(&self, args: MemoryListArgs) -> Result<MemoryListResponse, String> {
        let workdir_hash = optional_workdir_hash(args.workdir.as_deref())?;
        let include_all_projects = args.include_all_projects.unwrap_or(false);
        let type_filter = args
            .memory_type
            .as_deref()
            .map(normalize_type_filter)
            .transpose()?;
        let include_daily =
            args.include_daily.unwrap_or(false) || type_filter.as_deref() == Some("daily");
        let limit = args.limit.unwrap_or(200).min(1000);
        let offset = args.offset.unwrap_or(0);
        let scope_filter = normalize_scope_filter(args.scope.as_deref())?;
        let conn = self.lock_conn()?;

        let mut rows = load_all_meta(&conn)?;
        self.enrich_project_paths(&mut rows);
        rows.retain(|entry| include_daily || entry.memory_type != "daily");
        if let Some(scope) = scope_filter.as_deref() {
            rows.retain(|entry| entry.scope == scope);
        }
        if let Some(filter) = type_filter {
            rows.retain(|entry| entry.memory_type == filter);
        }
        if !include_all_projects {
            if let Some(hash) = workdir_hash.as_deref() {
                rows.retain(|entry| {
                    entry.scope == "global"
                        || (entry.scope == "project" && entry.workdir_hash == hash)
                });
            } else {
                rows.retain(|entry| entry.scope == "global");
            }
        }
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.slug.cmp(&b.slug))
        });

        let truncated = rows.len() > offset.saturating_add(limit);
        rows = rows.into_iter().skip(offset).take(limit).collect();
        let quota = build_list_quota(&conn, workdir_hash.as_deref(), scope_filter.as_deref())?;
        Ok(MemoryListResponse {
            entries: rows,
            truncated,
            quota,
        })
    }

    pub fn read(&self, args: MemoryReadArgs) -> Result<MemoryReadResponse, String> {
        let resolved = self.resolve_entry(
            &args.slug,
            args.scope.as_deref(),
            args.workdir.as_deref(),
            args.workdir_hash.as_deref(),
        )?;
        let body = resolved.parsed.body;
        let lines = body.lines().map(ToString::to_string).collect::<Vec<_>>();
        let total_lines = lines.len();
        let offset = args.offset.unwrap_or(0).min(total_lines);
        let default_len = total_lines.saturating_sub(offset);
        let length = args.length.unwrap_or(default_len).min(default_len);
        let truncated = offset > 0 || offset + length < total_lines;
        let window_body = if total_lines == 0 {
            String::new()
        } else {
            lines[offset..offset + length].join("\n")
        };
        let headline = if resolved.meta.memory_type == "daily" {
            daily_title_for_meta(&resolved.meta.slug, resolved.meta.date_local.as_deref())
        } else {
            resolved.meta.headline.clone()
        };

        Ok(MemoryReadResponse {
            slug: resolved.meta.slug,
            scope: resolved.meta.scope,
            memory_type: resolved.meta.memory_type,
            description: resolved.meta.description,
            headline,
            body: window_body,
            total_lines,
            window: MemoryReadWindow {
                offset,
                length,
                truncated,
            },
            meta: MemoryReadMeta {
                unreviewed: resolved.meta.unreviewed,
                confidence: resolved.meta.confidence,
                source: resolved.parsed.meta.source_json,
                created_at: resolved.meta.created_at,
                updated_at: resolved.meta.updated_at,
                archived: resolved.meta.archived,
            },
        })
    }

    pub fn search(&self, args: MemorySearchArgs) -> Result<MemorySearchResponse, String> {
        let query = args.query.trim();
        if query.is_empty() {
            return Ok(MemorySearchResponse {
                matches: Vec::new(),
                history_matches: Vec::new(),
                used_fallback: false,
            });
        }
        let workdir_hash = optional_workdir_hash(args.workdir.as_deref())?;
        let scope_filter = normalize_scope_filter(args.scope.as_deref())?;
        let type_filter = args
            .memory_type
            .as_deref()
            .map(normalize_search_type_filter)
            .transpose()?;
        let limit = args
            .limit
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT);
        let conn = self.lock_conn()?;
        let meta_by_key = load_all_meta(&conn)?
            .into_iter()
            .map(|meta| {
                (
                    (
                        meta.scope.clone(),
                        meta.workdir_hash.clone(),
                        meta.slug.clone(),
                    ),
                    meta,
                )
            })
            .collect::<HashMap<_, _>>();

        let mut matches = Vec::new();
        let mut used_fallback = false;
        let terms = expand_memory_search_terms(query);

        for term in &terms {
            let term_matches = search_fts(&conn, term, &meta_by_key, type_filter.as_deref())
                .unwrap_or_else(|_| {
                    used_fallback = true;
                    Vec::new()
                });
            matches.extend(term_matches);
        }
        drop(conn);

        if matches.len() < limit {
            used_fallback = true;
            matches.extend(self.search_by_scanning(
                &meta_by_key,
                &terms,
                type_filter.as_deref(),
            )?);
        }

        matches
            .retain(|entry| scope_matches(entry, scope_filter.as_deref(), workdir_hash.as_deref()));
        matches = dedupe_and_apply_project_shadow(matches);
        matches.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    b.raw_score
                        .partial_cmp(&a.raw_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| b.slug.cmp(&a.slug))
        });
        matches.truncate(limit);

        Ok(MemorySearchResponse {
            matches,
            history_matches: Vec::new(),
            used_fallback,
        })
    }


}
