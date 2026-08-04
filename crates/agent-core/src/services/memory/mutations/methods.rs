impl MemoryStore {
    pub fn write(&self, args: MemoryWriteArgs) -> Result<MemoryMutationResponse, String> {
        let actor = args.actor.unwrap_or_else(|| "tool".to_string());
        let options = WriteOptions {
            unreviewed: actor == "extractor",
            actor,
            conversation_id: args.conversation_id,
            trigger: None,
            model: args.model,
            risk_flag: None,
        };
        let mut evidence_applied = None;
        let body = match args
            .evidence
            .as_ref()
            .filter(|evidence| evidence_args_present(evidence))
        {
            Some(evidence) => {
                let (body, confidence, downgraded) =
                    apply_evidence_to_body(&args.body, evidence);
                evidence_applied = Some((confidence, downgraded));
                body
            }
            None => args.body,
        };
        let mut response = self.write_entry(
            args.slug,
            args.scope,
            args.workdir,
            args.memory_type,
            args.description,
            body,
            options,
            false,
        )?;
        if let Some((confidence, downgraded)) = evidence_applied {
            response.applied_confidence = Some(confidence);
            response.auto_downgraded = Some(downgraded);
        }
        Ok(response)
    }

    pub fn update(&self, args: MemoryUpdateArgs) -> Result<MemoryMutationResponse, String> {
        self.update_inner(args, None)
    }

    fn update_inner(
        &self,
        mut args: MemoryUpdateArgs,
        trigger: Option<String>,
    ) -> Result<MemoryMutationResponse, String> {
        if is_daily_slug(&args.slug) {
            let mode = args.mode.as_deref().unwrap_or("replace");
            if mode != "append" {
                return Err(error_json(
                    "append_mode_required",
                    "daily memory must be updated with mode=\"append\"",
                    Some(json!({
                        "action": "update",
                        "slug": args.slug,
                        "mode": "append"
                    })),
                    None,
                ));
            }
            let body = args.body.unwrap_or_default();
            let actor = args.actor.unwrap_or_else(|| "tool".to_string());
            return self.append_daily(
                args.slug,
                body,
                WriteOptions {
                    unreviewed: actor == "extractor",
                    actor,
                    conversation_id: args.conversation_id,
                    trigger,
                    model: args.model,
                    risk_flag: None,
                },
            );
        }

        // Daily appends never carry evidence; the ordinary path renders the
        // canonical evidence frontmatter here so downstream merge/replace logic
        // (including evidence-only updates) sees a normal body.
        let mut evidence_applied = None;
        if let Some(evidence) = args
            .evidence
            .take()
            .filter(|evidence| evidence_args_present(evidence))
        {
            let raw_body = args.body.clone().unwrap_or_default();
            let (body, confidence, downgraded) = apply_evidence_to_body(&raw_body, &evidence);
            args.body = Some(body);
            evidence_applied = Some((confidence, downgraded));
        }

        let default_mode = if args.actor.as_deref() == Some("extractor") {
            "merge"
        } else {
            "replace"
        };
        let mode = args.mode.as_deref().unwrap_or(default_mode);
        if mode == "append" {
            return Err(error_json(
                "invalid_mode",
                "ordinary memory entries do not support mode=\"append\"; use mode=\"replace\" or mode=\"merge\"",
                Some(json!({
                    "action": "update",
                    "slug": args.slug,
                    "mode": "merge"
                })),
                None,
            ));
        }
        if mode != "replace" && mode != "merge" {
            return Err(error_json(
                "invalid_mode",
                "ordinary memory entries only support mode=\"replace\" or mode=\"merge\"",
                Some(json!({
                    "action": "update",
                    "slug": args.slug,
                    "mode": "merge"
                })),
                None,
            ));
        }

        let _mutation_guard = self.lock_mutation()?;
        let resolved = self.resolve_entry(
            &args.slug,
            args.scope.as_deref(),
            args.workdir.as_deref(),
            args.workdir_hash.as_deref(),
        )?;
        let body_arg = args.body.clone();
        let evidence_only_update = body_arg.as_deref().is_some_and(is_evidence_only_body)
            && args.description.is_none()
            && args.memory_type.is_none();
        let memory_type = args
            .memory_type
            .unwrap_or(resolved.meta.memory_type.clone());
        let description = args
            .description
            .unwrap_or(resolved.meta.description.clone());
        let incoming_body = args.body.unwrap_or_else(|| resolved.parsed.body.clone());
        let body = if mode == "merge" {
            merge_memory_body(&resolved.parsed.body, &incoming_body)
        } else {
            incoming_body
        };
        let actor = args.actor.unwrap_or_else(|| "tool".to_string());
        let options = WriteOptions {
            unreviewed: if actor == "extractor" {
                if evidence_only_update {
                    resolved.meta.unreviewed
                } else {
                    true
                }
            } else if actor == "user" {
                false
            } else {
                resolved.meta.unreviewed
            },
            actor,
            conversation_id: args.conversation_id,
            trigger,
            model: args.model,
            risk_flag: None,
        };
        let mut response =
            self.replace_existing_entry(resolved, memory_type, description, body, options, mode)?;
        if let Some((confidence, downgraded)) = evidence_applied {
            response.applied_confidence = Some(confidence);
            response.auto_downgraded = Some(downgraded);
        }
        Ok(response)
    }

    pub fn delete(&self, args: MemoryDeleteArgs) -> Result<MemoryMutationResponse, String> {
        self.delete_inner(args, None)
    }

    pub fn delete_project(
        &self,
        args: MemoryDeleteProjectArgs,
    ) -> Result<MemoryDeleteProjectResponse, String> {
        let MemoryDeleteProjectArgs {
            workdir,
            actor,
            reason,
        } = args;
        let workdir = workdir.trim().to_string();
        if workdir.is_empty() {
            return Err(error_json(
                "workdir_required",
                "project memory deletion requires a workdir",
                None,
                None,
            ));
        }
        let actor = actor
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let actor = match actor.as_deref() {
            Some(value @ ("user" | "tool" | "extractor" | "reconcile")) => value.to_string(),
            _ => "tool".to_string(),
        };
        let reason = reason
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let _mutation_guard = self.lock_mutation()?;
        let workdir_hash = self.resolve_project_delete_workdir_hash(&workdir)?;
        let deleted_count = self.count_project_memory_entries(&workdir_hash)?;
        let project_dir = self.projects_dir().join(&workdir_hash);
        let quarantine_path = if project_dir.exists() {
            let quarantine_dir = self.root.join(".quarantine");
            fs::create_dir_all(&quarantine_dir)
                .map_err(|e| format!("创建项目记忆隔离目录失败：{e}"))?;
            let ts = now_ms();
            let mut target =
                quarantine_dir.join(format!("deleted-project-{}-{}", workdir_hash, ts));
            let mut suffix = 1;
            while target.exists() {
                target = quarantine_dir.join(format!(
                    "deleted-project-{}-{}-{}",
                    workdir_hash, ts, suffix
                ));
                suffix += 1;
            }
            fs::rename(&project_dir, &target).map_err(|e| format!("隔离项目记忆目录失败：{e}"))?;
            Some(target)
        } else {
            None
        };

        if deleted_count > 0 || quarantine_path.is_some() {
            let mut conn = self.lock_conn()?;
            delete_project_index_rows(
                &mut conn,
                &workdir_hash,
                &workdir,
                deleted_count,
                quarantine_path.as_deref(),
                &actor,
                reason.as_deref(),
            )?;
            drop(conn);
            self.refresh_memory_indexes()?;
        }

        Ok(MemoryDeleteProjectResponse {
            workdir_hash,
            deleted_count,
            quarantine_path: quarantine_path.map(|path| path.to_string_lossy().to_string()),
        })
    }

    fn resolve_project_delete_workdir_hash(&self, workdir: &str) -> Result<String, String> {
        let primary_hash = workdir_hash(workdir)?;
        if self.project_memory_state_exists(&primary_hash)? {
            return Ok(primary_hash);
        }
        Ok(self
            .find_project_workdir_hash_by_marker(workdir)
            .unwrap_or(primary_hash))
    }

    fn project_memory_state_exists(&self, workdir_hash: &str) -> Result<bool, String> {
        if self.projects_dir().join(workdir_hash).exists() {
            return Ok(true);
        }
        Ok(self.count_project_memory_entries(workdir_hash)? > 0)
    }

    fn count_project_memory_entries(&self, workdir_hash: &str) -> Result<usize, String> {
        let conn = self.lock_conn()?;
        let count = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_meta WHERE scope = 'project' AND workdir_hash = ?1",
                params![workdir_hash],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("读取项目记忆数量失败：{e}"))?;
        Ok(count.max(0) as usize)
    }

    fn find_project_workdir_hash_by_marker(&self, workdir: &str) -> Option<String> {
        let projects_dir = self.projects_dir();
        let entries = fs::read_dir(projects_dir).ok()?;
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let hash = entry.file_name().to_string_lossy().to_string();
            if normalize_workdir_hash_input(Some(&hash))
                .ok()
                .flatten()
                .is_none()
            {
                continue;
            }
            let Some(marker_path) = self.project_workdir_path(&hash) else {
                continue;
            };
            if workdir_paths_match(&marker_path, workdir) {
                return Some(hash);
            }
        }
        None
    }

    fn delete_inner(
        &self,
        args: MemoryDeleteArgs,
        trigger: Option<String>,
    ) -> Result<MemoryMutationResponse, String> {
        let MemoryDeleteArgs {
            slug,
            scope,
            workdir,
            workdir_hash,
            actor,
            reason,
            conversation_id,
            model,
        } = args;
        let _mutation_guard = self.lock_mutation()?;
        let resolved = self.resolve_entry(
            &slug,
            Some(&scope),
            workdir.as_deref(),
            workdir_hash.as_deref(),
        )?;
        if resolved.meta.archived {
            return Err(error_json(
                "daily_archived",
                "archived daily memory is read-only",
                None,
                None,
            ));
        }
        if trigger.as_deref() == Some("memory-organize") {
            self.snapshot_entry_before_organize(&resolved.meta, &resolved.path)?;
        }
        let trash_dir = self.trash_dir_for(&resolved.meta)?;
        fs::create_dir_all(&trash_dir).map_err(|e| format!("创建记忆回收站失败：{e}"))?;
        let target = trash_dir.join(format!("{}.{}.md", resolved.meta.slug, now_ms()));
        fs::rename(&resolved.path, &target).map_err(|e| format!("移动记忆到回收站失败：{e}"))?;
        let mut conn = self.lock_conn()?;
        delete_index_rows(
            &mut conn,
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            &resolved.meta.slug,
        )?;
        let actor = actor.unwrap_or_else(|| "tool".to_string());
        let reason = reason
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let mut detail = json!({ "trashPath": target.to_string_lossy() });
        if let Some(reason) = reason {
            detail["reason"] = Value::String(reason);
        }
        insert_audit_log(
            &mut conn,
            "delete",
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            &resolved.meta.slug,
            &actor,
            conversation_id.as_deref(),
            trigger.as_deref(),
            model.as_deref(),
            detail,
        )?;
        drop(conn);
        self.refresh_memory_indexes()?;
        Ok(MemoryMutationResponse {
            slug: resolved.meta.slug,
            scope: resolved.meta.scope,
            created: false,
            updated: false,
            deleted: true,
            index_updated: true,
            warning: None,
            applied_confidence: None,
            auto_downgraded: None,
        })
    }

    pub fn accept(&self, args: MemoryAcceptArgs) -> Result<MemoryMutationResponse, String> {
        let _mutation_guard = self.lock_mutation()?;
        let resolved = self.resolve_entry(
            &args.slug,
            Some(&args.scope),
            args.workdir.as_deref(),
            args.workdir_hash.as_deref(),
        )?;
        if resolved.meta.memory_type == "daily" {
            return Err(error_json(
                "invalid_type",
                "daily entries cannot be accepted",
                None,
                None,
            ));
        }
        let mut parsed = resolved.parsed;
        parsed.meta.unreviewed = false;
        parsed.meta.source_json = normalize_source_json(
            parsed.meta.source_json,
            false,
            "user",
            None,
            None,
            None,
            None,
        );
        let content = render_memory_markdown(&parsed.meta, &parsed.body);
        self.atomic_replace_entry_file(&resolved.path, &content)?;
        let mut conn = self.lock_conn()?;
        index_parsed_file(&mut conn, &parsed, &resolved.path, resolved.meta.archived)?;
        insert_audit_log(
            &mut conn,
            "accept",
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            &resolved.meta.slug,
            "user",
            None,
            None,
            None,
            json!({ "unreviewed": false }),
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

    pub fn apply_batch(&self, args: MemoryBatchArgs) -> Result<MemoryBatchResponse, String> {
        let mut created = Vec::new();
        let mut updated = Vec::new();
        let mut deleted = Vec::new();
        let mut warnings = Vec::new();
        let mut warning_details = Vec::new();
        let local_date = args
            .local_date
            .clone()
            .unwrap_or_else(|| today_local(DEFAULT_ROLLOVER_HOUR).to_string());
        let options = WriteOptions {
            actor: "extractor".to_string(),
            conversation_id: args.conversation_id.clone(),
            trigger: args.trigger.clone(),
            model: args.model.clone(),
            unreviewed: true,
            risk_flag: None,
        };

        if let Some(daily) = args.daily_append.clone() {
            if !daily.bullet.trim().is_empty() {
                match self.append_daily(
                    format!("daily-{local_date}"),
                    daily.bullet,
                    options.clone(),
                ) {
                    Ok(resp) => {
                        if resp.created {
                            created.push(resp.slug);
                        } else {
                            updated.push(resp.slug);
                        }
                        if let Some(warning) = resp.warning {
                            warnings.push(warning);
                        }
                    }
                    Err(error) => push_batch_warning(
                        &mut warnings,
                        &mut warning_details,
                        error,
                        None,
                        None,
                        "daily_append_failed",
                    ),
                }
            }
        }

        let decisions = args.decisions.clone().unwrap_or_default();
        if args.trigger.as_deref() == Some("memory-organize") {
            let mut groups: HashMap<String, Vec<(usize, MemoryDecisionArgs)>> = HashMap::new();
            for (index, decision) in decisions.iter().cloned().enumerate() {
                if let Some(group_id) = decision
                    .group_id
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    groups
                        .entry(group_id.to_string())
                        .or_default()
                        .push((index, decision));
                }
            }
            let mut consumed = HashSet::new();
            for (index, decision) in decisions.into_iter().enumerate() {
                if consumed.contains(&index) {
                    continue;
                }
                if let Some(group_id) = decision
                    .group_id
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    if let Some(group) = groups
                        .get(group_id)
                        .filter(|items| items.len() > 1)
                        .cloned()
                    {
                        for (group_index, _) in &group {
                            consumed.insert(*group_index);
                        }
                        self.apply_batch_group(
                            &args,
                            &options,
                            group,
                            &mut created,
                            &mut updated,
                            &mut deleted,
                            &mut warnings,
                            &mut warning_details,
                        );
                        continue;
                    }
                }
                self.apply_batch_decision(
                    &args,
                    &options,
                    decision,
                    index,
                    &mut created,
                    &mut updated,
                    &mut deleted,
                    &mut warnings,
                    &mut warning_details,
                );
            }
        } else {
            for (index, decision) in decisions.into_iter().enumerate() {
                self.apply_batch_decision(
                    &args,
                    &options,
                    decision,
                    index,
                    &mut created,
                    &mut updated,
                    &mut deleted,
                    &mut warnings,
                    &mut warning_details,
                );
            }
        }

        Ok(MemoryBatchResponse {
            created,
            updated,
            deleted,
            warnings,
            warning_details,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_batch_group(
        &self,
        args: &MemoryBatchArgs,
        options: &WriteOptions,
        group: Vec<(usize, MemoryDecisionArgs)>,
        created: &mut Vec<String>,
        updated: &mut Vec<String>,
        deleted: &mut Vec<String>,
        warnings: &mut Vec<String>,
        warning_details: &mut Vec<MemoryBatchWarning>,
    ) {
        let mut deferred_deletes = Vec::new();
        let mut group_failed = false;
        for (index, decision) in group {
            if decision.op.trim() == "delete" {
                deferred_deletes.push((index, decision));
                continue;
            }
            let ok = self.apply_batch_decision(
                args,
                options,
                decision,
                index,
                created,
                updated,
                deleted,
                warnings,
                warning_details,
            );
            if !ok {
                group_failed = true;
            }
        }
        if group_failed {
            for (index, decision) in deferred_deletes {
                let message = format!(
                    "skipped delete '{}' because its merge group update failed",
                    decision.slug
                );
                push_batch_warning(
                    warnings,
                    warning_details,
                    message,
                    Some(&decision),
                    Some(index),
                    "group_upsert_failed",
                );
            }
            return;
        }
        for (index, decision) in deferred_deletes {
            self.apply_batch_decision(
                args,
                options,
                decision,
                index,
                created,
                updated,
                deleted,
                warnings,
                warning_details,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_batch_decision(
        &self,
        args: &MemoryBatchArgs,
        options: &WriteOptions,
        decision: MemoryDecisionArgs,
        decision_index: usize,
        created: &mut Vec<String>,
        updated: &mut Vec<String>,
        deleted: &mut Vec<String>,
        warnings: &mut Vec<String>,
        warning_details: &mut Vec<MemoryBatchWarning>,
    ) -> bool {
        let op = decision.op.trim();
        let decision_workdir_hash = decision.workdir_hash.clone();
        if op == "delete" {
            let scope = decision
                .scope
                .clone()
                .unwrap_or_else(|| "project".to_string());
            let delete_args = MemoryDeleteArgs {
                slug: decision.slug.clone(),
                scope,
                workdir: args.workdir.clone(),
                workdir_hash: decision_workdir_hash,
                actor: Some("extractor".to_string()),
                reason: decision.reason.clone(),
                conversation_id: args.conversation_id.clone(),
                model: args.model.clone(),
            };
            let result = if args.trigger.as_deref() == Some("memory-organize") {
                self.delete_inner(delete_args, args.trigger.clone())
            } else {
                self.delete(delete_args)
            };
            return match result {
                Ok(resp) => {
                    deleted.push(resp.slug);
                    true
                }
                Err(error) => {
                    push_batch_warning(
                        warnings,
                        warning_details,
                        error,
                        Some(&decision),
                        Some(decision_index),
                        "delete_failed",
                    );
                    false
                }
            };
        }
        if op == "accept" {
            let scope = decision
                .scope
                .clone()
                .unwrap_or_else(|| "project".to_string());
            return match self.accept(MemoryAcceptArgs {
                slug: decision.slug.clone(),
                scope,
                workdir: args.workdir.clone(),
                workdir_hash: decision_workdir_hash,
            }) {
                Ok(resp) => {
                    updated.push(resp.slug);
                    true
                }
                Err(error) => {
                    push_batch_warning(
                        warnings,
                        warning_details,
                        error,
                        Some(&decision),
                        Some(decision_index),
                        "accept_failed",
                    );
                    false
                }
            };
        }
        // Partial or evidence-only revision of an existing entry. Unlike
        // upsert, every content field stays optional and resolves against the
        // stored entry via update_inner.
        if op == "update" {
            let scope = decision
                .scope
                .clone()
                .filter(|value| value == "global" || value == "project");
            return match self.update_inner(
                MemoryUpdateArgs {
                    slug: decision.slug.clone(),
                    scope,
                    workdir: args.workdir.clone(),
                    workdir_hash: decision_workdir_hash,
                    memory_type: decision.memory_type.clone(),
                    description: decision.description.clone(),
                    body: decision.body.clone(),
                    mode: decision.mode.clone(),
                    actor: Some("extractor".to_string()),
                    conversation_id: args.conversation_id.clone(),
                    model: args.model.clone(),
                    evidence: decision.evidence.clone(),
                },
                args.trigger.clone(),
            ) {
                Ok(resp) => {
                    updated.push(resp.slug);
                    true
                }
                Err(error) => {
                    push_batch_warning(
                        warnings,
                        warning_details,
                        error,
                        Some(&decision),
                        Some(decision_index),
                        "update_failed",
                    );
                    false
                }
            };
        }
        if op != "upsert" {
            push_batch_warning(
                warnings,
                warning_details,
                format!("unsupported memory decision op: {op}"),
                Some(&decision),
                Some(decision_index),
                "unsupported_op",
            );
            return false;
        }
        let Some(memory_type) = decision.memory_type.clone() else {
            push_batch_warning(
                warnings,
                warning_details,
                format!("memory decision {} missing memoryType", decision.slug),
                Some(&decision),
                Some(decision_index),
                "missing_memory_type",
            );
            return false;
        };
        let Some(description) = decision.description.clone() else {
            push_batch_warning(
                warnings,
                warning_details,
                format!("memory decision {} missing description", decision.slug),
                Some(&decision),
                Some(decision_index),
                "missing_description",
            );
            return false;
        };
        let Some(body) = decision.body.clone() else {
            push_batch_warning(
                warnings,
                warning_details,
                format!("memory decision {} missing body", decision.slug),
                Some(&decision),
                Some(decision_index),
                "missing_body",
            );
            return false;
        };
        let body = match decision
            .evidence
            .as_ref()
            .filter(|evidence| evidence_args_present(evidence))
        {
            Some(evidence) => apply_evidence_to_body(&body, evidence).0,
            None => body,
        };
        let scope = decision
            .scope
            .clone()
            .unwrap_or_else(|| "project".to_string());
        let write_options = options.clone();
        if args.trigger.as_deref() == Some("memory-organize") {
            return match self.update_inner(
                MemoryUpdateArgs {
                    slug: decision.slug.clone(),
                    scope: Some(scope),
                    workdir: args.workdir.clone(),
                    workdir_hash: decision_workdir_hash,
                    memory_type: Some(memory_type),
                    description: Some(description),
                    body: Some(body),
                    mode: Some("replace".to_string()),
                    actor: Some("extractor".to_string()),
                    conversation_id: args.conversation_id.clone(),
                    model: args.model.clone(),
                    evidence: None,
                },
                args.trigger.clone(),
            ) {
                Ok(resp) => {
                    updated.push(resp.slug);
                    true
                }
                Err(update_error) => {
                    push_batch_warning(
                        warnings,
                        warning_details,
                        update_error,
                        Some(&decision),
                        Some(decision_index),
                        "update_failed",
                    );
                    false
                }
            };
        }
        match self.write_entry(
            decision.slug.clone(),
            scope.clone(),
            args.workdir.clone(),
            memory_type.clone(),
            description.clone(),
            body.clone(),
            write_options.clone(),
            false,
        ) {
            Ok(resp) => {
                if resp.created {
                    created.push(resp.slug);
                } else {
                    updated.push(resp.slug);
                }
                true
            }
            Err(error) if error.contains("\"slug_exists\"") => {
                match self.update(MemoryUpdateArgs {
                    slug: decision.slug.clone(),
                    scope: Some(scope),
                    workdir: args.workdir.clone(),
                    workdir_hash: None,
                    memory_type: Some(memory_type),
                    description: Some(description),
                    body: Some(body),
                    mode: Some("merge".to_string()),
                    actor: Some("extractor".to_string()),
                    conversation_id: args.conversation_id.clone(),
                    model: args.model.clone(),
                    evidence: None,
                }) {
                    Ok(resp) => {
                        updated.push(resp.slug);
                        true
                    }
                    Err(update_error) => {
                        push_batch_warning(
                            warnings,
                            warning_details,
                            update_error,
                            Some(&decision),
                            Some(decision_index),
                            "update_failed",
                        );
                        false
                    }
                }
            }
            Err(error) => {
                push_batch_warning(
                    warnings,
                    warning_details,
                    error,
                    Some(&decision),
                    Some(decision_index),
                    "write_failed",
                );
                false
            }
        }
    }


}
