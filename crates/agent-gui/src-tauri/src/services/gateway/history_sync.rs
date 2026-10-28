use uuid::Uuid;
use prost::Message;
use std::collections::HashSet;

use crate::commands::chat_history::ChatHistorySummary;

use super::*;

pub fn build_history_sync_upsert(summary: &ChatHistorySummary) -> GatewayHistorySyncEvent {
    GatewayHistorySyncEvent {
        kind: "upsert".to_string(),
        conversation_id: summary.id.clone(),
        conversation: Some(GatewayHistorySyncConversation {
            id: summary.id.clone(),
            title: summary.title.clone(),
            provider_id: Some(summary.provider_id.clone()),
            model: Some(summary.model.clone()),
            session_id: summary.session_id.clone(),
            cwd: summary.cwd.clone(),
            selected_model_json: summary.selected_model_json.clone(),
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            message_count: summary.message_count,
            is_pinned: summary.is_pinned,
            pinned_at: summary.pinned_at,
            is_shared: summary.is_shared,
        }),
    }
}

pub fn build_history_sync_delete(conversation_id: impl Into<String>) -> GatewayHistorySyncEvent {
    let conversation_id = conversation_id.into();
    GatewayHistorySyncEvent {
        kind: "delete".to_string(),
        conversation_id,
        conversation: None,
    }
}

pub(crate) fn build_history_sync_upsert_from_proto(
    summary: &proto::ConversationSummary,
) -> GatewayHistorySyncEvent {
    GatewayHistorySyncEvent {
        kind: "upsert".to_string(),
        conversation_id: summary.id.clone(),
        conversation: Some(GatewayHistorySyncConversation {
            id: summary.id.clone(),
            title: summary.title.clone(),
            provider_id: (!summary.provider_id.trim().is_empty())
                .then(|| summary.provider_id.clone()),
            model: (!summary.model.trim().is_empty()).then(|| summary.model.clone()),
            session_id: (!summary.session_id.trim().is_empty()).then(|| summary.session_id.clone()),
            cwd: (!summary.cwd.trim().is_empty()).then(|| summary.cwd.clone()),
            selected_model_json: (!summary.selected_model_json.trim().is_empty())
                .then(|| summary.selected_model_json.clone()),
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            message_count: i64::from(summary.message_count),
            is_pinned: summary.is_pinned,
            pinned_at: (summary.pinned_at > 0).then_some(summary.pinned_at),
            is_shared: summary.is_shared,
        }),
    }
}

pub(crate) fn history_share_resolve_error_code(message: &str) -> i32 {
    let normalized = message.trim();
    if normalized.is_empty() {
        return 500;
    }
    if normalized.contains("分享 token 不能为空") {
        return 400;
    }
    if normalized.contains("分享链接不存在或已关闭") || normalized.contains("未找到对应的历史对话")
    {
        return 404;
    }
    500
}

pub(crate) fn build_history_sync_envelope(
    event: GatewayHistorySyncEvent,
) -> Result<proto::AgentEnvelope, String> {
    let conversation = event
        .conversation
        .map(|conversation| proto::ConversationSummary {
            id: conversation.id,
            title: conversation.title,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
            message_count: i32::try_from(conversation.message_count).unwrap_or(i32::MAX),
            provider_id: conversation.provider_id.unwrap_or_default(),
            model: conversation.model.unwrap_or_default(),
            session_id: conversation.session_id.unwrap_or_default(),
            cwd: conversation.cwd.unwrap_or_default(),
            selected_model_json: conversation.selected_model_json.unwrap_or_default(),
            is_pinned: conversation.is_pinned,
            pinned_at: conversation.pinned_at.unwrap_or_default(),
            is_shared: conversation.is_shared,
        });

    Ok(proto::AgentEnvelope {
        request_id: format!("history-sync-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(proto::agent_envelope::Payload::HistorySync(
            proto::HistorySyncEvent {
                kind: event.kind,
                conversation,
                conversation_id: event.conversation_id,
                source_id: String::new(),
                generation: String::new(),
                delivery_seq: 0,
            },
        )),
    })
}

fn history_sync_conversation_proto(
    conversation: GatewayHistorySyncConversation,
) -> proto::ConversationSummary {
    proto::ConversationSummary {
        id: conversation.id,
        title: conversation.title,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        message_count: i32::try_from(conversation.message_count).unwrap_or(i32::MAX),
        provider_id: conversation.provider_id.unwrap_or_default(),
        model: conversation.model.unwrap_or_default(),
        session_id: conversation.session_id.unwrap_or_default(),
        cwd: conversation.cwd.unwrap_or_default(),
        is_pinned: conversation.is_pinned,
        pinned_at: conversation.pinned_at.unwrap_or_default(),
        is_shared: conversation.is_shared,
        selected_model_json: conversation.selected_model_json.unwrap_or_default(),
    }
}

