# 输入框提示词澄清 · 计划 2：Web（agent-gateway）接线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web 端（`crates/agent-gateway/web`）的 `ChatComposerBar` 澄清按钮可用——点击后经 gateway RPC `clarify.prompt_turn` 转发到桌面 agent 执行一次纯文本补全，产出优化提示词回填输入框。

**Architecture:** 浏览器 WS → gateway（`browserConn.handleAgentRequest` 直通转发 + `vetAgentRequest` 白名单）→ 桌面端 Rust `envelope_handler` → 新增 unary 桥（oneshot pending + emit 事件）→ 桌面端 TS 运行时（复用 GUI 计划 1 的 clarify 执行逻辑 `streamAssistantMessage`）→ 回传文本。Web 宿主 `GatewayAppView` 复用 `agent-ui` 的 `ChatComposerBar`，只需注入 `runClarifyTurn` / `clarifyContext` 两个 props——clarify 按钮/面板/状态机全部自动生效。请求携带 Web 当前选中的模型（provider_id + model + runtime_controls），桌面端按此构造 provider runtime。

**Tech Stack:** protobuf（`proto/v2/gateway.proto`）、Go（`internal/protocol/pbws/guard.go`）、Rust（`services/gateway/`）、TypeScript（`crates/agent-gui/src/pages/chat/gateway/` + `crates/agent-gateway/web/src/lib/gatewaySocketV2/`）。

**Spec:** `docs/superpowers/specs/2026-08-30-composer-clarify-design.md`

## Global Constraints

- 终稿协议标记：`[CLARIFY_QUESTION]` / `[CLARIFY_FINAL]` 单行置于回复开头——**Web 宿主逐字复用 `clarifyProtocol.ts`，不新建协议**（spec 实施偏差记录）。
- 澄清轮次整段返回，无需流式（spec「Web 宿主」节：服务端执行一次文本补全并整段返回）。
- 模型用 Web 当前会话选中的主模型（`activeSelectedModel` + `currentChatProvider` + `chatRuntimeControlsForCurrentProvider`），经 RPC 传给桌面端。
- 无模型配置时按钮隐藏（与 GUI 一致；spec 实施偏差记录「Web 接线时统一决定」→ 定 hidden）。
- 澄清会话不持久化、不进会话历史；面板关闭即丢弃。
- i18n 复用 agent-ui `LocaleContext` + `chat.clarify.*` 键（Web 已 import `t as translate`），无需新增键。
- proto 修改后双端生成：Go 走 `buf generate`，桌面端 Rust 走 build.rs prost-build（`cargo build` 自动）。
- 测试：Web RPC 对齐 `crates/agent-gateway/test/webui/gateway-socket-client.test.mjs` 现有 envelope 模式；Go 白名单测试对齐 `guard_test.go`。
- 代码注释风格跟随周边：中文注释、说明「为什么」。

## 现有代码事实（实施者必读）

- **Web→gateway 直通**：`browserConn.handleAgentRequest`（`crates/agent-gateway/internal/protocol/pbws/browser_relay.go:17`）白名单校验（`vetAgentRequest`，`guard.go:24`）→ request_id 命名空间化 → `sm.AwaitUnaryResponse` → 还原回传。载荷 proto 直通，gateway 不解析业务字段。
- **gateway→桌面端**：`connection.rs` dispatcher → `envelope_handler.rs:28 handle_gateway_envelope` 大 match。每个 arm 模式：`Some(proto::gateway_envelope::Payload::X(req)) => { let r = gateway_bridge::handle_x(req).await; self.send_agent_envelope(payload: Some(Payload::XResp(r))).await }`。
- **Rust→TS unary 桥模板**：`chat.rs:258 handle_chat_queue_request` —— oneshot channel 塞进 pending map → `app_handle.emit("gateway:chat-queue-request", event)` → `tokio::time::timeout(30s, rx)` → `send_agent_envelope`。TS 侧 `respond_chat_queue_request`（`chat.rs:340`）收 invoke 回传 → pending tx send。**clarify 照抄此模式。**
- **TS 侧 chat 执行**：`useGatewayBridgeListeners.ts:349 handleGatewayChatRequest`（inbox 队列 + claim 租约，为 chat command 设计，复杂度高）。clarify 不需要这套——**独立轻量 unary 桥**，监听新事件直接执行。
- **GUI clarify 执行器**：`createGuiClarifyRunner`（`crates/agent-gui/src/pages/chat/runtime/clarifyRunner.ts:78`）接收 `getSelection`（`resolveEffectiveChatModelSelection`）和 `getRuntime`（`createProviderRuntimeConfig(provider, model, chatRuntimeControls)`）。ChatPage.tsx:2086 `getConversationClarifyRunner` 展示了完整构造。
- **Web RPC 客户端**：`gatewaySocketRpc.ts` 的 `GatewayWebSocketRpcClient`，`this.request<T>("rpc.name", payload)`（`gatewaySocketTransport.ts:860`）。`clarify.prompt_turn` 不在 `AGENT_ID_OPTIONAL_REQUEST_TYPES`（`gatewaySocketShared.ts:891`，仅 `agent.list`/`chat.activities`）→ 自动要求 agent id，无需改动。
- **adapters 映射**：`agentRequestPayload(type, body)`（`gatewaySocketV2/adapters.ts:388`）把字符串 type 映射到 `GatewayEnvelope` typed oneof payload。
- **Web 模型状态**：`useGatewayChatConfiguration`（`web/src/app/hooks/useGatewayChatConfiguration.ts:40`）——`activeSelectedModel{customProviderId, model}`、`currentChatProvider`（含 `type`/`requestFormat`）、`chatRuntimeControlsForCurrentProvider`。注入点在 `GatewayAppView.tsx:754 <ChatComposerBar>`。
- **proto 生成**：Go `internal/proto/v2/gateway.pb.go` 由 `buf generate`（`buf.yaml`）生成；桌面端 `src-tauri/build.rs:42` prost-build 编译 `agent-gateway/proto/v2/gateway.proto`（cargo build 自动）。
- **proto 字段号**：`GatewayEnvelope` oneof 已到 100（`installed_apps_list`）；`AgentEnvelope` oneof 已到 105（`installed_apps_list_resp`）。新字段用 101 / 106。

