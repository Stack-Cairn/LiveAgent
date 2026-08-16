// 窗口级 Session Workbench 布局的本机持久化。布局只保存稳定身份与空间信息
// （PaneTree/ratio/focus），绝不包含消息、草稿、Secret 或 Session ID；
// 该表不参与 Gateway Settings Sync。

/// 单窗口布局 Payload 上限（与设计文档一致）。
const WORKBENCH_LAYOUT_PAYLOAD_MAX_BYTES: usize = 96 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchLayoutRecord {
    pub scope_id: String,
    pub schema_version: i64,
    pub revision: i64,
    pub payload_json: String,
    pub updated_at: i64,
}

fn load_workbench_layout(
    conn: &Connection,
    scope_id: &str,
) -> Result<Option<WorkbenchLayoutRecord>, String> {
    conn.query_row(
        "SELECT scope_id, schema_version, revision, payload_json, updated_at
         FROM workbench_layout WHERE scope_id = ?1",
        params![scope_id],
        |row| {
            Ok(WorkbenchLayoutRecord {
                scope_id: row.get(0)?,
                schema_version: row.get(1)?,
                revision: row.get(2)?,
                payload_json: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("读取工作台布局失败：{e}"))
}

fn save_workbench_layout(
    conn: &Connection,
    scope_id: &str,
    schema_version: i64,
    revision: i64,
    payload_json: &str,
) -> Result<(), String> {
    if scope_id.trim().is_empty() {
        return Err("工作台布局 scope_id 不能为空".to_string());
    }
    if payload_json.len() > WORKBENCH_LAYOUT_PAYLOAD_MAX_BYTES {
        return Err("工作台布局 Payload 超过 96 KiB 上限".to_string());
    }
    conn.execute(
        "INSERT INTO workbench_layout (scope_id, schema_version, revision, payload_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(scope_id) DO UPDATE SET
             schema_version = excluded.schema_version,
             revision = excluded.revision,
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at",
        params![scope_id, schema_version, revision, payload_json, now_ms()],
    )
    .map_err(|e| format!("保存工作台布局失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn workbench_layout_load(
    scope_id: String,
) -> Result<Option<WorkbenchLayoutRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        load_workbench_layout(&conn, &scope_id)
    })
    .await
    .map_err(|e| format!("workbench_layout_load join 失败：{e}"))?
}

#[tauri::command]
pub async fn workbench_layout_save(
    scope_id: String,
    schema_version: i64,
    revision: i64,
    payload_json: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        save_workbench_layout(&conn, &scope_id, schema_version, revision, &payload_json)
    })
    .await
    .map_err(|e| format!("workbench_layout_save join 失败：{e}"))?
}
