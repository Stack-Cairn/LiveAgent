// Stable identity of a persisted user message, used to anchor edit-resend
// (`chat.edit_resend` base_message_ref, `rebased` truncation events). Wire
// form is snake_case (see shared buildHistoryMessageRefPayload); the
// desktop validates segment_id + message_id + role + content_hash before
// truncating. The full segmented conversation state machine lives in
// agent-gui — the webui renders from its TranscriptStore instead.
export type { HistoryMessageRef } from "@liveagent/ui/lib/chat/historyMessageRef";