---

### Task 1: proto 定义 + 双端生成

**Files:**
- Modify: `crates/agent-gateway/proto/v2/gateway.proto`
- 生成物（不手改）：`crates/agent-gateway/internal/proto/v2/gateway.pb.go`、桌面端 `src-tauri/src/proto/*.rs`（cargo 自动）

**Interfaces:**
- Consumes: 无。
- Produces（后续任务依赖的确切类型）:
  - `ClarifyTurnRequest { messages_json: string; provider_id: string; model: string; request_format: string; runtime_controls: ChatRuntimeControls; workdir: string; git_branch: string }`
  - `ClarifyTurnResponse { final_text: string; error_code: string; error_message: string }`
  - `GatewayEnvelope.clarify_turn`（oneof 字段，号 101）
  - `AgentEnvelope.clarify_turn_resp`（oneof 字段，号 106；105 已被 `installed_apps_list_resp` 占用）

- [ ] **Step 1: 在 gateway.proto 追加消息定义**

在 `proto/v2/gateway.proto` 中 `ChatRuntimeControls`（163 行）之后追加：

```proto
// 澄清轮次（Web 计划 2）：浏览器经 gateway 转发到桌面 agent 的一次纯文本补全。
// messages 走 JSON 字符串（ClarifyMessage[]，见 agent-ui clarifyTypes），避免为
// 澄清会话引入新的一等消息类型；provider/model/runtime 由 Web 当前选中下发，
// 桌面端按此构造 provider runtime。
message ClarifyTurnRequest {
  string messages_json = 1;
  string provider_id = 2;
  string model = 3;
  string request_format = 4;
  ChatRuntimeControls runtime_controls = 5;
  string workdir = 6;
  string git_branch = 7;
}

message ClarifyTurnResponse {
  string final_text = 1;
  string error_code = 2;
  string error_message = 3;
}
```

- [ ] **Step 2: GatewayEnvelope / AgentEnvelope 加 oneof 字段**

`GatewayEnvelope` 的 oneof payload（14 行起，末尾 `installed_apps_list = 100;` 之后）：

```proto
    ClarifyTurnRequest clarify_turn = 101;
```

`AgentEnvelope` 的 oneof payload（81 行起，末尾 `trajectory_fetch_resp = 104;` 之后）：

```proto
    ClarifyTurnResponse clarify_turn_resp = 106;
```

- [ ] **Step 3: Go 端重新生成 proto**

Run: `cd crates/agent-gateway && buf generate`
Expected: `internal/proto/v2/gateway.pb.go` 更新，出现 `GatewayEnvelope_ClarifyTurn` 与 `AgentEnvelope_ClarifyTurnResp`。

- [ ] **Step 4: 桌面端 Rust 自动生成**

Run: `cd crates/agent-gui/src-tauri && cargo check`
Expected: 编译通过，`src-tauri/src/proto/gateway.rs`（OUT_DIR 生成）出现 `clarify_turn` 相关类型。若 Rust 侧 proto 模块暴露方式与预期不同（`cargo check` 报缺字段），按报错定位生成路径——build.rs 已 rerun-if-changed，无需手动触发。

- [ ] **Step 5: 提交**

```bash
git add crates/agent-gateway/proto/v2/gateway.proto crates/agent-gateway/internal/proto/v2/gateway.pb.go
git commit -m "feat(clarify): add ClarifyTurnRequest/Response proto for web phase 2"
```

---

### Task 2: Go 白名单直通

**Files:**
- Modify: `crates/agent-gateway/internal/protocol/pbws/guard.go:72`
- Test: `crates/agent-gateway/internal/protocol/pbws/guard_test.go`

**Interfaces:**
- Consumes: `GatewayEnvelope_ClarifyTurn`（Task 1）。
- Produces: 无（白名单放行，转发由 `browser_relay.go` 既有逻辑承担）。

