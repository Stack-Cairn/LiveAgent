use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

/// Export legacy tables without starting a second writable Planning runtime.
pub fn read() -> Result<Option<Value>, String> {
    let path = crate::commands::settings::config_db_path()?;
    let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
    read_connection(&mut conn)
}

fn read_connection(conn: &mut Connection) -> Result<Option<Value>, String> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='planning_meta')", [], |r| r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        return Ok(None);
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let version: String = tx
        .query_row(
            "SELECT value FROM planning_meta WHERE key='schema'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if version != "1" {
        return Err("E:data_version_newer".into());
    }
    tx.execute(
        "INSERT OR IGNORE INTO planning_meta(key,value) VALUES('kbrainMigrationSource',?1)",
        [uuid::Uuid::new_v4().to_string()],
    )
    .map_err(|e| e.to_string())?;
    let meta = |key: &str| -> Result<Option<String>, String> {
        tx.query_row("SELECT value FROM planning_meta WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())
    };
    let source = meta("kbrainMigrationSource")?.ok_or("E:migration_source_required")?;
    let mut snapshot = json!({"seq":meta("seq")?.and_then(|s|s.parse::<u64>().ok()).unwrap_or(0),"timeZone":meta("timeZone")?.unwrap_or_else(||"UTC".into()),"todoSchedules":[],"subscriptions":[]});
    for table in [
        "calendars",
        "todos",
        "groups",
        "tags",
        "events",
        "reminders",
        "sources",
    ] {
        let mut stmt = tx
            .prepare(&format!("SELECT payload FROM planning_{table} ORDER BY id"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            items.push(
                serde_json::from_str::<Value>(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            );
        }
        snapshot[table] = json!(items);
    }
    for key in ["defaultGroupId", "myTasksColor"] {
        if let Some(value) = meta(key)? {
            snapshot[key] = json!(value);
        }
    }
    let subscriptions = {
        let mut stmt = tx.prepare("SELECT id,url,refresh_minutes,next_at,last_synced_at,last_error FROM planning_subscriptions").map_err(|e|e.to_string())?;
        let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"url":r.get::<_,String>(1)?,"refreshMinutes":r.get::<_,i64>(2)?,"nextAt":r.get::<_,i64>(3)?,"lastSyncedAt":r.get::<_,Option<i64>>(4)?,"lastError":r.get::<_,Option<String>>(5)?}))).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(
        json!({"source":source,"snapshot":snapshot,"subscriptions":subscriptions}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_export_keeps_rows_and_stable_source() {
        let mut conn = Connection::open_in_memory().unwrap();
        assert!(read_connection(&mut conn).unwrap().is_none());
        conn.execute_batch("CREATE TABLE planning_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO planning_meta VALUES('schema','1'); CREATE TABLE planning_subscriptions(id TEXT,url TEXT,refresh_minutes INTEGER,next_at INTEGER,last_synced_at INTEGER,last_error TEXT);").unwrap();
        for table in ["calendars", "todos", "groups", "tags", "events", "reminders", "sources"] {
            conn.execute_batch(&format!("CREATE TABLE planning_{table}(id TEXT PRIMARY KEY,payload TEXT);")).unwrap();
        }
        conn.execute("INSERT INTO planning_todos VALUES('old',?1)", [r#"{"id":"old","title":"preserved"}"#]).unwrap();
        conn.execute_batch("INSERT INTO planning_subscriptions VALUES('feed','https://example.test/private',15,0,NULL,NULL);").unwrap();
        let first = read_connection(&mut conn).unwrap().unwrap();
        let second = read_connection(&mut conn).unwrap().unwrap();
        assert_eq!(first, second);
        assert_eq!(first["snapshot"]["todos"][0]["title"], "preserved");
        assert_eq!(first["subscriptions"][0]["url"], "https://example.test/private");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM planning_todos", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        conn.execute("UPDATE planning_meta SET value='2' WHERE key='schema'", []).unwrap();
        assert_eq!(read_connection(&mut conn).unwrap_err(), "E:data_version_newer");
    }
}
