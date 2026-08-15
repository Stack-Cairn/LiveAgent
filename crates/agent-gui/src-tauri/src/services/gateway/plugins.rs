use serde::Deserialize;
use serde_json::{json, Value};

use crate::services::plugins::{self, PluginConfigUpdate};

use super::proto;

const MAX_PLUGIN_MANAGE_PAYLOAD_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginIdPayload {
    plugin_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginSetEnabledPayload {
    plugin_id: String,
    workspace: Option<String>,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginSetGrantsPayload {
    plugin_id: String,
    permissions: Vec<String>,
}

pub(crate) async fn handle_plugin_manage(
    request: proto::PluginManageRequest,
) -> Result<proto::PluginManageResponse, String> {
    if request.payload_json.len() > MAX_PLUGIN_MANAGE_PAYLOAD_BYTES {
        return Err("插件管理请求超过 1 MiB 限制".to_string());
    }
    let action = request.action.trim().to_string();
    let payload = request.payload_json;
    let result = tauri::async_runtime::spawn_blocking(move || {
        handle_plugin_manage_blocking(&action, &payload).map(|value| (action, value))
    })
    .await
    .map_err(|error| format!("插件管理任务 join 失败：{error}"))??;
    let result_json = serde_json::to_string(&result.1)
        .map_err(|error| format!("序列化插件管理响应失败：{error}"))?;
    if result_json.len() > MAX_PLUGIN_MANAGE_PAYLOAD_BYTES {
        return Err("插件管理响应超过 1 MiB 限制".to_string());
    }
    Ok(proto::PluginManageResponse {
        action: result.0,
        result_json,
    })
}

fn handle_plugin_manage_blocking(action: &str, payload: &str) -> Result<Value, String> {
    match action {
        "list" => {
            #[derive(Deserialize)]
            struct ListPayload {
                workspace: Option<String>,
            }
            let payload: ListPayload = parse_payload(payload)?;
            serde_json::to_value(plugins::inventory(payload.workspace.as_deref())?)
                .map_err(|error| format!("序列化插件 Inventory 失败：{error}"))
        }
        "set_enabled" => {
            let payload: PluginSetEnabledPayload = parse_payload(payload)?;
            let revision = plugins::enable(
                &payload.plugin_id,
                payload.workspace.as_deref(),
                payload.enabled,
            )?;
            Ok(json!(revision))
        }
        "set_grants" => {
            let payload: PluginSetGrantsPayload = parse_payload(payload)?;
            Ok(json!(plugins::grant(
                &payload.plugin_id,
                payload.permissions
            )?))
        }
        "update_config" => {
            let update: PluginConfigUpdate = parse_payload(payload)?;
            Ok(json!(plugins::configure(update)?))
        }
        "uninstall" => {
            let payload: PluginIdPayload = parse_payload(payload)?;
            plugins::uninstall(&payload.plugin_id)?;
            Ok(Value::Null)
        }
        _ => Err(format!("不支持的插件管理动作：{action}")),
    }
}

fn parse_payload<T: for<'de> Deserialize<'de>>(payload: &str) -> Result<T, String> {
    serde_json::from_str(if payload.trim().is_empty() {
        "{}"
    } else {
        payload
    })
    .map_err(|error| format!("插件管理请求格式无效：{error}"))
}
