use rusqlite::Connection;
use std::{collections::HashSet, fs, path::PathBuf, sync::Mutex, time::Duration};

const DB_FILENAME: &str = "chat-history.sqlite3";
const HISTORY_DB_SCHEMA_VERSION: i64 = 1;

static HISTORY_DB_MIGRATION_LOCK: Mutex<()> = Mutex::new(());

fn history_db_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir).map_err(|e| format!("创建历史目录失败：{e}"))?;
    Ok(dir)
}

pub(crate) fn open_connection() -> Result<Connection, String> {
    let db_path = history_db_dir()?.join(DB_FILENAME);
    let conn = Connection::open(db_path).map_err(|e| format!("打开历史数据库失败：{e}"))?;
    configure_connection(&conn)?;
    Ok(conn)
}

fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 SQLite busy_timeout 失败：{e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("启用历史数据库外键失败：{e}"))?;
    Ok(())
}

pub(crate) fn initialize_history_db() -> Result<(), String> {
    let conn = open_connection()?;
    initialize_connection(&conn)
}

pub(crate) fn initialize_connection(conn: &Connection) -> Result<(), String> {
    let _guard = HISTORY_DB_MIGRATION_LOCK
        .lock()
        .map_err(|_| "历史数据库迁移锁已损坏".to_string())?;
    configure_connection(conn)?;
    migrate_history_db(conn)
}

fn read_user_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("读取历史数据库版本失败：{e}"))
}

fn set_user_version(conn: &Connection, version: i64) -> Result<(), String> {
    conn.execute_batch(&format!("PRAGMA user_version = {version};"))
        .map_err(|e| format!("更新历史数据库版本失败：{e}"))
}

fn migrate_history_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| format!("锁定历史数据库迁移失败：{e}"))?;

    let result = migrate_history_db_inner(conn);
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT;")
            .map_err(|e| format!("提交历史数据库迁移失败：{e}")),
        Err(error) => {
            let rollback = conn.execute_batch("ROLLBACK;");
            if let Err(rollback_error) = rollback {
                return Err(format!("{error}；回滚历史数据库迁移失败：{rollback_error}"));
            }
            Err(error)
        }
    }
}

fn migrate_history_db_inner(conn: &Connection) -> Result<(), String> {
    let current_version = read_user_version(conn)?;
    if current_version > HISTORY_DB_SCHEMA_VERSION {
        return Err(format!(
            "历史数据库版本 {current_version} 高于当前支持版本 {HISTORY_DB_SCHEMA_VERSION}"
        ));
    }

    if current_version < 1 {
        migrate_to_v1(conn)?;
        set_user_version(conn, 1)?;
    }

    Ok(())
}

fn migrate_to_v1(conn: &Connection) -> Result<(), String> {
    ensure_chat_history_schema(conn)?;
    ensure_subagent_history_schema(conn)?;
    Ok(())
}

fn read_table_columns(
    conn: &Connection,
    table_name: &str,
    table_label: &str,
) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|e| format!("读取{table_label}结构失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("查询{table_label}结构失败：{e}"))?;
    let mut columns = HashSet::new();
    for row in rows {
        let column = row.map_err(|e| format!("读取{table_label}字段失败：{e}"))?;
        columns.insert(column.to_ascii_lowercase());
    }
    Ok(columns)
}

fn ensure_table_columns(
    conn: &Connection,
    table_name: &str,
    table_label: &str,
    migrations: &[(&str, &str)],
) -> Result<(), String> {
    let mut columns = read_table_columns(conn, table_name, table_label)?;

    for (column, ddl) in migrations {
        let column_key = column.to_ascii_lowercase();
        if columns.contains(&column_key) {
            continue;
        }

        match conn.execute_batch(ddl) {
            Ok(()) => {
                columns.insert(column_key);
            }
            Err(error) => {
                let refreshed_columns = read_table_columns(conn, table_name, table_label)?;
                if refreshed_columns.contains(&column_key) {
                    columns = refreshed_columns;
                    continue;
                }
                return Err(format!("迁移{table_label}字段 {column} 失败：{error}"));
            }
        }
    }

    Ok(())
}