pub(crate) fn build_history_sync_v2_envelope(
    input: GatewayHistorySyncPublishInput,
) -> Result<proto::AgentEnvelope, String> {
    let kind = input.kind.trim();
    let source_id = input.source_id.trim().to_string();
    let generation = input.generation.trim().to_string();
    if source_id.is_empty() || generation.is_empty() {
        return Err("history sync sourceId and generation are required".to_string());
    }
    if source_id.len() > 512 || generation.len() > 128 {
        return Err("history sync identity exceeds capacity".to_string());
    }
    if input.delivery_seq > 9_007_199_254_740_991 {
        return Err("history sync deliverySeq exceeds the JavaScript safe range".to_string());
    }

    let payload = match kind {
        "event" => {
            let event = input
                .event
                .ok_or_else(|| "history sync event payload is required".to_string())?;
            let event_kind = event.kind.trim().to_string();
            if event_kind != "upsert" && event_kind != "delete" {
                return Err("history sync event kind must be upsert or delete".to_string());
            }
            let conversation_id = event.conversation_id.trim().to_string();
            if conversation_id.is_empty() {
                return Err("history sync conversationId is required".to_string());
            }
            if event_kind == "upsert" && event.conversation.is_none() {
                return Err("history sync upsert conversation is required".to_string());
            }
            if let Some(conversation) = event.conversation.as_ref() {
                if conversation.id.trim() != conversation_id {
                    return Err("history sync conversation identity mismatch".to_string());
                }
            }
            let conversation = event.conversation.map(history_sync_conversation_proto);
            if conversation.as_ref().is_some_and(|value| value.encoded_len() > 8 << 20) {
                return Err("history sync conversation exceeds the browser frame budget".to_string());
            }
            proto::agent_envelope::Payload::HistorySync(proto::HistorySyncEvent {
                kind: event_kind,
                conversation,
                conversation_id,
                source_id,
                generation,
                delivery_seq: input.delivery_seq,
            })
        }
        "status" => proto::agent_envelope::Payload::HistorySyncStatus(proto::HistorySyncStatus {
            source_id,
            generation,
            latest_delivery_seq: input.delivery_seq,
            available: input.available,
            needs_resync: !input.available,
            resync_token: String::new(),
        }),
        "snapshot" => {
            if input.conversations.len() > 100_000 || input.workdirs.len() > 100_000 {
                return Err("history sync snapshot exceeds item capacity".to_string());
            }
            let mut ids = HashSet::with_capacity(input.conversations.len());
            for conversation in &input.conversations {
                let id = conversation.id.trim();
                if id.is_empty() || !ids.insert(id) {
                    return Err("history sync snapshot contains an invalid or duplicate id".to_string());
                }
            }
            if input
                .workdirs
                .iter()
                .any(|item| item.path.trim().is_empty() || item.conversation_count < 0)
            {
                return Err("history sync snapshot contains an invalid workdir".to_string());
            }
            let total_count = input.conversations.len() as u32;
            let conversations: Vec<proto::ConversationSummary> = input
                .conversations
                .into_iter()
                .map(history_sync_conversation_proto)
                .collect();
            if conversations
                .iter()
                .any(|value: &proto::ConversationSummary| value.encoded_len() > 8 << 20)
            {
                return Err("history sync conversation exceeds the browser frame budget".to_string());
            }
            let workdirs = input
                .workdirs
                .into_iter()
                .map(|item| proto::HistoryWorkdirSummary {
                    path: item.path,
                    conversation_count: item.conversation_count,
                    updated_at: item.updated_at,
                })
                .collect();
            proto::agent_envelope::Payload::HistorySyncSnapshot(proto::HistorySyncSnapshot {
                source_id,
                generation,
                cut_delivery_seq: input.delivery_seq,
                resync_token: String::new(),
                conversations,
                workdirs,
                offset: 0,
                next_offset: 0,
                total_count,
            })
        }
        _ => return Err("history sync kind must be status, snapshot, or event".to_string()),
    };

    let envelope = proto::AgentEnvelope {
        request_id: format!("history-sync-v2-{}", Uuid::new_v4()),
        timestamp: now_unix_seconds(),
        payload: Some(payload),
    };
    if envelope.encoded_len() > 64 << 20 {
        return Err("history sync payload exceeds the transport budget".to_string());
    }
    Ok(envelope)
}

#[cfg(test)]
mod history_sync_v2_tests {
    use super::*;

    fn base(kind: &str) -> GatewayHistorySyncPublishInput {
        GatewayHistorySyncPublishInput {
            kind: kind.to_string(),
            source_id: "source".to_string(),
            generation: "generation".to_string(),
            delivery_seq: 1,
            available: true,
            conversations: vec![],
            workdirs: vec![],
            event: None,
        }
    }

    fn conversation(id: &str) -> GatewayHistorySyncConversation {
        GatewayHistorySyncConversation {
            id: id.to_string(), title: "Title".to_string(), provider_id: None, model: None,
            session_id: None, cwd: None, selected_model_json: None, created_at: 1, updated_at: 1,
            message_count: 1, is_pinned: false, pinned_at: None, is_shared: false,
        }
    }

    #[test]
    fn v2_history_sync_rejects_unsafe_sequence_and_identity_mismatch() {
        let mut unsafe_seq = base("status");
        unsafe_seq.delivery_seq = 9_007_199_254_740_992;
        assert!(build_history_sync_v2_envelope(unsafe_seq).is_err());

        let mut mismatch = base("event");
        mismatch.event = Some(GatewayHistorySyncEventInput {
            kind: "upsert".to_string(), conversation_id: "expected".to_string(),
            conversation: Some(conversation("other")),
        });
        assert!(build_history_sync_v2_envelope(mismatch).is_err());
    }

    #[test]
    fn v2_history_sync_rejects_duplicate_snapshot_and_unbounded_identity() {
        let mut duplicate = base("snapshot");
        duplicate.conversations = vec![conversation("same"), conversation("same")];
        assert!(build_history_sync_v2_envelope(duplicate).is_err());

        let mut identity = base("status");
        identity.source_id = "x".repeat(513);
        assert!(build_history_sync_v2_envelope(identity).is_err());
    }
}
