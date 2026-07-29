// 稳定消息引用（HistoryMessageRef）的纯 JSON 工具：与前端 chatHistory.ts 的
// contentHash/stableId 算法逐字节对齐，供 history.prefix 与分支会话共用。

pub(crate) fn read_json_trimmed_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn flatten_user_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                block.as_object().and_then(|object| {
                    match object.get("type").and_then(Value::as_str) {
                        Some("text") => object.get("text").and_then(Value::as_str),
                        _ => None,
                    }
                })
            })
            .collect::<String>(),
        _ => String::new(),
    }
}

pub(crate) fn append_hash_part(parts: &mut Vec<String>, value: impl AsRef<str>) {
    let value = value.as_ref();
    parts.push(format!("{}:{value}", value.len()));
}

pub(crate) fn fnv1a32(input: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for byte in input.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("fnv1a32:{hash:08x}")
}

pub(crate) fn history_message_content_hash(message: &Value) -> String {
    let object = message.as_object();
    let role = object
        .and_then(|object| object.get("role"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut parts = vec!["liveagent-history-ref-v1".to_string()];
    append_hash_part(&mut parts, role);

    if role == "user" {
        let display_text = object
            .and_then(|object| object.get("liveAgentDisplayContent"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                flatten_user_content(object.and_then(|object| object.get("content")))
            });
        append_hash_part(&mut parts, display_text);

        let attachments = object
            .and_then(|object| object.get("liveAgentAttachments"))
            .and_then(Value::as_array);
        let valid_attachments = attachments
            .map(|attachments| {
                attachments
                    .iter()
                    .filter_map(Value::as_object)
                    .filter(|attachment| {
                        attachment
                            .get("relativePath")
                            .and_then(Value::as_str)
                            .is_some()
                            && attachment.get("fileName").and_then(Value::as_str).is_some()
                            && attachment.get("kind").and_then(Value::as_str).is_some()
                            && attachment
                                .get("sizeBytes")
                                .and_then(Value::as_f64)
                                .is_some()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        append_hash_part(&mut parts, valid_attachments.len().to_string());
        for attachment_object in valid_attachments {
            append_hash_part(
                &mut parts,
                attachment_object
                    .get("relativePath")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            append_hash_part(
                &mut parts,
                attachment_object
                    .get("fileName")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            append_hash_part(
                &mut parts,
                attachment_object
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            append_hash_part(
                &mut parts,
                attachment_object
                    .get("sizeBytes")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "0".to_string()),
            );
        }
    } else {
        append_hash_part(
            &mut parts,
            object
                .and_then(|object| object.get("content"))
                .map(Value::to_string)
                .unwrap_or_else(|| "null".to_string()),
        );
    }

    fnv1a32(&parts.join("|"))
}

pub(crate) fn history_message_id_for_ref(message: &Value) -> Option<String> {
    let object = message.as_object()?;
    read_json_trimmed_string(object, "id").or_else(|| {
        if object.get("role").and_then(Value::as_str) == Some("assistant") {
            read_json_trimmed_string(object, "responseId")
        } else {
            None
        }
    })
}

pub(crate) fn validate_user_history_message_ref(
    message_ref: &ChatHistoryMessageRef,
) -> Result<(), String> {
    if message_ref.segment_index < 0 || message_ref.message_index < 0 {
        return Err("base_message_ref indexes must be non-negative".to_string());
    }
    if message_ref.segment_id.trim().is_empty()
        || message_ref.message_id.trim().is_empty()
        || message_ref.role.trim().is_empty()
        || message_ref.content_hash.trim().is_empty()
    {
        return Err(
            "base_message_ref requires segment_id, message_id, role, and content_hash".to_string(),
        );
    }
    if message_ref.role.trim() != "user" {
        return Err("base_message_ref role must be user".to_string());
    }
    Ok(())
}

fn history_message_timestamp_for_ref(message: &Value) -> i64 {
    // stable-id 兜底必须确定性（前端 buildHistoryMessageRef 不会为缺 id 的
    // 消息发 ref，server 端合成后经 liveAgentHistoryRef 回显），因此缺失
    // 时间戳固定取 0，不取当前时间。
    read_message_timestamp_with_fallback(message, 0)
}

pub(crate) fn history_message_stable_id(
    message: &Value,
    segment_index: i64,
    message_index: usize,
) -> String {
    history_message_id_for_ref(message).unwrap_or_else(|| {
        format!(
            "segment-{segment_index}-message-{message_index}-{}",
            history_message_timestamp_for_ref(message)
        )
    })
}

pub(crate) fn build_history_message_ref_value(
    segment: &ChatHistorySegmentRecord,
    message_index: usize,
    message: &Value,
) -> Option<Value> {
    let object = message.as_object()?;
    let segment_id = segment.segment_id.trim();
    let role = object.get("role").and_then(Value::as_str)?.trim();
    if segment_id.is_empty() || role.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "segmentIndex": segment.segment_index,
        "messageIndex": message_index,
        "segmentId": segment_id,
        "messageId": history_message_stable_id(message, segment.segment_index, message_index),
        "role": role,
        "contentHash": history_message_content_hash(message),
    }))
}

pub(crate) fn message_matches_history_ref(
    segment: &ChatHistorySegmentRecord,
    message: &Value,
    message_index: usize,
    message_ref: &ChatHistoryMessageRef,
) -> bool {
    let Some(object) = message.as_object() else {
        return false;
    };
    segment.segment_index == message_ref.segment_index
        && segment.segment_id.trim() == message_ref.segment_id.trim()
        && history_message_stable_id(message, segment.segment_index, message_index)
            == message_ref.message_id.trim()
        && object
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
            == message_ref.role.trim()
        && history_message_content_hash(message) == message_ref.content_hash.trim()
}

#[derive(Debug, Clone)]
pub(crate) struct HistorySegmentMessageWindow {
    pub segment_index: i64,
    pub segment_id: String,
    pub summary: Option<Value>,
    pub messages: Vec<Value>,
    pub start_message_index: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct HistoryMessageWindow {
    pub segments: Vec<HistorySegmentMessageWindow>,
    pub returned_message_count: i64,
    pub oldest_offset: i64,
    pub end_offset: i64,
}

const MAX_HISTORY_WINDOW_BOUNDARY_OVERSHOOT: usize = 64;

fn parse_history_window_segment_messages(
    segment: &ChatHistorySegmentRecord,
) -> Result<Vec<Value>, String> {
    let parsed = serde_json::from_str::<Value>(&segment.messages_json)
        .map_err(|e| format!("parse history segment {} failed: {e}", segment.segment_id))?;
    let messages = parsed
        .as_array()
        .cloned()
        .ok_or_else(|| format!("history segment {} is not an array", segment.segment_id))?;
    if i64::try_from(messages.len()).unwrap_or(i64::MAX) != segment.message_count.max(0) {
        return Err(format!(
            "history segment {} messageCount does not match messagesJson",
            segment.segment_id
        ));
    }
    Ok(messages)
}

fn history_window_message_role(message: &Value) -> Option<&str> {
    message
        .as_object()
        .and_then(|object| object.get("role"))
        .and_then(Value::as_str)
        .map(str::trim)
}

pub(crate) fn build_history_message_window(
    segments: &[ChatHistorySegmentRecord],
    max_messages: i64,
    before_offset: Option<i64>,
    align_to_render_boundary: bool,
) -> Result<HistoryMessageWindow, String> {
    let total_message_count = segments.iter().fold(0_i64, |total, segment| {
        total.saturating_add(segment.message_count.max(0))
    });
    let end_offset = before_offset
        .unwrap_or(total_message_count)
        .clamp(0, total_message_count);
    let strict_oldest_offset = if max_messages > 0 {
        end_offset.saturating_sub(max_messages).max(0)
    } else {
        0
    };
    let mut oldest_offset = strict_oldest_offset;
    let mut parsed_messages_by_position: HashMap<usize, Vec<Value>> = HashMap::new();
    if align_to_render_boundary && strict_oldest_offset < end_offset {
        let mut segment_start_offset = 0_i64;
        for (segment_position, segment) in segments.iter().enumerate() {
            let segment_end_offset =
                segment_start_offset.saturating_add(segment.message_count.max(0));
            if strict_oldest_offset == segment_start_offset {
                break;
            }
            if strict_oldest_offset > segment_start_offset
                && strict_oldest_offset < segment_end_offset
            {
                let messages = parse_history_window_segment_messages(segment)?;
                let local_start = usize::try_from(strict_oldest_offset - segment_start_offset)
                    .map_err(|_| "history window alignment offset overflow".to_string())?;
                let bounded_start =
                    local_start.saturating_sub(MAX_HISTORY_WINDOW_BOUNDARY_OVERSHOOT);
                let candidates = &messages[bounded_start..=local_start];
                let aligned_local_start = candidates
                    .iter()
                    .rposition(|message| history_window_message_role(message) == Some("user"))
                    .or_else(|| {
                        candidates.iter().rposition(|message| {
                            history_window_message_role(message) == Some("assistant")
                        })
                    })
                    .map(|offset| bounded_start + offset)
                    .unwrap_or(local_start);
                oldest_offset = segment_start_offset
                    .saturating_add(i64::try_from(aligned_local_start).unwrap_or(i64::MAX));
                parsed_messages_by_position.insert(segment_position, messages);
                break;
            }
            segment_start_offset = segment_end_offset;
        }
    }
    let mut window_segments = Vec::new();
    let mut returned_message_count = 0_i64;
    let mut segment_start_offset = 0_i64;

    for (segment_position, segment) in segments.iter().enumerate() {
        let segment_message_count = segment.message_count.max(0);
        let segment_end_offset = segment_start_offset.saturating_add(segment_message_count);
        let overlap_start = oldest_offset.max(segment_start_offset);
        let overlap_end = end_offset.min(segment_end_offset);
        if overlap_start >= overlap_end {
            segment_start_offset = segment_end_offset;
            continue;
        }

        if let std::collections::hash_map::Entry::Vacant(entry) =
            parsed_messages_by_position.entry(segment_position)
        {
            entry.insert(parse_history_window_segment_messages(segment)?);
        }
        let source_messages = parsed_messages_by_position
            .get(&segment_position)
            .ok_or_else(|| "parsed history window segment is missing".to_string())?;
        let summary = match segment.summary_json.as_deref().map(str::trim) {
            Some(trimmed) if !trimmed.is_empty() => match serde_json::from_str::<Value>(trimmed) {
                Ok(summary) => Some(summary),
                Err(error) => {
                    eprintln!(
                        "skip invalid history segment summary {}: {error}",
                        segment.segment_id
                    );
                    None
                }
            },
            _ => None,
        };
        let start_message_index = usize::try_from(overlap_start - segment_start_offset)
            .map_err(|_| "history window start offset overflow".to_string())?;
        let end_message_index = usize::try_from(overlap_end - segment_start_offset)
            .map_err(|_| "history window end offset overflow".to_string())?;
        let mut messages = Vec::with_capacity(end_message_index - start_message_index);
        for (message_index, message) in source_messages
            .iter()
            .enumerate()
            .take(end_message_index)
            .skip(start_message_index)
        {
            let mut cloned = message.clone();
            if let Some(object) = cloned.as_object_mut() {
                if let Some(history_ref) =
                    build_history_message_ref_value(segment, message_index, message)
                {
                    object.insert("liveAgentHistoryRef".to_string(), history_ref);
                }
            }
            messages.push(cloned);
        }
        returned_message_count = returned_message_count
            .saturating_add(i64::try_from(messages.len()).unwrap_or(i64::MAX));
        window_segments.push(HistorySegmentMessageWindow {
            segment_index: segment.segment_index,
            segment_id: segment.segment_id.clone(),
            summary,
            messages,
            start_message_index: i64::try_from(start_message_index).unwrap_or(i64::MAX),
            created_at: segment.created_at,
            updated_at: segment.updated_at,
        });
        segment_start_offset = segment_end_offset;
    }

    Ok(HistoryMessageWindow {
        segments: window_segments,
        returned_message_count,
        oldest_offset,
        end_offset,
    })
}

pub(crate) fn serialize_history_segment_windows(
    window: &HistoryMessageWindow,
) -> Result<Vec<ChatHistorySegmentWindowRecord>, String> {
    window
        .segments
        .iter()
        .map(|segment| {
            Ok(ChatHistorySegmentWindowRecord {
                segment_index: segment.segment_index,
                segment_id: segment.segment_id.clone(),
                summary_json: segment
                    .summary
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|e| format!("serialize history segment summary failed: {e}"))?,
                messages_json: serde_json::to_string(&segment.messages)
                    .map_err(|e| format!("serialize history segment window failed: {e}"))?,
                start_message_index: segment.start_message_index,
                message_count: i64::try_from(segment.messages.len()).unwrap_or(i64::MAX),
                created_at: segment.created_at,
                updated_at: segment.updated_at,
            })
        })
        .collect()
}

pub(crate) fn flatten_history_message_window(
    window: &HistoryMessageWindow,
) -> Result<String, String> {
    let mut merged = Vec::new();
    for segment in &window.segments {
        if let Some(summary) = &segment.summary {
            merged.push(summary.clone());
        }
        merged.extend(segment.messages.iter().cloned());
    }
    serde_json::to_string(&merged)
        .map_err(|e| format!("serialize flattened history messages failed: {e}"))
}

pub(crate) struct HistoryMessageLocation {
    pub segment_position: usize,
    pub message_index: usize,
    pub messages: Vec<Value>,
}

pub(crate) fn locate_history_message_ref(
    segments: &[ChatHistorySegmentRecord],
    message_ref: &ChatHistoryMessageRef,
) -> Result<HistoryMessageLocation, String> {
    validate_user_history_message_ref(message_ref)?;
    let segment_position = segments
        .iter()
        .position(|segment| {
            segment.segment_index == message_ref.segment_index
                && segment.segment_id.trim() == message_ref.segment_id.trim()
        })
        .ok_or_else(|| "base_message_ref segment was not found in history".to_string())?;
    let segment = &segments[segment_position];
    let parsed = serde_json::from_str::<Value>(&segment.messages_json)
        .map_err(|e| format!("parse history segment {} failed: {e}", segment.segment_id))?;
    let messages = parsed
        .as_array()
        .cloned()
        .ok_or_else(|| format!("history segment {} is not an array", segment.segment_id))?;
    let hinted_index = usize::try_from(message_ref.message_index).ok();
    let message_index = hinted_index
        .filter(|index| {
            messages.get(*index).is_some_and(|message| {
                message_matches_history_ref(segment, message, *index, message_ref)
            })
        })
        .or_else(|| {
            messages.iter().enumerate().find_map(|(index, message)| {
                message_matches_history_ref(segment, message, index, message_ref).then_some(index)
            })
        })
        .ok_or_else(|| {
            "base_message_ref did not match a stable user message in history".to_string()
        })?;
    Ok(HistoryMessageLocation {
        segment_position,
        message_index,
        messages,
    })
}

pub(crate) fn build_history_prefix_segments(
    segments: &[ChatHistorySegmentRecord],
    message_ref: &ChatHistoryMessageRef,
) -> Result<(Vec<ChatHistorySegmentRecord>, i64), String> {
    let location = locate_history_message_ref(segments, message_ref)?;
    let mut prefix_segments = segments[..location.segment_position].to_vec();
    let mut prefix_message_count = prefix_segments.iter().fold(0_i64, |total, segment| {
        total.saturating_add(segment.message_count.max(0))
    });
    let source = &segments[location.segment_position];
    let prefix_messages = location.messages[..location.message_index].to_vec();
    let mut prefix_segment = source.clone();
    prefix_segment.messages_json = serde_json::to_string(&prefix_messages)
        .map_err(|e| format!("serialize history prefix segment failed: {e}"))?;
    prefix_segment.message_count = i64::try_from(prefix_messages.len()).unwrap_or(i64::MAX);
    prefix_segment.start_message_id = prefix_messages
        .first()
        .map(|message| history_message_stable_id(message, source.segment_index, 0));
    prefix_segment.end_message_id = prefix_messages.last().map(|message| {
        history_message_stable_id(
            message,
            source.segment_index,
            prefix_messages.len().saturating_sub(1),
        )
    });
    prefix_message_count = prefix_message_count.saturating_add(prefix_segment.message_count);
    prefix_segments.push(prefix_segment);
    Ok((prefix_segments, prefix_message_count))
}

pub(crate) fn patch_history_context_meta(
    raw: &str,
    active_segment_index: i64,
    total_segment_count: i64,
    total_message_count: i64,
) -> String {
    match serde_json::from_str::<Value>(raw) {
        Ok(mut parsed) => match parsed.as_object_mut() {
            Some(object) => {
                object.insert(
                    "activeSegmentIndex".to_string(),
                    Value::from(active_segment_index),
                );
                object.insert(
                    "totalSegmentCount".to_string(),
                    Value::from(total_segment_count),
                );
                object.insert(
                    "totalMessageCount".to_string(),
                    Value::from(total_message_count),
                );
                parsed.to_string()
            }
            None => raw.to_string(),
        },
        Err(_) => raw.to_string(),
    }
}

pub(crate) fn build_history_revision(
    id: &str,
    updated_at: i64,
    active_segment_index: i64,
    total_segment_count: i64,
    total_message_count: i64,
) -> String {
    format!(
        "{}:{updated_at}:{active_segment_index}:{total_segment_count}:{total_message_count}",
        id.trim()
    )
}

pub(crate) fn validate_expected_history_revision(
    expected_revision: Option<&str>,
    current_revision: &str,
) -> Result<(), String> {
    if let Some(expected_revision) = expected_revision {
        if expected_revision.trim() != current_revision {
            return Err(format!(
                "stale-window: expected revision {}, current revision {current_revision}",
                expected_revision.trim()
            ));
        }
    }
    Ok(())
}
