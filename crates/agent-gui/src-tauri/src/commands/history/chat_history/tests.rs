#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> Result<Connection, String> {
        let conn =
            Connection::open_in_memory().map_err(|e| format!("打开测试聊天历史数据库失败：{e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("设置测试 SQLite busy_timeout 失败：{e}"))?;
        history_db::initialize_connection(&conn)?;
        Ok(conn)
    }

    fn sample_conversation() -> ChatHistoryConversationInput {
        ChatHistoryConversationInput {
            id: "conv-1".to_string(),
            title: "Test Conversation".to_string(),
            provider_id: "codex".to_string(),
            model: "gpt-5".to_string(),
            session_id: Some("session-1".to_string()),
            cwd: Some("/tmp".to_string()),
            selected_model_json: None,
            context_meta_json: "{}".to_string(),
            active_segment_index: 0,
            total_segment_count: 1,
            total_message_count: 3,
            created_at: Some(1_700_000_000_000),
            updated_at: 1_700_000_000_100,
        }
    }

    fn table_column_names(conn: &Connection, table_name: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table_name})"))
            .expect("prepare table info query");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info");
        let mut columns = rows
            .map(|row| row.expect("read table column name"))
            .collect::<Vec<_>>();
        columns.sort();
        columns
    }

    fn insert_subagent_run_for_test(
        conn: &Connection,
        run_id: &str,
        parent_tool_call_id: &str,
        agent_index: i64,
    ) {
        conn.execute(
            "
            INSERT INTO subagentRun (
                id,
                parent_conversation_id,
                parent_tool_call_id,
                agent_id,
                agent_index,
                agent_total,
                prompt,
                mode,
                status,
                provider_id,
                model,
                context_schema_version,
                active_segment_index,
                total_segment_count,
                total_message_count,
                round_count,
                tool_call_count,
                compaction_count,
                started_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
            ",
            params![
                run_id,
                "conv-1",
                parent_tool_call_id,
                format!("agent-{agent_index}"),
                agent_index,
                2,
                format!("Agent {agent_index}"),
                "worktree",
                "completed",
                "codex",
                "gpt-5",
                1,
                0,
                1,
                1,
                0,
                0,
                0,
                1_700_000_000_100_i64,
                1_700_000_000_200_i64,
            ],
        )
        .expect("insert subagent run");
    }

    #[test]
    fn get_summary_by_id_reads_total_message_count() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();

        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        let summary = get_summary_by_id(&conn, &conversation.id).expect("load summary");

        assert_eq!(summary.id, conversation.id);
        assert_eq!(summary.message_count, conversation.total_message_count);
        assert_eq!(summary.title, conversation.title);
    }

    #[test]
    fn initialize_db_migrates_legacy_pin_columns() {
        let conn =
            Connection::open_in_memory().expect("open legacy in-memory chat history database");
        conn.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                session_id TEXT,
                cwd TEXT,
                context_meta_json TEXT,
                active_segment_index INTEGER,
                total_segment_count INTEGER,
                total_message_count INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ",
        )
        .expect("create legacy chatHistory table");

        history_db::initialize_connection(&conn).expect("migrate legacy schema");

        let is_pinned_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('chatHistory') WHERE name = 'is_pinned'",
                [],
                |row| row.get(0),
            )
            .expect("query is_pinned column");
        let pinned_at_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('chatHistory') WHERE name = 'pinned_at'",
                [],
                |row| row.get(0),
            )
            .expect("query pinned_at column");

        assert_eq!(is_pinned_exists, 1);
        assert_eq!(pinned_at_exists, 1);
        let share_table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'chatHistoryShare'",
                [],
                |row| row.get(0),
            )
            .expect("query share table");
        assert_eq!(share_table_exists, 1);
    }

    #[test]
    fn initialize_db_migrates_legacy_history_columns_for_list_query() {
        let conn =
            Connection::open_in_memory().expect("open legacy in-memory chat history database");
        conn.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            INSERT INTO chatHistory (
                id,
                title,
                provider_id,
                model,
                created_at,
                updated_at
            ) VALUES (
                'legacy-conv',
                'Legacy Conversation',
                'codex',
                'gpt-5',
                1700000000000,
                1700000000100
            );
            ",
        )
        .expect("create legacy chatHistory table");

        history_db::initialize_connection(&conn).expect("migrate legacy schema");

        let summaries = list_chat_history_sync(&conn, 1, 20).expect("list migrated legacy history");
        assert_eq!(summaries.total_count, 1);
        let summaries = summaries.items;
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "legacy-conv");
        assert_eq!(summaries[0].session_id, None);
        assert_eq!(summaries[0].cwd, None);
        assert_eq!(summaries[0].message_count, 0);
        assert!(!summaries[0].is_pinned);

        let record = get_record_by_id(&conn, "legacy-conv").expect("load migrated record");
        assert_eq!(record.context_meta_json, "{}");
        assert_eq!(record.active_segment_index, 0);
        assert_eq!(record.total_segment_count, 1);
        assert_eq!(record.total_message_count, 0);
    }

    #[test]
    fn initialize_db_tolerates_case_variant_existing_columns() {
        let conn =
            Connection::open_in_memory().expect("open legacy in-memory chat history database");
        conn.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                Context_Meta_Json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            INSERT INTO chatHistory (
                id,
                title,
                provider_id,
                model,
                created_at,
                updated_at
            ) VALUES (
                'legacy-conv',
                'Legacy Conversation',
                'codex',
                'gpt-5',
                1700000000000,
                1700000000100
            );
            ",
        )
        .expect("create legacy chatHistory table with case-variant context meta column");

        history_db::initialize_connection(&conn)
            .expect("migrate legacy schema with case-variant column");

        let context_meta_json: String = conn
            .query_row(
                "SELECT context_meta_json FROM chatHistory WHERE id = 'legacy-conv'",
                [],
                |row| row.get(0),
            )
            .expect("query migrated context meta");
        assert_eq!(context_meta_json, "{}");
    }

    #[test]
    fn migrated_legacy_table_columns_match_fresh_schema() {
        let fresh = open_test_db().expect("open fresh test db");
        let legacy =
            Connection::open_in_memory().expect("open legacy in-memory chat history database");
        legacy
            .execute_batch(
                "
                CREATE TABLE chatHistory (
                    id TEXT PRIMARY KEY
                );

                CREATE TABLE chatHistorySegment (
                    conversation_id TEXT NOT NULL,
                    segment_index INTEGER NOT NULL,
                    PRIMARY KEY (conversation_id, segment_index)
                );

                CREATE TABLE chatHistoryShare (
                    conversation_id TEXT PRIMARY KEY
                );

                CREATE TABLE chatHistoryFtsSegmentIndex (
                    conversation_id TEXT NOT NULL,
                    segment_index INTEGER NOT NULL,
                    PRIMARY KEY (conversation_id, segment_index)
                );

                INSERT INTO chatHistory (id) VALUES ('legacy-conv');
                INSERT INTO chatHistorySegment (
                    conversation_id,
                    segment_index
                ) VALUES (
                    'legacy-conv',
                    0
                );
                INSERT INTO chatHistoryShare (conversation_id) VALUES ('legacy-conv');
                ",
            )
            .expect("create minimal legacy history schema");

        history_db::initialize_connection(&legacy).expect("migrate minimal legacy schema");

        for table_name in [
            "chatHistory",
            "chatHistorySegment",
            "chatHistoryShare",
            "chatHistoryFtsSegmentIndex",
        ] {
            assert_eq!(
                table_column_names(&legacy, table_name),
                table_column_names(&fresh, table_name),
                "migrated {table_name} columns should match fresh schema"
            );
        }

        let summaries =
            list_chat_history_sync(&legacy, 1, 20).expect("list minimal migrated history");
        assert_eq!(summaries.total_count, 1);
        let summaries = summaries.items;
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "Untitled");
        assert_eq!(summaries[0].message_count, 0);

        let segments = load_segments(&legacy, "legacy-conv").expect("load minimal segment");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].segment_id, "segment-0");
        assert_eq!(segments[0].messages_json, "[]");
        assert_eq!(segments[0].message_count, 0);
    }

    #[test]
    fn pinned_history_sorts_first_and_unpin_restores_updated_order() {
        let conn = open_test_db().expect("open test db");
        let mut older = sample_conversation();
        older.id = "older".to_string();
        older.updated_at = 1_700_000_000_100;
        let mut newer = sample_conversation();
        newer.id = "newer".to_string();
        newer.updated_at = 1_700_000_000_200;

        upsert_chat_history_header(&conn, &older).expect("upsert older header");
        upsert_chat_history_header(&conn, &newer).expect("upsert newer header");
        let pinned =
            set_chat_history_pinned_sync(&conn, "older", true).expect("pin older conversation");
        assert!(pinned.is_pinned);
        assert!(pinned.pinned_at.is_some());

        let pinned_order = list_chat_history_sync(&conn, 1, 20)
            .expect("list pinned history")
            .items;
        assert_eq!(
            pinned_order
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["older", "newer"]
        );

        let unpinned =
            set_chat_history_pinned_sync(&conn, "older", false).expect("unpin older conversation");
        assert!(!unpinned.is_pinned);
        assert_eq!(unpinned.pinned_at, None);

        let restored_order = list_chat_history_sync(&conn, 1, 20)
            .expect("list unpinned history")
            .items;
        assert_eq!(
            restored_order
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["newer", "older"]
        );
    }

    #[test]
    fn list_history_returns_limited_page_and_total() {
        let conn = open_test_db().expect("open test db");
        for index in 0..5 {
            let mut conversation = sample_conversation();
            conversation.id = format!("conv-{index}");
            conversation.updated_at = 1_700_000_000_000 + index;
            upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        }

        let page = list_chat_history_sync(&conn, 2, 2).expect("list history page");

        assert_eq!(page.total_count, 5);
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["conv-2", "conv-1"]
        );
    }

    #[test]
    fn list_history_filters_by_cwd_and_empty_cwd() {
        let conn = open_test_db().expect("open test db");
        let mut project_a = sample_conversation();
        project_a.id = "project-a".to_string();
        project_a.cwd = Some("/tmp/project-a".to_string());
        project_a.updated_at = 1_700_000_000_300;
        let mut project_b = sample_conversation();
        project_b.id = "project-b".to_string();
        project_b.cwd = Some("/tmp/project-b".to_string());
        project_b.updated_at = 1_700_000_000_200;
        let mut empty_cwd = sample_conversation();
        empty_cwd.id = "chat-mode".to_string();
        empty_cwd.cwd = None;
        empty_cwd.updated_at = 1_700_000_000_100;

        upsert_chat_history_header(&conn, &project_a).expect("upsert project a");
        upsert_chat_history_header(&conn, &project_b).expect("upsert project b");
        upsert_chat_history_header(&conn, &empty_cwd).expect("upsert empty cwd");

        let project_page = list_chat_history_sync_with_filter(
            &conn,
            1,
            20,
            ChatHistoryListFilter {
                cwd: Some("/tmp/project-a".to_string()),
                cwd_empty: false,
            },
        )
        .expect("list project cwd history");
        assert_eq!(project_page.total_count, 1);
        assert_eq!(project_page.items[0].id, "project-a");

        let empty_page = list_chat_history_sync_with_filter(
            &conn,
            1,
            20,
            ChatHistoryListFilter {
                cwd: None,
                cwd_empty: true,
            },
        )
        .expect("list empty cwd history");
        assert_eq!(empty_page.total_count, 1);
        assert_eq!(empty_page.items[0].id, "chat-mode");
    }

    #[test]
    fn list_history_workdirs_returns_distinct_non_empty_cwd_counts() {
        let conn = open_test_db().expect("open test db");
        for (id, cwd, updated_at) in [
            ("project-a-older", "/tmp/project-a", 1_700_000_000_100),
            ("project-a-newer", "/tmp/project-a", 1_700_000_000_300),
            ("project-b", "/tmp/project-b", 1_700_000_000_200),
        ] {
            let mut conversation = sample_conversation();
            conversation.id = id.to_string();
            conversation.cwd = Some(cwd.to_string());
            conversation.updated_at = updated_at;
            upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        }
        let mut empty_cwd = sample_conversation();
        empty_cwd.id = "chat-mode".to_string();
        empty_cwd.cwd = None;
        upsert_chat_history_header(&conn, &empty_cwd).expect("upsert empty cwd");

        let response = list_chat_history_workdirs_sync(&conn).expect("list workdirs");

        assert_eq!(response.workdirs.len(), 2);
        assert_eq!(response.workdirs[0].path, "/tmp/project-a");
        assert_eq!(response.workdirs[0].conversation_count, 2);
        assert_eq!(response.workdirs[0].updated_at, 1_700_000_000_300);
        assert_eq!(response.workdirs[1].path, "/tmp/project-b");
        assert_eq!(response.workdirs[1].conversation_count, 1);
    }

    #[test]
    fn list_shared_history_returns_enabled_shares_only() {
        let conn = open_test_db().expect("open test db");
        for index in 0..4 {
            let mut conversation = sample_conversation();
            conversation.id = format!("conv-{index}");
            conversation.updated_at = 1_700_000_000_000 + index;
            upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        }

        set_chat_history_share_enabled_sync(&conn, "conv-0", true, None).expect("share conv-0");
        set_chat_history_share_enabled_sync(&conn, "conv-2", true, None).expect("share conv-2");
        set_chat_history_share_enabled_sync(&conn, "conv-3", true, None).expect("share conv-3");
        set_chat_history_share_enabled_sync(&conn, "conv-3", false, None)
            .expect("disable conv-3 share");

        let page = list_shared_chat_history_sync(&conn, 1, 1).expect("list shared history");

        assert_eq!(page.total_count, 2);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "conv-2");
        assert!(page.items[0].is_shared);
    }

    #[test]
    fn upsert_header_preserves_existing_pin_state() {
        let conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();

        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        let pinned = set_chat_history_pinned_sync(&conn, "conv-1", true).expect("pin conversation");
        let pinned_at = pinned.pinned_at.expect("pinned_at set");

        conversation.title = "Updated Conversation".to_string();
        conversation.updated_at += 1_000;
        upsert_chat_history_header(&conn, &conversation).expect("upsert updated header");
        let summary = get_summary_by_id(&conn, "conv-1").expect("load updated summary");

        assert!(summary.is_pinned);
        assert_eq!(summary.pinned_at, Some(pinned_at));
        assert_eq!(summary.title, "Updated Conversation");
    }

    #[test]
    fn v1_database_gains_selected_model_column_via_v2_migration() {
        // 复现存量库场景：完整的 v1 schema（无 selected_model_json）且
        // user_version 已到 1——版本门禁必须由 v2 迁移补齐新列。
        let v1 = Connection::open_in_memory().expect("open v1 in-memory chat history database");
        v1.execute_batch(
            "
            CREATE TABLE chatHistory (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                session_id TEXT,
                cwd TEXT,
                context_meta_json TEXT,
                active_segment_index INTEGER,
                total_segment_count INTEGER,
                total_message_count INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                pinned_at INTEGER
            );
            PRAGMA user_version = 1;
            ",
        )
        .expect("create v1 chatHistory schema");

        history_db::initialize_connection(&v1).expect("migrate v1 schema to v2");

        assert!(
            table_column_names(&v1, "chatHistory").contains(&"selected_model_json".to_string()),
            "v2 migration should add selected_model_json to a v1 database"
        );
    }

    #[test]
    fn set_model_persists_without_bumping_updated_at() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        let before = get_summary_by_id(&conn, "conv-1").expect("load summary");

        let payload = r#"{"customProviderId":"provider-a","model":"claude-fable-5"}"#;
        let summary =
            set_chat_history_model_sync(&conn, "conv-1", payload).expect("set conversation model");

        assert_eq!(summary.selected_model_json.as_deref(), Some(payload));
        assert_eq!(summary.updated_at, before.updated_at);
        assert_eq!(summary.title, before.title);
    }

    #[test]
    fn set_model_rejects_invalid_payloads() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        assert!(set_chat_history_model_sync(&conn, "conv-1", "not-json").is_err());
        assert!(set_chat_history_model_sync(&conn, "conv-1", r#"{"model":"m"}"#).is_err());
        assert!(set_chat_history_model_sync(
            &conn,
            "conv-1",
            r#"{"customProviderId":" ","model":"m"}"#
        )
        .is_err());
        assert!(set_chat_history_model_sync(
            &conn,
            "conv-missing",
            r#"{"customProviderId":"provider-a","model":"m"}"#
        )
        .is_err());

        let summary = get_summary_by_id(&conn, "conv-1").expect("load summary");
        assert_eq!(summary.selected_model_json, None);
    }

    #[test]
    fn upsert_header_preserves_selected_model_when_input_none() {
        let conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        let payload = r#"{"customProviderId":"provider-a","model":"claude-fable-5"}"#;
        set_chat_history_model_sync(&conn, "conv-1", payload).expect("set conversation model");

        conversation.updated_at += 1_000;
        upsert_chat_history_header(&conn, &conversation).expect("upsert without selection");
        let preserved = get_summary_by_id(&conn, "conv-1").expect("load summary");
        assert_eq!(preserved.selected_model_json.as_deref(), Some(payload));

        let replacement = r#"{"customProviderId":"provider-b","model":"gpt-5"}"#;
        conversation.selected_model_json = Some(replacement.to_string());
        conversation.updated_at += 1_000;
        upsert_chat_history_header(&conn, &conversation).expect("upsert with new selection");
        let replaced = get_summary_by_id(&conn, "conv-1").expect("load summary");
        assert_eq!(replaced.selected_model_json.as_deref(), Some(replacement));
    }

    #[test]
    fn rename_preserves_existing_pin_state() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();

        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        let pinned = set_chat_history_pinned_sync(&conn, "conv-1", true).expect("pin conversation");
        let pinned_at = pinned.pinned_at.expect("pinned_at set");

        let renamed =
            rename_chat_history_sync(&conn, "conv-1", "Renamed Conversation").expect("rename");

        assert!(renamed.is_pinned);
        assert_eq!(renamed.pinned_at, Some(pinned_at));
        assert_eq!(renamed.title, "Renamed Conversation");
    }

    #[test]
    fn share_status_is_disabled_by_default() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        let status = get_chat_history_share_status_sync(&conn, "conv-1").expect("get share status");
        let summary = get_summary_by_id(&conn, "conv-1").expect("get summary");

        assert_eq!(status.conversation_id, "conv-1");
        assert!(!status.enabled);
        assert_eq!(status.token, None);
        assert!(!status.redact_tool_content);
        assert!(!summary.is_shared);
    }

    #[test]
    fn share_enable_disable_and_reenable_rotates_token() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        let enabled =
            set_chat_history_share_enabled_sync(&conn, "conv-1", true, None).expect("enable share");
        let first_token = enabled.token.clone().expect("share token");
        assert!(enabled.enabled);
        assert_eq!(first_token.len(), 9);
        assert!(first_token.chars().all(|ch| ch.is_ascii_alphanumeric()));

        let enabled_again = set_chat_history_share_enabled_sync(&conn, "conv-1", true, None)
            .expect("enable share again");
        assert_eq!(enabled_again.token.as_deref(), Some(first_token.as_str()));
        assert!(
            get_summary_by_id(&conn, "conv-1")
                .expect("get enabled summary")
                .is_shared
        );

        let disabled = set_chat_history_share_enabled_sync(&conn, "conv-1", false, None)
            .expect("disable share");
        assert!(!disabled.enabled);
        assert_eq!(disabled.token, None);
        assert!(
            !get_summary_by_id(&conn, "conv-1")
                .expect("get disabled summary")
                .is_shared
        );
        assert!(resolve_chat_history_share_sync(&conn, &first_token).is_err());

        let reenabled = set_chat_history_share_enabled_sync(&conn, "conv-1", true, None)
            .expect("reenable share");
        let second_token = reenabled.token.expect("share token");
        assert!(reenabled.enabled);
        assert_ne!(first_token, second_token);
        assert!(resolve_chat_history_share_sync(&conn, &first_token).is_err());
    }

    #[test]
    fn share_redact_tool_content_can_be_updated_independently() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        let enabled = set_chat_history_share_enabled_sync(&conn, "conv-1", true, Some(true))
            .expect("enable share with redaction");
        let token = enabled.token.clone().expect("share token");
        assert!(enabled.enabled);
        assert!(enabled.redact_tool_content);

        let enabled_again = set_chat_history_share_enabled_sync(&conn, "conv-1", true, None)
            .expect("enable share without changing redaction");
        assert_eq!(enabled_again.token.as_deref(), Some(token.as_str()));
        assert!(enabled_again.redact_tool_content);

        let updated = set_chat_history_share_enabled_sync(&conn, "conv-1", true, Some(false))
            .expect("disable share redaction");
        assert_eq!(updated.token.as_deref(), Some(token.as_str()));
        assert!(!updated.redact_tool_content);

        let disabled = set_chat_history_share_enabled_sync(&conn, "conv-1", false, Some(true))
            .expect("disable share and preserve redaction preference");
        assert!(!disabled.enabled);
        assert_eq!(disabled.token, None);
        assert!(disabled.redact_tool_content);
    }

    #[test]
    fn share_rows_are_removed_with_conversation() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        set_chat_history_share_enabled_sync(&conn, "conv-1", true, None).expect("enable share");

        conn.execute("DELETE FROM chatHistory WHERE id = ?1", params!["conv-1"])
            .expect("delete parent conversation");

        let share_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chatHistoryShare", [], |row| {
                row.get(0)
            })
            .expect("count share rows");
        assert_eq!(share_count, 0);
    }

    #[test]
    fn delete_conversation_removes_subagent_history() {
        let mut conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[
                  {"id":"m-user","role":"user","content":"start","timestamp":1700000000001},
                  {"id":"m-agent","role":"toolResult","toolName":"Agent","toolCallId":"call-delete","content":"done","timestamp":1700000000002}
                ]"#
                .to_string(),
                message_count: 2,
                start_message_id: Some("m-user".to_string()),
                end_message_id: Some("m-agent".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_002,
            },
        )
        .expect("upsert segment");
        insert_subagent_run_for_test(&conn, "run-delete", "call-delete", 0);
        conn.execute(
            "
            INSERT INTO subagentRunSegment (
                run_id,
                segment_index,
                segment_id,
                messages_json,
                message_count,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                "run-delete",
                0,
                "subagent-segment-0",
                "[]",
                0,
                1_700_000_000_100_i64,
                1_700_000_000_200_i64,
            ],
        )
        .expect("insert subagent segment");
        conn.execute(
            "
            INSERT INTO subagentMessage (
                parent_conversation_id,
                seq,
                sender_id,
                recipient_id,
                channel,
                body_markdown,
                source_run_id,
                source_tool_call_id,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ",
            params![
                "conv-1",
                1_i64,
                "agent-0",
                "parent",
                "direct",
                "message with run",
                "run-delete",
                "call-send-delete",
                1_700_000_000_300_i64,
            ],
        )
        .expect("insert run-scoped message");
        conn.execute(
            "
            INSERT INTO subagentMessage (
                parent_conversation_id,
                seq,
                sender_id,
                recipient_id,
                channel,
                body_markdown,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                "conv-1",
                2_i64,
                "agent-0",
                "parent",
                "direct",
                "message without run",
                1_700_000_000_400_i64,
            ],
        )
        .expect("insert parent-scoped message");
        conn.execute(
            "
            INSERT INTO subagentIdentity (
                parent_conversation_id,
                agent_id,
                name,
                role,
                identity_prompt,
                last_mode,
                created_tool_call_id,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ",
            params![
                "conv-1",
                "agent-0",
                "Deleted Agent",
                "Reviewer",
                "Stable identity",
                "readonly",
                "call-delete",
                1_700_000_000_000_i64,
                1_700_000_000_100_i64,
            ],
        )
        .expect("insert subagent identity");

        let result = delete_chat_history_sync(&mut conn, "conv-1").expect("delete conversation");

        assert_eq!(result.removed_run_ids, vec!["run-delete".to_string()]);
        assert_eq!(result.removed_message_count, 2);
        assert_eq!(result.removed_identity_count, 1);
        for table_name in [
            "chatHistory",
            "chatHistorySegment",
            "subagentRun",
            "subagentRunSegment",
            "subagentMessage",
            "subagentIdentity",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table_name}"), [], |row| {
                    row.get(0)
                })
                .unwrap_or_else(|error| panic!("count {table_name}: {error}"));
            assert_eq!(count, 0, "{table_name} should be empty after delete");
        }
    }

    #[test]
    fn delete_conversation_cleans_upload_after_last_history_reference() {
        let mut conn = open_test_db().expect("open test db");
        let temp = tempfile::tempdir().expect("create temp dir");
        let workdir = temp.path().join("workspace");
        std::fs::create_dir_all(&workdir).expect("create workspace");
        let mut uploaded_files =
            crate::commands::system::system_import_uploaded_readable_files_sync(
                workdir.to_string_lossy().into_owned(),
                vec![
                    crate::commands::system::SystemReadableFileUploadInput {
                        file_name: "pasted-text-1.txt".to_string(),
                        mime_type: Some("text/plain".to_string()),
                        content: b"temporary conversation text".to_vec(),
                    },
                    crate::commands::system::SystemReadableFileUploadInput {
                        file_name: "removed-from-draft.txt".to_string(),
                        mime_type: Some("text/plain".to_string()),
                        content: b"orphaned sibling".to_vec(),
                    },
                ],
            )
            .expect("import managed upload")
            .files;
        let upload = uploaded_files.remove(0);
        let orphaned_sibling = uploaded_files.remove(0);
        let upload_path = std::path::PathBuf::from(&upload.absolute_path);
        let orphaned_sibling_path = std::path::PathBuf::from(&orphaned_sibling.absolute_path);
        let upload_batch = upload_path.parent().expect("upload batch").to_path_buf();

        let mut first = sample_conversation();
        first.cwd = Some(workdir.to_string_lossy().into_owned());
        upsert_chat_history_header(&conn, &first).expect("insert first conversation");
        let first_messages = serde_json::to_string(&serde_json::json!([{
            "id": "m-user-1",
            "role": "user",
            "content": format!("[Pasted text 1: {}]", upload.relative_path),
            "liveAgentAttachments": [{
                "relativePath": upload.relative_path.clone(),
                "absolutePath": upload.absolute_path.clone(),
                "fileName": upload.file_name.clone(),
                "kind": upload.kind.clone(),
                "sizeBytes": upload.size_bytes
            }]
        }]))
        .expect("serialize first conversation messages");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: first_messages,
                message_count: 1,
                start_message_id: Some("m-user-1".to_string()),
                end_message_id: Some("m-user-1".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_100,
            },
        )
        .expect("insert first conversation segment");

        let mut second = sample_conversation();
        second.id = "conv-2".to_string();
        second.cwd = Some(format!(
            "{}{}",
            workdir.to_string_lossy(),
            std::path::MAIN_SEPARATOR
        ));
        upsert_chat_history_header(&conn, &second).expect("insert second conversation");
        let second_summary = serde_json::to_string(&serde_json::json!({
            "summary": format!("Retain {} for the next turn", upload.relative_path)
        }))
        .expect("serialize second conversation summary");
        upsert_single_segment(
            &conn,
            "conv-2",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: Some(second_summary),
                messages_json: "[]".to_string(),
                message_count: 0,
                start_message_id: None,
                end_message_id: None,
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_100,
            },
        )
        .expect("insert second conversation segment");

        delete_chat_history_sync(&mut conn, "conv-1").expect("delete first conversation");
        assert!(
            upload_path.is_file(),
            "another conversation still references the upload"
        );
        assert!(orphaned_sibling_path.is_file());

        delete_chat_history_sync(&mut conn, "conv-2").expect("delete second conversation");
        assert!(
            !upload_path.exists(),
            "last reference cleanup removes upload"
        );
        assert!(
            !orphaned_sibling_path.exists(),
            "batch cleanup removes an unreferenced sibling"
        );
        assert!(!upload_batch.exists(), "empty managed batch is pruned");
    }

    #[test]
    fn resolve_share_returns_full_conversation_segments() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json:
                    r#"[{"role":"user","content":"hello"},{"role":"assistant","content":"world"}]"#
                        .to_string(),
                message_count: 2,
                start_message_id: Some("m-1".to_string()),
                end_message_id: Some("m-2".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_100,
            },
        )
        .expect("upsert segment");
        let status =
            set_chat_history_share_enabled_sync(&conn, "conv-1", true, None).expect("enable share");
        let token = status.token.expect("share token");

        let record = resolve_chat_history_share_sync(&conn, &token).expect("resolve share");

        assert_eq!(record.id, "conv-1");
        assert_eq!(record.segments.len(), 1);
        assert_eq!(record.segments[0].message_count, 2);
        assert!(record.segments[0].messages_json.contains("hello"));
    }

    #[test]
    fn chat_history_fts_indexes_message_and_segment_text() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[
                  {"id":"m-user","role":"user","content":"以后请用陕西腔跟我说话。","timestamp":1700000000001},
                  {"id":"m-assistant","role":"assistant","content":[{"type":"text","text":"我会记住陕西腔偏好。"},{"type":"thinking","thinking":"hidden"}],"timestamp":1700000000002}
                ]"#
                .to_string(),
                message_count: 2,
                start_message_id: Some("m-user".to_string()),
                end_message_id: Some("m-assistant".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_002,
            },
        )
        .expect("upsert segment");

        let matches = search_chat_history_fts(&conn, "陕西腔", 8, &default_history_search_filter())
            .expect("search history fts");

        assert!(
            matches.iter().any(|item| item.source == "message"
                && item.role.as_deref() == Some("user")
                && item.snippet.contains("陕西腔")),
            "message-level FTS should match user text: {:?}",
            matches
        );
        assert!(
            matches
                .iter()
                .any(|item| item.source == "segment" && item.snippet.contains("陕西腔")),
            "segment-level FTS should match aggregated segment text: {:?}",
            matches
        );
        assert!(
            !matches.iter().any(|item| item.snippet.contains("hidden")),
            "thinking text must not be indexed: {:?}",
            matches
        );
    }

    #[test]
    fn chat_history_fts_filters_matches_by_time_range() {
        let conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();
        conversation.total_segment_count = 2;
        conversation.total_message_count = 2;
        conversation.updated_at = 1_700_000_100_000;
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-early","role":"user","content":"rangemarker early","timestamp":1700000000001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-early".to_string()),
                end_message_id: Some("m-early".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_001,
            },
        )
        .expect("upsert early segment");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 1,
                segment_id: "segment-1".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-late","role":"user","content":"rangemarker late","timestamp":1700000100001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-late".to_string()),
                end_message_id: Some("m-late".to_string()),
                created_at: 1_700_000_100_000,
                updated_at: 1_700_000_100_001,
            },
        )
        .expect("upsert late segment");

        let filter = HistorySearchFilter {
            since: Some(1_700_000_050_000),
            until: Some(1_700_000_200_000),
            time_mode: HistorySearchTimeMode::Message,
        };
        let matches =
            search_chat_history_fts(&conn, "rangemarker", 8, &filter).expect("search with time");

        assert!(
            matches.iter().any(|item| item.snippet.contains("late")),
            "time-filtered search should keep late match: {:?}",
            matches
        );
        assert!(
            !matches.iter().any(|item| item.snippet.contains("early")),
            "time-filtered search should remove early match: {:?}",
            matches
        );
    }

    #[test]
    fn chat_history_time_overview_query_falls_back_to_time_window() {
        let conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();
        conversation.total_segment_count = 2;
        conversation.total_message_count = 2;
        conversation.updated_at = 1_700_000_100_000;
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-early","role":"user","content":"early travel planning marker","timestamp":1700000000001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-early".to_string()),
                end_message_id: Some("m-early".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_001,
            },
        )
        .expect("upsert early segment");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 1,
                segment_id: "segment-1".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-late","role":"user","content":"late travel planning marker","timestamp":1700000100001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-late".to_string()),
                end_message_id: Some("m-late".to_string()),
                created_at: 1_700_000_100_000,
                updated_at: 1_700_000_100_001,
            },
        )
        .expect("upsert late segment");

        let filter = HistorySearchFilter {
            since: Some(1_700_000_050_000),
            until: Some(1_700_000_200_000),
            time_mode: HistorySearchTimeMode::Updated,
        };
        let matches = search_chat_history_fts_with_refresh(&conn, "2026-05-13", 8, &filter)
            .expect("date overview query should use time window fallback");

        assert!(
            matches.iter().any(|item| item.snippet.contains("late")),
            "time-window fallback should include in-range segment: {:?}",
            matches
        );
        assert!(
            !matches.iter().any(|item| item.snippet.contains("early")),
            "time-window fallback should exclude out-of-range segment: {:?}",
            matches
        );
    }

    #[test]
    fn history_search_filter_accepts_local_date_and_time_mode() {
        let filter = resolve_history_search_filter(None, None, Some("2026-05-14"), Some("updated"))
            .expect("resolve local date filter");

        assert_eq!(filter.time_mode, HistorySearchTimeMode::Updated);
        assert!(filter.since.is_some());
        assert!(filter.until.is_some());
        assert!(filter.since.unwrap() < filter.until.unwrap());
    }

    #[test]
    fn memory_history_search_respects_explicit_include_history_with_type_filter() {
        let mut args = MemorySearchArgs {
            query: "2026-05-12".to_string(),
            scope: None,
            workdir: None,
            memory_type: Some("daily".to_string()),
            limit: None,
            include_history: None,
            history_since: None,
            history_until: None,
            history_date_local: Some("2026-05-12".to_string()),
            history_time_mode: Some("message".to_string()),
        };

        assert!(
            !should_include_history_for_memory_search(&args),
            "type-filtered memory search defaults history off"
        );
        args.memory_type = None;
        assert!(
            !should_include_history_for_memory_search(&args),
            "unfiltered memory search also defaults history off"
        );
        args.include_history = Some(true);
        assert!(
            should_include_history_for_memory_search(&args),
            "explicit includeHistory=true must still search chat history"
        );
    }

    #[test]
    fn chat_history_fts_backfills_existing_segments() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        conn.execute(
            "
            INSERT INTO chatHistorySegment (
                conversation_id,
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            ) VALUES (?1, 0, 'segment-0', NULL, ?2, 1, 'm-user', 'm-user', ?3, ?4)
            ",
            params![
                "conv-1",
                r#"[{"id":"m-user","role":"user","content":"请以后称呼我为林舟。","timestamp":1700000000001}]"#,
                1_700_000_000_000_i64,
                1_700_000_000_001_i64,
            ],
        )
        .expect("insert legacy segment without fts");

        let before = search_chat_history_fts(&conn, "林舟", 8, &default_history_search_filter())
            .expect("search before backfill");
        assert!(before.is_empty());

        refresh_chat_history_fts(&conn, &default_history_search_filter()).expect("refresh fts");
        let after = search_chat_history_fts(&conn, "林舟", 8, &default_history_search_filter())
            .expect("search after backfill");

        assert!(
            after.iter().any(|item| item.snippet.contains("林舟")),
            "backfilled FTS should find existing history: {:?}",
            after
        );
    }

    #[test]
    fn initialize_db_does_not_backfill_chat_history_fts() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        conn.execute(
            "
            INSERT INTO chatHistorySegment (
                conversation_id,
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            ) VALUES (?1, 0, 'segment-0', NULL, ?2, 1, 'm-user', 'm-user', ?3, ?4)
            ",
            params![
                "conv-1",
                r#"[{"id":"m-user","role":"user","content":"热路径不能做全库回填。","timestamp":1700000000001}]"#,
                1_700_000_000_000_i64,
                1_700_000_000_001_i64,
            ],
        )
        .expect("insert legacy segment without fts");

        history_db::initialize_connection(&conn).expect("re-run schema initialization");
        let after_init =
            search_chat_history_fts(&conn, "热路径", 8, &default_history_search_filter())
                .expect("search after schema init");

        assert!(
            after_init.is_empty(),
            "schema initialization should not rebuild history FTS: {:?}",
            after_init
        );
    }

    #[test]
    fn chat_history_search_refreshes_fts_before_query() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        conn.execute(
            "
            INSERT INTO chatHistorySegment (
                conversation_id,
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            ) VALUES (?1, 0, 'segment-0', NULL, ?2, 1, 'm-user', 'm-user', ?3, ?4)
            ",
            params![
                "conv-1",
                r#"[{"id":"m-user","role":"user","content":"搜索入口负责回填历史正文索引。","timestamp":1700000000001}]"#,
                1_700_000_000_000_i64,
                1_700_000_000_001_i64,
            ],
        )
        .expect("insert legacy segment without fts");

        let matches = search_chat_history_fts_with_refresh(
            &conn,
            "历史正文索引",
            8,
            &default_history_search_filter(),
        )
        .expect("search with refresh");

        assert!(
            matches
                .iter()
                .any(|item| item.snippet.contains("历史正文索引")),
            "search should refresh FTS before querying: {:?}",
            matches
        );
    }

    #[test]
    fn chat_history_fts_refresh_is_bounded_on_large_legacy_backfills() {
        let conn = open_test_db().expect("open test db");
        let mut conversation = sample_conversation();
        conversation.total_segment_count = (CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE + 1) as i64;
        conversation.total_message_count = (CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE + 1) as i64;
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");

        for index in 0..=CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE {
            let marker = format!("bounded-refresh-{index}");
            conn.execute(
                "
                INSERT INTO chatHistorySegment (
                    conversation_id,
                    segment_index,
                    segment_id,
                    summary_json,
                    messages_json,
                    message_count,
                    start_message_id,
                    end_message_id,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, ?3, NULL, ?4, 1, ?5, ?5, ?6, ?6)
                ",
                params![
                    "conv-1",
                    index as i64,
                    format!("segment-{index}"),
                    format!(
                        r#"[{{"id":"m-{index}","role":"user","content":"{marker}","timestamp":1700000000001}}]"#
                    ),
                    format!("m-{index}"),
                    1_700_000_000_000_i64 + index as i64,
                ],
            )
            .expect("insert legacy segment without fts");
        }

        refresh_chat_history_fts(&conn, &default_history_search_filter()).expect("refresh fts");
        let indexed_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chatHistoryFtsSegmentIndex",
                [],
                |row| row.get(0),
            )
            .expect("count indexed segments");

        assert_eq!(indexed_count, CHAT_HISTORY_FTS_REFRESH_BATCH_SIZE as i64);
    }

    #[test]
    fn chat_history_fts_search_deduplicates_duplicate_segment_rows() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        upsert_single_segment(
            &conn,
            "conv-1",
            &ChatHistorySegmentInput {
                segment_index: 0,
                segment_id: "segment-0".to_string(),
                summary_json: None,
                messages_json: r#"[{"id":"m-user","role":"user","content":"重复索引自愈测试","timestamp":1700000000001}]"#
                    .to_string(),
                message_count: 1,
                start_message_id: Some("m-user".to_string()),
                end_message_id: Some("m-user".to_string()),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_001,
            },
        )
        .expect("upsert segment");

        conn.execute(
            "
            INSERT INTO chatHistorySegmentFts (
                conversation_id,
                segment_index,
                segment_id,
                title,
                cwd,
                body,
                segment_updated_at,
                conversation_updated_at
            )
            SELECT
                conversation_id,
                segment_index,
                segment_id,
                title,
                cwd,
                body,
                segment_updated_at,
                conversation_updated_at
            FROM chatHistorySegmentFts
            WHERE conversation_id = 'conv-1' AND segment_index = 0
            ",
            [],
        )
        .expect("duplicate segment fts row");

        let matches = search_chat_history_fts(
            &conn,
            "重复索引自愈测试",
            8,
            &default_history_search_filter(),
        )
        .expect("search duplicate fts rows");
        let segment_matches = matches
            .iter()
            .filter(|item| item.source == "segment" && item.segment_index == 0)
            .count();

        assert_eq!(segment_matches, 1, "duplicate FTS rows must not leak to UI");
    }

    #[test]
    fn resolve_share_allows_empty_persisted_history() {
        let conn = open_test_db().expect("open test db");
        let conversation = sample_conversation();
        upsert_chat_history_header(&conn, &conversation).expect("upsert header");
        let status =
            set_chat_history_share_enabled_sync(&conn, "conv-1", true, None).expect("enable share");
        let token = status.token.expect("share token");

        let record = resolve_chat_history_share_sync(&conn, &token).expect("resolve share");

        assert_eq!(record.id, "conv-1");
        assert!(record.segments.is_empty());
    }

    #[test]
    fn subagent_prune_uses_initialized_history_schema() {
        let conn = open_test_db().expect("open test db");
        let before: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagentRun'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("query schema before prune");
        assert_eq!(before.as_deref(), Some("subagentRun"));

        let result = subagent_store::prune_subagent_runs_sync(&conn, "conv-1", &[])
            .expect("prune uses initialized subagent schema");

        assert!(result.removed_run_ids.is_empty());
        let after: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagentRun'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("query schema after prune");
        assert_eq!(after.as_deref(), Some("subagentRun"));
    }
}
