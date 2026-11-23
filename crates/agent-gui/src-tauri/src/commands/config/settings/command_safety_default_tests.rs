// New installs default to "ask"; stored snapshots keep their effective mode.
#[cfg(test)]
mod command_safety_default_tests {
    use super::*;
    use serde_json::json;

    const WORKDIR: &str = "/tmp/liveagent-default-project";

    fn open_memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        initialize_schema(&conn).expect("initialize schema");
        conn
    }

    fn loaded_mode(conn: &Connection) -> Value {
        load_system_with_defaults(conn, WORKDIR).expect("load system")["commandSafetyMode"].clone()
    }

    #[test]
    fn fresh_install_defaults_to_ask() {
        assert_eq!(loaded_mode(&open_memory_db()), json!("ask"));
        assert_eq!(
            system_value_with_defaults(None, WORKDIR)["commandSafetyMode"],
            json!("ask")
        );
        assert_eq!(
            system_value_with_defaults(Some(json!({})), WORKDIR)["commandSafetyMode"],
            json!("ask")
        );
    }

    #[test]
    fn existing_snapshot_without_the_key_keeps_always() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(&mut conn, json!({ "executionMode": "tools" }), WORKDIR)
            .expect("save legacy snapshot");
        assert_eq!(loaded_mode(&conn), json!("always"));
    }

    #[test]
    fn saved_choices_survive_the_new_default() {
        for mode in ["always", "ask", "autoEdit", "sandbox"] {
            let mut conn = open_memory_db();
            save_system_with_default_workdir(
                &mut conn,
                json!({ "executionMode": "tools", "commandSafetyMode": mode }),
                WORKDIR,
            )
            .expect("save system");
            assert_eq!(loaded_mode(&conn), json!(mode), "{mode}");
        }
        // The retired full-access value still migrates to "always".
        let legacy =
            system_value_with_defaults(Some(json!({ "commandSafetyMode": "auto" })), WORKDIR);
        assert_eq!(legacy["commandSafetyMode"], json!("always"));
    }
}