fn ensure_chat_history_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS chatHistory (
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

        CREATE TABLE IF NOT EXISTS chatHistorySegment (
            conversation_id TEXT NOT NULL,
            segment_index INTEGER NOT NULL,
            segment_id TEXT NOT NULL,
            summary_json TEXT,
            messages_json TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            start_message_id TEXT,
            end_message_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (conversation_id, segment_index),
            UNIQUE (conversation_id, segment_id),
            FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS chatHistoryShare (
            conversation_id TEXT PRIMARY KEY,
            token TEXT UNIQUE,
            enabled INTEGER NOT NULL DEFAULT 0,
            redact_tool_content INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
        );
        ",
    )
    .map_err(|e| format!("初始化聊天历史表失败：{e}"))?;

    ensure_chat_history_columns(conn)?;
    ensure_chat_history_segment_columns(conn)?;
    ensure_chat_history_share_columns(conn)?;
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_chatHistory_updated_at
            ON chatHistory(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chatHistorySegment_conversation_updated
            ON chatHistorySegment(conversation_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chatHistory_pinned
            ON chatHistory(is_pinned DESC, pinned_at DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chatHistoryShare_token
            ON chatHistoryShare(token);
        ",
    )
    .map_err(|e| format!("初始化聊天历史索引失败：{e}"))?;
    ensure_chat_history_fts(conn)?;

    Ok(())
}

fn ensure_chat_history_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "chatHistory",
        "聊天历史主表",
        &[
            (
                "title",
                "ALTER TABLE chatHistory ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled';",
            ),
            (
                "provider_id",
                "ALTER TABLE chatHistory ADD COLUMN provider_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "model",
                "ALTER TABLE chatHistory ADD COLUMN model TEXT NOT NULL DEFAULT '';",
            ),
            (
                "session_id",
                "ALTER TABLE chatHistory ADD COLUMN session_id TEXT;",
            ),
            ("cwd", "ALTER TABLE chatHistory ADD COLUMN cwd TEXT;"),
            (
                "context_meta_json",
                "ALTER TABLE chatHistory ADD COLUMN context_meta_json TEXT NOT NULL DEFAULT '{}';",
            ),
            (
                "active_segment_index",
                "ALTER TABLE chatHistory ADD COLUMN active_segment_index INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "total_segment_count",
                "ALTER TABLE chatHistory ADD COLUMN total_segment_count INTEGER NOT NULL DEFAULT 1;",
            ),
            (
                "total_message_count",
                "ALTER TABLE chatHistory ADD COLUMN total_message_count INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "created_at",
                "ALTER TABLE chatHistory ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "updated_at",
                "ALTER TABLE chatHistory ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "is_pinned",
                "ALTER TABLE chatHistory ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "pinned_at",
                "ALTER TABLE chatHistory ADD COLUMN pinned_at INTEGER;",
            ),
        ],
    )?;

    conn.execute_batch(
        "
        UPDATE chatHistory
        SET title = 'Untitled'
        WHERE title IS NULL OR trim(title) = '';

        UPDATE chatHistory
        SET provider_id = ''
        WHERE provider_id IS NULL;

        UPDATE chatHistory
        SET model = ''
        WHERE model IS NULL;

        UPDATE chatHistory
        SET context_meta_json = '{}'
        WHERE context_meta_json IS NULL OR trim(context_meta_json) = '';

        UPDATE chatHistory
        SET active_segment_index = 0
        WHERE active_segment_index IS NULL OR active_segment_index < 0;

        UPDATE chatHistory
        SET total_segment_count = 1
        WHERE total_segment_count IS NULL OR total_segment_count < 1;

        UPDATE chatHistory
        SET total_message_count = 0
        WHERE total_message_count IS NULL OR total_message_count < 0;

        UPDATE chatHistory
        SET created_at = 0
        WHERE created_at IS NULL;

        UPDATE chatHistory
        SET updated_at = created_at
        WHERE updated_at IS NULL;

        UPDATE chatHistory
        SET is_pinned = 0
        WHERE is_pinned IS NULL;
        ",
    )
    .map_err(|e| format!("修复聊天历史主表默认字段失败：{e}"))?;

    Ok(())
}