- [ ] **Step 1: 写失败测试**

`guard_test.go` 追加（对齐文件现有 `TestVetAgentRequest*` 风格，先读文件头部确认测试辅助函数）：

```go
func TestVetAgentRequestAllowsClarifyTurn(t *testing.T) {
	sm := &fakeAgentView{} // 对齐本文件现有 fake/mock
	err := vetAgentRequest(sm, &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_ClarifyTurn{
			ClarifyTurn: &gatewayv2.ClarifyTurnRequest{
				MessagesJson: `[{"role":"user","content":"hi"}]`,
				ProviderId:   "builtin-gemini",
				Model:        "gemini-2.0-flash",
			},
		},
	})
	if err != nil {
		t.Fatalf("clarify_turn should be passthrough, got %v", err)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd crates/agent-gateway && go test ./internal/protocol/pbws/ -run TestVetAgentRequestAllowsClarifyTurn -v`
Expected: FAIL，`unsupported agent_request payload`。

- [ ] **Step 3: 白名单加直通臂**

`guard.go:72` 的普通直通臂 case 列表（`*gatewayv2.GatewayEnvelope_ChatQueue:` 之后）追加：

```go
		// 澄清轮次：一次纯文本补全，载荷转发给桌面端执行，无网关侧门控。
		*gatewayv2.GatewayEnvelope_ClarifyTurn,
```

注意：是追加进**现有 `return nil` 的 case 组**，不是新增独立 case（与其他普通直通臂同组）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd crates/agent-gateway && go test ./internal/protocol/pbws/`
Expected: PASS（新测试 + 既有测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add crates/agent-gateway/internal/protocol/pbws/guard.go crates/agent-gateway/internal/protocol/pbws/guard_test.go
git commit -m "feat(clarify): allow clarify_turn passthrough in gateway vet"
```

---

### Task 3: 桌面端 Rust unary 桥

**Files:**
- Create: `crates/agent-gui/src-tauri/src/services/gateway/clarify.rs`
- Modify: `crates/agent-gui/src-tauri/src/services/gateway/mod.rs`
- Modify: `crates/agent-gui/src-tauri/src/services/gateway/envelope_handler.rs`
- Modify: `crates/agent-gui/src-tauri/src/lib.rs`（invoke 注册）

**Interfaces:**
- Consumes: `gateway_envelope::Payload::ClarifyTurn` / `agent_envelope::Payload::ClarifyTurnResp`（Task 1）。
- Produces（Task 4 依赖）:
  - 事件名常量 `"gateway:clarify-turn-requested"`，载荷 `GatewayClarifyTurnRequestEvent { request_id, messages_json, provider_id, model, request_format, runtime_controls_json, workdir, git_branch }`
  - invoke 命令 `gateway_clarify_respond`：参数 `{ request_id, final_text?, error_code?, error_message? }`
  - `GatewayClarifyRespondInput` 类型（Rust，响应结构化：成功 final_text / 失败 error_*）

- [ ] **Step 1: 新建 clarify.rs（模板照抄 chat.rs 的 handle_chat_queue_request）**

先读 `chat.rs:258-345`（handle_chat_queue_request + respond_chat_queue_request + send_chat_queue_response）和 `mod.rs:110-130`（`pending_chat_queue_requests` 字段声明、`GatewayChatQueueRequestEvent` 结构、`GatewayChatQueueResponseInput`），确认 `oneshot`、`now_unix_seconds`、`send_agent_envelope` 的导入与 self 字段写法后照抄。

```rust
// services/gateway/clarify.rs
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::chat::now_unix_seconds; // 若 now_unix_seconds 在 chat.rs，改为本地或按仓库现状
use crate::proto::{agent_envelope, gateway_envelope};

pub(crate) const GATEWAY_CLARIFY_TURN_REQUESTED_EVENT: &str = "gateway:clarify-turn-requested";

/// Rust → TS 的澄清轮次事件载荷。runtime_controls 以 JSON 字符串传递，
/// TS 侧 parse 回 ChatRuntimeControls（复用 agent-ui 的 normalize 逻辑）。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayClarifyTurnRequestEvent {
    pub request_id: String,
    pub messages_json: String,
    pub provider_id: String,
    pub model: String,
    pub request_format: String,
    pub runtime_controls_json: String,
    pub workdir: String,
    pub git_branch: String,
}

/// TS 侧经 invoke gateway_clarify_respond 回传的结果。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayClarifyRespondInput {
    pub request_id: String,
    pub final_text: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl GatewayClarifyTurnRequestEvent {
    pub(crate) fn from_request(request_id: String, request: crate::proto::ClarifyTurnRequest) -> Self {
        Self {
            request_id,
            messages_json: request.messages_json,
            provider_id: request.provider_id,
            model: request.model,
            request_format: request.request_format,
            runtime_controls_json: request
                .runtime_controls
                .map(|rc| serde_json::to_string(&rc).unwrap_or_default())
                .unwrap_or_default(),
            workdir: request.workdir,
            git_branch: request.git_branch,
        }
    }
}

impl From<GatewayClarifyRespondInput> for crate::proto::ClarifyTurnResponse {
    fn from(input: GatewayClarifyRespondInput) -> Self {
        crate::proto::ClarifyTurnResponse {
            final_text: input.final_text.unwrap_or_default(),
            error_code: input.error_code.unwrap_or_default(),
            error_message: input.error_message.unwrap_or_default(),
        }
    }
}
```

