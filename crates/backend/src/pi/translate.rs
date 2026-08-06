//! pi 事件 → 前端事件的翻译。
//!
//! 前端实际消费的只有三个事件（见 docs/design/pi-rpc-event-contract.md §2）：
//! `token_delta`、`tool_status_change`、`run_ended`。其余 pi 事件只用来
//! 维护 live 快照，不往外发——发出去也没人接，白占 WS 广播容量。
//!
//! payload 一律带 `conversation_id`（下划线）：前端按这个字段把事件路由到
//! 会话的 store，缺了直接丢弃。
//!
//! ## 终态判定
//!
//! pi 没有顶层 error 事件。LLM 失败表现为 assistant 消息的
//! `stopReason: "error"` + `errorMessage`，取消是 `stopReason: "aborted"`，
//! 而 `agent_end` / `agent_settled` 照常发。所以 `run_ended.state` 只能回看
//! 本轮最后一条 assistant 消息的 stopReason——这就是 `LiveState` 要记
//! `last_stop_reason` 的全部原因。

use std::sync::Mutex;

use serde_json::json;

use super::live::{LiveState, RetryAttempt};
use super::protocol::PiEvent;
use crate::events::EventSink;

/// 把一条 pi 事件落到 live 状态上，并按需广播前端事件。
///
/// 每个分支都先算好要发什么、放开锁、再发。持锁调 sink 会把「事件出口慢」
/// 变成「翻译层卡住」，那是两件不该耦合的事。
pub fn apply(
    conversation_id: &str,
    event: PiEvent,
    live: &Mutex<LiveState>,
    events: &dyn EventSink,
) {
    match event {
        PiEvent::AgentStart => {
            with_live(live, |state| state.begin_run());
        }

        // 新一轮 assistant 回合。只动 liveRounds，不发前端事件。
        PiEvent::TurnStart => {
            with_live(live, |state| state.begin_turn());
        }

        // 思考增量不映射成 token_delta（契约 §2.1），走独立的 thinking_delta
        // 事件带轮次落到前端 liveRounds。
        PiEvent::ThinkingDelta {
            delta,
            content_index,
        } => {
            if delta.is_empty() {
                return;
            }
            let round = with_live(live, |state| {
                state.is_settled = false;
                state.push_thinking_delta(&delta, content_index)
            });
            events.emit_json(
                "thinking_delta",
                json!({ "conversation_id": conversation_id, "delta": delta, "round": round }),
            );
        }

        PiEvent::TextDelta {
            delta,
            content_index,
        } => {
            if delta.is_empty() {
                return;
            }
            let round = with_live(live, |state| {
                state.draft_assistant_text.push_str(&delta);
                state.is_settled = false;
                state.push_text_delta(&delta, content_index)
            });
            events.emit_json(
                "token_delta",
                json!({ "conversation_id": conversation_id, "delta": delta, "round": round }),
            );
        }

        PiEvent::ToolStart {
            tool_call_id,
            tool_name,
            args,
        } => {
            let status = format!("正在执行：{}", summarize_tool_call(&tool_name, &args));
            let round = with_live(live, |state| {
                state.tool_status = Some(status.clone());
                state.begin_tool(&tool_call_id, &tool_name, args.clone())
            });
            emit_tool_status(events, conversation_id, Some(status), false, &[]);
            events.emit_json(
                "tool_call",
                json!({
                    "conversation_id": conversation_id,
                    "round": round,
                    "toolCall": {
                        "type": "toolCall",
                        "id": tool_call_id,
                        "name": tool_name,
                        "arguments": args,
                    },
                }),
            );
        }
        PiEvent::ToolEnd {
            tool_call_id,
            tool_name,
            content,
            details,
            is_error,
        } => {
            let landed = with_live(live, |state| {
                state.tool_status = None;
                state.finish_tool(&tool_call_id, content.clone(), details.clone(), is_error)
            });
            emit_tool_status(events, conversation_id, None, false, &[]);
            if let Some((round, timestamp_ms)) = landed {
                events.emit_json(
                    "tool_result",
                    json!({
                        "conversation_id": conversation_id,
                        "round": round,
                        "toolResult": {
                            "role": "toolResult",
                            "toolCallId": tool_call_id,
                            "toolName": tool_name,
                            "content": content,
                            "details": details,
                            "isError": is_error,
                            "timestamp": timestamp_ms,
                        },
                    }),
                );
            }
        }

        PiEvent::CompactionStart => {
            let status = "正在压缩上下文".to_string();
            with_live(live, |state| state.tool_status = Some(status.clone()));
            emit_tool_status(events, conversation_id, Some(status), true, &[]);
        }
        PiEvent::CompactionEnd => {
            with_live(live, |state| state.tool_status = None);
            emit_tool_status(events, conversation_id, None, true, &[]);
        }

        PiEvent::AutoRetryStart {
            attempt,
            max_attempts,
            error_message,
        } => {
            let status = format!("重试中（第 {attempt}/{max_attempts} 次）：{error_message}");
            let attempts = with_live(live, |state| {
                state.retry_attempts.push(RetryAttempt {
                    attempt,
                    max_attempts,
                    error_message,
                });
                state.tool_status = Some(status.clone());
                state.retry_attempts.clone()
            });
            emit_tool_status(events, conversation_id, Some(status), false, &attempts);
        }
        PiEvent::AutoRetryEnd => {
            with_live(live, |state| {
                state.retry_attempts.clear();
                state.tool_status = None;
            });
            emit_tool_status(events, conversation_id, None, false, &[]);
        }

        PiEvent::MessageEnd {
            stop_reason,
            error_message,
            provider,
            model,
            api,
            usage,
        } => {
            with_live(live, |state| {
                state.finish_message(&stop_reason, provider, model, api, usage);
                state.last_stop_reason = Some(stop_reason);
                state.last_error_message = error_message;
            });
        }

        PiEvent::AgentSettled => {
            let (run_state, error_message) = with_live(live, |state| {
                let verdict = run_state_from_stop_reason(state.last_stop_reason.as_deref());
                let error_message = state.last_error_message.clone();
                state.settle();
                (verdict, error_message)
            });
            emit_run_ended(events, conversation_id, run_state, error_message);
        }

        // 命令被 pi 拒绝（多半是 prompt 的 preflight：没配 key、模型不存在）。
        // 此时 agent 压根没起来，等不到 agent_settled，得自己补终态。
        PiEvent::CommandFailed { command, error } => {
            with_live(live, |state| state.settle());
            emit_run_ended(
                events,
                conversation_id,
                "failed",
                Some(format!("pi 命令 {command} 失败：{error}")),
            );
        }

        // 进程没了。只有还在跑时才补终态：空闲时进程退出（比如我们自己
        // kill 掉会话）不该给前端凭空造一条失败。
        PiEvent::ProcessExited => {
            let was_running = with_live(live, |state| {
                let was_running = state.is_running;
                state.settle();
                was_running
            });
            if was_running {
                emit_run_ended(
                    events,
                    conversation_id,
                    "failed",
                    Some("pi 进程已退出".to_string()),
                );
            }
        }
        // 审批请求在会话的事件泵里就被截走了（要 await 用户，最长 3 分钟，
        // 不能在这条同步路径上处理）。走到这里说明有人改了分流规则。
        PiEvent::ExtensionUiRequest { id, method, .. } => {
            eprintln!("扩展对话框到了翻译层，本该由会话泵接管（{method} / {id}）");
        }
    }
}

