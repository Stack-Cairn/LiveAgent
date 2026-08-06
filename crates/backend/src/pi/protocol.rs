//! pi RPC 的线上格式：出站命令与入站行的解析。
//!
//! 传输是严格 JSONL：一行一个 JSON 对象，按字节 `\n` 分帧。
//! 命令写 stdin，响应与事件混在 stdout 上，靠 `type` 字段区分。
//!
//! ## 为什么出站命令是 `serde_json::Value` 而不是 enum
//!
//! 命令侧是只写的：构造完就序列化发走，没有第二个消费者需要类型。
//! 上一版用内部 tag 的 enum，每个变体都得重复一遍 `id` 字段——三个构造
//! 函数比三个变体加三份 `id` 短，也少一层 `#[serde(rename)]`。
//!
//! ## 为什么入站解析是两趟
//!
//! pi 的 `message_update` 每行都带**全量累积消息**，而且 `assistantMessageEvent`
//! 里的 `partial` 是同一份消息的第二个副本。我们只要 `delta` 那几十字节。
//!
//! 内部 tag 的 enum（`#[serde(tag = "type")]`）在 serde 里会先把整个对象
//! 缓冲成 `Content` 再分发——正是我们要避开的分配。所以改成：
//! 第一趟只取 `type`，第二趟按 type 反序列化到**不含 `message`/`partial`
//! 字段**的窄结构体。serde 对未声明字段走 `IgnoredAny`，扫过去但不建对象。
//! 两趟扫描换零大对象分配，长回复下这笔买卖划算。

use serde::Deserialize;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// 出站命令
// ---------------------------------------------------------------------------

/// 一次提问。
///
/// `streamingBehavior` 恒为 `followUp`：pi 在**非流式**时忽略该字段直接开跑，
/// 流式时按它把消息排进队列。给死它，发送侧就没有「当前在不在流式」这个分支了
/// ——那个状态本来也只有 pi 自己知道得准，我们跟踪它只会跟丢。
pub fn prompt(message: &str) -> Value {
    json!({
        "type": "prompt",
        "message": message,
        "streamingBehavior": "followUp",
    })
}

/// 中止当前运行。空闲时 pi 也回 success。
pub fn abort() -> Value {
    json!({ "type": "abort" })
}

/// 切换模型。
pub fn set_model(provider: &str, model_id: &str) -> Value {
    json!({
        "type": "set_model",
        "provider": provider,
        "modelId": model_id,
    })
}

/// 回应扩展的对话框请求。`value` 是自由文本，不必是 `options` 里的选项
/// （已实测：pi 原样交给扩展）。审批桥用空串表示放行、非空表示拦截理由。
pub fn extension_ui_value(id: &str, value: &str) -> Value {
    json!({
        "type": "extension_ui_response",
        "id": id,
        "value": value,
    })
}

/// 取消一个对话框请求。用于不是我们发起的请求——每种 dialog 方法都认它，
/// 不回的话那个扩展会一直挂着。
pub fn extension_ui_cancel(id: &str) -> Value {
    json!({
        "type": "extension_ui_response",
        "id": id,
        "cancelled": true,
    })
}

// ---------------------------------------------------------------------------
// 入站行
// ---------------------------------------------------------------------------

/// pi stdout 的一行。响应按 id 路由回等待者，事件进翻译层。
#[derive(Debug)]
pub enum PiLine {
    Response(PiResponse),
    Event(PiEvent),
}

/// 命令应答。`success` 只表示**受理**——`prompt` 的实际结果异步走事件。
#[derive(Debug, Clone)]
pub struct PiResponse {
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    pub error: Option<String>,
    /// 查询类命令的返回值。只读命令才用得上；`prompt`/`abort` 这类没有。
    pub data: Option<Value>,
}

