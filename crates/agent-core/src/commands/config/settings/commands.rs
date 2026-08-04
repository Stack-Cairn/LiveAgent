pub async fn settings_load_all() -> Result<SettingsLoadResponse, String> {
    tokio::task::spawn_blocking(|| {
        let conn = open_db()?;
        let default_workdir = default_project_workdir()?;
        Ok(SettingsLoadResponse {
            providers: load_providers(&conn)?,
            system: Some(load_system_with_defaults(&conn, &default_workdir)?),
            mcp: load_mcp(&conn)?,
            agents: load_agents(&conn)?,
            ssh: load_ssh(&conn)?,
            remote: load_remote(&conn)?,
            memory: load_memory(&conn)?,
            default_workdir,
        })
    })
    .await
    .map_err(|e| format!("settings_load_all join 失败：{e}"))?
}

pub async fn settings_save_providers(payload: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_providers(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_providers join 失败：{e}"))?
}

pub async fn settings_save_system(
    payload: Value,
    automation_scheduler: &Arc<AutomationScheduler>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_system(&mut conn, payload)?;
        // 保存成功后刷新全局代理状态，让 shell env 注入与出网代理即时生效。
        refresh_system_proxy_state(&conn)
    })
    .await
    .map_err(|e| format!("settings_save_system join 失败：{e}"))??;
    // Bash cron tasks execute in the system workdir; reschedule so the new
    // workdir takes effect without an app restart.
    automation_scheduler.request_reload();
    Ok(())
}

pub async fn settings_save_mcp(payload: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_mcp(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_mcp join 失败：{e}"))?
}

/// 保存远程（Gateway）配置。
///
/// 保存完只往总线上发一条 `settings:remote-saved`，**不认识 Gateway**。
/// 谁想在配置变更后做事（当前是 `GatewayEventSink` 调 `apply_config`），
/// 自己去订阅——这是 P2-04~P2-08 一路用下来的同一个模式，
/// 也是这条命令能跟着 settings 一起迁入 agent-core 的唯一原因。
///
/// payload 发的是**落库后的归一化结果**而不是入参：订阅者要的是「现在是什么」，
/// 不是「谁请求了什么」。
pub async fn settings_save_remote(payload: Value, events: &Arc<EventBus>) -> Result<(), String> {
    let normalized = tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_remote(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_remote join 失败：{e}"))??;
    events.emit(SETTINGS_REMOTE_SAVED_EVENT, &normalized);
    Ok(())
}

pub async fn settings_save_memory(payload: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_memory(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_memory join 失败：{e}"))?
}

pub async fn settings_save_agents(payload: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_agents(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_agents join 失败：{e}"))?
}

pub async fn settings_save_ssh(payload: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_ssh(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_save_ssh join 失败：{e}"))?
}

pub async fn settings_apply_ssh_patch(payload: Value) -> Result<SshPatchApplyResponse, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        apply_ssh_patch_with_conn(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("settings_apply_ssh_patch join 失败：{e}"))?
}

pub async fn settings_reset_ssh_known_host(
    host: String,
    port: u16) -> Result<SshKnownHostResetResponse, String> {
    tokio::task::spawn_blocking(move || {
        let deleted = reset_runtime_ssh_known_host(&host, port)?;
        Ok(SshKnownHostResetResponse { deleted })
    })
    .await
    .map_err(|e| format!("settings_reset_ssh_known_host join 失败：{e}"))?
}
