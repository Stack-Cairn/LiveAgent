impl MemoryStore {
    pub fn organize_run_create(
        &self,
        args: MemoryOrganizeRunCreateArgs,
    ) -> Result<MemoryOrganizeRunCreateResponse, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("创建 memory organize run 事务失败：{e}"))?;
        let now = now_ms();
        reap_stale_organize_runs(&tx, now)?;
        if let Some(active) = find_blocking_organize_run(&tx)? {
            tx.commit()
                .map_err(|e| format!("提交 stale memory organize run 回收事务失败：{e}"))?;
            return Ok(MemoryOrganizeRunCreateResponse {
                run: None,
                accepted: false,
                already_running: true,
                active_run: Some(active),
            });
        }

        let run_id = format!("memory-organize-{}", Uuid::new_v4());
        let trigger = normalize_organize_trigger(&args.trigger)?;
        let scope = normalize_organize_scope(args.scope.as_deref());
        let mode = normalize_organize_mode(args.mode.as_deref());
        insert_organize_run(
            &tx,
            &run_id,
            &trigger,
            "pending",
            now,
            None,
            None,
            args.due_at,
            None,
            args.model.as_ref(),
            &scope,
            &mode,
        )?;
        tx.commit()
            .map_err(|e| format!("提交 memory organize run 事务失败：{e}"))?;
        drop(conn);
        let run = self
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: run_id.clone(),
            })?
            .ok_or_else(|| format!("memory organize run not found after create: {run_id}"))?;
        Ok(MemoryOrganizeRunCreateResponse {
            run: Some(run),
            accepted: true,
            already_running: false,
            active_run: None,
        })
    }

    pub fn organize_due_claim(
        &self,
        args: MemoryOrganizeDueClaimArgs,
    ) -> Result<MemoryOrganizeDueClaimResponse, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("创建 memory organize claim 事务失败：{e}"))?;
        let now = args.now.unwrap_or_else(now_ms);
        reap_stale_organize_runs(&tx, now)?;
        if find_active_organize_run(&tx)?.is_some() {
            let due_at = args.due_at.unwrap_or(0);
            if args.enabled.unwrap_or(false) && due_at > 0 && due_at <= now {
                let run_id = if let Some(existing_run_id) =
                    find_existing_skipped_organize_run_id(&tx, due_at, "already_running")?
                {
                    existing_run_id
                } else {
                    insert_skipped_organize_run(
                        &tx,
                        now,
                        due_at,
                        args.model.as_ref(),
                        &normalize_organize_scope(args.scope.as_deref()),
                        &normalize_organize_mode(args.mode.as_deref()),
                        "already_running",
                        "本次自动记忆整理因已有整理任务运行中而跳过。",
                    )?
                };
                tx.commit()
                    .map_err(|e| format!("提交 memory organize skipped claim 失败：{e}"))?;
                drop(conn);
                return Ok(MemoryOrganizeDueClaimResponse {
                    run: self.organize_run_read(MemoryOrganizeRunReadArgs { run_id })?,
                    skipped_reason: Some("already_running".to_string()),
                });
            }
            tx.commit()
                .map_err(|e| format!("提交 stale memory organize claim 回收事务失败：{e}"))?;
            return Ok(MemoryOrganizeDueClaimResponse {
                run: None,
                skipped_reason: Some("already_running".to_string()),
            });
        }

        if let Some(run_id) = find_pending_organize_run_id(&tx)? {
            mark_organize_run_running(&tx, &run_id, now)?;
            tx.commit()
                .map_err(|e| format!("提交 memory organize pending claim 失败：{e}"))?;
            drop(conn);
            return Ok(MemoryOrganizeDueClaimResponse {
                run: self.organize_run_read(MemoryOrganizeRunReadArgs { run_id })?,
                skipped_reason: None,
            });
        }

        if args.enabled.unwrap_or(false) {
            let due_at = args.due_at.unwrap_or(0);
            if due_at > 0 && due_at <= now {
                let run_id = format!("memory-organize-{}", Uuid::new_v4());
                let scope = normalize_organize_scope(args.scope.as_deref());
                let mode = normalize_organize_mode(args.mode.as_deref());
                insert_organize_run(
                    &tx,
                    &run_id,
                    "scheduled",
                    "running",
                    now,
                    Some(now),
                    None,
                    Some(due_at),
                    Some(now),
                    args.model.as_ref(),
                    &scope,
                    &mode,
                )?;
                tx.commit()
                    .map_err(|e| format!("提交 memory organize scheduled claim 失败：{e}"))?;
                drop(conn);
                return Ok(MemoryOrganizeDueClaimResponse {
                    run: self.organize_run_read(MemoryOrganizeRunReadArgs { run_id })?,
                    skipped_reason: None,
                });
            }
        }

        tx.commit()
            .map_err(|e| format!("提交 stale memory organize claim 回收事务失败：{e}"))?;
        Ok(MemoryOrganizeDueClaimResponse {
            run: None,
            skipped_reason: None,
        })
    }

    pub fn organize_due_complete(
        &self,
        args: MemoryOrganizeRunUpdateArgs,
    ) -> Result<Option<MemoryOrganizeRun>, String> {
        self.organize_run_update(args)
    }

    pub fn organize_run_update(
        &self,
        args: MemoryOrganizeRunUpdateArgs,
    ) -> Result<Option<MemoryOrganizeRun>, String> {
        let run_id = args.run_id.trim();
        if run_id.is_empty() {
            return Err("memory organize run_id is required".to_string());
        }
        if let Some(status) = args.status.as_deref() {
            normalize_organize_status(status)?;
        }

        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("创建 memory organize update 事务失败：{e}"))?;
        let current = load_organize_run_by_id(&tx, run_id)?;
        let Some(current) = current else {
            return Ok(None);
        };

        let next_status = args.status.unwrap_or(current.status);
        let next_started_at = args.started_at.or(current.started_at);
        let next_finished_at = args.finished_at.or(current.finished_at);
        let next_report = args.report.unwrap_or(current.report);
        let trimmed_protocol_json = serde_json::to_string(&next_report)
            .map_err(|e| format!("serialize organizer run report failed: {e}"))?;

        tx.execute(
            r#"
            UPDATE memory_organize_runs
            SET status = ?2,
                started_at = ?3,
                finished_at = ?4,
                input_count = ?5,
                cluster_count = ?6,
                safe_applied = ?7,
                review_skipped = ?8,
                created_count = ?9,
                updated_count = ?10,
                deleted_count = ?11,
                merged_count = ?12,
                parse_failures = ?13,
                error = ?14,
                final_summary = ?15,
                trimmed_protocol_json = ?16,
                phase = ?17,
                final_count = ?18,
                compression_ratio = ?19,
                compression_target = ?20,
                dry_run = ?21,
                token_usage_total = ?22,
                quota_headroom_at_start = ?23,
                override_reviewed = ?24
            WHERE run_id = ?1
            "#,
            params![
                run_id,
                next_status,
                next_started_at,
                next_finished_at,
                args.input_count.unwrap_or(current.input_count),
                args.cluster_count.unwrap_or(current.cluster_count),
                args.safe_applied.unwrap_or(current.safe_applied),
                args.review_skipped.unwrap_or(current.review_skipped),
                args.created_count.unwrap_or(current.created_count),
                args.updated_count.unwrap_or(current.updated_count),
                args.deleted_count.unwrap_or(current.deleted_count),
                args.merged_count.unwrap_or(current.merged_count),
                args.parse_failures.unwrap_or(current.parse_failures),
                args.error.or(current.error),
                args.final_summary.or(current.final_summary),
                trimmed_protocol_json,
                args.phase.or(current.phase),
                args.final_count.unwrap_or(current.final_count),
                args.compression_ratio.or(current.compression_ratio),
                args.compression_target.or(current.compression_target),
                if args.dry_run.unwrap_or(current.dry_run) { 1 } else { 0 },
                args.token_usage_total.unwrap_or(current.token_usage_total),
                args.quota_headroom_at_start
                    .or(current.quota_headroom_at_start),
                if args.override_reviewed.unwrap_or(current.override_reviewed) {
                    1
                } else {
                    0
                },
            ],
        )
        .map_err(|e| format!("更新 memory organize run 失败：{e}"))?;
        tx.commit()
            .map_err(|e| format!("提交 memory organize update 事务失败：{e}"))?;
        drop(conn);
        self.organize_run_read(MemoryOrganizeRunReadArgs {
            run_id: run_id.to_string(),
        })
    }

    pub fn organize_run_list(
        &self,
        args: MemoryOrganizeRunListArgs,
    ) -> Result<MemoryOrganizeRunListResponse, String> {
        let status = args
            .status
            .as_deref()
            .map(normalize_organize_status)
            .transpose()?;
        let limit = args.limit.unwrap_or(50).clamp(1, 200);
        let conn = self.lock_conn()?;
        let runs = if let Some(status) = status {
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
                           claimed_at, model_json, scope, mode, input_count, cluster_count,
                           safe_applied, review_skipped, created_count, updated_count,
                           deleted_count, merged_count, parse_failures, error, final_summary,
                           trimmed_protocol_json, phase, final_count, compression_ratio,
                           compression_target, dry_run, token_usage_total,
                           quota_headroom_at_start, override_reviewed
                    FROM memory_organize_runs
                    WHERE status = ?1
                    ORDER BY created_at DESC
                    LIMIT ?2
                    "#,
                )
                .map_err(|e| format!("准备 memory organize run list 失败：{e}"))?;
            let rows = stmt
                .query_map(params![status, limit as i64], row_to_organize_run)
                .map_err(|e| format!("查询 memory organize run list 失败：{e}"))?;
            collect_organize_runs(rows)?
        } else {
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
                           claimed_at, model_json, scope, mode, input_count, cluster_count,
                           safe_applied, review_skipped, created_count, updated_count,
                           deleted_count, merged_count, parse_failures, error, final_summary,
                           trimmed_protocol_json, phase, final_count, compression_ratio,
                           compression_target, dry_run, token_usage_total,
                           quota_headroom_at_start, override_reviewed
                    FROM memory_organize_runs
                    ORDER BY created_at DESC
                    LIMIT ?1
                    "#,
                )
                .map_err(|e| format!("准备 memory organize run list 失败：{e}"))?;
            let rows = stmt
                .query_map(params![limit as i64], row_to_organize_run)
                .map_err(|e| format!("查询 memory organize run list 失败：{e}"))?;
            collect_organize_runs(rows)?
        };
        Ok(MemoryOrganizeRunListResponse { runs })
    }

    pub fn organize_run_read(
        &self,
        args: MemoryOrganizeRunReadArgs,
    ) -> Result<Option<MemoryOrganizeRun>, String> {
        let run_id = args.run_id.trim();
        if run_id.is_empty() {
            return Err("memory organize run_id is required".to_string());
        }
        let conn = self.lock_conn()?;
        load_organize_run_by_id(&conn, run_id)
    }

    pub fn organize_run_clear_history(
        &self,
    ) -> Result<MemoryOrganizeRunClearHistoryResponse, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("创建 memory organize history clear 事务失败：{e}"))?;
        let retained_active_count = tx
            .query_row(
                "SELECT COUNT(*) FROM memory_organize_runs WHERE status IN ('pending', 'running')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("统计 memory organize active runs 失败：{e}"))?;
        let deleted_count =
            tx.execute(
                "DELETE FROM memory_organize_runs WHERE status NOT IN ('pending', 'running')",
                [],
            )
            .map_err(|e| format!("清空 memory organize history 失败：{e}"))? as i64;
        tx.commit()
            .map_err(|e| format!("提交 memory organize history clear 事务失败：{e}"))?;
        Ok(MemoryOrganizeRunClearHistoryResponse {
            deleted_count,
            retained_active_count,
        })
    }


}

