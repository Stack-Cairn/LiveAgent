//! 工具审批状态机。
//!
//! Node 在执行工具前调 /api/tool_approval_request，长时间挂起直到用户在前端作出决定。
//! 前端应答经 /api/tool_approval_respond 传来，触发 respond 操作。
//!
//! 并发语义：HashMap.remove 是原子的（Rust 保证），先到先得——两个并发响应者，
//! 只有移除成功的那个算赢，另一个返回 AlreadyAnswered（HTTP 409）。

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use std::collections::HashMap;
use agent_core::events::EventBus;

/// 审批决定的三态。对应 TypeScript 侧 ToolApprovalDecision。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// 本次放行。
    Approve,
    /// 本次拒绝。
    Deny,
    /// 本会话内该工具后续免审。
    ApproveSession,
}

/// 待审批请求的参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalPayload {
    /// 工具名（e.g. "bash", "git_clone"）。
    pub tool_name: String,
    /// 命令/参数摘要（供审批卡片展示）。
    pub summary: String,
    /// 推荐项（若有的话，超时时选这个；无则超时拒绝）。
    pub recommended: Option<Decision>,
}

/// 待审批项。
#[derive(Debug)]
struct PendingApproval {
    /// payload 的摘要，供应答方查证。
    #[allow(dead_code)]
    payload: ApprovalPayload,
    /// 响应者通道。被移除后 send 即调度前端应答落定。
    sender: tokio::sync::oneshot::Sender<Decision>,
    /// 创建时间戳（毫秒）。
    #[allow(dead_code)]
    created_at_ms: u64,
}

/// 工具审批注册表。进程级共享。
pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, PendingApproval>>,
}

impl ApprovalRegistry {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// 生成当前 UTC 时间戳（毫秒）。
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// 发起审批请求。
    ///
    /// # 行为
    /// 1. 生成 approval_id（UUID v4）
    /// 2. 存入 pending 表，创建 oneshot channel
    /// 3. 经 EventBus emit "tool-approval:request" 事件，前端 WS 广播收到
    /// 4. await oneshot 或等超时时间到达
    /// 5. 超时：有推荐项选推荐项；无则 Deny
    ///
    /// # 返回
    /// (approval_id, decision) 的 tuple。
    pub async fn request(
        &self,
        payload: ApprovalPayload,
        timeout_ms: u64,
        events: Arc<EventBus>,
    ) -> (String, Decision) {
        let approval_id = Uuid::new_v4().to_string();
        let created_at_ms = Self::now_ms();

        // 创建响应通道。
        let (sender, receiver) = tokio::sync::oneshot::channel();

        // 存入 pending。
        {
            let mut pending = self.pending.lock().await;
            pending.insert(
                approval_id.clone(),
                PendingApproval {
                    payload: payload.clone(),
                    sender,
                    created_at_ms,
                },
            );
        }

        // 广播请求事件。前端 WS 收到，显示审批卡片。
        events.emit(
            "tool-approval:request",
            serde_json::json!({
                "approval_id": &approval_id,
                "tool_name": &payload.tool_name,
                "summary": &payload.summary,
                "recommended": payload.recommended.map(|d| format!("{:?}", d).to_lowercase()),
            }),
        );

        // await 超时或应答。
        let decision = tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            receiver,
        )
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_else(|| {
            // 超时：有推荐项则选推荐，无则拒绝。
            payload.recommended.unwrap_or(Decision::Deny)
        });

        // 清理 pending（幂等，可能已被 respond 移除）。
        {
            let mut pending = self.pending.lock().await;
            pending.remove(&approval_id);
        }

        (approval_id, decision)
    }

    /// 应答一个待审批项。
    ///
    /// # 行为
    /// 原子 CAS：HashMap.remove 判定先到先得。只有移除成功者能 send 决定，
    /// 触发前端应答落定。
    ///
    /// # 返回
    /// - Ok(()) 应答成功
    /// - Err("AlreadyAnswered") 该 approval_id 已被应答或不存在（HTTP 409）
    pub async fn respond(
        &self,
        approval_id: &str,
        decision: Decision,
        _responder: &str, // 仅审计用，暂不记日志
    ) -> Result<(), String> {
        let mut pending = self.pending.lock().await;

        // 原子 remove：成功说明自己是第一个应答者。
        if let Some(approval) = pending.remove(approval_id) {
            // send 可能失败（receiver 已被 drop），但这不是错误——
            // 说明 request 已因超时或被取消而落定了。静默忽略即可。
            let _ = approval.sender.send(decision);
            Ok(())
        } else {
            // 已被移除或不存在。
            Err("AlreadyAnswered".to_string())
        }
    }
}