- [ ] **Step 2: 实现 handle_clarify_turn + respond_clarify_turn + 发响应**

在 `clarify.rs` 追加（pending map 用与 `pending_chat_queue_requests` 相同的锁容器，字段声明加进 `GatewayController`）：

```rust
impl GatewayController {
    pub(crate) async fn handle_clarify_turn(
        self: &Arc<Self>,
        request_id: String,
        request: crate::proto::ClarifyTurnRequest,
    ) -> Result<(), String> {
        let event_payload = GatewayClarifyTurnRequestEvent::from_request(request_id.clone(), request);

        let (tx, rx) = oneshot::channel();
        self.pending_clarify_turns
            .lock()
            .map_err(|_| "gateway clarify turn lock poisoned".to_string())?
            .insert(request_id.clone(), tx);

        if let Err(error) = self
            .app_handle
            .emit(GATEWAY_CLARIFY_TURN_REQUESTED_EVENT, event_payload)
        {
            let _ = self
                .pending_clarify_turns
                .lock()
                .map(|mut pending| pending.remove(&request_id));
            return self
                .send_clarify_turn_response(
                    request_id,
                    crate::proto::ClarifyTurnResponse {
                        final_text: String::new(),
                        error_code: "emit_failed".to_string(),
                        error_message: format!("emit gateway clarify turn failed: {error}"),
                    },
                )
                .await;
        }

        let response = match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => crate::proto::ClarifyTurnResponse {
                final_text: String::new(),
                error_code: "response_dropped".to_string(),
                error_message: "clarify turn response dropped".to_string(),
            },
            Err(_) => {
                let _ = self
                    .pending_clarify_turns
                    .lock()
                    .map(|mut pending| pending.remove(&request_id));
                crate::proto::ClarifyTurnResponse {
                    final_text: String::new(),
                    error_code: "timeout".to_string(),
                    error_message: "clarify turn timed out".to_string(),
                }
            }
        };

        self.send_clarify_turn_response(request_id, response).await
    }

    pub(crate) async fn send_clarify_turn_response(
        &self,
        request_id: String,
        response: crate::proto::ClarifyTurnResponse,
    ) -> Result<(), String> {
        self.send_agent_envelope(crate::proto::AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(agent_envelope::Payload::ClarifyTurnResp(response)),
        })
        .await
    }

    pub(crate) fn respond_clarify_turn(
        &self,
        input: GatewayClarifyRespondInput,
    ) -> Result<(), String> {
        let Some(tx) = self
            .pending_clarify_turns
            .lock()
            .map_err(|_| "gateway clarify turn lock poisoned".to_string())?
            .remove(&input.request_id)
        else {
            return Ok(()); // 已超时/已移除：静默丢弃迟到的响应。
        };
        tx.send(crate::proto::ClarifyTurnResponse::from(input))
            .map_err(|_| "gateway clarify turn response receiver dropped".to_string())
    }
}
```

- [ ] **Step 3: 注册字段 + mod + envelope_handler arm**

`mod.rs`：
- `pub(crate) mod clarify;`（模块声明，含 `GatewayClarifyTurnRequestEvent`/`GatewayClarifyRespondInput` 重导出供 commands 用）
- `GatewayController` 字段追加：

```rust
    pub(crate) pending_clarify_turns:
        std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<crate::proto::ClarifyTurnResponse>>>,
```

在既有 `pending_chat_queue_requests` 字段初始化处同步初始化。

`envelope_handler.rs` 的 match 追加（对齐 `ChatQueue` arm 写法，见 85-90 行）：

```rust
            Some(proto::gateway_envelope::Payload::ClarifyTurn(request)) => {
                if let Err(error) = self.handle_clarify_turn(request_id, request).await {
                    eprintln!("handle clarify turn failed: {error}");
                }
            }
```

- [ ] **Step 4: lib.rs 注册 invoke**

在 `lib.rs` 的 `invoke_handler` 列表（参考 `gateway_chat_claim_next` / `gateway_chat_queue_respond` 的注册位置）加：

```rust
            commands::gateway::clarify_respond,
```

在 `commands/gateway.rs`（或现有 gateway commands 模块）新增命令：

```rust
#[tauri::command]
pub(crate) fn clarify_respond(
    state: tauri::State<'_, Arc<crate::services::gateway::GatewayController>>,
    input: crate::services::gateway::clarify::GatewayClarifyRespondInput,
) -> Result<(), String> {
    state.respond_clarify_turn(input)
}
```