fn normalize_organize_trigger(input: &str) -> Result<String, String> {
    match input.trim() {
        "manual" | "scheduled" => Ok(input.trim().to_string()),
        other => Err(format!("invalid memory organize trigger: {other}")),
    }
}

fn normalize_organize_status(input: &str) -> Result<String, String> {
    match input.trim() {
        "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" => {
            Ok(input.trim().to_string())
        }
        other => Err(format!("invalid memory organize status: {other}")),
    }
}

fn normalize_organize_scope(input: Option<&str>) -> String {
    match input.unwrap_or("all").trim() {
        "global" => "global".to_string(),
        "projects" | "all-projects" => "projects".to_string(),
        "current-project" => "current-project".to_string(),
        _ => "all".to_string(),
    }
}

fn normalize_organize_mode(input: Option<&str>) -> String {
    match input.unwrap_or("standard").trim() {
        "conservative" => "conservative".to_string(),
        "aggressive" => "aggressive".to_string(),
        _ => "standard".to_string(),
    }
}

fn parse_json_value(raw: Option<String>, fallback: Value) -> Value {
    let Some(raw) = raw else {
        return fallback;
    };
    serde_json::from_str(&raw).unwrap_or(fallback)
}

fn row_to_organize_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryOrganizeRun> {
    let model_json: Option<String> = row.get(8)?;
    let trimmed_protocol_json: String = row.get(22)?;
    Ok(MemoryOrganizeRun {
        run_id: row.get(0)?,
        trigger: row.get(1)?,
        status: row.get(2)?,
        created_at: row.get(3)?,
        started_at: row.get(4)?,
        finished_at: row.get(5)?,
        due_at: row.get(6)?,
        claimed_at: row.get(7)?,
        model: parse_json_value(model_json, Value::Null),
        scope: row.get(9)?,
        mode: row.get(10)?,
        input_count: row.get(11)?,
        cluster_count: row.get(12)?,
        safe_applied: row.get(13)?,
        review_skipped: row.get(14)?,
        created_count: row.get(15)?,
        updated_count: row.get(16)?,
        deleted_count: row.get(17)?,
        merged_count: row.get(18)?,
        parse_failures: row.get(19)?,
        error: row.get(20)?,
        final_summary: row.get(21)?,
        phase: row.get(23)?,
        final_count: row.get(24)?,
        compression_ratio: row.get(25)?,
        compression_target: row.get(26)?,
        dry_run: row.get::<_, i64>(27)? != 0,
        token_usage_total: row.get(28)?,
        quota_headroom_at_start: row.get(29)?,
        override_reviewed: row.get::<_, i64>(30)? != 0,
        report: parse_json_value(Some(trimmed_protocol_json), json!({})),
    })
}