impl Default for ApprovalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// 超时时有推荐项：自动选推荐。
    #[tokio::test]
    async fn timeout_with_recommendation() {
        let registry = Arc::new(ApprovalRegistry::new());
        let events = Arc::new(EventBus::new());
        let payload = ApprovalPayload {
            tool_name: "bash".to_string(),
            summary: "rm -rf /".to_string(),
            recommended: Some(Decision::Deny),
        };

        let (_, decision) = registry
            .request(payload, 10, events) // 10ms 超时
            .await;

        // 应该自动选了推荐的 Deny。
        assert_eq!(decision, Decision::Deny);
    }

    /// 超时时无推荐项：拒绝。
    #[tokio::test]
    async fn timeout_without_recommendation() {
        let registry = Arc::new(ApprovalRegistry::new());
        let events = Arc::new(EventBus::new());
        let payload = ApprovalPayload {
            tool_name: "git".to_string(),
            summary: "git push --force".to_string(),
            recommended: None,
        };

        let (_, decision) = registry
            .request(payload, 10, events) // 10ms 超时
            .await;

        // 应该自动拒绝。
        assert_eq!(decision, Decision::Deny);
    }

    /// 双响应：只有先者生效，后者返回 409。
    #[tokio::test]
    async fn double_response_only_first_wins() {
        let registry = Arc::new(ApprovalRegistry::new());
        let events = Arc::new(EventBus::new());
        let payload = ApprovalPayload {
            tool_name: "bash".to_string(),
            summary: "echo hello".to_string(),
            recommended: None,
        };

        // 发起 request 并让它运行（不 await，所以它在后台运行）。
        let registry_clone = Arc::clone(&registry);
        let events_clone = Arc::clone(&events);
        let payload_clone = payload.clone();
        let request_handle = tokio::spawn(async move {
            registry_clone.request(payload_clone, 5000, events_clone).await
        });

        // 等等让 request 设置好 pending 表。
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // 获取 approval_id。
        let approval_id = {
            let pending = registry.pending.lock().await;
            pending.keys().next().cloned().expect("should have pending approval")
        };

        // 两个并发响应者，用 spawn 来确保真正的并发行为。
        let (r1, r2) = {
            let r1_handle = tokio::spawn({
                let reg = Arc::clone(&registry);
                let id = approval_id.clone();
                async move { reg.respond(&id, Decision::Approve, "user1").await }
            });

            let r2_handle = tokio::spawn({
                let reg = Arc::clone(&registry);
                let id = approval_id.clone();
                async move { reg.respond(&id, Decision::Deny, "user2").await }
            });

            (r1_handle.await.unwrap(), r2_handle.await.unwrap())
        };

        // 只有一个成功，另一个失败。
        let one_ok = r1.is_ok();
        let two_ok = r2.is_ok();
        assert!(
            (one_ok && !two_ok) || (!one_ok && two_ok),
            "expected exactly one Ok and one Err, got r1.is_ok()={}, r2.is_ok()={}",
            one_ok,
            two_ok
        );

        // 确保请求任务也完成了。
        request_handle.abort();
    }

    /// 正常应答：应答成功，request 立即返回应答的决定。
    #[tokio::test]
    async fn normal_response() {
        let registry = Arc::new(ApprovalRegistry::new());
        let events = Arc::new(EventBus::new());
        let payload = ApprovalPayload {
            tool_name: "bash".to_string(),
            summary: "ls -la".to_string(),
            recommended: Some(Decision::Deny),
        };

        let registry_clone = Arc::clone(&registry);
        let events_clone = Arc::clone(&events);
        let payload_clone = payload.clone();

        // 在后台发起 request。
        let request_handle = tokio::spawn(async move {
            registry_clone
                .request(payload_clone, 5000, events_clone)
                .await
        });

        // 给 request 一点时间进行设置。
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // 直接遍历 pending 来获取 approval_id（因为测试可以这样做）。
        let approval_id = {
            let pending = registry.pending.lock().await;
            pending.keys().next().cloned().expect("should have pending approval")
        };

        // 前端应答。
        let respond_result = registry
            .respond(&approval_id, Decision::Approve, "frontend-user")
            .await;

        assert!(respond_result.is_ok());

        // request 应该立即返回应答的决定。
        let (returned_id, returned_decision) = request_handle.await.unwrap();
        assert_eq!(returned_decision, Decision::Approve);
        assert_eq!(returned_id, approval_id);
    }

    /// 应答不存在的 approval_id：返回错误。
    #[tokio::test]
    async fn respond_to_nonexistent_approval() {
        let registry = ApprovalRegistry::new();
        let result = registry
            .respond("nonexistent-id", Decision::Approve, "user")
            .await;

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "AlreadyAnswered");
    }
}