/// 翻译层关心的 pi 事件。其余事件在解析阶段就丢掉，不进管道。
#[derive(Debug, Clone)]
pub enum PiEvent {
    /// 一次 agent 运行开始。压缩续跑和自动重试也会重新发这个。
    AgentStart,
    /// 新一轮 assistant 回合。**第一轮不发**（pi 的 agent loop 只在
    /// 非首轮发 turn_start），所以 liveRounds 的第一轮要惰性创建。
    TurnStart,
    /// assistant 正文增量。`content_index` 用来切分内容块——同一个块的
    /// 增量往一起拼，换了号就是新块。
    TextDelta { delta: String, content_index: i64 },
    /// 思考增量。**不映射成 token_delta**（前端契约 §2.1），只进 liveRounds。
    ThinkingDelta { delta: String, content_index: i64 },
    ToolStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    ToolEnd {
        tool_call_id: String,
        tool_name: String,
        /// 工具结果的 content 数组（`(TextContent|ImageContent)[]`），原样透传。
        content: Value,
        details: Value,
        is_error: bool,
    },
    CompactionStart,
    CompactionEnd,
    AutoRetryStart {
        attempt: u32,
        max_attempts: u32,
        error_message: String,
    },
    AutoRetryEnd,
    /// 一条消息落定。assistant 消息的 `stopReason` 是判定终态的唯一依据：
    /// pi 没有顶层 error 事件，LLM 失败表现为 `stopReason: "error"`。
    MessageEnd {
        stop_reason: String,
        error_message: Option<String>,
        /// 本轮 meta：provider / model / api / usage。前端 `UiRound.meta` 的来源。
        provider: Option<String>,
        model: Option<String>,
        api: Option<String>,
        usage: Option<Value>,
    },
    /// 本轮彻底结束（重试、压缩、排队的 follow_up 全部排空之后）。
    AgentSettled,
    /// 扩展要求一次用户交互。审批桥是唯一的来源（见 pi-extension/approval.ts），
    /// 但别的 dialog 也可能落到这里，所以带上原始 `title` 让上层自己认。
    ///
    /// 只有需要应答的 dialog 方法（select/confirm/input/editor）会进来；
    /// notify/setStatus 这类发完不管的在解析阶段就丢了。
    ExtensionUiRequest {
        id: String,
        method: String,
        title: String,
    },

    // 以下两条不是 pi 发的，由 process.rs 合成，走同一条管道进翻译层。
    /// 无人等待的失败响应。preflight 失败（没配 key、模型不存在）走这条——
    /// 此时 agent 根本没起来，不会有 agent_settled，不补一条前端就永远转圈。
    CommandFailed { command: String, error: String },
    /// pi 进程的 stdout 关了，即进程没了。
    ProcessExited,
}

/// 解析一行。不认识的行返回 `None` 直接丢——pi 加新事件不该让我们崩。
pub fn parse_line(line: &str) -> Option<PiLine> {
    let kind = serde_json::from_str::<Tagged>(line).ok()?.kind;

    match kind.as_str() {
        "response" => {
            let raw: RawResponse = serde_json::from_str(line).ok()?;
            Some(PiLine::Response(PiResponse {
                id: raw.id,
                command: raw.command,
                success: raw.success,
                error: raw.error,
                data: raw.data,
            }))
        }
        "agent_start" => Some(PiLine::Event(PiEvent::AgentStart)),
        "turn_start" => Some(PiLine::Event(PiEvent::TurnStart)),
        "agent_settled" => Some(PiLine::Event(PiEvent::AgentSettled)),
        "message_update" => {
            let raw: RawMessageUpdate = serde_json::from_str(line).ok()?;
            // 只有这两种增量有下游：正文进 token_delta + liveRounds，
            // 思考只进 liveRounds。toolcall 增量由 tool_execution_* 覆盖，丢弃。
            match raw.event.kind.as_str() {
                "text_delta" => Some(PiLine::Event(PiEvent::TextDelta {
                    delta: raw.event.delta?,
                    content_index: raw.event.content_index,
                })),
                "thinking_delta" => Some(PiLine::Event(PiEvent::ThinkingDelta {
                    delta: raw.event.delta?,
                    content_index: raw.event.content_index,
                })),
                _ => None,
            }
        }
        "message_end" => {
            let raw: RawMessageEnd = serde_json::from_str(line).ok()?;
            // 用户消息也走 message_end，但没有 stopReason，拿它定终态是错的。
            if raw.message.role != "assistant" {
                return None;
            }
            Some(PiLine::Event(PiEvent::MessageEnd {
                stop_reason: raw.message.stop_reason,
                error_message: raw.message.error_message,
                provider: raw.message.provider,
                model: raw.message.model,
                api: raw.message.api,
                usage: raw.message.usage,
            }))
        }
        "tool_execution_start" => {
            let raw: RawToolStart = serde_json::from_str(line).ok()?;
            Some(PiLine::Event(PiEvent::ToolStart {
                tool_call_id: raw.tool_call_id,
                tool_name: raw.tool_name,
                args: raw.args,
            }))
        }
        "tool_execution_end" => {
            let raw: RawToolEnd = serde_json::from_str(line).ok()?;
            Some(PiLine::Event(PiEvent::ToolEnd {
                tool_call_id: raw.tool_call_id,
                tool_name: raw.tool_name,
                content: raw.result.content,
                details: raw.result.details,
                is_error: raw.is_error,
            }))
        }
        "compaction_start" => Some(PiLine::Event(PiEvent::CompactionStart)),
        "compaction_end" => Some(PiLine::Event(PiEvent::CompactionEnd)),
        "auto_retry_start" => {
            let raw: RawAutoRetryStart = serde_json::from_str(line).ok()?;
            Some(PiLine::Event(PiEvent::AutoRetryStart {
                attempt: raw.attempt,
                max_attempts: raw.max_attempts,
                error_message: raw.error_message,
            }))
        }
        "auto_retry_end" => Some(PiLine::Event(PiEvent::AutoRetryEnd)),
        "extension_ui_request" => {
            let raw: RawExtensionUiRequest = serde_json::from_str(line).ok()?;
            // 只应答会阻塞扩展的那几种；notify/setStatus/setWidget/setTitle/
            // set_editor_text 是发完不管的，回它们反而是协议噪声。
            if !matches!(
                raw.method.as_str(),
                "select" | "confirm" | "input" | "editor"
            ) {
                return None;
            }
            Some(PiLine::Event(PiEvent::ExtensionUiRequest {
                id: raw.id,
                method: raw.method,
                title: raw.title,
            }))
        }
        _ => None,
    }
}

