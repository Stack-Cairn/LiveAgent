use serde_json::{json, Value};

use super::*;

fn summary(value: &Value) -> proto::ConversationSummary {
    let text = |key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let number = |key| value.get(key).and_then(Value::as_i64).unwrap_or_default();
    proto::ConversationSummary {
        id: text("id"),
        title: text("title"),
        provider_id: text("providerId"),
        model: text("model"),
        // WebUI restores session_id as its next conversation target. Keep the
        // desktop identity; backend session IDs belong to the desktop mapping.
        session_id: text("id"),
        cwd: text("cwd"),
        selected_model_json: text("selectedModelJson"),
        created_at: number("createdAt"),
        updated_at: number("updatedAt"),
        message_count: number("messageCount").clamp(0, i32::MAX as i64) as i32,
        is_pinned: value["isPinned"].as_bool().unwrap_or(false),
        pinned_at: number("pinnedAt"),
        is_shared: value["isShared"].as_bool().unwrap_or(false),
    }
}

impl GatewayController {
    pub(crate) async fn handle_kbrain_history_request(
        self: &std::sync::Arc<Self>,
        request_id: String,
        payload: &proto::gateway_envelope::Payload,
    ) -> Result<bool, String> {
        use proto::agent_envelope::Payload as Response;
        use proto::gateway_envelope::Payload as Request;
        let (action, conversation_id, data) = match payload {
            Request::HistoryList(r) => (
                "list",
                "",
                json!({"page":r.page,"pageSize":r.page_size,"cwd":r.cwd,"cwdEmpty":r.cwd_empty}),
            ),
            Request::HistoryWorkdirs(_) => ("workdirs", "", Value::Null),
            Request::HistoryGet(r) => (
                "get",
                r.conversation_id.as_str(),
                json!({"maxMessages":r.max_messages}),
            ),
            Request::HistoryRename(r) => (
                "rename",
                r.conversation_id.as_str(),
                json!({"title":r.title}),
            ),
            Request::HistoryPin(r) => (
                "pin",
                r.conversation_id.as_str(),
                json!({"isPinned":r.is_pinned}),
            ),
            Request::HistorySetCwd(r) => ("cwd", r.conversation_id.as_str(), json!({"cwd":r.cwd})),
            Request::HistoryDelete(r) => ("delete", r.conversation_id.as_str(), Value::Null),
            _ => return Ok(false),
        };
        let result = self
            .run_composer_action(GatewayComposerActionEvent {
                request_id: request_id.clone(),
                kind: "history".into(),
                conversation_id: conversation_id.into(),
                action: action.into(),
                cron: String::new(),
                interval: String::new(),
                prompt: String::new(),
                reasoning: String::new(),
                loop_id: String::new(),
                data: Some(data),
            })
            .await;
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                self.send_error_response(request_id, 502, error).await?;
                return Ok(true);
            }
        };
        let conversation = value.get("conversation").map(summary);
        if matches!(action, "rename" | "pin" | "cwd") {
            if let Some(conversation) = conversation.as_ref() {
                self.publish_history_sync(build_history_sync_upsert_from_proto(conversation))
                    .await;
            }
        } else if action == "delete" {
            self.publish_history_sync(build_history_sync_delete(conversation_id.to_string()))
                .await;
        }
        let response = match action {
            "list" => Response::HistoryListResp(proto::HistoryListResponse {
                conversations: value["items"]
                    .as_array()
                    .map(|items| items.iter().map(summary).collect())
                    .unwrap_or_default(),
                total_count: value["totalCount"]
                    .as_i64()
                    .unwrap_or_default()
                    .clamp(0, i32::MAX as i64) as i32,
            }),
            "workdirs" => Response::HistoryWorkdirsResp(proto::HistoryWorkdirsResponse {
                workdirs: value["workdirs"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| proto::HistoryWorkdirSummary {
                                path: item["path"].as_str().unwrap_or_default().into(),
                                conversation_count: item["conversationCount"]
                                    .as_i64()
                                    .unwrap_or_default()
                                    .clamp(0, i32::MAX as i64)
                                    as i32,
                                updated_at: item["updatedAt"].as_i64().unwrap_or_default(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            }),
            "get" => Response::HistoryGetResp(proto::HistoryGetResponse {
                conversation_id: conversation_id.into(),
                conversation,
                messages_json: value["messagesJson"].as_str().unwrap_or("[]").into(),
                total_message_count: value["totalMessageCount"]
                    .as_i64()
                    .unwrap_or_default()
                    .clamp(0, i32::MAX as i64) as i32,
                returned_message_count: value["returnedMessageCount"]
                    .as_i64()
                    .unwrap_or_default()
                    .clamp(0, i32::MAX as i64) as i32,
                has_more: value["hasMore"].as_bool().unwrap_or(false),
            }),
            "rename" => Response::HistoryRenameResp(proto::HistoryRenameResponse { conversation }),
            "pin" => Response::HistoryPinResp(proto::HistoryPinResponse { conversation }),
            "cwd" => Response::HistorySetCwdResp(proto::HistorySetCwdResponse { conversation }),
            "delete" => Response::HistoryDeleteResp(proto::HistoryDeleteResponse {}),
            _ => unreachable!(),
        };
        self.send_agent_envelope(proto::AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(response),
        })
        .await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webui_restore_keeps_desktop_identity_and_windows_workdir() {
        let value = summary(&json!({
            "id": "desktop-conversation", "sessionId": "backend-session",
            "cwd": "C:\\Users\\Tester\\workspace", "messageCount": 4,
            "providerId": "backend", "model": "model"
        }));
        assert_eq!(value.id, "desktop-conversation");
        assert_eq!(value.session_id, value.id);
        assert_eq!(value.cwd, "C:\\Users\\Tester\\workspace");
        assert_eq!(value.message_count, 4);
    }
}
