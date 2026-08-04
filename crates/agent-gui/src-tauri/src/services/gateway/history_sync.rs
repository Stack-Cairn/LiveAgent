use uuid::Uuid;

use agent_core::commands::chat_history::ChatHistorySummary;

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
            },
        )),
    })
}