先读 `commands/gateway.rs` 现有 `chat_queue_respond`（或同名）命令写法，对齐 `#[tauri::command]` 的 State 获取与返回风格。

- [ ] **Step 5: 编译验证**

Run: `cd crates/agent-gui/src-tauri && cargo check`
Expected: 编译通过。若 `GatewayController` 字段/`commands/gateway.rs` 结构不同，按报错调整——语义不变。

- [ ] **Step 6: 提交**

```bash
git add crates/agent-gui/src-tauri/src/services/gateway/ crates/agent-gui/src-tauri/src/lib.rs
git commit -m "feat(clarify): desktop gateway unary bridge for clarify turns"
```

---

### Task 4: 桌面端 TS bridge + ChatPage 执行器注入

**Files:**
- Modify: `crates/agent-gui/src/pages/chat/gateway/useGatewayBridgeListeners.ts`
- Modify: `crates/agent-gui/src/pages/chat/gateway/gatewayBridgeTypes.ts`（或事件类型所在文件，先 grep `GatewayChatQueueRequestEvent` 定位）
- Modify: `crates/agent-gui/src/pages/ChatPage.tsx`

**Interfaces:**
- Consumes: 事件 `gateway:clarify-turn-requested`、invoke `gateway_clarify_respond`（Task 3）；`createGuiClarifyRunner`（clarifyRunner.ts:78）；`createProviderRuntimeConfig`（lib/providers/llm.ts）；`ClarifyMessage` / `RunClarifyTurn`（agent-ui clarifyTypes）。
- Produces: 无（终端执行器）。

- [ ] **Step 1: 类型定义**

事件类型文件（grep 定位 `GatewayChatQueueRequestEvent` 的 TS 定义处，同文件追加）：

```ts
export interface GatewayClarifyTurnRequestEvent {
  request_id: string;
  messages_json: string;
  provider_id: string;
  model: string;
  request_format: string;
  runtime_controls_json: string;
  workdir: string;
  git_branch: string;
}

export interface GatewayClarifyRespondInput {
  request_id: string;
  final_text?: string;
  error_code?: string;
  error_message?: string;
}
```

- [ ] **Step 2: params 加执行器方法**

`useGatewayBridgeListeners.ts` 的 `UseGatewayBridgeListenersParams` 追加一个注入方法（ChatPage 提供，见 Step 4）：

```ts
  /** 执行一次澄清补全（Web 下发模型选择）。返回 assistant 全文文本。 */
  runGatewayClarifyTurn: (
    messages: ClarifyMessage[],
    selection: {
      providerId: string;
      providerType: string;
      model: string;
      requestFormat: string;
    },
    runtimeControls: ChatRuntimeControls,
  ) => Promise<string>;
```

- [ ] **Step 3: 监听事件 + 执行 + 回传**

`useGatewayBridgeListeners.ts` 内（对齐 `listen<GatewayChatRequestReadyEvent>("gateway:chat-request-ready", ...)` 的注册写法，约 618 行）：

```ts
    const handleClarifyTurnRequested = async (
      event: GatewayClarifyTurnRequestEvent,
    ) => {
      const { request_id } = event;
      let final_text = "";
      let error_code: string | undefined;
      let error_message: string | undefined;
      try {
        let messages: ClarifyMessage[];
        try {
          messages = JSON.parse(event.messages_json) as ClarifyMessage[];
        } catch {
          messages = [{ role: "user", content: event.messages_json }];
        }
        const runtimeControls = event.runtime_controls_json
          ? (JSON.parse(event.runtime_controls_json) as Partial<ChatRuntimeControls>)
          : undefined;
        final_text = await latestParamsRef.current.runGatewayClarifyTurn(
          messages,
          {
            providerId: event.provider_id,
            providerType: event.provider_id,
            model: event.model,
            requestFormat: event.request_format,
          },
          normalizeChatRuntimeControls(runtimeControls),
        );
      } catch (error) {
        error_code = "execution_error";
        error_message = error instanceof Error ? error.message : String(error);
      } finally {
        await invoke<unknown>("gateway_clarify_respond", {
          request_id,
          final_text: final_text || undefined,
          error_code,
          error_message,
        }).catch((error: unknown) => {
          console.warn("gateway_clarify_respond failed", error);
        });
      }
    };

    void listen<GatewayClarifyTurnRequestEvent>(
      "gateway:clarify-turn-requested",
      handleClarifyTurnRequested,
    ).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlistenClarifyTurnRequested = dispose;
    });
```

`disposed` / `unlisten*` 变量对齐文件现有模式声明。`normalizeChatRuntimeControls` 已 import（第 6 行）。

- [ ] **Step 4: ChatPage 注入执行器**

`ChatPage.tsx`：传给 `useGatewayBridgeListeners` 的 params 追加 `runGatewayClarifyTurn`。实现按 Web 下发的模型选择构造 provider runtime（对齐 `getConversationClarifyRunner` 的 `createProviderRuntimeConfig` 用法，ChatPage.tsx:2096-2103）：