/// stopReason → 前端终态。`aborted` 是用户取消，`error` 是失败，其余算完成。
fn run_state_from_stop_reason(stop_reason: Option<&str>) -> &'static str {
    match stop_reason {
        Some("error") => "failed",
        Some("aborted") => "cancelled",
        _ => "completed",
    }
}

fn emit_run_ended(
    events: &dyn EventSink,
    conversation_id: &str,
    state: &str,
    error_message: Option<String>,
) {
    events.emit_json(
        "run_ended",
        json!({
            "conversation_id": conversation_id,
            "state": state,
            "errorMessage": error_message,
        }),
    );
}

fn emit_tool_status(
    events: &dyn EventSink,
    conversation_id: &str,
    status: Option<String>,
    is_compaction: bool,
    retry_attempts: &[RetryAttempt],
) {
    events.emit_json(
        "tool_status_change",
        json!({
            "conversation_id": conversation_id,
            "status": status,
            "isCompaction": is_compaction,
            "retryAttempts": retry_attempts,
        }),
    );
}

/// 锁中毒不传染：翻译层挂了不该连累正在跑的会话，这与 `EventBus` 的取舍一致。
fn with_live<T: Default>(live: &Mutex<LiveState>, f: impl FnOnce(&mut LiveState) -> T) -> T {
    match live.lock() {
        Ok(mut state) => f(&mut state),
        Err(error) => {
            eprintln!("pi live 状态锁中毒：{error}");
            T::default()
        }
    }
}

