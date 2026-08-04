impl MemoryStore {
    fn write_entry(
        &self,
        slug_input: String,
        scope_input: String,
        workdir: Option<String>,
        memory_type_input: String,
        description_input: String,
        body: String,
        mut options: WriteOptions,
        upsert: bool,
    ) -> Result<MemoryMutationResponse, String> {
        let slug = normalize_slug(&slug_input)?;
        let scope = normalize_write_scope(&scope_input)?;
        let memory_type = normalize_memory_type(&memory_type_input)?;
        if memory_type == "daily" {
            return Err(error_json(
                "invalid_type",
                "memory.write cannot create type=daily",
                None,
                None,
            ));
        }
        validate_body_limit(&body, MAX_BODY_BYTES, &slug)?;
        apply_risk_policy(&slug, &body, &mut options)?;
        let description = normalize_description(&description_input)?;
        let workdir_hash = if scope == "project" {
            required_workdir_hash(workdir.as_deref())?
        } else {
            String::new()
        };
        let _mutation_guard = self.lock_mutation()?;
        let target = self.path_for(
            &scope,
            &workdir_hash,
            workdir.as_deref(),
            &memory_type,
            &slug,
        )?;
        let existed_before = target.exists();
        if existed_before && !upsert {
            return Err(error_json(
                "slug_exists",
                &format!("memory with slug '{slug}' already exists in {scope} scope"),
                Some(json!({
                    "action": "update",
                    "slug": slug,
                    "scope": scope
                })),
                None,
            ));
        }
        self.validate_scope_quota(&scope, &workdir_hash, existed_before)?;
        let now = now_ms();
        let source = normalize_source_json(
            Value::Null,
            options.unreviewed,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            options.risk_flag.as_deref(),
        );
        let meta = ParsedFrontmatter {
            name: slug.clone(),
            memory_type: memory_type.clone(),
            scope: scope.clone(),
            description,
            headline: String::new(),
            date: None,
            append_count: 0,
            created_at: Some(format_rfc3339(now)),
            updated_at: Some(format_rfc3339(now)),
            source_json: source,
            links_json: Value::Array(Vec::new()),
            unreviewed: options.unreviewed,
        };
        let content = render_memory_markdown(&meta, &body);
        self.atomic_replace_entry_file(&target, &content)?;
        let parsed = ParsedMemoryFile {
            meta,
            body,
            path: target.clone(),
            archived: false,
        };
        let mut conn = self.lock_conn()?;
        index_parsed_file(&mut conn, &parsed, &target, false)?;
        insert_audit_log(
            &mut conn,
            if existed_before { "update" } else { "write" },
            &scope,
            &workdir_hash,
            &slug,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            json!({ "type": memory_type }),
        )?;
        drop(conn);
        self.refresh_memory_indexes()?;
        Ok(MemoryMutationResponse {
            slug,
            scope,
            created: !existed_before,
            updated: existed_before,
            deleted: false,
            index_updated: true,
            warning: None,
            applied_confidence: None,
            auto_downgraded: None,
        })
    }

    fn replace_existing_entry(
        &self,
        resolved: ResolvedEntry,
        memory_type_input: String,
        description_input: String,
        body: String,
        mut options: WriteOptions,
        update_mode: &str,
    ) -> Result<MemoryMutationResponse, String> {
        let memory_type = normalize_memory_type(&memory_type_input)?;
        if memory_type == "daily" {
            return Err(error_json(
                "invalid_type",
                "ordinary update cannot set type=daily",
                None,
                None,
            ));
        }
        validate_body_limit(&body, MAX_BODY_BYTES, &resolved.meta.slug)?;
        apply_risk_policy(&resolved.meta.slug, &body, &mut options)?;
        let description = normalize_description(&description_input)?;
        let mut parsed = resolved.parsed;
        parsed.meta.memory_type = memory_type.clone();
        parsed.meta.description = description;
        parsed.meta.updated_at = Some(format_rfc3339(now_ms()));
        parsed.meta.unreviewed = options.unreviewed;
        parsed.meta.source_json = normalize_source_json(
            parsed.meta.source_json,
            options.unreviewed,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            options.risk_flag.as_deref(),
        );
        let target = self.path_for(
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            None,
            &memory_type,
            &resolved.meta.slug,
        )?;
        let content = render_memory_markdown(&parsed.meta, &body);
        if options.trigger.as_deref() == Some("memory-organize") {
            self.snapshot_entry_before_organize(&resolved.meta, &resolved.path)?;
        }
        self.atomic_replace_entry_file(&target, &content)?;
        if target != resolved.path && resolved.path.exists() {
            let _ = fs::remove_file(&resolved.path);
        }
        parsed.body = body;
        parsed.path = target.clone();
        let mut conn = self.lock_conn()?;
        index_parsed_file(&mut conn, &parsed, &target, false)?;
        insert_audit_log(
            &mut conn,
            "update",
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            &resolved.meta.slug,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            json!({ "type": memory_type, "mode": update_mode }),
        )?;
        drop(conn);
        self.refresh_memory_indexes()?;
        Ok(MemoryMutationResponse {
            slug: resolved.meta.slug,
            scope: resolved.meta.scope,
            created: false,
            updated: true,
            deleted: false,
            index_updated: true,
            warning: None,
            applied_confidence: None,
            auto_downgraded: None,
        })
    }


}
