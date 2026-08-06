//! 工具审批桥：pi 的 `extension_ui_request` ⇄ 前端审批卡片。
//!
//! ```text
//! pi tool_call ─→ approval.ts ─→ extension_ui_request ─→ 本模块
//!                                                          │
//!                              allow/deny 直接裁决 ←───────┤
//!                                                          ↓ ask
//!                        approval.rs ─→ tool-approval:request ─→ 前端卡片
//! ```
//!
//! 裁决**全部**在这一侧：扩展是哑管道（见 `pi-extension/approval.ts`）。
//! 这样策略改动不需要回去改 TS。
//!
//! 应答协议：空串放行，非空即拦截理由（原样交给模型）。
//!
//! ## 免审记忆（approve_session）搬到了这里
//!
//! 原先在 Node 的 `toolApproval.ts` 里按 conversationId 分区存。现在每个
//! 会话本来就有独立的 pi 进程和状态，直接挂在会话上——不需要再按 id 分区，
//! 会话销毁时记忆自然消失。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde::Deserialize;

use super::translate::summarize_tool_call;
use crate::approval::{ApprovalPayload, ApprovalRegistry, Decision, Outcome};
use crate::events::EventBus;

/// 与 `pi-extension/approval.ts` 的 `MARKER` 逐字对应。改一边就要改另一边。
pub const APPROVAL_MARKER: &str = "liveagent-approval-v1:";

/// 审批窗口。沿用 Node 侧 `TOOL_APPROVAL_TIMEOUT_MS`（3 分钟）的口径，
/// 免得同一个交互在迁移前后等待时长不一致。
pub const APPROVAL_TIMEOUT_MS: u64 = 3 * 60 * 1000;

/// 扩展送来的一次工具调用。字段名与 approval.ts 里 `JSON.stringify` 的一致。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequest {
    #[serde(default)]
    tool_call_id: String,
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    input: serde_json::Value,
}

/// 一次工具调用的策略。与前端设置里的 `toolPolicies` 取值一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPolicy {
    Allow,
    Ask,
    Deny,
}

/// 解析一次工具调用的策略。
///
/// 只认**按工具名的显式配置**，其余一律 allow。这是有意收窄：
/// Node 版还支持 `server:<id>` / `group:<id>` 两级回落和 `isReadOnly` 缺省，
/// 但那三者都依赖 Node 内置工具注册表里的元数据（groupId/serverId/isReadOnly），
/// pi 的工具集不是同一套，也不向我们暴露这些元数据。按工具名猜一个假的
/// 分组，比不做更糟——不做至少行为可预测。
///
/// 缺省 allow 与 Node 版一致（`resolveToolPolicy` 末行就是 `return "allow"`），
/// 所以没配过策略的用户不会突然被弹审批。
pub fn resolve_tool_policy(
    tool_name: &str,
    policies: Option<&serde_json::Value>,
) -> ToolPolicy {
    let explicit = policies
        .and_then(|policies| policies.get(tool_name))
        .and_then(serde_json::Value::as_str);

    match explicit {
        Some("ask") => ToolPolicy::Ask,
        Some("deny") => ToolPolicy::Deny,
        _ => ToolPolicy::Allow,
    }
}

/// 会话级免审记忆：`approve_session` 批过的工具名。
#[derive(Default)]
pub struct SessionApprovals {
    allowed_tools: Mutex<HashSet<String>>,
}

impl SessionApprovals {
    fn is_allowed(&self, tool_name: &str) -> bool {
        match self.allowed_tools.lock() {
            Ok(allowed) => allowed.contains(tool_name),
            // 记不住只是多问一次，比放行安全。
            Err(_) => false,
        }
    }

    fn remember(&self, tool_name: &str) {
        if let Ok(mut allowed) = self.allowed_tools.lock() {
            allowed.insert(tool_name.to_string());
        }
    }
}

/// 裁决一次 `extension_ui_request`。
///
/// 返回值直接就是要写回 pi 的 `value`：空串放行，非空是拦截理由。
/// 不是审批请求（别的扩展的对话框）返回 `None`，由调用方回 `cancelled`。
pub async fn resolve_ui_request(
    conversation_id: &str,
    title: &str,
    policies: Option<&serde_json::Value>,
    session_approvals: &SessionApprovals,
    approvals: &ApprovalRegistry,
    events: Arc<EventBus>,
) -> Option<String> {
    let payload = title.strip_prefix(APPROVAL_MARKER)?;
    let request: ApprovalRequest = match serde_json::from_str(payload) {
        Ok(request) => request,
        Err(error) => {
            // 认得出是我们的 marker 但解不开，说明两侧协议不同步了。
            // 放行比拦截好：拦了等于整个 agent 不可用，而策略默认本就是 allow。
            eprintln!("审批请求解析失败（{conversation_id}）：{error}");
            return Some(String::new());
        }
    };

    match resolve_tool_policy(&request.tool_name, policies) {
        ToolPolicy::Allow => return Some(String::new()),
        ToolPolicy::Deny => {
            return Some(format!(
                "工具 {} 已被用户的权限策略禁止（deny）。不要重试；如确需使用，请让用户在设置的工具权限中放行。",
                request.tool_name
            ))
        }
        ToolPolicy::Ask => {}
    }

    if session_approvals.is_allowed(&request.tool_name) {
        return Some(String::new());
    }

    let (_, outcome) = approvals
        .request(
            ApprovalPayload {
                conversation_id: conversation_id.to_string(),
                tool_call_id: request.tool_call_id,
                tool_name: request.tool_name.clone(),
                summary: summarize_tool_call(&request.tool_name, &request.input),
                recommended: None,
            },
            APPROVAL_TIMEOUT_MS,
            events,
        )
        .await;

    Some(verdict_for(outcome, &request.tool_name, |tool_name| {
        session_approvals.remember(tool_name)
    }))
}