fn collect_organize_runs<I>(rows: I) -> Result<Vec<MemoryOrganizeRun>, String>
where
    I: IntoIterator<Item = rusqlite::Result<MemoryOrganizeRun>>,
{
    rows.into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取 memory organize run row 失败：{e}"))
}

fn load_organize_run_by_id(
    conn: &Connection,
    run_id: &str,
) -> Result<Option<MemoryOrganizeRun>, String> {
    conn.query_row(
        r#"
        SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
               claimed_at, model_json, scope, mode, input_count, cluster_count,
               safe_applied, review_skipped, created_count, updated_count,
               deleted_count, merged_count, parse_failures, error, final_summary,
               trimmed_protocol_json, phase, final_count, compression_ratio,
               compression_target, dry_run, token_usage_total,
               quota_headroom_at_start, override_reviewed
        FROM memory_organize_runs
        WHERE run_id = ?1
        "#,
        params![run_id],
        row_to_organize_run,
    )
    .optional()
    .map_err(|e| format!("读取 memory organize run 失败：{e}"))
}

fn find_active_organize_run(conn: &Connection) -> Result<Option<MemoryOrganizeRun>, String> {
    conn.query_row(
        r#"
        SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
               claimed_at, model_json, scope, mode, input_count, cluster_count,
               safe_applied, review_skipped, created_count, updated_count,
               deleted_count, merged_count, parse_failures, error, final_summary,
               trimmed_protocol_json, phase, final_count, compression_ratio,
               compression_target, dry_run, token_usage_total,
               quota_headroom_at_start, override_reviewed
        FROM memory_organize_runs
        WHERE status = 'running'
        ORDER BY started_at ASC, created_at ASC
        LIMIT 1
        "#,
        [],
        row_to_organize_run,
    )
    .optional()
    .map_err(|e| format!("读取 active memory organize run 失败：{e}"))
}

