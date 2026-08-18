#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectorySubagentRunsResponse {
    pub runs_json: String,
}

pub(crate) async fn trajectory_get_subagent_runs_inner(
    conversation_id: String,
    run_ids: Vec<String>,
) -> Result<TrajectorySubagentRunsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = history_db::open_connection()?;
        let states = subagent_store::load_subagent_run_states_by_ids_sync(
            &conn,
            &conversation_id,
            &run_ids,
        )?;
        let runs_json =
            serde_json::to_string(&states).map_err(|e| format!("序列化轨迹子代理运行失败：{e}"))?;
        Ok(TrajectorySubagentRunsResponse { runs_json })
    })
    .await
    .map_err(|e| format!("trajectory_get_subagent_runs join 失败：{e}"))?
}

#[tauri::command]
pub async fn trajectory_get_subagent_runs(
    conversation_id: String,
    run_ids: Option<Vec<String>>,
) -> Result<TrajectorySubagentRunsResponse, String> {
    trajectory_get_subagent_runs_inner(conversation_id, run_ids.unwrap_or_default()).await
}