```ts
      runGatewayClarifyTurn: async (messages, selection, runtimeControls) => {
        const provider = settings.providers.find(
          (p) => p.id === selection.providerId,
        );
        if (!provider) {
          throw new Error(`clarify provider not found: ${selection.providerId}`);
        }
        const runtime = createProviderRuntimeConfig(
          provider,
          selection.model,
          runtimeControls,
        );
        const assistant = await streamAssistantMessage({
          providerId: selection.providerId,
          model: selection.model,
          runtime,
          signal: new AbortController().signal,
          cacheRetention: "none",
          nativeWebSearch: false,
          context: buildClarifyCallContextFromJson(messages),
          onTextDelta: undefined,
        });
        return assistantMessageToText(assistant);
      },
```

`buildClarifyCallContextFromJson`：解析 `messages_json` 后复用 `clarifyRunner.ts` 的 `buildClarifyCallContext`（把 `system` 消息并入 `systemPrompt`、user/assistant 映射为 `Context`）。从 `clarifyRunner.ts` 导出该内部函数，或在新方法里内联同样逻辑（读 clarifyRunner.ts:50-72 照抄）。`settings.providers` 的字段名以仓库实际类型为准（provider `id`/`type`/`requestFormat`）。

- [ ] **Step 5: 类型检查**

Run: `cd crates/agent-gui && npx tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
git add crates/agent-gui/src/pages/chat/gateway/ crates/agent-gui/src/pages/ChatPage.tsx
git commit -m "feat(clarify): desktop TS bridge executes gateway clarify turns"
```

---

### Task 5: Web adapters + RPC 客户端 + 测试

**Files:**
- Modify: `crates/agent-gateway/web/src/lib/gatewaySocketV2/adapters.ts`
- Modify: `crates/agent-gateway/web/src/lib/gatewaySocketRpc.ts`
- Test: `crates/agent-gateway/test/webui/gateway-socket-client.test.mjs`

**Interfaces:**
- Consumes: `ClarifyTurnRequest`/`ClarifyTurnResponse` proto（Task 1 生成物，`web/src/lib/proto/gen/`）。
- Produces（Task 6 依赖）:
  - `GatewayWebSocketRpcClient.clarifyPromptTurn(input): Promise<{ final_text: string; error_code?: string; error_message?: string }>`
  - input: `{ messages: ClarifyMessage[]; providerId: string; model: string; requestFormat: string; runtimeControls?: ChatRuntimeControls; workdir: string; gitBranch?: string }`

- [ ] **Step 1: adapters 加 type 映射**

`adapters.ts` 的 `agentRequestPayload`（388 行）switch 末尾（`trajectory.fetch` case 之后）加：

```ts
    case "clarify.prompt_turn":
      return {
        case: "clarifyTurn",
        value: create(ClarifyTurnRequestSchema, {
          messages_json: typeof body.messages === "string" ? body.messages : JSON.stringify(body.messages ?? []),
          provider_id: trimStr(body.provider_id),
          model: trimStr(body.model),
          request_format: trimStr(body.request_format),
          runtime_controls: body.runtime_controls
            ? create(ChatRuntimeControlsSchema, {
                thinking_enabled: bool(rec(body.runtime_controls).thinking_enabled),
                native_web_search_enabled: bool(
                  rec(body.runtime_controls).native_web_search_enabled,
                ),
                reasoning: str(rec(body.runtime_controls).reasoning),
                plan_mode_enabled: bool(rec(body.runtime_controls).plan_mode_enabled),
              })
            : undefined,
          workdir: trimStr(body.workdir),
          git_branch: trimStr(body.git_branch),
        }),
      };
```

`ClarifyTurnRequestSchema` / `ChatRuntimeControlsSchema` 需加入文件顶部 schema import（对齐 `MemoryManageRequestSchema` 等现有 import 列表，`adapters.ts:60-90`）。先 `grep ClarifyTurnRequestSchema` 确认 proto 生成的 schema 导出名（在 `web/src/lib/proto/gen/`）。

- [ ] **Step 2: RPC 客户端方法**

`gatewaySocketRpc.ts` 的 `GatewayWebSocketRpcClient` 加（对齐 `trajectoryFetch` 风格）：

```ts
  async clarifyPromptTurn(input: {
    messages: ClarifyMessage[];
    providerId: string;
    model: string;
    requestFormat: string;
    runtimeControls?: ChatRuntimeControls;
    workdir: string;
    gitBranch?: string;
  }): Promise<{
    final_text: string;
    error_code?: string;
    error_message?: string;
  }> {
    return this.request("clarify.prompt_turn", {
      messages: input.messages,
      provider_id: input.providerId,
      model: input.model,
      request_format: input.requestFormat,
      runtime_controls: input.runtimeControls,
      workdir: input.workdir,
      git_branch: input.gitBranch ?? "",
    });
  }
```

`ClarifyMessage` 从 `@liveagent/ui/components/chat/clarify/clarifyTypes` import；`ChatRuntimeControls` 从既有 import 拿。

- [ ] **Step 3: 写失败测试（帧断言）**