/// 第一趟：只认 `type`，其余字段走 `IgnoredAny`。
#[derive(Deserialize)]
struct Tagged {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct RawResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    command: String,
    #[serde(default)]
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    data: Option<Value>,
}

/// 刻意不声明 `message`：那是全量累积消息，声明了就要分配。
#[derive(Deserialize)]
struct RawMessageUpdate {
    #[serde(rename = "assistantMessageEvent")]
    event: RawAssistantEvent,
}

/// 同理不声明 `partial`。
#[derive(Deserialize)]
struct RawAssistantEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    delta: Option<String>,
    #[serde(rename = "contentIndex", default)]
    content_index: i64,
}

#[derive(Deserialize)]
struct RawMessageEnd {
    message: RawFinalMessage,
}

#[derive(Deserialize)]
struct RawFinalMessage {
    #[serde(default)]
    role: String,
    #[serde(rename = "stopReason", default)]
    stop_reason: String,
    #[serde(rename = "errorMessage", default)]
    error_message: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    api: Option<String>,
    #[serde(default)]
    usage: Option<Value>,
}

#[derive(Deserialize)]
struct RawToolStart {
    #[serde(rename = "toolCallId", default)]
    tool_call_id: String,
    #[serde(rename = "toolName", default)]
    tool_name: String,
    #[serde(default)]
    args: Value,
}

#[derive(Deserialize)]
struct RawToolEnd {
    #[serde(rename = "toolCallId", default)]
    tool_call_id: String,
    #[serde(rename = "toolName", default)]
    tool_name: String,
    #[serde(default)]
    result: RawToolResult,
    #[serde(rename = "isError", default)]
    is_error: bool,
}

/// 工具结果里我们要转发给前端的两个字段。`usage`/`terminate` 不进
/// `ToolResultMessage`，丢掉。
#[derive(Deserialize, Default)]
struct RawToolResult {
    #[serde(default)]
    content: Value,
    #[serde(default)]
    details: Value,
}

#[derive(Deserialize)]
struct RawAutoRetryStart {
    #[serde(default)]
    attempt: u32,
    #[serde(rename = "maxAttempts", default)]
    max_attempts: u32,
    #[serde(rename = "errorMessage", default)]
    error_message: String,
}

#[derive(Deserialize)]
struct RawExtensionUiRequest {
    #[serde(default)]
    id: String,
    #[serde(default)]
    method: String,
    /// `select`/`confirm`/`input`/`editor` 都有 title；审批桥把请求 JSON 塞在这里。
    #[serde(default)]
    title: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_response_envelope() {
        let line = r#"{"id":"r1","type":"response","command":"abort","success":true}"#;
        match parse_line(line) {
            Some(PiLine::Response(resp)) => {
                assert_eq!(resp.id.as_deref(), Some("r1"));
                assert_eq!(resp.command, "abort");
                assert!(resp.success);
            }
            other => panic!("期望 response，得到 {other:?}"),
        }
    }

    #[test]
    fn parses_failed_response_with_error() {
        let line =
            r#"{"type":"response","command":"prompt","success":false,"error":"no api key"}"#;
        match parse_line(line) {
            Some(PiLine::Response(resp)) => {
                assert!(!resp.success);
                assert_eq!(resp.error.as_deref(), Some("no api key"));
            }
            other => panic!("期望 response，得到 {other:?}"),
        }
    }

    /// 全量 message 与 partial 都在行里，但解析只取 delta——这条测试锁住
    /// 「窄结构体不声明大字段」的约定，有人手滑加回 `message` 就会更慢而不会红。
    #[test]
    fn extracts_text_delta_ignoring_bulk_message() {
        let line = r#"{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"很长的累积正文"}],"stopReason":"pending"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"文","partial":{"role":"assistant","content":[]}}}"#;
        match parse_line(line) {
            Some(PiLine::Event(PiEvent::TextDelta { delta, content_index })) => {
                assert_eq!(delta, "文");
                assert_eq!(content_index, 0);
            }
            other => panic!("期望 text_delta，得到 {other:?}"),
        }
    }