/// 工具状态行的文案，对齐 Node 的 `summarizeToolCall` 风格：`名字 键=值`。
///
/// 刻意**不**复刻 Node 那份逐工具特判（`uiMessages.ts` 里一百多行嵌套三元）：
/// 那是给桌面 UI 排版用的，这里只是一行状态文本，且 pi 的工具集和参数名
/// 与 Node 那套本就不同。取第一个命中的常见参数键就够，长值截断防止状态行
/// 变成半个文件。
pub(super) fn summarize_tool_call(tool_name: &str, args: &serde_json::Value) -> String {
    const PRIMARY_KEYS: [&str; 7] = [
        "command",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "name",
    ];
    const MAX_VALUE_CHARS: usize = 80;

    let Some(object) = args.as_object() else {
        return tool_name.to_string();
    };

    for key in PRIMARY_KEYS {
        let Some(value) = object.get(key).and_then(|value| value.as_str()) else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        // 按字符截断，不按字节：中文路径切一半会切出非法 UTF-8。
        let truncated: String = value.chars().take(MAX_VALUE_CHARS).collect();
        let ellipsis = if truncated.chars().count() < value.chars().count() {
            "…"
        } else {
            ""
        };
        return format!("{tool_name} {key}={truncated}{ellipsis}");
    }

    tool_name.to_string()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::events::EventBus;

    #[derive(Default)]
    struct RecordingSink {
        seen: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventSink for RecordingSink {
        fn emit_json(&self, event: &str, payload: serde_json::Value) {
            self.seen
                .lock()
                .expect("recording sink lock")
                .push((event.to_string(), payload));
        }
    }

    fn drive(events: &[PiEvent]) -> (Arc<RecordingSink>, Mutex<LiveState>) {
        let sink = Arc::new(RecordingSink::default());
        let bus = EventBus::new();
        bus.register(sink.clone());
        let live = Mutex::new(LiveState::default());
        for event in events {
            apply("conv-1", event.clone(), &live, &bus);
        }
        (sink, live)
    }

    fn emitted(sink: &RecordingSink) -> Vec<(String, serde_json::Value)> {
        sink.seen.lock().expect("recording sink lock").clone()
    }

    // 构造器：这些变体大多数字段与被测行为无关（meta 只喂 liveRounds），
    // 在每个用例里重复写四个 None 只会淹没真正在测的东西。
    fn text_delta(delta: &str) -> PiEvent {
        PiEvent::TextDelta {
            delta: delta.to_string(),
            content_index: 0,
        }
    }

    fn tool_start(tool_name: &str, args: serde_json::Value) -> PiEvent {
        PiEvent::ToolStart {
            tool_call_id: "t1".to_string(),
            tool_name: tool_name.to_string(),
            args,
        }
    }

    fn tool_end() -> PiEvent {
        PiEvent::ToolEnd {
            tool_call_id: "t1".to_string(),
            tool_name: "Bash".to_string(),
            content: json!([]),
            details: json!({}),
            is_error: false,
        }
    }

    fn message_end(stop_reason: &str, error_message: Option<&str>) -> PiEvent {
        PiEvent::MessageEnd {
            stop_reason: stop_reason.to_string(),
            error_message: error_message.map(str::to_string),
            provider: None,
            model: None,
            api: None,
            usage: None,
        }
    }

    #[test]
    fn text_deltas_become_token_delta_and_accumulate_into_the_snapshot() {
        let (sink, live) = drive(&[
            PiEvent::AgentStart,
            text_delta("你"),
            text_delta("好"),
        ]);

        let events = emitted(&sink);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "token_delta");
        assert_eq!(events[0].1["conversation_id"], "conv-1");
        assert_eq!(events[0].1["delta"], "你");
        assert_eq!(
            live.lock().expect("live lock").draft_assistant_text,
            "你好"
        );
    }

    /// 思考走独立的 thinking_delta，绝不能发成 token_delta（那等于把思考吐给用户）。
    #[test]
    fn thinking_deltas_never_reach_the_frontend_as_text() {
        let (sink, live) = drive(&[
            PiEvent::AgentStart,
            PiEvent::ThinkingDelta {
                delta: "内心戏".to_string(),
                content_index: 0,
            },
        ]);

        let events = emitted(&sink);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "thinking_delta");
        assert_eq!(events[0].1["delta"], "内心戏");
        assert_eq!(events[0].1["round"], 0);
        let state = live.lock().expect("live lock");
        assert!(
            state.draft_assistant_text.is_empty(),
            "思考不该混进 draftAssistantText"
        );
        let rounds = state.snapshot("conv-1")["live"]["liveRounds"].clone();
        assert_eq!(rounds[0]["blocks"][0]["kind"], "thinking");
        assert_eq!(rounds[0]["blocks"][0]["text"], "内心戏");
    }

    #[test]
    fn empty_delta_emits_nothing() {
        let (sink, _) = drive(&[text_delta("")]);
        assert!(emitted(&sink).is_empty());
    }

    #[test]
    fn tool_execution_sets_then_clears_the_status_line() {
        let (sink, live) = drive(&[
            tool_start("Bash", json!({ "command": "cargo build" })),
            tool_end(),
        ]);

        let events = emitted(&sink);
        assert_eq!(events[0].0, "tool_status_change");
        assert_eq!(events[0].1["status"], "正在执行：Bash command=cargo build");
        assert_eq!(events[0].1["isCompaction"], false);
        assert_eq!(events[1].1["status"], serde_json::Value::Null);
        assert!(live.lock().expect("live lock").tool_status.is_none());
    }

    #[test]
    fn compaction_is_flagged_on_the_status_event() {
        let (sink, _) = drive(&[PiEvent::CompactionStart, PiEvent::CompactionEnd]);
        let events = emitted(&sink);
        assert_eq!(events[0].1["isCompaction"], true);
        assert_eq!(events[1].1["isCompaction"], true);
        assert_eq!(events[1].1["status"], serde_json::Value::Null);
    }

    #[test]
    fn retry_attempts_ride_along_on_tool_status_change() {
        let (sink, _) = drive(&[PiEvent::AutoRetryStart {
            attempt: 2,
            max_attempts: 5,
            error_message: "429".to_string(),
        }]);

        let events = emitted(&sink);
        let attempts = &events[0].1["retryAttempts"];
        assert_eq!(attempts[0]["attempt"], 2);
        assert_eq!(attempts[0]["maxAttempts"], 5);
        assert_eq!(attempts[0]["errorMessage"], "429");
    }

    #[test]
    fn settled_run_reports_completed_when_nothing_went_wrong() {
        let (sink, live) = drive(&[
            PiEvent::AgentStart,
            message_end("stop", None),
            PiEvent::AgentSettled,
        ]);

        let events = emitted(&sink);
        let (name, payload) = events.last().expect("run_ended");
        assert_eq!(name, "run_ended");
        assert_eq!(payload["state"], "completed");
        assert!(live.lock().expect("live lock").is_settled);
        assert!(!live.lock().expect("live lock").is_running);
    }

    /// pi 没有顶层 error 事件——失败只能从 assistant 消息的 stopReason 看出来。
    #[test]
    fn error_stop_reason_becomes_failed_with_its_message() {
        let (sink, _) = drive(&[
            PiEvent::AgentStart,
            message_end("error", Some("上游 500")),
            PiEvent::AgentSettled,
        ]);

        let events = emitted(&sink);
        let payload = &events.last().expect("run_ended").1;
        assert_eq!(payload["state"], "failed");
        assert_eq!(payload["errorMessage"], "上游 500");
    }

    #[test]
    fn aborted_stop_reason_becomes_cancelled() {
        let (sink, _) = drive(&[
            PiEvent::AgentStart,
            message_end("aborted", None),
            PiEvent::AgentSettled,
        ]);

        assert_eq!(emitted(&sink).last().expect("run_ended").1["state"], "cancelled");
    }

    /// 上一轮失败不能污染下一轮：begin_run 必须把结论清掉。
    #[test]
    fn a_new_run_does_not_inherit_the_previous_failure() {
        let (sink, _) = drive(&[
            PiEvent::AgentStart,
            message_end("error", Some("上一轮炸了")),
            PiEvent::AgentSettled,
            PiEvent::AgentStart,
            message_end("stop", None),
            PiEvent::AgentSettled,
        ]);

        let events = emitted(&sink);
        let payload = &events.last().expect("run_ended").1;
        assert_eq!(payload["state"], "completed");
        assert_eq!(payload["errorMessage"], serde_json::Value::Null);
    }

    /// preflight 失败不会有 agent_settled，终态必须由 CommandFailed 补上。
    #[test]
    fn rejected_command_still_produces_a_terminal_event() {
        let (sink, _) = drive(&[PiEvent::CommandFailed {
            command: "prompt".to_string(),
            error: "no api key".to_string(),
        }]);

        let events = emitted(&sink);
        assert_eq!(events[0].0, "run_ended");
        assert_eq!(events[0].1["state"], "failed");
        assert!(events[0].1["errorMessage"]
            .as_str()
            .expect("errorMessage")
            .contains("no api key"));
    }

    #[test]
    fn process_exit_only_ends_a_run_that_was_actually_running() {
        let (idle_sink, _) = drive(&[PiEvent::ProcessExited]);
        assert!(emitted(&idle_sink).is_empty());

        let (busy_sink, _) = drive(&[PiEvent::AgentStart, PiEvent::ProcessExited]);
        let events = emitted(&busy_sink);
        assert_eq!(events[0].0, "run_ended");
        assert_eq!(events[0].1["state"], "failed");
    }

    #[test]
    fn tool_summary_falls_back_to_the_bare_name() {
        assert_eq!(summarize_tool_call("Think", &json!({})), "Think");
        assert_eq!(summarize_tool_call("Think", &json!(null)), "Think");
        assert_eq!(
            summarize_tool_call("Read", &json!({ "path": "  " })),
            "Read"
        );
    }

    /// 截断按字符走：按字节切中文路径会切出非法 UTF-8 并 panic。
    #[test]
    fn tool_summary_truncates_by_characters() {
        let long_path = "目".repeat(200);
        let summary = summarize_tool_call("Read", &json!({ "path": long_path }));
        assert!(summary.starts_with("Read path="));
        assert!(summary.ends_with('…'));
        assert_eq!(summary.chars().filter(|c| *c == '目').count(), 80);
    }
}