/// 把审批结论翻成给 pi 的 `value`：空串放行，非空是给模型看的理由。
///
/// 「超时」和「拒绝」的措辞刻意不同：两者都按拒绝执行，但对模型的下一步指示
/// 不一样——被明确拒绝时该换路子或问用户，而没人应答时重试同样没意义，得说清
/// 是「没等到确认」而不是「你被否了」。措辞沿用迁移前 Node 侧的两句原文。
fn verdict_for(
    outcome: Outcome,
    tool_name: &str,
    remember_session_approval: impl FnOnce(&str),
) -> String {
    match outcome {
        Outcome::Decided(Decision::Approve) => String::new(),
        Outcome::Decided(Decision::ApproveSession) => {
            remember_session_approval(tool_name);
            String::new()
        }
        Outcome::Decided(Decision::Deny) => format!(
            "用户拒绝了工具 {tool_name} 的执行。不要重试；可改用其他方式或询问用户。"
        ),
        Outcome::TimedOut => format!(
            "工具 {tool_name} 的审批在等待窗口内未获用户确认，已按拒绝处理。不要重试。"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unconfigured_tools_stay_allowed() {
        // 迁移前的缺省就是 allow；这里要是变了，所有用户都会突然被弹审批。
        assert_eq!(resolve_tool_policy("bash", None), ToolPolicy::Allow);
        assert_eq!(
            resolve_tool_policy("bash", Some(&json!({ "read": "ask" }))),
            ToolPolicy::Allow
        );
    }

    #[test]
    fn explicit_policies_are_honoured() {
        let policies = json!({ "bash": "ask", "write": "deny", "read": "allow" });
        assert_eq!(
            resolve_tool_policy("bash", Some(&policies)),
            ToolPolicy::Ask
        );
        assert_eq!(
            resolve_tool_policy("write", Some(&policies)),
            ToolPolicy::Deny
        );
        assert_eq!(
            resolve_tool_policy("read", Some(&policies)),
            ToolPolicy::Allow
        );
    }

    /// 已知收窄：Node 版支持这两级回落，这里不支持。锁住现状免得被误当成 bug 修。
    #[test]
    fn group_and_server_scoped_policies_are_not_applied() {
        let policies = json!({ "group:mcp": "deny", "server:docs": "ask" });
        assert_eq!(
            resolve_tool_policy("some_mcp_tool", Some(&policies)),
            ToolPolicy::Allow
        );
    }

    #[test]
    fn session_memory_only_covers_the_tool_it_was_granted_for() {
        let approvals = SessionApprovals::default();
        assert!(!approvals.is_allowed("bash"));
        approvals.remember("bash");
        assert!(approvals.is_allowed("bash"));
        assert!(!approvals.is_allowed("write"));
    }

    #[tokio::test]
    async fn non_approval_dialogs_are_not_ours_to_answer() {
        let verdict = resolve_ui_request(
            "conv-1",
            "某个别的扩展的对话框",
            None,
            &SessionApprovals::default(),
            &ApprovalRegistry::new(),
            Arc::new(EventBus::new()),
        )
        .await;
        assert!(verdict.is_none());
    }

    #[tokio::test]
    async fn allow_policy_short_circuits_without_bothering_the_user() {
        let title = format!(
            "{APPROVAL_MARKER}{}",
            json!({ "toolCallId": "t1", "toolName": "read", "input": { "path": "a.rs" } })
        );
        let verdict = resolve_ui_request(
            "conv-1",
            &title,
            None,
            &SessionApprovals::default(),
            &ApprovalRegistry::new(),
            Arc::new(EventBus::new()),
        )
        .await;
        assert_eq!(verdict.as_deref(), Some(""));
    }

    #[tokio::test]
    async fn deny_policy_blocks_with_a_reason_the_model_can_act_on() {
        let title = format!(
            "{APPROVAL_MARKER}{}",
            json!({ "toolCallId": "t1", "toolName": "bash", "input": {} })
        );
        let verdict = resolve_ui_request(
            "conv-1",
            &title,
            Some(&json!({ "bash": "deny" })),
            &SessionApprovals::default(),
            &ApprovalRegistry::new(),
            Arc::new(EventBus::new()),
        )
        .await
        .expect("应有裁决");
        assert!(verdict.contains("bash"));
        assert!(verdict.contains("不要重试"));
    }

    /// 会话内已 approve_session 的工具不该再问一次——这条要是坏了，
    /// 表现是「记住」按钮点了没用，但不会有任何报错。
    #[tokio::test]
    async fn remembered_tools_skip_the_approval_round_trip() {
        let session_approvals = SessionApprovals::default();
        session_approvals.remember("bash");
        let title = format!(
            "{APPROVAL_MARKER}{}",
            json!({ "toolCallId": "t1", "toolName": "bash", "input": {} })
        );

        let verdict = resolve_ui_request(
            "conv-1",
            &title,
            Some(&json!({ "bash": "ask" })),
            &session_approvals,
            &ApprovalRegistry::new(),
            Arc::new(EventBus::new()),
        )
        .await;

        assert_eq!(verdict.as_deref(), Some(""));
    }

    /// marker 对得上但载荷坏了：放行而不是拦截。拦了等于 agent 整个不可用。
    #[tokio::test]
    async fn malformed_payload_fails_open() {
        let verdict = resolve_ui_request(
            "conv-1",
            &format!("{APPROVAL_MARKER}not-json"),
            None,
            &SessionApprovals::default(),
            &ApprovalRegistry::new(),
            Arc::new(EventBus::new()),
        )
        .await;
        assert_eq!(verdict.as_deref(), Some(""));
    }

    /// 超时与拒绝都拦，但给模型的说法必须不同：被否了该换路子，
    /// 没等到确认则要说清是「没人确认」而不是「你被否了」。
    #[test]
    fn timeout_and_denial_give_the_model_different_instructions() {
        let denied = verdict_for(Outcome::Decided(Decision::Deny), "bash", |_| {});
        let timed_out = verdict_for(Outcome::TimedOut, "bash", |_| {});

        assert!(!denied.is_empty(), "拒绝必须拦截");
        assert!(!timed_out.is_empty(), "超时必须拦截");
        assert_ne!(denied, timed_out);
        assert!(denied.contains("用户拒绝"));
        assert!(timed_out.contains("未获用户确认"));
        // 两条都要明确劝阻重试，否则模型会原样再调一次。
        assert!(denied.contains("不要重试"));
        assert!(timed_out.contains("不要重试"));
    }

    #[test]
    fn approval_returns_an_empty_verdict_and_only_session_grants_are_remembered() {
        let mut remembered: Vec<String> = Vec::new();
        assert_eq!(
            verdict_for(Outcome::Decided(Decision::Approve), "bash", |name| {
                remembered.push(name.to_string())
            }),
            ""
        );
        assert!(remembered.is_empty(), "单次批准不该被记成免审");

        assert_eq!(
            verdict_for(Outcome::Decided(Decision::ApproveSession), "bash", |name| {
                remembered.push(name.to_string())
            }),
            ""
        );
        assert_eq!(remembered, vec!["bash".to_string()]);
    }

    #[tokio::test]
    async fn user_approval_lets_the_call_through() {
        // 只用真实公开 API：从广播出去的 tool-approval:request 里拿 approval_id，
        // 再走 respond——正是前端的路径。给 registry 开测试后门就测不到这段了。
        #[derive(Default)]
        struct ApprovalIdSink {
            seen: Mutex<Vec<String>>,
        }
        impl crate::events::EventSink for ApprovalIdSink {
            fn emit_json(&self, event: &str, payload: serde_json::Value) {
                if event != "tool-approval:request" {
                    return;
                }
                if let Some(id) = payload["approval_id"].as_str() {
                    if let Ok(mut seen) = self.seen.lock() {
                        seen.push(id.to_string());
                    }
                }
            }
        }

        let sink = Arc::new(ApprovalIdSink::default());
        let events = Arc::new(EventBus::new());
        events.register(Arc::clone(&sink) as Arc<dyn crate::events::EventSink>);

        let approvals = Arc::new(ApprovalRegistry::new());
        let title = format!(
            "{APPROVAL_MARKER}{}",
            json!({ "toolCallId": "t1", "toolName": "bash", "input": { "command": "ls" } })
        );

        let registry = Arc::clone(&approvals);
        let responder = tokio::spawn(async move {
            for _ in 0..400 {
                let pending = sink.seen.lock().expect("sink lock").first().cloned();
                if let Some(approval_id) = pending {
                    registry
                        .respond(&approval_id, Decision::Approve, "test")
                        .await
                        .expect("应答审批");
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            panic!("审批请求始终没广播出来");
        });

        let verdict = resolve_ui_request(
            "conv-1",
            &title,
            Some(&json!({ "bash": "ask" })),
            &SessionApprovals::default(),
            &approvals,
            events,
        )
        .await;

        responder.await.expect("应答任务");
        assert_eq!(verdict.as_deref(), Some(""));
    }
}
