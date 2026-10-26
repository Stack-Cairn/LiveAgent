#[cfg(test)]
mod migration_tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn exports_fixture_in_order_without_mutating_sqlite_or_checkpoint_artifacts() {
        let temp = tempfile::tempdir().expect("fixture directory");
        let path = temp.path().join("chat-history.sqlite3");
        let conn = Connection::open(&path).expect("open fixture");
        history_db::initialize_connection(&conn).expect("initialize fixture");
        conn.execute(
            "INSERT INTO chatHistory (id,title,provider_id,model,context_meta_json,active_segment_index,total_segment_count,total_message_count,created_at,updated_at,is_pinned) VALUES ('legacy-a','Draft','fixture','model','{\"systemPrompt\":\"sys\"}',1,2,2,10,20,1)",
            [],
        ).expect("insert history");
        conn.execute(
            "INSERT INTO chatHistorySegment (conversation_id,segment_index,segment_id,summary_json,messages_json,message_count,created_at,updated_at) VALUES ('legacy-a',0,'seg-0','{\"role\":\"summary\",\"content\":\"old\"}','[{\"role\":\"user\",\"id\":\"u0\",\"content\":\"hello\"}]',1,10,11)",
            [],
        ).expect("insert first segment");
        conn.execute(
            "INSERT INTO chatHistorySegment (conversation_id,segment_index,segment_id,messages_json,message_count,created_at,updated_at) VALUES ('legacy-a',1,'seg-1','[]',0,12,20)",
            [],
        ).expect("insert active segment");
        drop(conn);
        let checkpoint_dir = temp.path().join(".liveagent/checkpoints/legacy-a");
        std::fs::create_dir_all(checkpoint_dir.join("blobs")).unwrap();
        let checkpoint = checkpoint_dir.join("index.jsonl");
        let index = concat!(
            r#"{"schema":2,"turnSeq":7,"turnId":"u0","root":"/workspace","relPath":"file.txt","kind":"file","existedBefore":true,"blob":"0123456789abcdef@v1","size":3,"mtimeMs":8,"capturedAt":9,"mode":33188,"note":"ledger note"}"#,
            "\n"
        );
        std::fs::write(&checkpoint, index).unwrap();
        let blob = checkpoint_dir.join("blobs/0123456789abcdef@v1");
        std::fs::write(&blob, [0, 255, 1]).unwrap();
        let bytes_before = std::fs::read(&path).unwrap();
        let conn = open_migration_path(&path).expect("open read-only fixture");
        assert!(conn.execute("DELETE FROM chatHistory", []).is_err());
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM chatHistorySegment", [], |row| {
                row.get(0)
            })
            .unwrap();
        let page = migration_page_sync(&conn, None, temp.path()).expect("export fixture");
        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM chatHistorySegment", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before);
        assert_eq!(std::fs::read(&checkpoint).unwrap(), index.as_bytes());
        assert_eq!(page.conversations[0].active_segment_index, 1);
        assert!(page.conversations[0].segments[1].active);
        let wire = serde_json::to_value(&page).unwrap();
        assert_eq!(wire["nextCursor"], serde_json::Value::Null);
        assert_eq!(wire["conversations"][0]["activeSegmentIndex"], 1);
        assert_eq!(page.conversations.len(), 1);
        assert_eq!(page.conversations[0].segments[0].segment_id, "seg-0");
        assert_eq!(page.conversations[0].segments[1].segment_id, "seg-1");
        assert_eq!(
            page.conversations[0].segments[0].summary_json.as_deref(),
            Some("{\"role\":\"summary\",\"content\":\"old\"}")
        );
        assert_eq!(page.conversations[0].checkpoint.status, "available");
        assert_eq!(std::fs::read(&blob).unwrap(), [0, 255, 1]);
        assert_eq!(page.conversations[0].checkpoint.index_jsonl, index);
        let exported = &page.conversations[0].checkpoint.records[0];
        assert_eq!(exported.blob_base64.as_deref(), Some("AP8B"));
        assert_eq!(exported.mode, Some(33188));
        assert_eq!(exported.mtime_ms, 8);
        assert_eq!(exported.note.as_deref(), Some("ledger note"));
        assert_eq!(
            page.conversations[0].checkpoint.native_path,
            "~/.liveagent/checkpoints/legacy-a"
        );
        assert_eq!(page.conversations[0].checkpoint.records.len(), 1);
    }

    #[test]
    fn malformed_segment_is_exported_for_per_conversation_isolation() {
        let conn = Connection::open_in_memory().expect("open fixture");
        history_db::initialize_connection(&conn).expect("initialize fixture");
        conn.execute(
            "INSERT INTO chatHistory (id,title,provider_id,model,context_meta_json,active_segment_index,total_segment_count,total_message_count,created_at,updated_at) VALUES ('legacy-b','Bad','p','m','{}',0,1,1,1,1)",
            [],
        ).expect("insert history");
        conn.execute(
            "INSERT INTO chatHistorySegment (conversation_id,segment_index,segment_id,messages_json,message_count,created_at,updated_at) VALUES ('legacy-b',0,'bad','not-json',1,1,1)",
            [],
        ).expect("insert malformed segment");
        let page = migration_page_sync(&conn, None, tempfile::tempdir().unwrap().path())
            .expect("raw malformed segment export");
        assert_eq!(page.conversations.len(), 1);
        assert_eq!(page.conversations[0].segments[0].messages_json, "not-json");
    }
    #[test]
    fn checkpoint_export_preserves_invalid_lines_and_does_not_follow_blob_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(".liveagent/checkpoints/partial");
        std::fs::create_dir_all(dir.join("blobs")).unwrap();
        let mut record = serde_json::json!({"schema":2,"turnSeq":1,"turnId":"u","root":"/workspace","relPath":"a","kind":"file","existedBefore":true,"blob":"missing","size":1,"mtimeMs":0,"capturedAt":1});
        let index = format!("{}\nnot-json\n", record);
        std::fs::write(dir.join("index.jsonl"), &index).unwrap();
        let export = checkpoint_export("partial", temp.path());
        assert_eq!(export.status, "partial");
        assert_eq!(export.invalid_lines.len(), 2);
        assert_eq!(export.index_jsonl, index);
        assert!(export.records[0].blob_base64.is_none());
        record["blob"] = serde_json::json!("../../secret");
        std::fs::write(dir.join("index.jsonl"), record.to_string()).unwrap();
        let export = checkpoint_export("partial", temp.path());
        assert_eq!(export.status, "partial");
        assert!(export.records[0].blob_base64.is_none());
        #[cfg(unix)]
        {
            std::fs::write(temp.path().join("secret"), "x").unwrap();
            std::os::unix::fs::symlink(temp.path().join("secret"), dir.join("blobs/link")).unwrap();
            record["blob"] = serde_json::json!("link");
            std::fs::write(dir.join("index.jsonl"), record.to_string()).unwrap();
            let export = checkpoint_export("partial", temp.path());
            assert_eq!(export.status, "partial");
            assert!(export.records[0].blob_base64.is_none());
            assert_eq!(
                std::fs::read_to_string(temp.path().join("secret")).unwrap(),
                "x"
            );
        }
    }
    #[test]
    fn exports_checkpoint_acceptance_fixture() {
        let scratch = std::env::var_os("KBRAIN_MIGRATION_ACCEPTANCE_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let temp = tempfile::Builder::new()
            .prefix("native-export-")
            .tempdir_in(&scratch)
            .unwrap();
        let home = temp.path();
        let db = home.join("chat-history.sqlite3");
        let conn = Connection::open(&db).unwrap();
        history_db::initialize_connection(&conn).unwrap();
        let workspace = home.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        conn.execute("INSERT INTO chatHistory (id,title,provider_id,model,cwd,context_meta_json,active_segment_index,total_segment_count,total_message_count,created_at,updated_at,is_pinned) VALUES ('acceptance','Native checkpoint acceptance','fixture','fixture-model',?1,'{\"systemPrompt\":\"system\"}',0,1,1,10,20,1)", [workspace.to_str().unwrap()]).unwrap();
        conn.execute("INSERT INTO chatHistorySegment (conversation_id,segment_index,segment_id,messages_json,message_count,created_at,updated_at) VALUES ('acceptance',0,'seg-0','[{\"role\":\"user\",\"id\":\"user-native\",\"content\":\"edit file\",\"timestamp\":10}]',1,10,20)", []).unwrap();
        drop(conn);
        let dir = home.join(".liveagent/checkpoints/acceptance");
        std::fs::create_dir_all(dir.join("blobs")).unwrap();
        let record = serde_json::json!({"schema":2,"turnSeq":7,"turnId":"user-native","root":workspace,"relPath":"binary.dat","kind":"file","existedBefore":true,"blob":"0123456789abcdef@v1","size":4,"mtimeMs":8,"capturedAt":9,"mode":33188,"note":"acceptance ledger"});
        let index = format!("{record}\n");
        std::fs::write(dir.join("index.jsonl"), &index).unwrap();
        let preimage = [0, 255, 1, 128];
        std::fs::write(dir.join("blobs/0123456789abcdef@v1"), preimage).unwrap();
        std::fs::write(workspace.join("binary.dat"), b"modified workspace").unwrap();
        let db_before = std::fs::read(&db).unwrap();
        let mut conn = open_migration_path(&db).unwrap();
        let tx = conn.transaction().unwrap();
        let page = migration_page_sync(&tx, None, home).unwrap();
        let exported = serde_json::to_vec(&page).unwrap();
        assert_eq!(
            page.conversations[0].checkpoint.records[0]
                .blob_base64
                .as_deref(),
            Some("AP8BgA==")
        );
        drop(tx);
        drop(conn);
        assert_eq!(std::fs::read(&db).unwrap(), db_before);
        assert_eq!(
            std::fs::read(dir.join("index.jsonl")).unwrap(),
            index.as_bytes()
        );
        assert_eq!(
            std::fs::read(dir.join("blobs/0123456789abcdef@v1")).unwrap(),
            preimage
        );
        if std::env::var_os("KBRAIN_MIGRATION_ACCEPTANCE_DIR").is_some() {
            std::fs::write(scratch.join("native-page.json"), exported).unwrap();
            std::fs::write(scratch.join("native-home.txt"), home.to_str().unwrap()).unwrap();
            let _ = temp.keep();
        }
    }

    #[test]
    fn migration_signature_tracks_exported_rows_and_checkpoint_indexes() {
        let temp = tempfile::tempdir().expect("fixture directory");
        let path = temp.path().join("chat-history.sqlite3");
        let conn = Connection::open(&path).expect("open fixture");
        history_db::initialize_connection(&conn).expect("initialize fixture");
        conn.execute(
            "INSERT INTO chatHistory (id,title,provider_id,model,context_meta_json,active_segment_index,total_segment_count,total_message_count,created_at,updated_at,is_pinned) VALUES ('legacy-a','Draft','fixture','model','{}',0,1,1,10,20,0)",
            [],
        ).expect("insert history");
        conn.execute(
            "INSERT INTO chatHistorySegment (conversation_id,segment_index,segment_id,messages_json,message_count,created_at,updated_at) VALUES ('legacy-a',0,'seg-0','[]',0,10,20)",
            [],
        ).expect("insert segment");
        let read = || {
            let conn = open_migration_path(&path).expect("open read-only fixture");
            migration_signature_sync(&conn, temp.path()).expect("signature")
        };
        let first = read();
        assert_eq!(read(), first, "an untouched export keeps its signature");

        conn.execute("UPDATE chatHistorySegment SET updated_at = 30", [])
            .expect("touch segment");
        let touched = read();
        assert_ne!(touched, first, "an edited segment changes the signature");

        conn.execute(
            "INSERT INTO chatHistoryShare (conversation_id,token,enabled,redact_tool_content,created_at,updated_at) VALUES ('legacy-a','t',1,0,30,30)",
            [],
        ).expect("share");
        let shared = read();
        assert_ne!(shared, touched, "sharing changes the signature");

        // Older builds rename, pin and move conversations without touching updated_at.
        let mut previous = shared.clone();
        for edit in [
            "UPDATE chatHistory SET title = 'Renamed'",
            "UPDATE chatHistory SET is_pinned = 1",
            "UPDATE chatHistory SET cwd = '/elsewhere'",
        ] {
            conn.execute(edit, []).expect("metadata edit");
            let edited = read();
            assert_ne!(edited, previous, "{edit} changes the signature");
            previous = edited;
        }
        let shared = previous;

        let checkpoint_dir = temp.path().join(".liveagent/checkpoints/legacy-a");
        std::fs::create_dir_all(&checkpoint_dir).unwrap();
        std::fs::write(checkpoint_dir.join("index.jsonl"), "{}\n").unwrap();
        let with_index = read();
        assert_ne!(
            with_index, shared,
            "a new checkpoint index changes the signature"
        );
        std::fs::write(checkpoint_dir.join("index.jsonl"), "{}\n{}\n").unwrap();
        assert_ne!(
            read(),
            with_index,
            "a grown checkpoint index changes the signature"
        );
    }
}