`gateway-socket-client.test.mjs` 追加（对齐 `memory manage payloads` 用例，603-634 行——`installBrowser` + `loadGatewaySocket` + `findAgentRequest` + `receiveBinary` 骨架照抄）：

```js
test("GatewayWebSocketClient sends clarify prompt turn payloads", async () => {
  installBrowser();
  const { codec, getGatewayWebSocketClient, resetGatewayWebSocketClient } = loadGatewaySocket();
  resetGatewayWebSocketClient();

  const client = getGatewayWebSocketClient("token");
  const clarifyPromise = client.clarifyPromptTurn({
    messages: [{ role: "user", content: "帮我做一个网站" }],
    providerId: "builtin-gemini",
    model: "gemini-2.0-flash",
    requestFormat: "google",
    workdir: "/repo/x",
    gitBranch: "main",
  });
  const socket = await connectAndAuth(codec);
  await waitFor(() => findAgentRequest(codec, socket, "clarify_turn"), "clarify frame");
  const request = findAgentRequest(codec, socket, "clarify_turn");
  assert.deepEqual(JSON.parse(request.json.agent_request.clarify_turn.messages_json), [
    { role: "user", content: "帮我做一个网站" },
  ]);
  assert.equal(request.json.agent_request.clarify_turn.provider_id, "builtin-gemini");
  assert.equal(request.json.agent_request.clarify_turn.model, "gemini-2.0-flash");
  assert.equal(request.json.agent_request.clarify_turn.workdir, "/repo/x");
  assert.equal(request.json.agent_request.clarify_turn.git_branch, "main");

  socket.receiveBinary(
    codec.encodeServerFrame({
      request_id: request.requestId,
      agent_response: {
        clarify_turn_resp: {
          final_text: "优化后的提示词",
        },
      },
    }),
  );

  assert.deepEqual(await clarifyPromise, { final_text: "优化后的提示词" });
  resetGatewayWebSocketClient();
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd crates/agent-gateway && node ../../scripts/run-node-tests.mjs test/webui/gateway-socket-client.test.mjs`
Expected: PASS（新用例 + 既有全绿）。

- [ ] **Step 5: 提交**

```bash
git add crates/agent-gateway/web/src/lib/gatewaySocketV2/adapters.ts crates/agent-gateway/web/src/lib/gatewaySocketRpc.ts crates/agent-gateway/test/webui/gateway-socket-client.test.mjs
git commit -m "feat(clarify): web clarify_prompt_turn RPC client + frame test"
```

---

### Task 6: Web 宿主注入

**Files:**
- Modify: `crates/agent-gateway/web/src/app/GatewayAppView.tsx`
- Modify: `crates/agent-gateway/web/src/app/GatewayApp.tsx`

**Interfaces:**
- Consumes: `clarifyPromptTurn`（Task 5）；`activeSelectedModel`/`currentChatProvider`/`chatRuntimeControlsForCurrentProvider`（useGatewayChatConfiguration）；`displayedConversationWorkdir`。
- Produces: 无（终端注入，`ChatComposerBar` 的 `runClarifyTurn`/`clarifyContext` props 接上）。

- [ ] **Step 1: GatewayApp.tsx 传递所需模型状态到 View**

`GatewayAppView` 已从 props 拿 `activeSelectedModel`/`currentChatProvider`/`chatRuntimeControlsForCurrentProvider` 吗？先 grep——若 View 只有 `selectedValue`/`currentModelLabel` 等派生值，则在 `GatewayApp.tsx` 的 `<GatewayAppView ...>` props 追加传递：

```tsx
    activeSelectedModel={activeSelectedModel}
    currentChatProvider={currentChatProvider}
    chatRuntimeControlsForCurrentProvider={chatRuntimeControlsForCurrentProvider}
```

（对齐现有 props 传递风格；View 组件 props 类型同步加字段。）

- [ ] **Step 2: GatewayAppView.tsx 构造 runClarifyTurn + clarifyContext**

`GatewayAppView.tsx` 内，`<ChatComposerBar>`（754 行）前构造执行器（对齐组件内既有 useMemo/useCallback 风格）：

```tsx
  const runClarifyTurn = useCallback<RunClarifyTurn>(
    async (messages, _signal) => {
      if (!activeSelectedModel || !currentChatProvider) {
        throw new Error("no active model selected");
      }
      const result = await api.clarifyPromptTurn({
        messages,
        providerId: currentChatProvider.id,
        model: activeSelectedModel.model,
        requestFormat: currentChatProvider.requestFormat ?? "",
        runtimeControls: chatRuntimeControlsForCurrentProvider,
        workdir: displayedConversationWorkdir,
        gitBranch: displayedConversationGitBranch,
      });
      if (result.error_code) {
        throw new Error(result.error_message || result.error_code);
      }
      return result.final_text;
    },
    [
      activeSelectedModel,
      currentChatProvider,
      chatRuntimeControlsForCurrentProvider,
      displayedConversationWorkdir,
      displayedConversationGitBranch,
    ],
  );

  const clarifyContext = useMemo<ClarifyContext | undefined>(
    () => (displayedConversationWorkdir ? { workdir: displayedConversationWorkdir } : undefined),
    [displayedConversationWorkdir],
  );
```

