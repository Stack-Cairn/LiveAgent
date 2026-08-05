#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn test_store() -> MemoryStore {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("memory");
        ensure_root_dirs(&root).expect("root dirs");
        let db_path = root.join(DB_FILENAME);
        let conn = open_memory_connection(&db_path).expect("open db");
        let store = MemoryStore {
            root,
            db_path,
            conn: Mutex::new(conn),
            mutation_lock: Mutex::new(()),
        };
        std::mem::forget(temp);
        store
    }

    #[test]
    fn organize_runs_claim_update_and_list_history() {
        let store = test_store();
        let created = store
            .organize_run_create(MemoryOrganizeRunCreateArgs {
                trigger: "manual".to_string(),
                due_at: None,
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("all".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("create organize run");
        assert!(created.accepted);
        assert!(!created.already_running);
        let run_id = created.run.expect("created run").run_id;

        let claimed = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(false),
                due_at: None,
                now: Some(1_000),
                model: None,
                scope: None,
                mode: None,
            })
            .expect("claim pending run");
        let claimed_run = claimed.run.expect("claimed run");
        assert_eq!(claimed_run.run_id, run_id);
        assert_eq!(claimed_run.status, "running");
        assert_eq!(claimed_run.started_at, Some(1_000));

        let duplicate = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(1_000),
                now: Some(1_000),
                model: None,
                scope: None,
                mode: None,
            })
            .expect("duplicate claim");
        let skipped = duplicate.run.expect("skipped scheduled run");
        assert_eq!(skipped.status, "skipped");
        assert_eq!(skipped.trigger, "scheduled");
        assert_eq!(duplicate.skipped_reason.as_deref(), Some("already_running"));

        let duplicate_again = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(1_000),
                now: Some(1_001),
                model: None,
                scope: None,
                mode: None,
            })
            .expect("duplicate skipped claim");
        let skipped_again = duplicate_again.run.expect("deduped skipped scheduled run");
        assert_eq!(skipped_again.run_id, skipped.run_id);
        assert_eq!(
            duplicate_again.skipped_reason.as_deref(),
            Some("already_running")
        );

        let updated = store
            .organize_run_update(MemoryOrganizeRunUpdateArgs {
                run_id: run_id.clone(),
                status: Some("succeeded".to_string()),
                started_at: None,
                finished_at: Some(2_000),
                input_count: Some(12),
                cluster_count: Some(2),
                safe_applied: Some(3),
                review_skipped: Some(1),
                created_count: Some(0),
                updated_count: Some(2),
                deleted_count: Some(1),
                merged_count: Some(1),
                parse_failures: Some(0),
                error: None,
                final_summary: Some("整理完成".to_string()),
                report: Some(json!({ "clusterSummaries": ["完成"] })),
                ..Default::default()
            })
            .expect("update run")
            .expect("updated run");
        assert_eq!(updated.status, "succeeded");
        assert_eq!(updated.final_summary.as_deref(), Some("整理完成"));
        assert_eq!(updated.safe_applied, 3);

        let list = store
            .organize_run_list(MemoryOrganizeRunListArgs {
                status: None,
                limit: Some(10),
            })
            .expect("list runs");
        assert_eq!(list.runs.len(), 2);
        assert!(list.runs.iter().any(|run| run.run_id == run_id));
        assert!(list.runs.iter().any(|run| run.status == "skipped"));
    }

    #[test]
    fn organize_run_clear_history_deletes_finished_and_retains_active() {
        let store = test_store();
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "pending-run",
                "manual",
                "pending",
                1_000,
                None,
                None,
                None,
                None,
                None,
                "all",
                "standard",
            )
            .expect("insert pending run");
            insert_organize_run(
                &conn,
                "running-run",
                "scheduled",
                "running",
                1_001,
                Some(1_001),
                None,
                Some(1_000),
                Some(1_001),
                None,
                "global",
                "standard",
            )
            .expect("insert running run");
            insert_organize_run(
                &conn,
                "succeeded-run",
                "manual",
                "succeeded",
                1_002,
                Some(1_002),
                Some(1_003),
                None,
                None,
                None,
                "all",
                "standard",
            )
            .expect("insert succeeded run");
            insert_organize_run(
                &conn,
                "failed-run",
                "manual",
                "failed",
                1_004,
                Some(1_004),
                Some(1_005),
                None,
                None,
                None,
                "all",
                "standard",
            )
            .expect("insert failed run");
        }

        let cleared = store
            .organize_run_clear_history()
            .expect("clear organize history");
        assert_eq!(cleared.deleted_count, 2);
        assert_eq!(cleared.retained_active_count, 2);

        let list = store
            .organize_run_list(MemoryOrganizeRunListArgs {
                status: None,
                limit: Some(10),
            })
            .expect("list retained runs");
        let retained: Vec<_> = list.runs.iter().map(|run| run.run_id.as_str()).collect();
        assert_eq!(retained.len(), 2);
        assert!(retained.contains(&"pending-run"));
        assert!(retained.contains(&"running-run"));
    }

    #[test]
    fn organize_run_create_reaps_stale_active_run() {
        let store = test_store();
        let stale_at = now_ms() - ORGANIZE_RUN_STALE_AFTER_MS - 1_000;
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "stale-running-run",
                "manual",
                "running",
                stale_at,
                Some(stale_at),
                None,
                None,
                Some(stale_at),
                None,
                "all",
                "standard",
            )
            .expect("insert stale running run");
        }

        let created = store
            .organize_run_create(MemoryOrganizeRunCreateArgs {
                trigger: "manual".to_string(),
                due_at: None,
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("all".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("create after stale run");
        assert!(created.accepted);
        assert!(!created.already_running);
        assert!(created.run.is_some());

        let stale = store
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: "stale-running-run".to_string(),
            })
            .expect("read stale run")
            .expect("stale run exists");
        assert_eq!(stale.status, "failed");
        assert_eq!(stale.error.as_deref(), Some("stale_timeout"));
        assert_eq!(
            stale.final_summary.as_deref(),
            Some(ORGANIZE_RUN_STALE_SUMMARY)
        );
        assert!(stale.finished_at.is_some());
    }

    #[test]
    fn organize_run_create_keeps_fresh_active_run_blocking() {
        let store = test_store();
        let fresh_at = now_ms();
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "fresh-running-run",
                "manual",
                "running",
                fresh_at,
                Some(fresh_at),
                None,
                None,
                Some(fresh_at),
                None,
                "all",
                "standard",
            )
            .expect("insert fresh running run");
        }

        let created = store
            .organize_run_create(MemoryOrganizeRunCreateArgs {
                trigger: "manual".to_string(),
                due_at: None,
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("all".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("create blocked by fresh run");
        assert!(!created.accepted);
        assert!(created.already_running);
        assert_eq!(
            created.active_run.as_ref().map(|run| run.run_id.as_str()),
            Some("fresh-running-run")
        );

        let fresh = store
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: "fresh-running-run".to_string(),
            })
            .expect("read fresh run")
            .expect("fresh run exists");
        assert_eq!(fresh.status, "running");
        assert_eq!(fresh.error, None);
    }

    #[test]
    fn organize_due_claim_creates_scheduled_run_when_due() {
        let store = test_store();
        let claimed = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(1_000),
                now: Some(2_000),
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("global".to_string()),
                mode: Some("conservative".to_string()),
            })
            .expect("claim scheduled run");
        let run = claimed.run.expect("scheduled run");
        assert_eq!(run.trigger, "scheduled");
        assert_eq!(run.status, "running");
        assert_eq!(run.scope, "global");
        assert_eq!(run.mode, "conservative");
        assert_eq!(run.due_at, Some(1_000));
    }

    #[test]
    fn organize_due_claim_reaps_stale_running_run_before_scheduled_claim() {
        let store = test_store();
        let stale_at = 1_000;
        let now = stale_at + ORGANIZE_RUN_STALE_AFTER_MS + 1;
        let due_at = now - 1_000;
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "stale-scheduled-run",
                "scheduled",
                "running",
                stale_at,
                Some(stale_at),
                None,
                Some(stale_at),
                Some(stale_at),
                None,
                "global",
                "standard",
            )
            .expect("insert stale scheduled run");
        }

        let claimed = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(due_at),
                now: Some(now),
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("global".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("claim scheduled run after stale reap");
        let run = claimed.run.expect("new scheduled run");
        assert_eq!(claimed.skipped_reason, None);
        assert_ne!(run.run_id, "stale-scheduled-run");
        assert_eq!(run.trigger, "scheduled");
        assert_eq!(run.status, "running");
        assert_eq!(run.due_at, Some(due_at));

        let stale = store
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: "stale-scheduled-run".to_string(),
            })
            .expect("read stale scheduled run")
            .expect("stale scheduled run exists");
        assert_eq!(stale.status, "failed");
        assert_eq!(stale.error.as_deref(), Some("stale_timeout"));
    }

    #[test]
    fn organize_due_claim_reaps_stale_running_run_even_when_not_due() {
        let store = test_store();
        let stale_at = 1_000;
        let now = stale_at + ORGANIZE_RUN_STALE_AFTER_MS + 1;
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "stale-not-due-run",
                "scheduled",
                "running",
                stale_at,
                Some(stale_at),
                None,
                Some(stale_at + ORGANIZE_RUN_STALE_AFTER_MS + 60_000),
                Some(stale_at),
                None,
                "global",
                "standard",
            )
            .expect("insert stale not-due run");
        }

        let claimed = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(now + 60_000),
                now: Some(now),
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("global".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("claim before next due after stale reap");
        assert!(claimed.run.is_none());
        assert_eq!(claimed.skipped_reason, None);

        let stale = store
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: "stale-not-due-run".to_string(),
            })
            .expect("read stale not-due run")
            .expect("stale not-due run exists");
        assert_eq!(stale.status, "failed");
        assert_eq!(stale.error.as_deref(), Some("stale_timeout"));
    }

    #[test]
    fn init_schema_rebuilds_legacy_v1_cache_schema() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("memory");
        ensure_root_dirs(&root).expect("root dirs");
        let memory_file = root.join("global").join("user").join("user-legacy.md");
        fs::write(
            &memory_file,
            [
                "---",
                "name: user-legacy",
                "type: user",
                "scope: global",
                "description: legacy user memory",
                "createdAt: 2026-05-01T00:00:00Z",
                "updatedAt: 2026-05-01T00:00:00Z",
                "---",
                "legacy body",
            ]
            .join("\n"),
        )
        .expect("write legacy memory file");

        let db_path = root.join(DB_FILENAME);
        let legacy = Connection::open(&db_path).expect("open legacy db");
        legacy
            .execute_batch(
                r#"
                CREATE TABLE memory_meta (
                    scope TEXT NOT NULL,
                    workdir_hash TEXT NOT NULL DEFAULT '',
                    slug TEXT NOT NULL,
                    type TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference')),
                    description TEXT NOT NULL DEFAULT '',
                    body_hash TEXT NOT NULL,
                    file_mtime INTEGER NOT NULL,
                    file_size INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    source_json TEXT,
                    links_json TEXT,
                    PRIMARY KEY (scope, workdir_hash, slug)
                );
                CREATE VIRTUAL TABLE memory_fts USING fts5(
                    slug UNINDEXED,
                    scope UNINDEXED,
                    workdir_hash UNINDEXED,
                    type,
                    description,
                    body
                );
                CREATE VIRTUAL TABLE memory_fts_tri USING fts5(
                    slug UNINDEXED,
                    scope UNINDEXED,
                    workdir_hash UNINDEXED,
                    body,
                    tokenize = "trigram"
                );
                CREATE TABLE memory_schema_version (
                    version INTEGER PRIMARY KEY,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO memory_schema_version (version, applied_at) VALUES (1, 0);
                "#,
            )
            .expect("create legacy schema");
        drop(legacy);

        let conn = open_memory_connection(&db_path).expect("open migrated db");
        let store = MemoryStore {
            root,
            db_path,
            conn: Mutex::new(conn),
            mutation_lock: Mutex::new(()),
        };
        store.reconcile().expect("reconcile legacy files");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-legacy".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read migrated memory");
        assert_eq!(read.body, "legacy body");

        let conn = store.lock_conn().expect("lock migrated db");
        let version = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM memory_schema_version",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("schema version");
        assert_eq!(version, 4);
        let meta_columns = table_columns(&conn, "memory_meta").expect("memory_meta columns");
        assert!(meta_columns.contains("archived"));
        let trigram_columns = table_columns(&conn, "memory_fts_tri").expect("trigram columns");
        assert!(trigram_columns.contains("description"));
        assert!(trigram_columns.contains("headline"));
    }

    #[test]
    fn write_read_and_search_global_user_memory() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-name".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "用户叫 Kevin".to_string(),
                body: "用户的名字是 Kevin，是计算机专业的大学生。".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write memory");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-name".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read memory");
        assert!(read.body.contains("Kevin"));

        let search = store
            .search(MemorySearchArgs {
                query: "我是谁".to_string(),
                scope: None,
                workdir: None,
                memory_type: None,
                limit: None,
                include_history: None,
                history_since: None,
                history_until: None,
                history_date_local: None,
                history_time_mode: None,
            })
            .expect("search memory");
        assert!(
            search.matches.iter().any(|item| item.slug == "user-name"),
            "identity query should find user-name: {:?}",
            search.matches
        );
    }

    #[test]
    fn list_quota_reports_applicable_scope_usage() {
        let store = test_store();
        let workdir = tempfile::tempdir().expect("workdir");
        let workdir_text = workdir.path().to_string_lossy().to_string();
        let workdir_hash = workdir_hash(&workdir_text).expect("workdir hash");

        store
            .write(MemoryWriteArgs {
                slug: "user-style".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "feedback".to_string(),
                description: "全局偏好".to_string(),
                body: "用户偏好中文回答。".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write global memory");
        store
            .write(MemoryWriteArgs {
                slug: "project-purpose".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_text.clone()),
                memory_type: "project".to_string(),
                description: "项目目标".to_string(),
                body: "当前项目是 LiveAgent。".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project memory");
        store
            .update(MemoryUpdateArgs {
                slug: "daily-2026-05-18".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("- daily does not count toward ordinary quota".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("append daily");

        let list = store
            .list(MemoryListArgs {
                scope: None,
                workdir: Some(workdir_text),
                include_all_projects: None,
                memory_type: None,
                include_daily: Some(true),
                limit: None,
                offset: None,
            })
            .expect("list memories");

        assert_eq!(list.quota.used, 1);
        assert_eq!(list.quota.limit, MAX_SCOPE_ENTRIES);
        assert_eq!(list.quota.scope_quotas.len(), 2);
        assert!(list.quota.scope_quotas.iter().any(|quota| {
            quota.scope == "global" && quota.workdir_hash.is_empty() && quota.used == 1
        }));
        assert!(list.quota.scope_quotas.iter().any(|quota| {
            quota.scope == "project" && quota.workdir_hash == workdir_hash && quota.used == 1
        }));
    }

    #[test]
    fn list_all_projects_returns_project_paths_and_hash_read_works() {
        let store = test_store();
        let workdir_a = tempfile::tempdir().expect("workdir a");
        let workdir_b = tempfile::tempdir().expect("workdir b");
        let workdir_a_text = workdir_a.path().to_string_lossy().to_string();
        let workdir_b_text = workdir_b.path().to_string_lossy().to_string();
        let workdir_a_hash = workdir_hash(&workdir_a_text).expect("workdir a hash");
        let workdir_b_hash = workdir_hash(&workdir_b_text).expect("workdir b hash");

        store
            .write(MemoryWriteArgs {
                slug: "project-a-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a_text.clone()),
                memory_type: "project".to_string(),
                description: "项目 A 说明".to_string(),
                body: "project A body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project a memory");
        store
            .write(MemoryWriteArgs {
                slug: "project-b-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b_text.clone()),
                memory_type: "project".to_string(),
                description: "项目 B 说明".to_string(),
                body: "project B body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project b memory");

        let list = store
            .list(MemoryListArgs {
                scope: None,
                workdir: None,
                include_all_projects: Some(true),
                memory_type: None,
                include_daily: None,
                limit: None,
                offset: None,
            })
            .expect("list all project memories");

        assert!(list.entries.iter().any(|entry| {
            entry.slug == "project-a-note"
                && entry.workdir_hash == workdir_a_hash
                && entry.workdir_path.as_deref() == Some(workdir_a_text.as_str())
        }));
        assert!(list.entries.iter().any(|entry| {
            entry.slug == "project-b-note"
                && entry.workdir_hash == workdir_b_hash
                && entry.workdir_path.as_deref() == Some(workdir_b_text.as_str())
        }));

        let read = store
            .read(MemoryReadArgs {
                slug: "project-b-note".to_string(),
                scope: Some("project".to_string()),
                workdir: None,
                workdir_hash: Some(workdir_b_hash),
                offset: None,
                length: None,
            })
            .expect("read project memory by workdir hash");
        assert_eq!(read.body, "project B body");
    }

    #[test]
    fn delete_project_removes_only_matching_project_memory() {
        let store = test_store();
        let workdir_a = tempfile::tempdir().expect("workdir a");
        let workdir_b = tempfile::tempdir().expect("workdir b");
        let workdir_a_text = workdir_a.path().to_string_lossy().to_string();
        let workdir_b_text = workdir_b.path().to_string_lossy().to_string();
        let workdir_a_hash = workdir_hash(&workdir_a_text).expect("workdir a hash");
        let workdir_b_hash = workdir_hash(&workdir_b_text).expect("workdir b hash");

        store
            .write(MemoryWriteArgs {
                slug: "global-note".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "全局说明".to_string(),
                body: "global body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write global memory");
        store
            .write(MemoryWriteArgs {
                slug: "project-a-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a_text.clone()),
                memory_type: "project".to_string(),
                description: "项目 A 说明".to_string(),
                body: "project A body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project a memory");
        store
            .write(MemoryWriteArgs {
                slug: "project-b-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b_text.clone()),
                memory_type: "project".to_string(),
                description: "项目 B 说明".to_string(),
                body: "project B body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project b memory");

        let project_a_dir = store.projects_dir().join(&workdir_a_hash);
        assert!(project_a_dir.exists());

        let deleted = store
            .delete_project(MemoryDeleteProjectArgs {
                workdir: workdir_a_text,
                actor: Some("tool".to_string()),
                reason: Some("workspace removal".to_string()),
            })
            .expect("delete project memory");

        assert_eq!(deleted.workdir_hash, workdir_a_hash);
        assert_eq!(deleted.deleted_count, 1);
        let quarantine_path = deleted
            .quarantine_path
            .as_deref()
            .map(PathBuf::from)
            .expect("quarantine path");
        assert!(!project_a_dir.exists());
        assert!(quarantine_path.exists());
        assert!(quarantine_path.join("project-a-note.md").exists());

        let list = store
            .list(MemoryListArgs {
                scope: None,
                workdir: None,
                include_all_projects: Some(true),
                memory_type: None,
                include_daily: None,
                limit: None,
                offset: None,
            })
            .expect("list memories after project delete");
        assert!(!list
            .entries
            .iter()
            .any(|entry| entry.slug == "project-a-note"));
        assert!(list.entries.iter().any(|entry| {
            entry.slug == "project-b-note" && entry.workdir_hash == workdir_b_hash
        }));
        assert!(list.entries.iter().any(|entry| entry.slug == "global-note"));
        store
            .read(MemoryReadArgs {
                slug: "project-a-note".to_string(),
                scope: Some("project".to_string()),
                workdir: None,
                workdir_hash: Some(deleted.workdir_hash),
                offset: None,
                length: None,
            })
            .expect_err("deleted project memory should not be readable");
    }

    #[cfg(unix)]
    #[test]
    fn delete_project_uses_workdir_marker_when_path_no_longer_canonicalizes() {
        use std::os::unix::fs::symlink;

        let store = test_store();
        let real_workdir = tempfile::tempdir().expect("real workdir");
        let link_parent = tempfile::tempdir().expect("link parent");
        let link_path = link_parent.path().join("project-link");
        symlink(real_workdir.path(), &link_path).expect("create workdir symlink");
        let link_text = link_path.to_string_lossy().to_string();
        let canonical_hash = workdir_hash(&link_text).expect("canonical workdir hash");

        store
            .write(MemoryWriteArgs {
                slug: "symlink-project-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(link_text.clone()),
                memory_type: "project".to_string(),
                description: "symlink project".to_string(),
                body: "project body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write symlink project memory");
        assert!(store.projects_dir().join(&canonical_hash).exists());

        fs::remove_file(&link_path).expect("remove workdir symlink");
        let raw_hash = workdir_hash(&link_text).expect("raw workdir hash");
        assert_ne!(raw_hash, canonical_hash);

        let deleted = store
            .delete_project(MemoryDeleteProjectArgs {
                workdir: link_text,
                actor: Some("tool".to_string()),
                reason: Some("workspace removal".to_string()),
            })
            .expect("delete symlink project memory");

        assert_eq!(deleted.workdir_hash, canonical_hash);
        assert_eq!(deleted.deleted_count, 1);
        assert!(!store.projects_dir().join(&canonical_hash).exists());
    }

    #[test]
    fn read_missing_daily_suggests_time_filtered_history_search() {
        let store = test_store();
        let error = store
            .read(MemoryReadArgs {
                slug: "daily-2026-05-13".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect_err("missing daily should return a structured error");
        let value: Value = serde_json::from_str(&error).expect("structured memory error");
        let suggested = value
            .get("suggested_next_call")
            .expect("missing daily should suggest a next call");

        assert_eq!(value["error"], "slug_not_found");
        assert_eq!(suggested["action"], "search");
        assert_eq!(suggested["query"], "2026-05-13");
        assert_eq!(suggested["include_history"], true);
        assert_eq!(suggested["history_date_local"], "2026-05-13");
        assert_eq!(suggested["history_time_mode"], "message");
        assert!(suggested.get("filter_type").is_none());
        assert!(suggested.get("type").is_none());
    }

    #[test]
    fn build_snippet_handles_cjk_byte_offsets() {
        let body = format!("{}但{}", "记".repeat(1069), "后续".repeat(80));
        let snippet = build_snippet(&body, &["但".to_string()]);

        assert!(snippet.contains("但"));
        assert!(snippet.is_char_boundary(snippet.len()));
    }

    #[test]
    fn daily_append_updates_single_file() {
        let store = test_store();
        let slug = "daily-2026-05-13".to_string();
        store
            .update(MemoryUpdateArgs {
                slug: slug.clone(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("## 10:00 — conversation test — liveagent\n- 写入 daily".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: Some("conversation-a".to_string()),
                model: Some("model-a".to_string()),
                evidence: None,
            })
            .expect("append daily");
        store
            .update(MemoryUpdateArgs {
                slug: slug.clone(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("## 11:00 — conversation test — liveagent\n- 完成验证".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: Some("conversation-b".to_string()),
                model: Some("model-b".to_string()),
                evidence: None,
            })
            .expect("append daily again");

        let read = store
            .read(MemoryReadArgs {
                slug,
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read daily");
        assert_eq!(read.headline, "2026-05-13");
        assert_eq!(read.meta.archived, false);
        assert!(read.body.contains("10:00"));
        assert!(read.body.contains("11:00"));
        let sources = read
            .meta
            .source
            .as_array()
            .expect("daily source should be a source array");
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0]["conversationId"], "conversation-a");
        assert_eq!(sources[0]["trigger"], "end");
        assert_eq!(sources[0]["model"], "model-a");
        assert_eq!(sources[1]["conversationId"], "conversation-b");
        assert_eq!(sources[1]["trigger"], "end");
        assert_eq!(sources[1]["model"], "model-b");
    }

    #[test]
    fn list_daily_filter_includes_daily_entries_without_include_daily_flag() {
        let store = test_store();
        store
            .update(MemoryUpdateArgs {
                slug: "daily-2026-05-13".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("- daily entry".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("append daily");

        let list = store
            .list(MemoryListArgs {
                scope: Some("global".to_string()),
                workdir: None,
                include_all_projects: None,
                memory_type: Some("daily".to_string()),
                include_daily: None,
                limit: None,
                offset: None,
            })
            .expect("list daily memories");

        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].slug, "daily-2026-05-13");
        assert_eq!(list.entries[0].memory_type, "daily");
    }

    #[test]
    fn reconcile_archives_old_daily_files() {
        let store = test_store();
        let slug = "daily-2000-01-01".to_string();
        store
            .update(MemoryUpdateArgs {
                slug: slug.clone(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("- old daily entry".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: Some("conversation-old".to_string()),
                model: Some("model-old".to_string()),
                evidence: None,
            })
            .expect("append old daily");

        store.reconcile().expect("reconcile archives old daily");

        assert!(!store.global_daily_dir().join("2000-01-01.md").exists());
        assert!(store
            .global_daily_dir()
            .join(".archive")
            .join("2000")
            .join("2000-01-01.md")
            .exists());
        let read = store
            .read(MemoryReadArgs {
                slug,
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read archived daily");
        assert!(read.meta.archived);
    }

    #[test]
    fn merge_update_preserves_unrelated_trip_details() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "北京找朋友玩的出行计划".to_string(),
                body: [
                    "---",
                    r#"confidence: high"#,
                    r#"source_quote: "请你记住我的计划""#,
                    r#"reasoning: "用户明确要求记住北京出行计划""#,
                    "aliases: []",
                    "conflicts_with: []",
                    r#"supersedes: """#,
                    r#"override_reject: """#,
                    "---",
                    "",
                    "7月去北京找朋友玩的出行计划。",
                    "可能会去找大学同学，也有可能去找我的导师，但是一定会去故宫玩一玩。",
                    "第一天故宫，第二天长城，第三天回去。",
                ]
                .join("\n"),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write original trip plan");

        store
            .update(MemoryUpdateArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: Some("user".to_string()),
                description: Some("北京找朋友玩的出行计划（7月改至8月）".to_string()),
                body: Some(
                    [
                        "---",
                        r#"confidence: medium"#,
                        r#"source_quote: "本来打算7月份去北京玩，但是现在要改到8月了，因为工作很忙""#,
                        r#"reasoning: "用户明确修正了出发月份""#,
                        "aliases: []",
                        "conflicts_with: []",
                        r#"supersedes: """#,
                        r#"override_reject: """#,
                        "---",
                        "",
                        "8月去北京找朋友玩的出行计划，原计划7月但因工作忙推迟到8月。",
                    ]
                    .join("\n"),
                ),
                mode: Some("merge".to_string()),
                actor: Some("extractor".to_string()),
                conversation_id: Some("conversation-merge".to_string()),
                model: Some("model-merge".to_string()),
                evidence: None,
            })
            .expect("merge update trip plan");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read merged trip plan");

        assert!(read.body.contains("8月去北京找朋友玩的出行计划"));
        assert!(read.body.contains("第一天故宫，第二天长城，第三天回去"));
        assert!(read.body.contains("一定会去故宫玩一玩"));
        assert!(!read.body.contains("7月去北京找朋友玩的出行计划。"));
    }

    #[test]
    fn extractor_update_defaults_to_merge_when_mode_is_omitted() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "北京找朋友玩的出行计划".to_string(),
                body: [
                    "7月去北京找朋友玩的出行计划。",
                    "第一天故宫，第二天长城，第三天回去。",
                ]
                .join("\n"),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write original trip plan");

        store
            .update(MemoryUpdateArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: Some("user".to_string()),
                description: Some("北京找朋友玩的出行计划（7月改至8月）".to_string()),
                body: Some(
                    "8月去北京找朋友玩的出行计划，原计划7月但因工作忙推迟到8月。".to_string(),
                ),
                mode: None,
                actor: Some("extractor".to_string()),
                conversation_id: Some("conversation-default-merge".to_string()),
                model: Some("model-default-merge".to_string()),
                evidence: None,
            })
            .expect("extractor update defaults to merge");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read merged trip plan");

        assert!(read.body.contains("8月去北京找朋友玩的出行计划"));
        assert!(read.body.contains("第一天故宫，第二天长城，第三天回去"));
    }

    #[test]
    fn confidence_only_update_refreshes_evidence_without_rewriting_body() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-major".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "用户专业信息".to_string(),
                body: [
                    "---",
                    r#"confidence: low"#,
                    r#"source_quote: "可能是计算机专业""#,
                    r#"reasoning: "早期推断""#,
                    "---",
                    "",
                    "用户可能是计算机专业学生。",
                ]
                .join("\n"),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write low-confidence user memory");

        store
            .update(MemoryUpdateArgs {
                slug: "user-major".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some(
                    [
                        "---",
                        r#"confidence: medium"#,
                        r#"source_quote: "我是计算机专业学生""#,
                        r#"reasoning: "用户在后续轮次自然复述了专业信息""#,
                        "---",
                    ]
                    .join("\n"),
                ),
                mode: Some("merge".to_string()),
                actor: Some("extractor".to_string()),
                conversation_id: Some("conversation-confidence".to_string()),
                model: Some("model-confidence".to_string()),
                evidence: None,
            })
            .expect("confidence-only update");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-major".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read confidence-updated memory");
        assert!(read.meta.unreviewed);
        assert_eq!(read.meta.confidence, "medium");
        assert!(read.body.contains("confidence: medium"));
        assert!(read.body.contains("用户可能是计算机专业学生。"));
        assert!(!read.body.contains("confidence: low"));
    }

    #[test]
    fn apply_batch_slug_exists_uses_merge_for_partial_corrections() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "北京找朋友玩的出行计划".to_string(),
                body: [
                    "7月去北京找朋友玩的出行计划。",
                    "第一天故宫，第二天长城，第三天回去。",
                ]
                .join("\n"),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write original trip plan");

        let response = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: Some("conversation-batch".to_string()),
                trigger: Some("end".to_string()),
                model: Some("deepseek-v4-flash".to_string()),
                local_date: None,
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "upsert".to_string(),
                    slug: "user-beijing-trip-plan".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: Some("user".to_string()),
                    description: Some("北京找朋友玩的出行计划（7月改至8月）".to_string()),
                    body: Some(
                        "8月去北京找朋友玩的出行计划，原计划7月但因工作忙推迟到8月。".to_string(),
                    ),
                    reason: None,
                    group_id: None,
                    evidence: None,
                    mode: None,
                }]),
            })
            .expect("apply batch update");

        assert_eq!(response.created, Vec::<String>::new());
        assert_eq!(response.updated, vec!["user-beijing-trip-plan".to_string()]);

        let read = store
            .read(MemoryReadArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read merged batch plan");

        assert!(read.body.contains("8月去北京找朋友玩的出行计划"));
        assert!(read.body.contains("第一天故宫，第二天长城，第三天回去"));
    }

    #[test]
    fn reviewed_user_memory_outranks_conflicting_daily_journal() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "kevin-accent".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "用户口音偏好".to_string(),
                body: "用户 Kevin 之前让我用北京腔说话，后来改成要求用陕西口音交流，不习惯北京腔。"
                    .to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write user memory");
        store
            .update(MemoryUpdateArgs {
                slug: "daily-2026-05-14".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("## 07:19\n- User: 我希望你在跟我交流的时候带点北京腔儿～".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("append conflicting daily");

        let search = store
            .search(MemorySearchArgs {
                query: "北京腔".to_string(),
                scope: None,
                workdir: None,
                memory_type: None,
                limit: Some(8),
                include_history: None,
                history_since: None,
                history_until: None,
                history_date_local: None,
                history_time_mode: None,
            })
            .expect("search accent memory");

        let user_index = search
            .matches
            .iter()
            .position(|item| item.slug == "kevin-accent")
            .expect("user memory should match");
        let daily_index = search
            .matches
            .iter()
            .position(|item| item.slug == "daily-2026-05-14")
            .expect("daily should match");
        assert!(
            user_index < daily_index,
            "reviewed user preference should outrank daily journal: {:?}",
            search.matches
        );
        assert!(search.matches[user_index].score > search.matches[daily_index].score);
    }

    #[test]
    fn search_recovers_after_poisoned_sqlite_mutex() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-concurrency".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "并发搜索恢复测试".to_string(),
                body: "memory sqlite mutex poison recovery marker".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write memory");

        let poison_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = store.conn.lock().expect("lock memory sqlite mutex");
            panic!("poison memory sqlite mutex for recovery test");
        }));
        assert!(poison_result.is_err());

        let search = store
            .search(MemorySearchArgs {
                query: "poison recovery marker".to_string(),
                scope: None,
                workdir: None,
                memory_type: None,
                limit: Some(8),
                include_history: None,
                history_since: None,
                history_until: None,
                history_date_local: None,
                history_time_mode: None,
            })
            .expect("search should recover poisoned sqlite mutex");

        assert!(
            search
                .matches
                .iter()
                .any(|item| item.slug == "user-concurrency"),
            "search should continue after mutex poison: {:?}",
            search.matches
        );
    }

    #[test]
    fn concurrent_memory_searches_complete_without_lock_errors() {
        let store = Arc::new(test_store());
        store
            .write(MemoryWriteArgs {
                slug: "user-parallel-search".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "并发搜索测试".to_string(),
                body: "parallel search marker should be visible to every concurrent search"
                    .to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write memory");

        let mut handles = Vec::new();
        for _ in 0..16 {
            let store = Arc::clone(&store);
            handles.push(std::thread::spawn(move || {
                store
                    .search(MemorySearchArgs {
                        query: "parallel search marker".to_string(),
                        scope: None,
                        workdir: None,
                        memory_type: None,
                        limit: Some(8),
                        include_history: None,
                        history_since: None,
                        history_until: None,
                        history_date_local: None,
                        history_time_mode: None,
                    })
                    .expect("concurrent memory search")
            }));
        }

        for handle in handles {
            let search = handle.join().expect("search thread joined");
            assert!(
                search
                    .matches
                    .iter()
                    .any(|item| item.slug == "user-parallel-search"),
                "concurrent search should find memory: {:?}",
                search.matches
            );
        }
    }

    #[test]
    fn concurrent_daily_append_preserves_all_entries() {
        let store = Arc::new(test_store());
        let slug = "daily-2026-05-14".to_string();
        let mut handles = Vec::new();
        for index in 0..16 {
            let store = Arc::clone(&store);
            let slug = slug.clone();
            handles.push(std::thread::spawn(move || {
                store
                    .update(MemoryUpdateArgs {
                        slug,
                        scope: Some("global".to_string()),
                        workdir: None,
                        workdir_hash: None,
                        memory_type: None,
                        description: None,
                        body: Some(format!("## {index:02}:00\n- append-{index}")),
                        mode: Some("append".to_string()),
                        actor: None,
                        conversation_id: None,
                        model: None,
                        evidence: None,
                    })
                    .expect("append daily from thread");
            }));
        }
        for handle in handles {
            handle.join().expect("thread joined");
        }

        let read = store
            .read(MemoryReadArgs {
                slug: slug.clone(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read daily");
        for index in 0..16 {
            assert!(read.body.contains(&format!("append-{index}")));
        }

        let list = store
            .list(MemoryListArgs {
                scope: Some("global".to_string()),
                workdir: None,
                include_all_projects: None,
                memory_type: None,
                include_daily: Some(true),
                limit: Some(10),
                offset: None,
            })
            .expect("list daily");
        let entry = list
            .entries
            .iter()
            .find(|entry| entry.slug == slug)
            .expect("daily entry listed");
        assert_eq!(entry.append_count, 16);
    }

    #[test]
    fn project_memory_shadows_global_in_overview() {
        let store = test_store();
        let workdir = std::env::temp_dir().join(format!("liveagent-memory-test-{}", now_ms()));
        fs::create_dir_all(&workdir).expect("create workdir");
        let workdir_text = workdir.to_string_lossy().to_string();

        store
            .write(MemoryWriteArgs {
                slug: "project-style".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "全局说明".to_string(),
                body: "global".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write global");
        store
            .write(MemoryWriteArgs {
                slug: "project-style".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_text.clone()),
                memory_type: "project".to_string(),
                description: "项目说明".to_string(),
                body: "project".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project");

        let overview = store.overview(Some(workdir_text)).expect("overview");
        assert!(overview
            .project
            .iter()
            .any(|entry| entry.slug == "project-style"));
        assert!(!overview
            .global
            .iter()
            .any(|entry| entry.slug == "project-style"));
    }

    #[test]
    fn overview_includes_unreviewed_user_hypotheses_but_excludes_unreviewed_feedback() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-major-unreviewed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "用户可能是计算机专业学生".to_string(),
                body: [
                    "---",
                    r#"confidence: medium"#,
                    r#"source_quote: "我是计算机专业学生""#,
                    r#"reasoning: "用户陈述了身份信息""#,
                    "---",
                    "",
                    "用户可能是计算机专业学生。",
                ]
                .join("\n"),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write unreviewed user");
        store
            .write(MemoryWriteArgs {
                slug: "feedback-unreviewed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "feedback".to_string(),
                description: "未审核偏好".to_string(),
                body: "以后默认使用测试口吻。".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write unreviewed feedback");
        store
            .write(MemoryWriteArgs {
                slug: "reference-unreviewed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "未审核引用".to_string(),
                body: "参考入口仍可作为弱证据。".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write unreviewed reference");

        let overview = store.overview(None).expect("overview");
        assert!(overview.user.iter().any(|entry| {
            entry.slug == "user-major-unreviewed"
                && entry.unreviewed
                && entry.confidence == "medium"
        }));
        assert!(!overview
            .user
            .iter()
            .any(|entry| entry.slug == "feedback-unreviewed"));
        assert!(overview
            .global
            .iter()
            .any(|entry| entry.slug == "reference-unreviewed" && entry.unreviewed));
    }

    #[test]
    fn direct_write_applies_hard_and_soft_risk_filters() {
        let store = test_store();
        let hard = store
            .write(MemoryWriteArgs {
                slug: "secret-token".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "secret".to_string(),
                body: "API key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA must be saved".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect_err("hard secret-like content should be blocked");
        assert!(hard.contains("risk_hard_blocked"));

        store
            .write(MemoryWriteArgs {
                slug: "soft-risk-note".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "soft risk".to_string(),
                body: "排障步骤里提到 sudo apt install。".to_string(),
                actor: Some("tool".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("soft risk note should be stored as unreviewed");
        let read = store
            .read(MemoryReadArgs {
                slug: "soft-risk-note".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read soft risk note");
        assert!(read.meta.unreviewed);
        assert_eq!(
            read.meta.source.get("risk_flag").and_then(Value::as_str),
            Some("low")
        );
    }

    #[test]
    fn project_search_is_limited_to_current_workdir() {
        let store = test_store();
        let workdir_a = std::env::temp_dir().join(format!("liveagent-memory-a-{}", now_ms()));
        let workdir_b = std::env::temp_dir().join(format!("liveagent-memory-b-{}", now_ms()));
        fs::create_dir_all(&workdir_a).expect("create workdir a");
        fs::create_dir_all(&workdir_b).expect("create workdir b");
        let workdir_a = workdir_a.to_string_lossy().to_string();
        let workdir_b = workdir_b.to_string_lossy().to_string();

        store
            .write(MemoryWriteArgs {
                slug: "project-alpha".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a.clone()),
                memory_type: "project".to_string(),
                description: "alpha sharedprojectmarker".to_string(),
                body: "sharedprojectmarker belongs to project alpha".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project a");
        store
            .write(MemoryWriteArgs {
                slug: "project-beta".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b),
                memory_type: "project".to_string(),
                description: "beta sharedprojectmarker".to_string(),
                body: "sharedprojectmarker belongs to project beta".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project b");

        let search = store
            .search(MemorySearchArgs {
                query: "sharedprojectmarker".to_string(),
                scope: None,
                workdir: Some(workdir_a),
                memory_type: None,
                limit: Some(10),
                include_history: None,
                history_since: None,
                history_until: None,
                history_date_local: None,
                history_time_mode: None,
            })
            .expect("search current project");

        assert!(search
            .matches
            .iter()
            .any(|item| item.slug == "project-alpha"));
        assert!(!search
            .matches
            .iter()
            .any(|item| item.slug == "project-beta"));
    }

    #[test]
    fn recent_rejections_only_returns_user_deletions_for_current_scope() {
        let store = test_store();
        let workdir_a = std::env::temp_dir().join(format!("liveagent-reject-a-{}", now_ms()));
        let workdir_b = std::env::temp_dir().join(format!("liveagent-reject-b-{}", now_ms()));
        fs::create_dir_all(&workdir_a).expect("create workdir a");
        fs::create_dir_all(&workdir_b).expect("create workdir b");
        let workdir_a = workdir_a.to_string_lossy().to_string();
        let workdir_b = workdir_b.to_string_lossy().to_string();

        store
            .write(MemoryWriteArgs {
                slug: "user-career".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "职业方向".to_string(),
                body: "用户计划转销售".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write global");
        store
            .delete(MemoryDeleteArgs {
                slug: "user-career".to_string(),
                scope: "global".to_string(),
                workdir: None,
                workdir_hash: None,
                actor: Some("user".to_string()),
                reason: Some("用户不想保留这个旧结论".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("delete global as user");

        store
            .write(MemoryWriteArgs {
                slug: "project-plan".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a.clone()),
                memory_type: "project".to_string(),
                description: "当前项目计划".to_string(),
                body: "project A".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project a");
        store
            .delete(MemoryDeleteArgs {
                slug: "project-plan".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a.clone()),
                workdir_hash: None,
                actor: Some("user".to_string()),
                reason: Some("project A rejection".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("delete project a as user");

        store
            .write(MemoryWriteArgs {
                slug: "project-plan".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b.clone()),
                memory_type: "project".to_string(),
                description: "其他项目计划".to_string(),
                body: "project B".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project b");
        store
            .delete(MemoryDeleteArgs {
                slug: "project-plan".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b),
                workdir_hash: None,
                actor: Some("user".to_string()),
                reason: Some("project B rejection".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("delete project b as user");

        store
            .write(MemoryWriteArgs {
                slug: "tool-removed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "工具清理".to_string(),
                body: "tool removed".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write tool cleanup");
        store
            .delete(MemoryDeleteArgs {
                slug: "tool-removed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                workdir_hash: None,
                actor: Some("tool".to_string()),
                reason: Some("tool cleanup".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("delete global as tool");

        let response = store
            .recent_rejections(MemoryRecentRejectionsArgs {
                since_days: Some(7),
                limit: Some(10),
                workdir: Some(workdir_a),
            })
            .expect("recent rejections");

        assert_eq!(response.entries.len(), 2);
        assert!(response
            .entries
            .iter()
            .any(|entry| entry.slug == "user-career" && entry.scope == "global"));
        assert!(response.entries.iter().any(|entry| {
            entry.slug == "project-plan"
                && entry.scope == "project"
                && entry.reason.as_deref() == Some("project A rejection")
        }));
        assert!(!response
            .entries
            .iter()
            .any(|entry| entry.reason.as_deref() == Some("project B rejection")));
        assert!(!response
            .entries
            .iter()
            .any(|entry| entry.slug == "tool-removed"));
    }

    #[test]
    fn extractor_upsert_reports_created_and_marks_unreviewed() {
        let store = test_store();
        let first = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: Some("conversation-memory-test".to_string()),
                trigger: Some("end".to_string()),
                model: Some("test-model".to_string()),
                local_date: Some("2026-05-13".to_string()),
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "upsert".to_string(),
                    slug: "user-test-major".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: Some("user".to_string()),
                    description: Some("用户是计算机专业学生".to_string()),
                    body: Some("用户是计算机专业的大学生。".to_string()),
                    reason: None,
                    group_id: None,
                    evidence: None,
                    mode: None,
                }]),
            })
            .expect("first extractor batch");
        assert_eq!(first.created, vec!["user-test-major".to_string()]);
        assert!(first.updated.is_empty());

        let read = store
            .read(MemoryReadArgs {
                slug: "user-test-major".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read extractor memory");
        assert!(read.meta.unreviewed);

        let second = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: Some("conversation-memory-test".to_string()),
                trigger: Some("end".to_string()),
                model: Some("test-model".to_string()),
                local_date: Some("2026-05-13".to_string()),
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "upsert".to_string(),
                    slug: "user-test-major".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: Some("user".to_string()),
                    description: Some("用户仍是计算机专业学生".to_string()),
                    body: Some("用户是计算机专业的大学生，偏好工程化回答。".to_string()),
                    reason: None,
                    group_id: None,
                    evidence: None,
                    mode: None,
                }]),
            })
            .expect("second extractor batch");
        assert!(second.created.is_empty());
        assert_eq!(second.updated, vec!["user-test-major".to_string()]);
    }

    #[test]
    fn memory_organize_apply_batch_snapshots_before_update_and_delete() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "organize-target".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "整理目标".to_string(),
                body: "旧内容".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write organize target");
        store
            .write(MemoryWriteArgs {
                slug: "organize-delete".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "整理删除".to_string(),
                body: "将被删除".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write organize delete target");

        let updated = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: None,
                trigger: Some("memory-organize".to_string()),
                model: Some("organizer-model".to_string()),
                local_date: None,
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "upsert".to_string(),
                    slug: "organize-target".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: Some("user".to_string()),
                    description: Some("整理目标更新".to_string()),
                    body: Some("新内容".to_string()),
                    reason: Some("test update snapshot".to_string()),
                    group_id: None,
                    evidence: None,
                    mode: None,
                }]),
            })
            .expect("organizer update batch");
        assert_eq!(updated.updated, vec!["organize-target".to_string()]);
        let replaced = store
            .read(MemoryReadArgs {
                slug: "organize-target".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read organizer replacement");
        assert_eq!(replaced.body, "新内容");

        let deleted = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: None,
                trigger: Some("memory-organize".to_string()),
                model: Some("organizer-model".to_string()),
                local_date: None,
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "delete".to_string(),
                    slug: "organize-delete".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: None,
                    description: None,
                    body: None,
                    reason: Some("test delete snapshot".to_string()),
                    group_id: None,
                    evidence: None,
                    mode: None,
                }]),
            })
            .expect("organizer delete batch");
        assert_eq!(deleted.deleted, vec!["organize-delete".to_string()]);

        let snapshot_dir = store.root.join("global").join(".organize-snapshots");
        let snapshot_count = fs::read_dir(snapshot_dir)
            .expect("snapshot dir")
            .filter_map(Result::ok)
            .count();
        assert_eq!(snapshot_count, 2);
    }

    #[test]
    fn memory_organize_group_skips_deletes_when_update_fails() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "organize-large-target".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "整理目标".to_string(),
                body: "旧内容".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write large target");
        store
            .write(MemoryWriteArgs {
                slug: "organize-large-source".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "整理来源".to_string(),
                body: "来源内容".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write large source");

        let response = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: None,
                trigger: Some("memory-organize".to_string()),
                model: Some("organizer-model".to_string()),
                local_date: None,
                daily_append: None,
                decisions: Some(vec![
                    MemoryDecisionArgs {
                        op: "upsert".to_string(),
                        slug: "organize-large-target".to_string(),
                        scope: Some("global".to_string()),
                        workdir_hash: None,
                        memory_type: Some("reference".to_string()),
                        description: Some("整理目标更新".to_string()),
                        body: Some("x".repeat(MAX_BODY_BYTES + 1)),
                        reason: Some("oversized grouped update".to_string()),
                        group_id: Some("merge-test-group".to_string()),
                        evidence: None,
                        mode: None,
                    },
                    MemoryDecisionArgs {
                        op: "delete".to_string(),
                        slug: "organize-large-source".to_string(),
                        scope: Some("global".to_string()),
                        workdir_hash: None,
                        memory_type: None,
                        description: None,
                        body: None,
                        reason: Some("merged into target".to_string()),
                        group_id: Some("merge-test-group".to_string()),
                        evidence: None,
                        mode: None,
                    },
                ]),
            })
            .expect("organizer grouped batch");

        assert!(response.updated.is_empty());
        assert!(response.deleted.is_empty());
        assert!(response
            .warning_details
            .iter()
            .any(|warning| warning.code == "body_too_large"));
        assert!(response
            .warning_details
            .iter()
            .any(|warning| warning.code == "group_upsert_failed"));
        store
            .read(MemoryReadArgs {
                slug: "organize-large-source".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("source should remain after grouped update failure");
    }

    #[test]
    fn write_with_evidence_applies_contract_and_renders_frontmatter() {
        let store = test_store();

        // high + sufficient quote stays high
        let high = store
            .write(MemoryWriteArgs {
                slug: "pref-editor".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "prefers vim".to_string(),
                body: "User prefers vim keybindings.".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: Some(MemoryEvidenceArgs {
                    confidence: Some("high".to_string()),
                    source_quote: Some("我一直用 vim 的键位".to_string()),
                    reasoning: Some("explicit statement".to_string()),
                    ..Default::default()
                }),
            })
            .expect("write with evidence");
        assert_eq!(high.applied_confidence.as_deref(), Some("high"));
        assert_eq!(high.auto_downgraded, Some(false));

        // high + short quote downgrades to medium
        let downgraded = store
            .write(MemoryWriteArgs {
                slug: "pref-shell".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "prefers zsh".to_string(),
                body: "User prefers zsh.".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: Some(MemoryEvidenceArgs {
                    confidence: Some("high".to_string()),
                    source_quote: Some("zsh".to_string()),
                    ..Default::default()
                }),
            })
            .expect("write with short quote");
        assert_eq!(downgraded.applied_confidence.as_deref(), Some("medium"));
        assert_eq!(downgraded.auto_downgraded, Some(true));

        // medium + empty quote downgrades to low
        let low = store
            .write(MemoryWriteArgs {
                slug: "pref-theme".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "prefers dark theme".to_string(),
                body: "User prefers dark theme.".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: Some(MemoryEvidenceArgs {
                    confidence: Some("medium".to_string()),
                    ..Default::default()
                }),
            })
            .expect("write with empty quote");
        assert_eq!(low.applied_confidence.as_deref(), Some("low"));
        assert_eq!(low.auto_downgraded, Some(true));

        // the indexer must read the rendered frontmatter back (single parse path)
        let read = store
            .read(MemoryReadArgs {
                slug: "pref-editor".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read entry");
        assert_eq!(read.meta.confidence, "high");
        assert!(read.body.contains("confidence: high"));
        assert!(read.body.contains("User prefers vim keybindings."));

        // evidence-only update changes confidence without touching content
        let evidence_only = store
            .update(MemoryUpdateArgs {
                slug: "pref-editor".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: None,
                mode: Some("merge".to_string()),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: Some(MemoryEvidenceArgs {
                    confidence: Some("medium".to_string()),
                    source_quote: Some("其实我最近换 helix 了".to_string()),
                    ..Default::default()
                }),
            })
            .expect("evidence-only update");
        assert_eq!(evidence_only.applied_confidence.as_deref(), Some("medium"));
        let after = store
            .read(MemoryReadArgs {
                slug: "pref-editor".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read after evidence-only update");
        assert_eq!(after.meta.confidence, "medium");
        assert!(after.body.contains("User prefers vim keybindings."));
    }

    #[test]
    fn apply_batch_accept_flips_unreviewed() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "team-workflow".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "feedback".to_string(),
                description: "commit style".to_string(),
                body: "Use conventional commits.".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write unreviewed entry");

        let response = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: None,
                trigger: Some("memory-extraction".to_string()),
                model: None,
                local_date: None,
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "accept".to_string(),
                    slug: "team-workflow".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: None,
                    description: None,
                    body: None,
                    reason: None,
                    group_id: None,
                    evidence: None,
                    mode: None,
                }]),
            })
            .expect("apply accept batch");
        assert_eq!(response.updated, vec!["team-workflow".to_string()]);
        assert!(response.warnings.is_empty());

        let list = store
            .list(MemoryListArgs {
                scope: Some("global".to_string()),
                workdir: None,
                include_all_projects: None,
                memory_type: None,
                include_daily: None,
                limit: None,
                offset: None,
            })
            .expect("list entries");
        let entry = list
            .entries
            .iter()
            .find(|entry| entry.slug == "team-workflow")
            .expect("entry present");
        assert!(!entry.unreviewed);
    }

    #[test]
    fn quota_summary_counts_scopes_and_unreviewed() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "reviewed-entry".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "reviewed".to_string(),
                body: "Reviewed entry.".to_string(),
                actor: Some("user".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write reviewed");
        store
            .write(MemoryWriteArgs {
                slug: "unreviewed-entry".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "unreviewed".to_string(),
                body: "Unreviewed entry.".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write unreviewed");

        let summary = store
            .quota_summary(MemoryQuotaSummaryArgs { workdir: None })
            .expect("quota summary");
        assert_eq!(summary.scopes.len(), 1);
        let global = &summary.scopes[0];
        assert_eq!(global.scope, "global");
        assert_eq!(global.used, 2);
        assert_eq!(global.limit, MAX_SCOPE_ENTRIES);
        assert_eq!(global.headroom, MAX_SCOPE_ENTRIES - 2);
        assert_eq!(global.unreviewed_count, 1);
        assert!(global.oldest_unreviewed_age_days.is_some());

        let workdir = tempfile::tempdir().expect("workdir");
        let workdir_path = workdir.path().to_string_lossy().to_string();
        store
            .write(MemoryWriteArgs {
                slug: "project-entry".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_path.clone()),
                memory_type: "project".to_string(),
                description: "project note".to_string(),
                body: "Project note.".to_string(),
                actor: Some("user".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("write project entry");
        let with_project = store
            .quota_summary(MemoryQuotaSummaryArgs {
                workdir: Some(workdir_path),
            })
            .expect("quota summary with project");
        assert_eq!(with_project.scopes.len(), 2);
        let project = &with_project.scopes[1];
        assert_eq!(project.scope, "project");
        assert_eq!(project.used, 1);
        assert_eq!(project.unreviewed_count, 0);
        assert!(project.oldest_unreviewed_age_days.is_none());
    }

    #[test]
    fn organize_runs_v3_to_v4_migration_preserves_history() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("memory");
        ensure_root_dirs(&root).expect("root dirs");
        let db_path = root.join(DB_FILENAME);

        // Simulate a v3-era database: old-shape organize_runs table + version 3.
        {
            let conn = Connection::open(&db_path).expect("open raw db");
            conn.execute_batch(
                r#"
                CREATE TABLE memory_organize_runs (
                    run_id                TEXT PRIMARY KEY,
                    trigger               TEXT NOT NULL,
                    status                TEXT NOT NULL,
                    created_at            INTEGER NOT NULL,
                    started_at            INTEGER,
                    finished_at           INTEGER,
                    due_at                INTEGER,
                    claimed_at            INTEGER,
                    model_json            TEXT,
                    scope                 TEXT NOT NULL DEFAULT 'all',
                    mode                  TEXT NOT NULL DEFAULT 'standard',
                    input_count           INTEGER NOT NULL DEFAULT 0,
                    cluster_count         INTEGER NOT NULL DEFAULT 0,
                    safe_applied          INTEGER NOT NULL DEFAULT 0,
                    review_skipped        INTEGER NOT NULL DEFAULT 0,
                    created_count         INTEGER NOT NULL DEFAULT 0,
                    updated_count         INTEGER NOT NULL DEFAULT 0,
                    deleted_count         INTEGER NOT NULL DEFAULT 0,
                    merged_count          INTEGER NOT NULL DEFAULT 0,
                    parse_failures        INTEGER NOT NULL DEFAULT 0,
                    error                 TEXT,
                    final_summary         TEXT,
                    trimmed_protocol_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE memory_schema_version (
                    version    INTEGER PRIMARY KEY,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO memory_schema_version (version, applied_at) VALUES (3, 0);
                INSERT INTO memory_organize_runs (run_id, trigger, status, created_at)
                VALUES ('memory-organize-legacy', 'manual', 'succeeded', 1000);
                "#,
            )
            .expect("seed v3 schema");
        }

        let conn = open_memory_connection(&db_path).expect("open migrated db");
        let store = MemoryStore {
            root,
            db_path,
            conn: Mutex::new(conn),
            mutation_lock: Mutex::new(()),
        };
        std::mem::forget(temp);

        let run = store
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: "memory-organize-legacy".to_string(),
            })
            .expect("read legacy run")
            .expect("legacy run retained");
        assert_eq!(run.status, "succeeded");
        assert_eq!(run.final_count, 0);
        assert!(!run.dry_run);
        assert!(run.phase.is_none());

        // v4 fields are writable after migration
        let updated = store
            .organize_run_update(MemoryOrganizeRunUpdateArgs {
                run_id: "memory-organize-legacy".to_string(),
                phase: Some("apply".to_string()),
                final_count: Some(20),
                compression_ratio: Some(0.8),
                token_usage_total: Some(1234),
                ..Default::default()
            })
            .expect("update with v4 fields")
            .expect("run present");
        assert_eq!(updated.phase.as_deref(), Some("apply"));
        assert_eq!(updated.final_count, 20);
        assert_eq!(updated.token_usage_total, 1234);
    }

    #[test]
    fn apply_batch_update_supports_partial_and_evidence_only_revisions() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-editor".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "editor preference".to_string(),
                body: "User prefers vim.".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
                evidence: None,
            })
            .expect("seed entry");

        // evidence-only update: no body/description/type, evidence only
        let response = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: None,
                trigger: Some("memory-extraction".to_string()),
                model: None,
                local_date: None,
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "update".to_string(),
                    slug: "user-editor".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: None,
                    description: None,
                    body: None,
                    mode: Some("merge".to_string()),
                    reason: None,
                    group_id: None,
                    evidence: Some(MemoryEvidenceArgs {
                        confidence: Some("high".to_string()),
                        source_quote: Some("我只用 vim，别的都不用".to_string()),
                        ..Default::default()
                    }),
                }]),
            })
            .expect("apply evidence-only update");
        assert_eq!(response.updated, vec!["user-editor".to_string()]);
        assert!(response.warnings.is_empty(), "{:?}", response.warnings);

        let read = store
            .read(MemoryReadArgs {
                slug: "user-editor".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read updated entry");
        assert_eq!(read.meta.confidence, "high");
        assert!(read.body.contains("User prefers vim."));
    }
}