fn find_blocking_organize_run(conn: &Connection) -> Result<Option<MemoryOrganizeRun>, String> {
    conn.query_row(
        r#"
        SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
               claimed_at, model_json, scope, mode, input_count, cluster_count,
               safe_applied, review_skipped, created_count, updated_count,
               deleted_count, merged_count, parse_failures, error, final_summary,
               trimmed_protocol_json, phase, final_count, compression_ratio,
               compression_target, dry_run, token_usage_total,
               quota_headroom_at_start, override_reviewed
        FROM memory_organize_runs
        WHERE status IN ('pending', 'running')
        ORDER BY created_at ASC
        LIMIT 1
        "#,
        [],
        row_to_organize_run,
    )
    .optional()
    .map_err(|e| format!("读取 blocking memory organize run 失败：{e}"))
}

fn find_pending_organize_run_id(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        r#"
        SELECT run_id
        FROM memory_organize_runs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        "#,
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 pending memory organize run 失败：{e}"))
}

fn find_existing_skipped_organize_run_id(
    conn: &Connection,
    due_at: i64,
    reason: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        r#"
        SELECT run_id
        FROM memory_organize_runs
        WHERE trigger = 'scheduled'
          AND status = 'skipped'
          AND due_at = ?1
          AND error = ?2
        ORDER BY created_at DESC
        LIMIT 1
        "#,
        params![due_at, reason],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 skipped memory organize run 失败：{e}"))
}

