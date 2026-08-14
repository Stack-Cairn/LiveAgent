use std::sync::Arc;

use serde_json::Value;
use tauri::Emitter;

use crate::commands::chat_history::{self};
use crate::commands::settings::{
    apply_ssh_patch_with_conn, open_db, redact_gateway_settings_sync_payload,
    reset_runtime_ssh_known_host, SSH_PATCH_FIELD,
};
use crate::services::gateway_bridge;
use crate::services::workspace_watch::WatchSource;

use super::*;

pub(super) fn provider_usage_agent_envelope(
    request_id: String,
    response: proto::ProviderUsageResponse,
) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id,
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::ProviderUsageResp(response)),
    }
}

impl GatewayController {
    pub(crate) async fn handle_gateway_envelope(
        self: &Arc<Self>,
        envelope: proto::GatewayEnvelope,
    ) -> Result<(), String> {
        let request_id = envelope.request_id.clone();

        match envelope.payload {
            Some(proto::gateway_envelope::Payload::Ping(ping)) => {
                let pong = proto::AgentEnvelope {
                    request_id: request_id.clone(),
                    timestamp: now_unix_seconds(),
                    payload: Some(proto::agent_envelope::Payload::Pong(proto::PongResponse {
                        timestamp: ping.timestamp,
                    })),
                };
                if is_chat_runtime_wake_request_id(&request_id) {
                    if let Err(error) = self.wake_chat_runtime("gateway_ping") {
                        eprintln!("emit gateway chat runtime wake ping failed: {error}");
                    }
                }
                // Never block the receive loop on outbound saturation, and
                // never let a pong failure tear down the connection. Pongs
                // ride the dedicated control lane so chat.prepare probes are
                // answered even while streamed tokens saturate the data
                // queue; the data queue is only a best-effort fallback while
                // the lanes are being swapped mid-reconnect.
                let pong = match self.current_outbound_control_sender() {
                    Ok(sender) => match sender.try_send(pong) {
                        Ok(()) => return Ok(()),
                        Err(envelope) => envelope,
                    },
                    Err(_) => pong,
                };
                if let Ok(sender) = self.current_outbound_sender() {
                    let _ = sender.try_send(pong);
                }
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::TunnelState(snapshot)) => {
                self.handle_tunnel_state_snapshot(snapshot);
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::TunnelMutation(mutation)) => {
                self.handle_tunnel_mutation_request(request_id, mutation);
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::TunnelFrame(frame)) => {
                self.tunnel_proxy.handle_frame(self, frame)
            }
            Some(proto::gateway_envelope::Payload::WorkspaceWatch(request)) => {
                self.workspace_watch
                    .set_desired(WatchSource::Gateway, request.workdirs);
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::ChatCommand(command)) => {
                self.handle_chat_command(request_id, command).await
            }
            Some(proto::gateway_envelope::Payload::ChatQueue(request)) => {
                self.handle_chat_queue_request(request_id, request).await
            }
            Some(proto::gateway_envelope::Payload::ChatIngressAck(ack)) => {
                self.handle_chat_ingress_ack(request_id, ack).await
            }
            Some(proto::gateway_envelope::Payload::CronManage(request)) => {
                // Successful apply actions broadcast their own snapshot via the
                // AutomationStore notifier; no extra refresh is needed here.
                match gateway_bridge::handle_cron_manage(
                    Arc::clone(&self.automation_store),
                    request,
                )
                .await
                {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::CronManageResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::HistoryList(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_list(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(proto::agent_envelope::Payload::HistoryListResp(
                                        response,
                                    )),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.list handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryWorkdirs(_request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_workdirs().await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryWorkdirsResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.workdirs handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryGet(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_get(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(proto::agent_envelope::Payload::HistoryGetResp(
                                        response,
                                    )),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.get handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryPrefix(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_prefix(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryPrefixResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.prefix handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryRename(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_rename(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryRenameResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.rename handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryBranch(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_branch(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryBranchResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.branch handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryPin(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_pin(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(proto::agent_envelope::Payload::HistoryPinResp(
                                        response,
                                    )),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.pin handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistorySetCwd(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_set_cwd(request).await {
                        Ok(response) => {
                            if let Some(conversation) = response.conversation.as_ref() {
                                controller
                                    .publish_history_sync(build_history_sync_upsert_from_proto(
                                        conversation,
                                    ))
                                    .await;
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistorySetCwdResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.set_cwd handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryShareGet(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_share_get(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryShareGetResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.share.get handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryShareSet(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_share_set(request).await {
                        Ok(response) => {
                            if let Some(share) = response.share.as_ref() {
                                match chat_history::chat_history_get_summary_inner(
                                    share.conversation_id.clone(),
                                )
                                .await
                                {
                                    Ok(summary) => {
                                        controller
                                            .publish_history_sync(build_history_sync_upsert(
                                                &summary,
                                            ))
                                            .await;
                                    }
                                    Err(error) => {
                                        eprintln!(
                                            "publish history share sync event failed: {error}"
                                        )
                                    }
                                }
                            }
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryShareSetResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.share.set handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryShareResolve(request)) => {
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_share_resolve(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryShareResolveResp(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            let code = history_share_resolve_error_code(&error);
                            controller
                                .send_error_response(request_id.clone(), code, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.share.resolve handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::HistoryDelete(request)) => {
                let deleted_conversation_id = request.conversation_id.trim().to_string();
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match gateway_bridge::handle_history_delete(request).await {
                        Ok(response) => {
                            controller
                                .publish_history_sync(build_history_sync_delete(
                                    deleted_conversation_id,
                                ))
                                .await;
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::HistoryDeleteResp(response),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(err) = result {
                        eprintln!("gateway history.delete handler failed: {err}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::ProviderList(_request)) => {
                match gateway_bridge::handle_provider_list().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::ProviderListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::ProviderUsage(request)) => {
                let sender = self.current_outbound_sender()?;
                let provider_usage_service = Arc::clone(&self.provider_usage_service);
                tauri::async_runtime::spawn(async move {
                    let envelope = match gateway_bridge::handle_provider_usage(
                        provider_usage_service,
                        request,
                    )
                    .await
                    {
                        Ok(response) => provider_usage_agent_envelope(request_id, response),
                        Err(error) => build_error_response_envelope(request_id, 500, error),
                    };
                    if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                        eprintln!("gateway provider usage handler failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::ProviderModels(request)) => {
                match gateway_bridge::handle_provider_models(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::ProviderModelsResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 502, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SettingsGet(_request)) => {
                match self.current_settings_snapshot().await {
                    Ok(snapshot) => {
                        let settings_json = match serialize_settings_sync_payload(&snapshot) {
                            Ok(settings_json) => settings_json,
                            Err(error) => {
                                return self.send_error_response(request_id, 500, error).await;
                            }
                        };
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SettingsGetResp(
                                proto::SettingsGetResponse { settings_json },
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SettingsUpdate(request)) => {
                match parse_settings_sync_payload(&request.settings_json) {
                    Ok(snapshot) => {
                        if snapshot.get(SSH_PATCH_FIELD).is_some() {
                            let patch_payload = snapshot.clone();
                            let apply_response =
                                match tauri::async_runtime::spawn_blocking(move || {
                                    let mut conn = open_db()?;
                                    apply_ssh_patch_with_conn(&mut conn, patch_payload)
                                })
                                .await
                                .map_err(|e| format!("settings ssh patch join failed: {e}"))
                                {
                                    Ok(Ok(response)) => response,
                                    Ok(Err(error)) | Err(error) => {
                                        return self
                                            .send_error_response(request_id, 500, error)
                                            .await;
                                    }
                                };
                            if let Some(conflict) = apply_response.conflict {
                                return self
                                    .send_agent_envelope(proto::AgentEnvelope {
                                        request_id,
                                        timestamp: now_unix_seconds(),
                                        payload: Some(
                                            proto::agent_envelope::Payload::SettingsUpdateResp(
                                                proto::SettingsUpdateResponse {
                                                    accepted: false,
                                                    message: conflict,
                                                },
                                            ),
                                        ),
                                    })
                                    .await;
                            }

                            let fresh_snapshot = match self.current_settings_snapshot().await {
                                Ok(snapshot) => snapshot,
                                Err(error) => {
                                    return self.send_error_response(request_id, 500, error).await;
                                }
                            };
                            let merged_ssh =
                                fresh_snapshot.get("ssh").cloned().unwrap_or(Value::Null);
                            let event_payload =
                                match build_local_settings_update_event_payload_with_ssh(
                                    snapshot.clone(),
                                    merged_ssh,
                                ) {
                                    Ok(payload) => payload,
                                    Err(error) => {
                                        return self
                                            .send_error_response(request_id, 400, error)
                                            .await;
                                    }
                                };
                            if let Err(error) = self
                                .app_handle
                                .emit(GATEWAY_SETTINGS_SYNC_EVENT, event_payload)
                            {
                                return self
                                    .send_error_response(
                                        request_id,
                                        500,
                                        format!("emit gateway settings sync failed: {error}"),
                                    )
                                    .await;
                            }
                            if let Err(error) = self.publish_settings_sync(fresh_snapshot).await {
                                eprintln!("publish gateway ssh settings sync failed: {error}");
                            }
                            return self
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id,
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::SettingsUpdateResp(
                                            proto::SettingsUpdateResponse {
                                                accepted: true,
                                                message: "ok".to_string(),
                                            },
                                        ),
                                    ),
                                })
                                .await;
                        }

                        let event_payload =
                            match build_local_settings_update_event_payload(snapshot.clone()) {
                                Ok(payload) => payload,
                                Err(error) => {
                                    return self.send_error_response(request_id, 400, error).await;
                                }
                            };
                        let public_update = match redact_gateway_settings_sync_payload(snapshot) {
                            Ok(payload) => payload,
                            Err(error) => {
                                return self.send_error_response(request_id, 400, error).await;
                            }
                        };
                        // The update is a partial payload (only changed fields, e.g.
                        // {"theme":"dark"}). Overlay it onto the current full snapshot;
                        // storing it as-is would drop every other cached field and let
                        // rebuilt snapshots revert UI-only settings like theme.
                        let current_snapshot = match self.current_settings_snapshot().await {
                            Ok(snapshot) => snapshot,
                            Err(error) => {
                                return self.send_error_response(request_id, 500, error).await;
                            }
                        };
                        let removed_project_ids = match removed_workspace_project_ids(
                            &current_snapshot,
                            &public_update,
                        ) {
                            Ok(project_ids) => project_ids,
                            Err(error) => {
                                return self.send_error_response(request_id, 400, error).await;
                            }
                        };
                        let merged_snapshot = match merge_settings_update_into_snapshot(
                            current_snapshot,
                            public_update,
                        ) {
                            Ok(payload) => payload,
                            Err(error) => {
                                return self.send_error_response(request_id, 400, error).await;
                            }
                        };
                        if let Err(error) =
                            crate::commands::root_grants::revoke_workspace_root_grants_for_projects(
                                removed_project_ids,
                            )
                            .await
                        {
                            return self.send_error_response(request_id, 500, error).await;
                        }
                        if let Err(error) = self.store_settings_snapshot(merged_snapshot) {
                            return self.send_error_response(request_id, 500, error).await;
                        }
                        match self
                            .app_handle
                            .emit(GATEWAY_SETTINGS_SYNC_EVENT, event_payload)
                        {
                            Ok(()) => {
                                self.send_agent_envelope(proto::AgentEnvelope {
                                    request_id,
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::SettingsUpdateResp(
                                            proto::SettingsUpdateResponse {
                                                accepted: true,
                                                message: "ok".to_string(),
                                            },
                                        ),
                                    ),
                                })
                                .await
                            }
                            Err(error) => {
                                self.send_error_response(
                                    request_id,
                                    500,
                                    format!("emit gateway settings sync failed: {error}"),
                                )
                                .await
                            }
                        }
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SettingsResetSshKnownHost(request)) => {
                let host = request.host.trim().to_string();
                let port = match u16::try_from(request.port) {
                    Ok(port) if port > 0 => port,
                    _ => {
                        return self
                            .send_error_response(
                                request_id,
                                400,
                                "SSH port must be between 1 and 65535".to_string(),
                            )
                            .await;
                    }
                };
                match reset_runtime_ssh_known_host(&host, port) {
                    Ok(deleted) => {
                        let deleted = u32::try_from(deleted).unwrap_or(u32::MAX);
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::SettingsResetSshKnownHostResp(
                                    proto::SettingsResetSshKnownHostResponse { deleted },
                                ),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsRoots(_request)) => {
                match gateway_bridge::handle_fs_roots().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsRootsResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::WorkspaceRootGrants(request)) => {
                match gateway_bridge::handle_workspace_root_grants(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::WorkspaceRootGrantsResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 400, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsListDirs(request)) => {
                match gateway_bridge::handle_fs_list_dirs(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsListDirsResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsCreateProjectFolder(request)) => {
                match gateway_bridge::handle_fs_create_project_folder(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::FsCreateProjectFolderResp(response),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsList(request)) => {
                match gateway_bridge::handle_fs_list(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsListResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsReadEditableText(request)) => {
                match gateway_bridge::handle_fs_read_editable_text(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsReadEditableTextResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsReadWorkspaceImage(request)) => {
                match gateway_bridge::handle_fs_read_workspace_image(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(
                                proto::agent_envelope::Payload::FsReadWorkspaceImageResp(response),
                            ),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::ChatFileOpen(request)) => {
                let sender = self.current_outbound_sender()?;
                tauri::async_runtime::spawn(async move {
                    let envelope = match gateway_bridge::handle_chat_file_open(request).await {
                        Ok(response) => proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::ChatFileOpenResp(
                                response,
                            )),
                        },
                        Err(error) => build_error_response_envelope(request_id, 500, error),
                    };
                    if let Err(error) = send_agent_envelope_to(sender, envelope).await {
                        eprintln!("send gateway chat file open response failed: {error}");
                    }
                });
                Ok(())
            }
            Some(proto::gateway_envelope::Payload::FsWriteText(request)) => {
                match gateway_bridge::handle_fs_write_text(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsWriteTextResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsCreateDir(request)) => {
                match gateway_bridge::handle_fs_create_dir(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsCreateDirResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsRename(request)) => {
                match gateway_bridge::handle_fs_rename(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsRenameResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FsDelete(request)) => {
                match gateway_bridge::handle_fs_delete(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FsDeleteResp(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillFilesList(_request)) => {
                match gateway_bridge::handle_skill_files_list().await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillFilesListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::FileMentionList(request)) => {
                match gateway_bridge::handle_file_mention_list(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::FileMentionListResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::UploadReadableFiles(request)) => {
                match gateway_bridge::handle_upload_readable_files(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::UploadReadableFilesResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::UploadedImagePreview(request)) => {
                self.spawn_uploaded_image_preview_response(request_id, request)
            }
            Some(proto::gateway_envelope::Payload::MemoryManage(request)) => {
                match gateway_bridge::handle_memory_manage(Arc::clone(&self.memory_store), request)
                    .await
                {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::MemoryManageResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillMetadataRead(request)) => {
                match gateway_bridge::handle_skill_metadata_read(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillMetadataReadResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillTextRead(request)) => {
                match gateway_bridge::handle_skill_text_read(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillTextReadResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SkillManage(request)) => {
                match gateway_bridge::handle_skill_manage(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SkillManageResp(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::GitRequest(request)) => {
                match gateway_bridge::handle_git_request(
                    request,
                    Arc::clone(&self.git_clone_task_registry),
                )
                .await
                {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::GitResponse(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::TerminalRequest(request)) => {
                match self.handle_terminal_request(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::TerminalResponse(
                                response,
                            )),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::SftpRequest(request)) => {
                match self.handle_sftp_request(request).await {
                    Ok(response) => {
                        self.send_agent_envelope(proto::AgentEnvelope {
                            request_id,
                            timestamp: now_unix_seconds(),
                            payload: Some(proto::agent_envelope::Payload::SftpResponse(response)),
                        })
                        .await
                    }
                    Err(error) => self.send_error_response(request_id, 500, error).await,
                }
            }
            Some(proto::gateway_envelope::Payload::ManagedProcessRequest(request)) => {
                // A stop carries a bounded TERM grace; run it off the inbound
                // stream loop so tunnel frames and pings keep flowing.
                let controller = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let result = match controller.handle_managed_process_request(request).await {
                        Ok(response) => {
                            controller
                                .send_agent_envelope(proto::AgentEnvelope {
                                    request_id: request_id.clone(),
                                    timestamp: now_unix_seconds(),
                                    payload: Some(
                                        proto::agent_envelope::Payload::ManagedProcessResponse(
                                            response,
                                        ),
                                    ),
                                })
                                .await
                        }
                        Err(error) => {
                            controller
                                .send_error_response(request_id.clone(), 500, error)
                                .await
                        }
                    };
                    if let Err(error) = result {
                        eprintln!("send gateway managed process response failed: {error}");
                    }
                });
                Ok(())
            }
            None => Ok(()),
        }
    }
}
