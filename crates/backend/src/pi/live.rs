//! 单会话的 live 快照状态。
//!
//! `GET /api/conversation_live` 的数据源。字段名与前端 `LiveTranscriptState`
//! 逐字对齐（`crates/frontend/src/lib/chat/conversation/liveTranscriptStore.ts`），
//! 因为这个形状是前端契约的一部分。
//!
//! ## liveRounds 的组装
//!
//! 结构对齐前端的 `LiveRound`（`src/lib/chat/messages/uiMessages.ts`）：
//!
//! ```text
//! LiveRound = { round, key, blocks, meta?, runningToolCallIds, thinkingOpen }
//! blocks[]  = { kind:"text"|"thinking", id, text }
//!           | { kind:"tool", item: { toolCall, toolResult? } }
//! ```
//!
//! 数据来自 pi 的事件流：正文/思考增量按 `contentIndex` 切块，
//! `tool_execution_start/end` 配成一个 tool 块，`message_end` 填 `meta`。
//!
//! **pi 拿不到、因而缺省的字段**（结构在，值为空）：
//! - `UiRoundContentBlock` 的 `hostedSearch` 变体：provider 原生搜索块在 pi 的
//!   事件流里不单独出现，我们永远不产出这个 kind。
//! - `ToolCall.thoughtSignature`：provider 内部字段，`tool_execution_start` 不带。
//! - `ToolResultMessage` 的 `usage` / `addedToolNames`：`tool_execution_end` 不带。
//! - `ToolResultMessage.timestamp`：pi 不给，用**收到事件的时刻**填。它表达的是
//!   「结果何时到达」而不是「工具何时执行完」，差一个 IPC 的量级。
//!
//! 前端目前只 `console.debug` 这份快照（重连恢复是空实现），所以以上缺口不影响
//! 任何在跑的功能；记在这里是为了将来真接快照恢复时知道边界在哪。

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};

/// 自动重试的一次尝试记录。前端 `RetryAttemptRecord` 的同构体。
#[derive(Debug, Clone, Serialize)]
pub struct RetryAttempt {
    pub attempt: u32,
    #[serde(rename = "maxAttempts")]
    pub max_attempts: u32,
    #[serde(rename = "errorMessage")]
    pub error_message: String,
}

/// 一个内容块。与前端 `UiRoundContentBlock` 里我们能产出的三个变体对应。
#[derive(Debug)]
enum Block {
    Text {
        content_index: i64,
        text: String,
    },
    Thinking {
        content_index: i64,
        text: String,
    },
    Tool {
        tool_call_id: String,
        tool_name: String,
        args: Value,
        result: Option<ToolResult>,
    },
}

#[derive(Debug)]
struct ToolResult {
    content: Value,
    details: Value,
    is_error: bool,
    timestamp_ms: u64,
}

/// 一轮 assistant 回合。
#[derive(Debug, Default)]
struct Round {
    blocks: Vec<Block>,
    running_tool_call_ids: Vec<String>,
    thinking_open: bool,
    provider: Option<String>,
    model: Option<String>,
    api: Option<String>,
    stop_reason: Option<String>,
    usage: Option<Value>,
}

impl Round {
    fn to_json(&self, index: usize) -> Value {
        let blocks: Vec<Value> = self
            .blocks
            .iter()
            .enumerate()
            .map(|(block_index, block)| block.to_json(index, block_index))
            .collect();

        let mut round = Map::new();
        round.insert("round".to_string(), json!(index));
        // 稳定渲染 key，沿用前端历史轮次的 `r<n>` 命名。
        round.insert("key".to_string(), json!(format!("r{index}")));
        round.insert("blocks".to_string(), Value::Array(blocks));
        round.insert(
            "runningToolCallIds".to_string(),
            json!(self.running_tool_call_ids),
        );
        round.insert("thinkingOpen".to_string(), json!(self.thinking_open));
        if let Some(meta) = self.meta_to_json() {
            round.insert("meta".to_string(), meta);
        }
        Value::Object(round)
    }

