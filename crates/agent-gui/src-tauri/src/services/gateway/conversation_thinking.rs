//! 与前端 conversationThinkingSync.ts 使用相同的逐会话版本顺序。
use serde_json::{Map, Value};

fn revision(value: Option<&Value>) -> Option<(u64, &str)> {
    let value = value?;
    let version = value.get("version")?.as_u64()?;
    let writer = value.get("writerId")?.as_str()?.trim();
    (version > 0 && version <= 9_007_199_254_740_991 && !writer.is_empty())
        .then_some((version, writer))
}

pub(super) fn merge_conversation_thinking(current: &Value, incoming: &Value) -> Value {
    let Some(mut result) = incoming.as_object().cloned() else {
        return current.clone();
    };
    let mut thinking = current
        .get("thinkingByConversation")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut revisions = current
        .get("thinkingByConversationRevisions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let empty = Map::new();
    let incoming_thinking = incoming
        .get("thinkingByConversation")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let incoming_revisions = incoming
        .get("thinkingByConversationRevisions")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    for id in incoming_thinking.keys().chain(
        incoming_revisions
            .iter()
            .filter(|(_, value)| revision(Some(value)).is_some())
            .map(|(id, _)| id),
    ) {
        let before = revision(revisions.get(id));
        let after = revision(incoming_revisions.get(id));
        if before.is_some() && after <= before {
            continue;
        }
        if let Some(value) = incoming_thinking.get(id) {
            thinking.insert(id.clone(), value.clone());
        } else {
            thinking.remove(id);
        }
        if after.is_some() {
            revisions.insert(id.clone(), incoming_revisions[id].clone());
        }
    }
    for (field, map) in [
        ("thinkingByConversation", thinking),
        ("thinkingByConversationRevisions", revisions),
    ] {
        if map.is_empty() {
            result.remove(field);
        } else {
            result.insert(field.to_string(), Value::Object(map));
        }
    }
    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(id: &str, version: u64, writer: &str, level: &str) -> Value {
        json!({
            "thinkingByConversation": {id: {"reasoning": level}},
            "thinkingByConversationRevisions": {id: {"version": version, "writerId": writer}},
        })
    }

    #[test]
    fn independent_conversations_and_stale_snapshots_are_merged() {
        let a = snapshot("a", 1, "desktop", "xhigh");
        let b = snapshot("b", 1, "web", "low");
        let merged = merge_conversation_thinking(&a, &b);
        assert_eq!(merged["thinkingByConversation"]["a"]["reasoning"], "xhigh");
        assert_eq!(merged["thinkingByConversation"]["b"]["reasoning"], "low");
        let newer = snapshot("a", 2, "desktop", "medium");
        let merged = merge_conversation_thinking(&merged, &newer);
        let stale = merge_conversation_thinking(&merged, &a);
        assert_eq!(stale["thinkingByConversation"]["a"]["reasoning"], "medium");
        assert_eq!(stale["thinkingByConversation"]["b"]["reasoning"], "low");
    }

    #[test]
    fn concurrent_same_conversation_converges_in_both_orders() {
        let a = snapshot("a", 1, "desktop", "xhigh");
        let b = snapshot("a", 1, "web", "low");
        assert_eq!(
            merge_conversation_thinking(&a, &b),
            merge_conversation_thinking(&b, &a)
        );
    }

    #[test]
    fn deleted_draft_cannot_be_resurrected_by_legacy_or_stale_snapshot() {
        let old = snapshot("draft", 1, "web", "low");
        let deleted = json!({"thinkingByConversationRevisions": {
            "draft": {"version": 2, "writerId": "web"}
        }});
        let merged = merge_conversation_thinking(&old, &deleted);
        assert!(merged.get("thinkingByConversation").is_none());
        let legacy = json!({"thinkingByConversation": {"draft": {"reasoning": "high"}}});
        assert_eq!(merge_conversation_thinking(&merged, &old), merged);
        assert_eq!(merge_conversation_thinking(&merged, &legacy), merged);
    }
}