`api` 是组件里已有的 gateway WS 客户端实例（grep 确认变量名，可能叫 `api` 或 `gatewayApi`）。`displayedConversationGitBranch`：若已有现成 git 分支状态则复用；否则省略该字段（`clarifyContext` 只喂 workdir，`runClarifyTurn` 的 gitBranch 传空串——spec 允许轻量上下文，workdir 即可）。

- [ ] **Step 3: ChatComposerBar 注入 props**

`GatewayAppView.tsx:754` 的 `<ChatComposerBar>` 追加：

```tsx
                          runClarifyTurn={runClarifyTurn}
                          clarifyContext={clarifyContext}
```

`RunClarifyTurn` / `ClarifyContext` 类型从 `@liveagent/ui/components/chat/clarify/clarifyTypes` import（文件已 import `ChatComposerBar`，加类型 import 即可）。

- [ ] **Step 4: 类型检查**

Run: `cd crates/agent-gateway/web && npx tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 5: 提交**

```bash
git add crates/agent-gateway/web/src/app/GatewayAppView.tsx crates/agent-gateway/web/src/app/GatewayApp.tsx
git commit -m "feat(clarify): wire web clarify runner into gateway composer"
```

---

### Task 7: 端到端手测

**Files:** 无新文件（验证任务）。

- [ ] **Step 1: 启动桌面端 + gateway**

- 启动桌面 GUI（`cd crates/agent-gui && pnpm tauri dev`，后台）。确保桌面 agent 连上 gateway（状态栏显示已连接）。
- 启动 gateway（`cd crates/agent-gateway && go run ./cmd/gateway`，或仓库现有启动方式）。

- [ ] **Step 2: 浏览器验收清单**

1. 浏览器开 gateway Web UI，选一个已配置模型（如 MiniMax-M3）。
2. 输入框输入模糊草稿（「帮我做一个网站」）→ 澄清按钮（魔棒）可用 → 点击 → 面板出现在输入框上方，首问出现（带 A/B/C/D 选项）。
3. 回答 1-2 轮 → 点「直接生成提示词」→ 终稿写入输入框，面板关闭。
4. 草稿为空 → 按钮禁用。
5. 无模型配置（清空 provider）→ 按钮隐藏。
6. 中英文 UI 各切一遍，`chat.clarify.*` 文案正确。
7. 面板打开期间 Enter → 不发送主会话。

- [ ] **Step 3: 错误路径**

- 停掉桌面端 → Web 点澄清 → RPC 失败（gateway 报 agent 离线），面板出现错误行（由 useClarifySession 的失败态驱动）。
- 桌面端在澄清进行中关面板 → 请求超时/丢弃，无崩溃。

- [ ] **Step 4: 修复发现的问题（每修一个跑对应测试），全部通过后收尾 commit**

```bash
git add -A
git commit -m "fix(clarify): polish from web manual verification pass"
```
（无问题则跳过本步。）

---

## Self-Review 记录

- **Spec 覆盖**：RPC `clarify_prompt_turn`（T1/T5）、复用 protobuf envelope（T1/T2/T5）、服务端用当前 provider 配置（T3/T4 传模型选择 + `createProviderRuntimeConfig`）、整段返回不流式（T3 timeout unary + T4 `streamAssistantMessage` 全文回传）、Web 宿主只需实现 `RunClarifyTurn`（T6）、逐字复用 clarifyProtocol（T6 复用 agent-ui 组件/状态机，零协议代码）、i18n 复用 `chat.clarify.*`（无新增）、Web RPC 失败经既有错误通道（T4 useClarifySession 失败态 + toast 通道沿用）、测试对齐 gateway-socket-client（T5）。「无模型配置 隐藏 vs 禁用」决策 → hidden（T7 验收 5）。
- **占位符**：T3/T4 标注了两处「按仓库现状微调」的接线点（`now_unix_seconds` 位置、`commands/gateway.rs` 现有命令写法），语义已锁死；T6 的 `api` 变量名 / `displayedConversationGitBranch` 以实施时 grep 为准。其余步骤代码完整。
- **类型一致性**：`ClarifyTurnRequest` 字段名（`messages_json`/`provider_id`/`model`/`request_format`/`runtime_controls`/`workdir`/`git_branch`）贯穿 T1（proto）→ T3（Rust 事件）→ T4（TS 事件类型）→ T5（adapters snake_case + RPC camelCase input）→ T6（camelCase input）。`ClarifyTurnResponse`（`final_text`/`error_code`/`error_message`）贯穿 T1→T3→T5 断言→T6 抛出。
- **Rust→TS unary 桥**：T3 完全照抄 `handle_chat_queue_request` 的 oneshot+pending+timeout+emit+invoke 回传模式（chat.rs:258-345），该模式经 chat_queue 生产验证。
