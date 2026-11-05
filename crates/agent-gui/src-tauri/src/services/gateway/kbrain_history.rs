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

fn count(value: &Value) -> i32 {
    value.as_i64().unwrap_or_default().clamp(0, i32::MAX as i64) as i32
}

fn message_ref_json(value: &proto::ChatMessageRef) -> Value {
    json!({
        "segmentIndex": value.segment_index,
        "messageIndex": value.message_index,
        "segmentId": value.segment_id,
        "messageId": value.message_id,
        "role": value.role,
        "contentHash": value.content_hash,
    })
}

fn share_status(value: &Value) -> proto::HistoryShareStatus {
    proto::HistoryShareStatus {
        conversation_id: value["conversationId"].as_str().unwrap_or_default().into(),
        enabled: value["enabled"].as_bool().unwrap_or(false),
        token: value["token"].as_str().unwrap_or_default().into(),
        created_at: value["createdAt"].as_i64().unwrap_or_default(),
        updated_at: value["updatedAt"].as_i64().unwrap_or_default(),
        redact_tool_content: value["redactToolContent"].as_bool().unwrap_or(false),
    }
}

fn trajectory_response(conversation_id: &str, value: &Value) -> proto::TrajectoryFetchResponse {
    proto::TrajectoryFetchResponse {
        conversation_id: conversation_id.into(),
        events_json: value["eventsJson"].as_str().unwrap_or_default().into(),
        truncated: value["truncated"].as_bool().unwrap_or(false),
        sections: value["sections"]
            .as_array()
            .map(|sections| {
                sections
                    .iter()
                    .map(|section| {
                        let content = section["content"].as_str().unwrap_or_default();
                        proto::TrajectorySectionPayload {
                            section_id: section["sectionId"].as_str().unwrap_or_default().into(),
                            slot: section["slot"].as_str().unwrap_or_default().into(),
                            content: content.into(),
                            bytes: section["bytes"].as_i64().unwrap_or(content.len() as i64),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default(),
        oldest_segment_index: count(&value["oldestSegmentIndex"]),
        returned_segment_count: count(&value["returnedSegmentCount"]),
        total_segment_count: count(&value["totalSegmentCount"]),
        has_more_before: value["hasMoreBefore"].as_bool().unwrap_or(false),
        subagent_runs_json: value["subagentRunsJson"]
            .as_str()
            .unwrap_or_default()
            .into(),
    }
}

fn summary_cwd(value: &Value) -> Option<String> {
    value["conversation"]["cwd"]
        .as_str()
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .map(str::to_string)
}

impl GatewayController {
    /// Working directory of a conversation as the desktop frontend's history
    /// (K-brain sessions or the local database) records it; `None` when the
    /// frontend cannot find it.
    pub(crate) async fn kbrain_conversation_workdir(
        self: &std::sync::Arc<Self>,
        request_id: String,
        conversation_id: String,
    ) -> Option<String> {
        let value = self
            .run_composer_action(GatewayComposerActionEvent {
                request_id,
                kind: "history".into(),
                conversation_id,
                action: "get".into(),
                cron: String::new(),
                interval: String::new(),
                prompt: String::new(),
                reasoning: String::new(),
                loop_id: String::new(),
                data: Some(json!({"maxMessages":1})),
            })
            .await
            .ok()?;
        summary_cwd(&value)
    }

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
            Request::HistoryBranch(r) => {
                let Some(base) = r.base_message_ref.as_ref() else {
                    self.send_error_response(
                        request_id,
                        400,
                        "history.branch requires base_message_ref".into(),
                    )
                    .await?;
                    return Ok(true);
                };
                (
                    "branch",
                    r.conversation_id.as_str(),
                    json!({"baseMessageRef": message_ref_json(base)}),
                )
            }
            Request::HistoryShareGet(r) => ("share_get", r.conversation_id.as_str(), Value::Null),
            Request::HistoryShareSet(r) => (
                "share_set",
                r.conversation_id.as_str(),
                json!({"enabled":r.enabled,"redactToolContent":r.redact_tool_content}),
            ),
            Request::HistoryShareResolve(r) => ("share_resolve", "", json!({"token":r.token})),
            Request::TrajectoryFetch(r) => (
                "trajectory",
                r.conversation_id.as_str(),
                json!({
                    "sectionIds": r.section_ids,
                    "maxSegments": r.max_segments,
                    "beforeSegmentIndex": r.before_segment_index,
                    "includeSubagentRuns": r.include_subagent_runs,
                    "subagentRunIds": r.subagent_run_ids,
                }),
            ),
            Request::Checkpoint(r) => {
                let action = match r.action.trim() {
                    "list" => "checkpoint_list",
                    "diff" => "checkpoint_diff",
                    "rewind" => "checkpoint_rewind",
                    other => {
                        self.send_error_response(
                            request_id,
                            400,
                            format!("unsupported checkpoint action: {other}"),
                        )
                        .await?;
                        return Ok(true);
                    }
                };
                (
                    action,
                    r.conversation_id.as_str(),
                    json!({
                        "turnSeq": r.turn_seq,
                        "authorizedRoots": r.authorized_roots,
                        "expected": r.expected.iter().map(|entry| json!({
                            "key": entry.key,
                            "currentHash": entry.current_hash,
                        })).collect::<Vec<_>>(),
                    }),
                )
            }
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
                let code = match action {
                    "share_resolve" => history_share_resolve_error_code(&error),
                    // The local checkpoint path answered 400; keep WebUI's error handling stable.
                    "checkpoint_list" | "checkpoint_diff" | "checkpoint_rewind" => 400,
                    _ => 502,
                };
                if let (404, Request::HistoryShareResolve(r)) = (code, payload) {
                    // Links shared before the K-brain migration still live in the
                    // legacy store; keep serving them read-only.
                    if let Ok(response) =
                        crate::services::gateway_bridge::handle_history_share_resolve(r.clone())
                            .await
                    {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(Response::HistoryShareResolveResp(response)),
                        })
                        .await?;
                        return Ok(true);
                    }
                }
                self.send_error_response(request_id, code, error).await?;
                return Ok(true);
            }
        };
        let conversation = value.get("conversation").map(summary);
        if matches!(action, "rename" | "pin" | "cwd" | "branch" | "share_set") {
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
            "branch" => Response::HistoryBranchResp(proto::HistoryBranchResponse { conversation }),
            "share_get" => Response::HistoryShareGetResp(proto::HistoryShareGetResponse {
                share: value.get("share").map(share_status),
            }),
            "share_set" => Response::HistoryShareSetResp(proto::HistoryShareSetResponse {
                share: value.get("share").map(share_status),
            }),
            "share_resolve" => {
                Response::HistoryShareResolveResp(proto::HistoryShareResolveResponse {
                    conversation_id: value["conversationId"].as_str().unwrap_or_default().into(),
                    messages_json: value["messagesJson"].as_str().unwrap_or("[]").into(),
                    total_message_count: count(&value["totalMessageCount"]),
                    conversation,
                    redact_tool_content: value["redactToolContent"].as_bool().unwrap_or(false),
                })
            }
            "trajectory" => {
                Response::TrajectoryFetchResp(trajectory_response(conversation_id, &value))
            }
            "checkpoint_list" | "checkpoint_diff" | "checkpoint_rewind" => {
                Response::CheckpointResp(proto::CheckpointResponse {
                    action: action.trim_start_matches("checkpoint_").into(),
                    result_json: serde_json::to_string(&value["result"])
                        .map_err(|error| format!("serialize checkpoint result failed: {error}"))?,
                })
            }
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

    #[test]
    fn trajectory_response_keeps_window_and_section_fields() {
        let window = trajectory_response(
            "desktop-conversation",
            &json!({
                "eventsJson": "[{\"k\":\"run\"}]", "truncated": true,
                "oldestSegmentIndex": 3, "returnedSegmentCount": 2,
                "totalSegmentCount": 5, "hasMoreBefore": true,
                "sections": [], "subagentRunsJson": ""
            }),
        );
        assert_eq!(window.conversation_id, "desktop-conversation");
        assert_eq!(window.events_json, "[{\"k\":\"run\"}]");
        assert!(window.truncated && window.has_more_before);
        assert_eq!(
            (
                window.oldest_segment_index,
                window.returned_segment_count,
                window.total_segment_count
            ),
            (3, 2, 5)
        );

        let sections = trajectory_response(
            "c",
            &json!({"sections": [{"sectionId": "s1", "slot": "system", "content": "héllo"}]}),
        );
        assert_eq!(sections.sections.len(), 1);
        assert_eq!(sections.sections[0].section_id, "s1");
        // K-brain sections carry no byte count; derive the UTF-8 length.
        assert_eq!(sections.sections[0].bytes, 6);
        assert_eq!(sections.events_json, "");
    }

    #[test]
    fn share_status_and_message_ref_round_trip_camel_case() {
        let status = share_status(&json!({
            "conversationId": "desktop-conversation", "enabled": true, "token": "t",
            "createdAt": 10, "updatedAt": 20, "redactToolContent": true
        }));
        assert_eq!(status.conversation_id, "desktop-conversation");
        assert!(status.enabled && status.redact_tool_content);
        assert_eq!((status.created_at, status.updated_at), (10, 20));
        assert_eq!(status.token, "t");

        let reference = message_ref_json(&proto::ChatMessageRef {
            segment_index: 1,
            message_index: 7,
            segment_id: "kbrain:session".into(),
            message_id: "user-1".into(),
            role: "user".into(),
            content_hash: "hash".into(),
        });
        assert_eq!(reference["messageIndex"], 7);
        assert_eq!(reference["segmentId"], "kbrain:session");
        assert_eq!(reference["contentHash"], "hash");
    }
}