    /// `meta` 整个是可选的：一轮还没落定时它没有任何内容，这时**不发**这个键，
    /// 而不是发一个全 null 的对象——后者会让前端的 `round.meta?.usage` 之类
    /// 从「没有 meta」变成「有 meta 但字段是 undefined」，语义不同。
    fn meta_to_json(&self) -> Option<Value> {
        let mut meta = Map::new();
        for (key, value) in [
            ("provider", &self.provider),
            ("model", &self.model),
            ("api", &self.api),
            ("stopReason", &self.stop_reason),
        ] {
            if let Some(value) = value {
                meta.insert(key.to_string(), json!(value));
            }
        }
        if let Some(usage) = &self.usage {
            meta.insert("usage".to_string(), usage.clone());
            if let Some(total) = usage.get("totalTokens").and_then(Value::as_u64) {
                meta.insert("usageTotalTokens".to_string(), json!(total));
            }
        }

        if meta.is_empty() {
            None
        } else {
            Some(Value::Object(meta))
        }
    }
}

impl Block {
    fn to_json(&self, round_index: usize, block_index: usize) -> Value {
        // 块 id 要在轮内稳定。块只追加不重排，所以下标就够稳。
        let id = format!("r{round_index}b{block_index}");
        match self {
            Block::Text { text, .. } => json!({ "kind": "text", "id": id, "text": text }),
            Block::Thinking { text, .. } => json!({ "kind": "thinking", "id": id, "text": text }),
            Block::Tool {
                tool_call_id,
                tool_name,
                args,
                result,
            } => {
                let mut item = Map::new();
                item.insert(
                    "toolCall".to_string(),
                    json!({
                        "type": "toolCall",
                        "id": tool_call_id,
                        "name": tool_name,
                        "arguments": args,
                    }),
                );
                if let Some(result) = result {
                    item.insert(
                        "toolResult".to_string(),
                        json!({
                            "role": "toolResult",
                            "toolCallId": tool_call_id,
                            "toolName": tool_name,
                            "content": result.content,
                            "details": result.details,
                            "isError": result.is_error,
                            "timestamp": result.timestamp_ms,
                        }),
                    );
                }
                json!({ "kind": "tool", "item": Value::Object(item) })
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct LiveState {
    pub draft_assistant_text: String,
    pub tool_status: Option<String>,
    pub retry_attempts: Vec<RetryAttempt>,
    pub is_settled: bool,
    pub is_running: bool,
    /// pi 的 `messageCount`。没查过就是 None——契约允许 null。
    pub message_count: Option<u64>,
    /// 本轮最后一条 assistant 消息的 stopReason。`agent_settled` 时据此定终态。
    pub last_stop_reason: Option<String>,
    pub last_error_message: Option<String>,
    rounds: Vec<Round>,
}

impl LiveState {
    /// 一段 agent 运行开始。压缩续跑与自动重试也会走到这里，所以只重置
    /// 「本段的结论」，不动已经流出去的正文和已积累的轮次——它们由 settle 统一清。
    pub fn begin_run(&mut self) {
        self.is_running = true;
        self.is_settled = false;
        self.last_stop_reason = None;
        self.last_error_message = None;
    }

    /// 本轮彻底结束。与前端 store 的 `settle()` 同语义：清空并置 settled。
    pub fn settle(&mut self) {
        self.draft_assistant_text.clear();
        self.tool_status = None;
        self.retry_attempts.clear();
        self.rounds.clear();
        self.is_settled = true;
        self.is_running = false;
    }

    /// 开一轮新的 assistant 回合。
    pub fn begin_turn(&mut self) {
        // 上一轮的思考块不该跨轮继续「展开」。
        if let Some(previous) = self.rounds.last_mut() {
            previous.thinking_open = false;
        }
        self.rounds.push(Round::default());
    }

    /// 取当前轮，没有就开一个。
    ///
    /// 惰性创建是必需的：pi 的 agent loop **不为第一轮发 `turn_start`**
    /// （只在非首轮发），所以第一轮只能由第一个内容事件带出来。
    fn current_round(&mut self) -> &mut Round {
        if self.rounds.is_empty() {
            self.rounds.push(Round::default());
        }
        self.rounds.last_mut().expect("刚 push 过，必然非空")
    }

    /// 当前轮的下标。内容事件要随事件广播轮次，前端据此落块。
    fn current_round_index(&self) -> usize {
        self.rounds.len().saturating_sub(1)
    }

    pub fn push_text_delta(&mut self, delta: &str, content_index: i64) -> usize {
        let round = self.current_round();
        // 正文一出现，思考块就算收起来了。
        round.thinking_open = false;
        match round.blocks.last_mut() {
            // 同一个内容块的后续增量：接着拼，不新开块。
            Some(Block::Text {
                content_index: index,
                text,
            }) if *index == content_index => text.push_str(delta),
            _ => round.blocks.push(Block::Text {
                content_index,
                text: delta.to_string(),
            }),
        }
        self.current_round_index()
    }

    pub fn push_thinking_delta(&mut self, delta: &str, content_index: i64) -> usize {
        let round = self.current_round();
        round.thinking_open = true;
        match round.blocks.last_mut() {
            Some(Block::Thinking {
                content_index: index,
                text,
            }) if *index == content_index => text.push_str(delta),
            _ => round.blocks.push(Block::Thinking {
                content_index,
                text: delta.to_string(),
            }),
        }
        self.current_round_index()
    }

    pub fn begin_tool(&mut self, tool_call_id: &str, tool_name: &str, args: Value) -> usize {
        let round = self.current_round();
        round.thinking_open = false;
        round.blocks.push(Block::Tool {
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            args,
            result: None,
        });
        round.running_tool_call_ids.push(tool_call_id.to_string());
        self.current_round_index()
    }

    /// 工具结果落到对应的块上。返回落点轮次与到达时刻（供广播），没配上则 None。
    ///
    /// 按 id 从后往前找**所有**轮次：并行工具调用下结束顺序与开始顺序无关，
    /// 而压缩续跑又可能让上一轮的工具在新轮开始后才回来。
    pub fn finish_tool(
        &mut self,
        tool_call_id: &str,
        content: Value,
        details: Value,
        is_error: bool,
    ) -> Option<(usize, u64)> {
        let timestamp_ms = now_ms();
        for (round_index, round) in self.rounds.iter_mut().enumerate().rev() {
            round.running_tool_call_ids.retain(|id| id != tool_call_id);
            let slot = round.blocks.iter_mut().rev().find_map(|block| match block {
                Block::Tool {
                    tool_call_id: id,
                    result,
                    ..
                } if id == tool_call_id => Some(result),
                _ => None,
            });
            if let Some(slot) = slot {
                *slot = Some(ToolResult {
                    content,
                    details,
                    is_error,
                    timestamp_ms,
                });
                return Some((round_index, timestamp_ms));
            }
        }
        None
    }

    /// 一条 assistant 消息落定，把 meta 记到当前轮上。
    pub fn finish_message(
        &mut self,
        stop_reason: &str,
        provider: Option<String>,
        model: Option<String>,
        api: Option<String>,
        usage: Option<Value>,
    ) {
        let round = self.current_round();
        round.stop_reason = Some(stop_reason.to_string());
        round.provider = provider;
        round.model = model;
        round.api = api;
        round.usage = usage;
        round.thinking_open = false;
    }

    /// 组装对外快照。形状见模块注释。
    pub fn snapshot(&self, conversation_id: &str) -> Value {
        let rounds: Vec<Value> = self
            .rounds
            .iter()
            .enumerate()
            .map(|(index, round)| round.to_json(index))
            .collect();

        json!({
            "conversationId": conversation_id,
            "isRunning": self.is_running,
            "live": {
                "draftAssistantText": self.draft_assistant_text,
                "toolStatus": self.tool_status,
                "liveRounds": rounds,
                "retryAttempts": self.retry_attempts,
                "isSettled": self.is_settled,
            },
            "messageCount": self.message_count,
        })
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(state: &LiveState) -> Value {
        state.snapshot("conv-1")["live"].clone()
    }

    #[test]
    fn snapshot_keeps_every_contract_field() {
        let state = LiveState::default();
        let snapshot = state.snapshot("conv-1");

        assert_eq!(snapshot["conversationId"], "conv-1");
        assert_eq!(snapshot["isRunning"], false);
        assert_eq!(snapshot["messageCount"], Value::Null);
        let live = &snapshot["live"];
        assert_eq!(live["draftAssistantText"], "");
        assert_eq!(live["toolStatus"], Value::Null);
        assert!(live["liveRounds"].is_array());
        assert!(live["retryAttempts"].is_array());
        assert_eq!(live["isSettled"], false);
    }

    #[test]
    fn settle_clears_transient_state_and_stops_running() {
        let mut state = LiveState::default();
        state.begin_run();
        state.draft_assistant_text.push_str("半条回复");
        state.tool_status = Some("正在执行：Bash".to_string());
        state.push_text_delta("hi", 0);
        state.retry_attempts.push(RetryAttempt {
            attempt: 1,
            max_attempts: 3,
            error_message: "429".to_string(),
        });

        state.settle();

        assert!(state.draft_assistant_text.is_empty());
        assert!(state.tool_status.is_none());
        assert!(state.retry_attempts.is_empty());
        assert_eq!(live(&state)["liveRounds"].as_array().expect("数组").len(), 0);
        assert!(state.is_settled);
        assert!(!state.is_running);
    }

    #[test]
    fn begin_run_drops_the_previous_runs_verdict() {
        let mut state = LiveState {
            last_stop_reason: Some("error".to_string()),
            last_error_message: Some("boom".to_string()),
            ..Default::default()
        };

        state.begin_run();

        assert!(state.last_stop_reason.is_none());
        assert!(state.last_error_message.is_none());
        assert!(state.is_running);
    }

    /// pi 不为第一轮发 turn_start，第一个内容事件必须自己把轮次带出来。
    #[test]
    fn the_first_round_is_created_lazily() {
        let mut state = LiveState::default();
        state.push_text_delta("你好", 0);

        let rounds = live(&state)["liveRounds"].clone();
        assert_eq!(rounds.as_array().expect("数组").len(), 1);
        assert_eq!(rounds[0]["round"], 0);
        assert_eq!(rounds[0]["key"], "r0");
        assert_eq!(rounds[0]["blocks"][0]["kind"], "text");
        assert_eq!(rounds[0]["blocks"][0]["text"], "你好");
        assert_eq!(rounds[0]["blocks"][0]["id"], "r0b0");
    }

    #[test]
    fn deltas_of_one_content_block_merge_but_a_new_index_starts_a_block() {
        let mut state = LiveState::default();
        state.push_text_delta("你", 0);
        state.push_text_delta("好", 0);
        state.push_text_delta("第二块", 1);

        let blocks = live(&state)["liveRounds"][0]["blocks"].clone();
        assert_eq!(blocks.as_array().expect("数组").len(), 2);
        assert_eq!(blocks[0]["text"], "你好");
        assert_eq!(blocks[1]["text"], "第二块");
        assert_eq!(blocks[1]["id"], "r0b1");
    }

    #[test]
    fn thinking_blocks_are_separate_from_text_and_close_when_text_arrives() {
        let mut state = LiveState::default();
        state.push_thinking_delta("想一下", 0);
        assert_eq!(live(&state)["liveRounds"][0]["thinkingOpen"], true);

        state.push_text_delta("答案", 1);
        let round = live(&state)["liveRounds"][0].clone();
        assert_eq!(round["thinkingOpen"], false);
        assert_eq!(round["blocks"][0]["kind"], "thinking");
        assert_eq!(round["blocks"][0]["text"], "想一下");
        assert_eq!(round["blocks"][1]["kind"], "text");
    }

    #[test]
    fn a_tool_block_carries_the_call_then_gains_its_result() {
        let mut state = LiveState::default();
        state.begin_tool("t1", "Bash", json!({ "command": "ls" }));

        let round = live(&state)["liveRounds"][0].clone();
        assert_eq!(round["runningToolCallIds"], json!(["t1"]));
        let item = round["blocks"][0]["item"].clone();
        assert_eq!(round["blocks"][0]["kind"], "tool");
        assert_eq!(item["toolCall"]["type"], "toolCall");
        assert_eq!(item["toolCall"]["id"], "t1");
        assert_eq!(item["toolCall"]["name"], "Bash");
        assert_eq!(item["toolCall"]["arguments"]["command"], "ls");
        assert!(item.get("toolResult").is_none(), "还没结束不该有 toolResult");

        state.finish_tool(
            "t1",
            json!([{ "type": "text", "text": "a.rs" }]),
            json!({}),
            false,
        );

        let round = live(&state)["liveRounds"][0].clone();
        assert_eq!(round["runningToolCallIds"], json!([]));
        let result = round["blocks"][0]["item"]["toolResult"].clone();
        assert_eq!(result["role"], "toolResult");
        assert_eq!(result["toolCallId"], "t1");
        assert_eq!(result["toolName"], "Bash");
        assert_eq!(result["isError"], false);
        assert_eq!(result["content"][0]["text"], "a.rs");
        assert!(result["timestamp"].as_u64().expect("时间戳") > 0);
    }

    /// 并行工具的结束顺序与开始顺序无关，配对只能按 id。
    #[test]
    fn parallel_tools_are_matched_by_id_not_by_order() {
        let mut state = LiveState::default();
        state.begin_tool("t1", "Read", json!({}));
        state.begin_tool("t2", "Bash", json!({}));

        state.finish_tool("t2", json!([]), json!({}), true);

        let round = live(&state)["liveRounds"][0].clone();
        assert_eq!(round["runningToolCallIds"], json!(["t1"]));
        assert!(round["blocks"][0]["item"].get("toolResult").is_none());
        assert_eq!(round["blocks"][1]["item"]["toolResult"]["isError"], true);
    }

    /// 压缩续跑会开新轮，而上一轮的工具可能到那时才回来。
    #[test]
    fn a_tool_result_finds_its_block_in_an_earlier_round() {
        let mut state = LiveState::default();
        state.begin_tool("t1", "Bash", json!({}));
        state.begin_turn();
        state.push_text_delta("新一轮", 0);

        state.finish_tool("t1", json!([]), json!({}), false);

        let rounds = live(&state)["liveRounds"].clone();
        assert_eq!(rounds.as_array().expect("数组").len(), 2);
        assert!(rounds[0]["blocks"][0]["item"]["toolResult"].is_object());
        assert_eq!(rounds[0]["runningToolCallIds"], json!([]));
    }

    #[test]
    fn turn_start_opens_a_numbered_round_with_a_stable_key() {
        let mut state = LiveState::default();
        state.push_text_delta("一", 0);
        state.begin_turn();
        state.push_text_delta("二", 0);

        let rounds = live(&state)["liveRounds"].clone();
        assert_eq!(rounds[0]["round"], 0);
        assert_eq!(rounds[0]["key"], "r0");
        assert_eq!(rounds[1]["round"], 1);
        assert_eq!(rounds[1]["key"], "r1");
        assert_eq!(rounds[1]["blocks"][0]["id"], "r1b0");
    }

    #[test]
    fn message_end_fills_round_meta_including_derived_total_tokens() {
        let mut state = LiveState::default();
        state.push_text_delta("hi", 0);
        state.finish_message(
            "stop",
            Some("anthropic".to_string()),
            Some("claude-opus-4-8".to_string()),
            Some("anthropic-messages".to_string()),
            Some(json!({ "input": 10, "output": 5, "totalTokens": 15 })),
        );

        let meta = live(&state)["liveRounds"][0]["meta"].clone();
        assert_eq!(meta["provider"], "anthropic");
        assert_eq!(meta["model"], "claude-opus-4-8");
        assert_eq!(meta["api"], "anthropic-messages");
        assert_eq!(meta["stopReason"], "stop");
        assert_eq!(meta["usage"]["totalTokens"], 15);
        assert_eq!(meta["usageTotalTokens"], 15);
    }

    /// meta 整个缺省时不发这个键——发一个空对象会让 `round.meta?.x`
    /// 从「没有 meta」变成「有 meta 但字段是 undefined」，语义不同。
    #[test]
    fn a_round_without_meta_omits_the_key_entirely() {
        let mut state = LiveState::default();
        state.push_text_delta("hi", 0);
        assert!(live(&state)["liveRounds"][0].get("meta").is_none());
    }
}