#[allow(clippy::too_many_arguments)]
fn insert_organize_run(
    conn: &Connection,
    run_id: &str,
    trigger: &str,
    status: &str,
    created_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    due_at: Option<i64>,
    claimed_at: Option<i64>,
    model: Option<&Value>,
    scope: &str,
    mode: &str,
) -> Result<(), String> {
    let model_json = model
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| format!("serialize memory organizer model failed: {e}"))?;
    conn.execute(
        r#"
        INSERT INTO memory_organize_runs
            (run_id, trigger, status, created_at, started_at, finished_at, due_at,
             claimed_at, model_json, scope, mode)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
        params![
            run_id,
            trigger,
            status,
            created_at,
            started_at,
            finished_at,
            due_at,
            claimed_at,
            model_json,
            scope,
            mode,
        ],
    )
    .map_err(|e| format!("插入 memory organize run 失败：{e}"))?;
    Ok(())
}

fn insert_skipped_organize_run(
    conn: &Connection,
    now: i64,
    due_at: i64,
    model: Option<&Value>,
    scope: &str,
    mode: &str,
    reason: &str,
    final_summary: &str,
) -> Result<String, String> {
    let run_id = format!("memory-organize-{}", Uuid::new_v4());
    let model_json = model
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| format!("serialize memory organizer model failed: {e}"))?;
    let trimmed_protocol_json = serde_json::to_string(&json!({
        "reviewNotes": [final_summary],
        "skipReason": reason,
    }))
    .map_err(|e| format!("serialize memory organizer skipped protocol failed: {e}"))?;
    conn.execute(
        r#"
        INSERT INTO memory_organize_runs
            (run_id, trigger, status, created_at, started_at, finished_at, due_at,
             claimed_at, model_json, scope, mode, error, final_summary, trimmed_protocol_json)
        VALUES (?1, 'scheduled', 'skipped', ?2, ?2, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            run_id,
            now,
            due_at,
            model_json,
            scope,
            mode,
            reason,
            final_summary,
            trimmed_protocol_json,
        ],
    )
    .map_err(|e| format!("插入 skipped memory organize run 失败：{e}"))?;
    Ok(run_id)
}

fn reap_stale_organize_runs(conn: &Connection, now: i64) -> Result<usize, String> {
    let stale_before = now.saturating_sub(ORGANIZE_RUN_STALE_AFTER_MS);
    let trimmed_protocol_json = serde_json::to_string(&json!({
        "reviewNotes": [ORGANIZE_RUN_STALE_SUMMARY],
        "staleReason": "stale_timeout",
    }))
    .map_err(|e| format!("serialize stale memory organizer protocol failed: {e}"))?;
    conn.execute(
        r#"
        UPDATE memory_organize_runs
        SET status = 'failed',
            finished_at = ?1,
            error = 'stale_timeout',
            final_summary = ?2,
            trimmed_protocol_json = ?3
        WHERE status IN ('pending', 'running')
          AND COALESCE(claimed_at, started_at, created_at) <= ?4
        "#,
        params![
            now,
            ORGANIZE_RUN_STALE_SUMMARY,
            trimmed_protocol_json,
            stale_before,
        ],
    )
    .map_err(|e| format!("回收 stale memory organize run 失败：{e}"))
}

fn mark_organize_run_running(conn: &Connection, run_id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        r#"
        UPDATE memory_organize_runs
        SET status = 'running',
            started_at = COALESCE(started_at, ?2),
            claimed_at = ?2
        WHERE run_id = ?1 AND status = 'pending'
        "#,
        params![run_id, now],
    )
    .map_err(|e| format!("claim memory organize run 失败：{e}"))?;
    Ok(())
}