    /// 思考增量要解析出来（liveRounds 要它），但**不能**变成正文增量——
    /// 混进 token_delta 就是把模型的思考直接吐给用户。
    #[test]
    fn thinking_delta_parses_as_thinking_not_as_text() {
        let line = r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":2,"delta":"想"}}"#;
        match parse_line(line) {
            Some(PiLine::Event(PiEvent::ThinkingDelta {
                delta,
                content_index,
            })) => {
                assert_eq!(delta, "想");
                assert_eq!(content_index, 2);
            }
            other => panic!("期望 thinking_delta，得到 {other:?}"),
        }
    }

    /// toolcall 增量由 tool_execution_* 覆盖，不该重复进事件流。
    #[test]
    fn toolcall_deltas_are_dropped() {
        let line = r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":0,"delta":"{\"a\":"}}"#;
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn message_end_only_reports_assistant_stop_reason() {
        let user = r#"{"type":"message_end","message":{"role":"user","content":"hi"}}"#;
        assert!(parse_line(user).is_none());

        let assistant = r#"{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"boom"}}"#;
        match parse_line(assistant) {
            Some(PiLine::Event(PiEvent::MessageEnd {
                stop_reason,
                error_message,
                ..
            })) => {
                assert_eq!(stop_reason, "error");
                assert_eq!(error_message.as_deref(), Some("boom"));
            }
            other => panic!("期望 message_end，得到 {other:?}"),
        }
    }

    #[test]
    fn parses_tool_and_retry_events() {
        let start = r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"Bash","args":{"command":"ls"}}"#;
        match parse_line(start) {
            Some(PiLine::Event(PiEvent::ToolStart { tool_name, args, .. })) => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(args["command"], "ls");
            }
            other => panic!("期望 tool_execution_start，得到 {other:?}"),
        }

        let retry = r#"{"type":"auto_retry_start","attempt":2,"maxAttempts":5,"delayMs":1000,"errorMessage":"429"}"#;
        match parse_line(retry) {
            Some(PiLine::Event(PiEvent::AutoRetryStart {
                attempt,
                max_attempts,
                error_message,
            })) => {
                assert_eq!((attempt, max_attempts), (2, 5));
                assert_eq!(error_message, "429");
            }
            other => panic!("期望 auto_retry_start，得到 {other:?}"),
        }
    }

    #[test]
    fn unknown_and_malformed_lines_are_dropped_not_fatal() {
        assert!(parse_line(r#"{"type":"queue_update","steering":[]}"#).is_none());
        assert!(parse_line("not json at all").is_none());
        assert!(parse_line("{}").is_none());
        assert!(parse_line("").is_none());
    }

    #[test]
    fn prompt_always_carries_follow_up_behavior() {
        let cmd = prompt("hi");
        assert_eq!(cmd["type"], "prompt");
        assert_eq!(cmd["message"], "hi");
        assert_eq!(cmd["streamingBehavior"], "followUp");
    }

    #[test]
    fn parses_blocking_extension_dialogs() {
        let line = r#"{"type":"extension_ui_request","id":"u1","method":"select","title":"liveagent-approval-v1:{}","options":["allow","deny"]}"#;
        match parse_line(line) {
            Some(PiLine::Event(PiEvent::ExtensionUiRequest { id, method, title })) => {
                assert_eq!(id, "u1");
                assert_eq!(method, "select");
                assert!(title.starts_with("liveagent-approval-v1:"));
            }
            other => panic!("期望 extension_ui_request，得到 {other:?}"),
        }
    }

    /// 发完不管的方法不能进事件流：回应它们是协议噪声，而且没人在等。
    #[test]
    fn fire_and_forget_extension_methods_are_dropped() {
        for method in ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"] {
            let line = format!(
                r#"{{"type":"extension_ui_request","id":"u1","method":"{method}","message":"x"}}"#
            );
            assert!(parse_line(&line).is_none(), "{method} 不该进事件流");
        }
    }

    #[test]
    fn extension_ui_responses_have_the_shapes_pi_accepts() {
        let allow = extension_ui_value("u1", "");
        assert_eq!(allow["type"], "extension_ui_response");
        assert_eq!(allow["id"], "u1");
        assert_eq!(allow["value"], "");

        let cancel = extension_ui_cancel("u2");
        assert_eq!(cancel["cancelled"], true);
        assert!(cancel.get("value").is_none());
    }
}