fn ensure_chat_history_segment_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "chatHistorySegment",
        "聊天历史分段表",
        &[
            (
                "segment_id",
                "ALTER TABLE chatHistorySegment ADD COLUMN segment_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "summary_json",
                "ALTER TABLE chatHistorySegment ADD COLUMN summary_json TEXT;",
            ),
            (
                "messages_json",
                "ALTER TABLE chatHistorySegment ADD COLUMN messages_json TEXT NOT NULL DEFAULT '[]';",
            ),
            (
                "message_count",
                "ALTER TABLE chatHistorySegment ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "start_message_id",
                "ALTER TABLE chatHistorySegment ADD COLUMN start_message_id TEXT;",
            ),
            (
                "end_message_id",
                "ALTER TABLE chatHistorySegment ADD COLUMN end_message_id TEXT;",
            ),
            (
                "created_at",
                "ALTER TABLE chatHistorySegment ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "updated_at",
                "ALTER TABLE chatHistorySegment ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )?;

    conn.execute_batch(
        "
        UPDATE chatHistorySegment
        SET segment_id = 'segment-' || segment_index
        WHERE segment_id IS NULL OR trim(segment_id) = '';

        UPDATE chatHistorySegment
        SET messages_json = '[]'
        WHERE messages_json IS NULL OR trim(messages_json) = '';

        UPDATE chatHistorySegment
        SET message_count = 0
        WHERE message_count IS NULL OR message_count < 0;

        UPDATE chatHistorySegment
        SET created_at = 0
        WHERE created_at IS NULL;

        UPDATE chatHistorySegment
        SET updated_at = created_at
        WHERE updated_at IS NULL;
        ",
    )
    .map_err(|e| format!("修复聊天历史分段表默认字段失败：{e}"))?;

    Ok(())
}

fn ensure_chat_history_share_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "chatHistoryShare",
        "聊天历史分享表",
        &[
            (
                "token",
                "ALTER TABLE chatHistoryShare ADD COLUMN token TEXT;",
            ),
            (
                "enabled",
                "ALTER TABLE chatHistoryShare ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "redact_tool_content",
                "ALTER TABLE chatHistoryShare ADD COLUMN redact_tool_content INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "created_at",
                "ALTER TABLE chatHistoryShare ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "updated_at",
                "ALTER TABLE chatHistoryShare ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )?;

    conn.execute_batch(
        "
        UPDATE chatHistoryShare
        SET enabled = 0
        WHERE enabled IS NULL;

        UPDATE chatHistoryShare
        SET redact_tool_content = 0
        WHERE redact_tool_content IS NULL;

        UPDATE chatHistoryShare
        SET created_at = 0
        WHERE created_at IS NULL;

        UPDATE chatHistoryShare
        SET updated_at = created_at
        WHERE updated_at IS NULL;
        ",
    )
    .map_err(|e| format!("修复聊天历史分享表默认字段失败：{e}"))?;

    Ok(())
}

fn ensure_chat_history_fts(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS chatHistorySegmentFts USING fts5(
            conversation_id         UNINDEXED,
            segment_index           UNINDEXED,
            segment_id              UNINDEXED,
            title,
            cwd,
            body,
            segment_updated_at      UNINDEXED,
            conversation_updated_at UNINDEXED,
            tokenize = "trigram"
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS chatHistoryMessageFts USING fts5(
            conversation_id         UNINDEXED,
            segment_index           UNINDEXED,
            segment_id              UNINDEXED,
            message_index           UNINDEXED,
            message_id              UNINDEXED,
            role                    UNINDEXED,
            title,
            cwd,
            body,
            message_updated_at      UNINDEXED,
            segment_updated_at      UNINDEXED,
            conversation_updated_at UNINDEXED,
            tokenize = "trigram"
        );

        CREATE TABLE IF NOT EXISTS chatHistoryFtsSegmentIndex (
            conversation_id         TEXT NOT NULL,
            segment_index           INTEGER NOT NULL,
            segment_updated_at      INTEGER NOT NULL,
            conversation_updated_at INTEGER NOT NULL,
            PRIMARY KEY (conversation_id, segment_index)
        );
        "#,
    )
    .map_err(|e| format!("初始化聊天历史 FTS 表失败：{e}"))?;

    ensure_chat_history_fts_index_columns(conn)?;
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_chatHistoryFtsSegmentIndex_segment_updated
            ON chatHistoryFtsSegmentIndex(segment_updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_chatHistoryFtsSegmentIndex_conversation_updated
            ON chatHistoryFtsSegmentIndex(conversation_updated_at DESC);
        ",
    )
    .map_err(|e| format!("初始化聊天历史 FTS 索引失败：{e}"))?;

    seed_existing_chat_history_fts_index(conn)?;

    Ok(())
}

fn ensure_chat_history_fts_index_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "chatHistoryFtsSegmentIndex",
        "聊天历史 FTS 元数据表",
        &[
            (
                "segment_updated_at",
                "ALTER TABLE chatHistoryFtsSegmentIndex ADD COLUMN segment_updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "conversation_updated_at",
                "ALTER TABLE chatHistoryFtsSegmentIndex ADD COLUMN conversation_updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )
}

fn seed_existing_chat_history_fts_index(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "
        INSERT OR IGNORE INTO chatHistoryFtsSegmentIndex (
            conversation_id,
            segment_index,
            segment_updated_at,
            conversation_updated_at
        )
        SELECT
            f.conversation_id,
            CAST(f.segment_index AS INTEGER),
            s.updated_at,
            h.updated_at
        FROM chatHistorySegmentFts f
        JOIN chatHistorySegment s
          ON s.conversation_id = f.conversation_id
         AND s.segment_index = CAST(f.segment_index AS INTEGER)
        JOIN chatHistory h ON h.id = s.conversation_id
        WHERE CAST(f.segment_updated_at AS INTEGER) = s.updated_at
          AND CAST(f.conversation_updated_at AS INTEGER) = h.updated_at
        GROUP BY f.conversation_id, CAST(f.segment_index AS INTEGER)
        ",
        [],
    )
    .map_err(|e| format!("同步历史 FTS 元数据失败：{e}"))?;

    Ok(())
}

fn ensure_subagent_history_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS subagentIdentity (
            parent_conversation_id TEXT NOT NULL,
            logical_agent_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL,
            identity_prompt TEXT NOT NULL,
            agent_id TEXT,
            template_name TEXT,
            default_mode TEXT NOT NULL,
            default_task_intent TEXT NOT NULL,
            default_apply_policy TEXT NOT NULL,
            created_parent_tool_call_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (parent_conversation_id, logical_agent_id)
        );

        CREATE TABLE IF NOT EXISTS subagentRun (
            id TEXT PRIMARY KEY,
            parent_conversation_id TEXT,
            parent_session_id TEXT,
            parent_tool_call_id TEXT NOT NULL,
            parent_tool_name TEXT NOT NULL,
            agent_index INTEGER NOT NULL,
            agent_total INTEGER NOT NULL,
            logical_agent_id TEXT NOT NULL DEFAULT '',
            agent_id TEXT,
            agent_name TEXT,
            description TEXT NOT NULL,
            mode TEXT NOT NULL,
            status TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            model TEXT NOT NULL,
            session_id TEXT,
            workdir TEXT,
            worktree_root TEXT,
            branch_name TEXT,
            context_meta_json TEXT NOT NULL,
            active_segment_index INTEGER NOT NULL,
            total_segment_count INTEGER NOT NULL,
            total_message_count INTEGER NOT NULL,
            round_count INTEGER NOT NULL DEFAULT 0,
            tool_call_count INTEGER NOT NULL DEFAULT 0,
            compaction_count INTEGER NOT NULL DEFAULT 0,
            summary TEXT,
            error TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS subagentRunSegment (
            run_id TEXT NOT NULL,
            segment_index INTEGER NOT NULL,
            segment_id TEXT NOT NULL,
            summary_json TEXT,
            messages_json TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            start_message_id TEXT,
            end_message_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, segment_index),
            UNIQUE (run_id, segment_id),
            FOREIGN KEY (run_id) REFERENCES subagentRun(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS subagentRunEvent (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            round_index INTEGER,
            tool_call_id TEXT,
            tool_name TEXT,
            is_error INTEGER NOT NULL DEFAULT 0,
            payload_json TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (run_id) REFERENCES subagentRun(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS subagentMessageBusEntry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_conversation_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            sender_agent_id TEXT NOT NULL,
            sender_display_name TEXT,
            recipient_agent_id TEXT NOT NULL,
            recipient_display_name TEXT,
            channel TEXT NOT NULL,
            subject TEXT,
            body_markdown TEXT NOT NULL,
            source_run_id TEXT,
            source_tool_call_id TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE (parent_conversation_id, seq)
        );
        ",
    )
    .map_err(|e| format!("初始化子 agent 历史表失败：{e}"))?;

    ensure_subagent_identity_columns(conn)?;
    ensure_subagent_run_columns(conn)?;
    ensure_subagent_run_segment_columns(conn)?;
    ensure_subagent_run_event_columns(conn)?;
    ensure_subagent_message_bus_columns(conn)?;
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_subagentIdentity_parent_updated
            ON subagentIdentity(parent_conversation_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_subagentRun_parent
            ON subagentRun(parent_conversation_id, parent_tool_call_id, agent_index);

        CREATE INDEX IF NOT EXISTS idx_subagentRun_updated_at
            ON subagentRun(updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_subagentRun_parent_updated
            ON subagentRun(parent_conversation_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_subagentRun_logical_agent
            ON subagentRun(parent_conversation_id, logical_agent_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_subagentRunSegment_run_updated
            ON subagentRunSegment(run_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_subagentRunEvent_run_id
            ON subagentRunEvent(run_id, id ASC);

        CREATE INDEX IF NOT EXISTS idx_subagentMessageBusEntry_parent_seq
            ON subagentMessageBusEntry(parent_conversation_id, seq ASC);

        CREATE INDEX IF NOT EXISTS idx_subagentMessageBusEntry_parent_recipient_seq
            ON subagentMessageBusEntry(parent_conversation_id, recipient_agent_id, seq ASC);

        CREATE INDEX IF NOT EXISTS idx_subagentMessageBusEntry_parent_sender_seq
            ON subagentMessageBusEntry(parent_conversation_id, sender_agent_id, seq ASC);

        CREATE INDEX IF NOT EXISTS idx_subagentMessageBusEntry_source_run
            ON subagentMessageBusEntry(source_run_id);
        ",
    )
    .map_err(|e| format!("初始化子 agent 历史索引失败：{e}"))?;

    Ok(())
}

fn ensure_subagent_identity_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "subagentIdentity",
        "子 agent 身份表",
        &[
            (
                "parent_conversation_id",
                "ALTER TABLE subagentIdentity ADD COLUMN parent_conversation_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "logical_agent_id",
                "ALTER TABLE subagentIdentity ADD COLUMN logical_agent_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "display_name",
                "ALTER TABLE subagentIdentity ADD COLUMN display_name TEXT NOT NULL DEFAULT '';",
            ),
            (
                "role",
                "ALTER TABLE subagentIdentity ADD COLUMN role TEXT NOT NULL DEFAULT '';",
            ),
            (
                "identity_prompt",
                "ALTER TABLE subagentIdentity ADD COLUMN identity_prompt TEXT NOT NULL DEFAULT '';",
            ),
            (
                "agent_id",
                "ALTER TABLE subagentIdentity ADD COLUMN agent_id TEXT;",
            ),
            (
                "template_name",
                "ALTER TABLE subagentIdentity ADD COLUMN template_name TEXT;",
            ),
            (
                "default_mode",
                "ALTER TABLE subagentIdentity ADD COLUMN default_mode TEXT NOT NULL DEFAULT '';",
            ),
            (
                "default_task_intent",
                "ALTER TABLE subagentIdentity ADD COLUMN default_task_intent TEXT NOT NULL DEFAULT '';",
            ),
            (
                "default_apply_policy",
                "ALTER TABLE subagentIdentity ADD COLUMN default_apply_policy TEXT NOT NULL DEFAULT '';",
            ),
            (
                "created_parent_tool_call_id",
                "ALTER TABLE subagentIdentity ADD COLUMN created_parent_tool_call_id TEXT;",
            ),
            (
                "created_at",
                "ALTER TABLE subagentIdentity ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "updated_at",
                "ALTER TABLE subagentIdentity ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )
}

fn ensure_subagent_run_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "subagentRun",
        "子 agent run 表",
        &[
            (
                "parent_conversation_id",
                "ALTER TABLE subagentRun ADD COLUMN parent_conversation_id TEXT;",
            ),
            (
                "parent_session_id",
                "ALTER TABLE subagentRun ADD COLUMN parent_session_id TEXT;",
            ),
            (
                "parent_tool_call_id",
                "ALTER TABLE subagentRun ADD COLUMN parent_tool_call_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "parent_tool_name",
                "ALTER TABLE subagentRun ADD COLUMN parent_tool_name TEXT NOT NULL DEFAULT '';",
            ),
            (
                "agent_index",
                "ALTER TABLE subagentRun ADD COLUMN agent_index INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "agent_total",
                "ALTER TABLE subagentRun ADD COLUMN agent_total INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "logical_agent_id",
                "ALTER TABLE subagentRun ADD COLUMN logical_agent_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "agent_id",
                "ALTER TABLE subagentRun ADD COLUMN agent_id TEXT;",
            ),
            (
                "agent_name",
                "ALTER TABLE subagentRun ADD COLUMN agent_name TEXT;",
            ),
            (
                "description",
                "ALTER TABLE subagentRun ADD COLUMN description TEXT NOT NULL DEFAULT '';",
            ),
            (
                "mode",
                "ALTER TABLE subagentRun ADD COLUMN mode TEXT NOT NULL DEFAULT '';",
            ),
            (
                "status",
                "ALTER TABLE subagentRun ADD COLUMN status TEXT NOT NULL DEFAULT '';",
            ),
            (
                "provider_id",
                "ALTER TABLE subagentRun ADD COLUMN provider_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "model",
                "ALTER TABLE subagentRun ADD COLUMN model TEXT NOT NULL DEFAULT '';",
            ),
            (
                "session_id",
                "ALTER TABLE subagentRun ADD COLUMN session_id TEXT;",
            ),
            (
                "workdir",
                "ALTER TABLE subagentRun ADD COLUMN workdir TEXT;",
            ),
            (
                "worktree_root",
                "ALTER TABLE subagentRun ADD COLUMN worktree_root TEXT;",
            ),
            (
                "branch_name",
                "ALTER TABLE subagentRun ADD COLUMN branch_name TEXT;",
            ),
            (
                "context_meta_json",
                "ALTER TABLE subagentRun ADD COLUMN context_meta_json TEXT NOT NULL DEFAULT '{}';",
            ),
            (
                "active_segment_index",
                "ALTER TABLE subagentRun ADD COLUMN active_segment_index INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "total_segment_count",
                "ALTER TABLE subagentRun ADD COLUMN total_segment_count INTEGER NOT NULL DEFAULT 1;",
            ),
            (
                "total_message_count",
                "ALTER TABLE subagentRun ADD COLUMN total_message_count INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "round_count",
                "ALTER TABLE subagentRun ADD COLUMN round_count INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "tool_call_count",
                "ALTER TABLE subagentRun ADD COLUMN tool_call_count INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "compaction_count",
                "ALTER TABLE subagentRun ADD COLUMN compaction_count INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "summary",
                "ALTER TABLE subagentRun ADD COLUMN summary TEXT;",
            ),
            ("error", "ALTER TABLE subagentRun ADD COLUMN error TEXT;"),
            (
                "started_at",
                "ALTER TABLE subagentRun ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "ended_at",
                "ALTER TABLE subagentRun ADD COLUMN ended_at INTEGER;",
            ),
            (
                "created_at",
                "ALTER TABLE subagentRun ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "updated_at",
                "ALTER TABLE subagentRun ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )?;

    conn.execute_batch(
        "
        UPDATE subagentRun
        SET logical_agent_id = ''
        WHERE logical_agent_id IS NULL;

        UPDATE subagentRun
        SET context_meta_json = '{}'
        WHERE context_meta_json IS NULL OR trim(context_meta_json) = '';

        UPDATE subagentRun
        SET total_segment_count = 1
        WHERE total_segment_count IS NULL OR total_segment_count < 1;

        UPDATE subagentRun
        SET active_segment_index = 0
        WHERE active_segment_index IS NULL OR active_segment_index < 0;

        UPDATE subagentRun
        SET total_message_count = 0
        WHERE total_message_count IS NULL OR total_message_count < 0;

        UPDATE subagentRun
        SET round_count = 0
        WHERE round_count IS NULL OR round_count < 0;

        UPDATE subagentRun
        SET tool_call_count = 0
        WHERE tool_call_count IS NULL OR tool_call_count < 0;

        UPDATE subagentRun
        SET compaction_count = 0
        WHERE compaction_count IS NULL OR compaction_count < 0;
        ",
    )
    .map_err(|e| format!("修复子 agent run 表默认字段失败：{e}"))?;

    Ok(())
}

fn ensure_subagent_run_segment_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "subagentRunSegment",
        "子 agent run 分段表",
        &[
            (
                "run_id",
                "ALTER TABLE subagentRunSegment ADD COLUMN run_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "segment_index",
                "ALTER TABLE subagentRunSegment ADD COLUMN segment_index INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "segment_id",
                "ALTER TABLE subagentRunSegment ADD COLUMN segment_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "summary_json",
                "ALTER TABLE subagentRunSegment ADD COLUMN summary_json TEXT;",
            ),
            (
                "messages_json",
                "ALTER TABLE subagentRunSegment ADD COLUMN messages_json TEXT NOT NULL DEFAULT '[]';",
            ),
            (
                "message_count",
                "ALTER TABLE subagentRunSegment ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "start_message_id",
                "ALTER TABLE subagentRunSegment ADD COLUMN start_message_id TEXT;",
            ),
            (
                "end_message_id",
                "ALTER TABLE subagentRunSegment ADD COLUMN end_message_id TEXT;",
            ),
            (
                "created_at",
                "ALTER TABLE subagentRunSegment ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "updated_at",
                "ALTER TABLE subagentRunSegment ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )?;

    conn.execute_batch(
        "
        UPDATE subagentRunSegment
        SET segment_id = 'segment-' || segment_index
        WHERE segment_id IS NULL OR trim(segment_id) = '';

        UPDATE subagentRunSegment
        SET messages_json = '[]'
        WHERE messages_json IS NULL OR trim(messages_json) = '';

        UPDATE subagentRunSegment
        SET message_count = 0
        WHERE message_count IS NULL OR message_count < 0;
        ",
    )
    .map_err(|e| format!("修复子 agent run 分段表默认字段失败：{e}"))?;

    Ok(())
}

fn ensure_subagent_run_event_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "subagentRunEvent",
        "子 agent run 事件表",
        &[
            (
                "run_id",
                "ALTER TABLE subagentRunEvent ADD COLUMN run_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "event_type",
                "ALTER TABLE subagentRunEvent ADD COLUMN event_type TEXT NOT NULL DEFAULT '';",
            ),
            (
                "round_index",
                "ALTER TABLE subagentRunEvent ADD COLUMN round_index INTEGER;",
            ),
            (
                "tool_call_id",
                "ALTER TABLE subagentRunEvent ADD COLUMN tool_call_id TEXT;",
            ),
            (
                "tool_name",
                "ALTER TABLE subagentRunEvent ADD COLUMN tool_name TEXT;",
            ),
            (
                "is_error",
                "ALTER TABLE subagentRunEvent ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "payload_json",
                "ALTER TABLE subagentRunEvent ADD COLUMN payload_json TEXT;",
            ),
            (
                "created_at",
                "ALTER TABLE subagentRunEvent ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )
}

fn ensure_subagent_message_bus_columns(conn: &Connection) -> Result<(), String> {
    ensure_table_columns(
        conn,
        "subagentMessageBusEntry",
        "子 agent message bus 表",
        &[
            (
                "parent_conversation_id",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN parent_conversation_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "seq",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;",
            ),
            (
                "sender_agent_id",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN sender_agent_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "sender_display_name",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN sender_display_name TEXT;",
            ),
            (
                "recipient_agent_id",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN recipient_agent_id TEXT NOT NULL DEFAULT '';",
            ),
            (
                "recipient_display_name",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN recipient_display_name TEXT;",
            ),
            (
                "channel",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN channel TEXT NOT NULL DEFAULT '';",
            ),
            (
                "subject",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN subject TEXT;",
            ),
            (
                "body_markdown",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN body_markdown TEXT NOT NULL DEFAULT '';",
            ),
            (
                "source_run_id",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN source_run_id TEXT;",
            ),
            (
                "source_tool_call_id",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN source_tool_call_id TEXT;",
            ),
            (
                "created_at",
                "ALTER TABLE subagentMessageBusEntry ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
            ),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory history db");
        initialize_connection(&conn).expect("initialize history db");
        conn
    }

    #[test]
    fn initialize_connection_sets_schema_version() {
        let conn = open_test_db();
        assert_eq!(read_user_version(&conn).expect("read version"), 1);
    }

    #[test]
    fn initialize_connection_creates_chat_and_subagent_tables() {
        let conn = open_test_db();
        for table_name in [
            "chatHistory",
            "chatHistorySegment",
            "chatHistoryShare",
            "chatHistoryFtsSegmentIndex",
            "subagentIdentity",
            "subagentRun",
            "subagentRunSegment",
            "subagentRunEvent",
            "subagentMessageBusEntry",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table_name],
                    |row| row.get(0),
                )
                .expect("query table existence");
            assert_eq!(exists, 1, "{table_name} should exist");
        }
    }

    #[test]
    fn migrate_legacy_history_db_to_v1() {
        let conn = Connection::open_in_memory().expect("open legacy in-memory history db");
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

            CREATE TABLE subagentRun (
                id TEXT PRIMARY KEY,
                parent_tool_call_id TEXT NOT NULL,
                parent_tool_name TEXT NOT NULL,
                agent_index INTEGER NOT NULL,
                agent_total INTEGER NOT NULL,
                description TEXT NOT NULL,
                mode TEXT NOT NULL,
                status TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                context_meta_json TEXT NOT NULL,
                active_segment_index INTEGER NOT NULL,
                total_segment_count INTEGER NOT NULL,
                total_message_count INTEGER NOT NULL,
                started_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ",
        )
        .expect("create legacy history schema");

        initialize_connection(&conn).expect("migrate legacy history schema");

        assert_eq!(read_user_version(&conn).expect("read version"), 1);
        for (table_name, column_name) in [
            ("chatHistory", "context_meta_json"),
            ("chatHistory", "is_pinned"),
            ("subagentRun", "logical_agent_id"),
        ] {
            let columns = read_table_columns(&conn, table_name, table_name)
                .expect("read migrated table columns");
            assert!(
                columns.contains(column_name),
                "{table_name}.{column_name} should exist"
            );
        }
    }
}
