//! 每会话一个 pi 进程的会话管理。
//!
//! 数据关系很简单：`conversationId → PiSession`，一个 `PiSession` 拥有
//! 一个 pi 进程、一份 live 状态、一个事件泵任务。pi 一进程只有一个活动会话，
//! 所以「一会话一进程」不是选择，是它的约束。
//!
//! 首次 `chat_send` 惰性拉起进程；此后同会话复用。会话文件落在数据目录的
//! `pi-sessions/` 下，`--session-id` 用 conversationId，进程重启也能接上。
//!
//! ## 发送侧没有「在不在流式」这个分支
//!
//! pi 的 `prompt` 带上 `streamingBehavior: "followUp"` 之后，空闲就直接跑、
//! 流式就自动排队。我们不跟踪 `isStreaming`，也就不会跟丢——这个状态只有
//! pi 自己知道得准，在这边镜像一份纯属自找竞态。

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use super::approval::SessionApprovals;
use super::live::LiveState;
use super::process::{PiProcess, PiSpawnConfig};
use super::protocol::{self, PiEvent};
use super::translate;
use crate::approval::ApprovalRegistry;
use crate::events::EventBus;

/// pi 可执行文件的环境变量覆盖。不设就走 PATH 上的 `pi`。
const PI_BIN_ENV: &str = "LIVEAGENT_PI_BIN";
/// 会话文件目录，挂在应用数据目录下。
const SESSION_SUBDIR: &str = "pi-sessions";
/// 每会话的 pi agent 配置目录（`PI_CODING_AGENT_DIR`）根。models.json 落在
/// `pi-agent/<conversationId>/` 下，一份只含当前 provider，绝不碰 `~/.pi/agent/`。
const AGENT_DIR_SUBDIR: &str = "pi-agent";
/// 审批扩展的落盘目录。
const EXTENSION_SUBDIR: &str = "pi-extensions";
/// 审批扩展的文件名。
const EXTENSION_FILENAME: &str = "approval.ts";
/// 审批扩展源码，编译期嵌进二进制。
///
/// pi 的 `-e` 只认磁盘上的路径，而后端可能以任何方式分发（容器、Tauri 包、
/// 裸二进制）。嵌进来再落盘，就不必要求打包流程额外拷一个文件——漏拷的
/// 表现是「审批静默失效」，比编译不过难查得多。
const APPROVAL_EXTENSION_SOURCE: &str = include_str!("../../pi-extension/approval.ts");
/// `clientRequestId` 去重窗口。够覆盖任何合理的网络重试，又不会无限长。
const SEEN_REQUEST_ID_CAPACITY: usize = 256;
/// 同步类命令（set_model / abort）的等待上限。
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

/// `POST /api/chat_send` 的请求体。
///
/// 未知字段一律忽略（serde 默认行为），这是有意的：前端还在发 `sessionId`、
/// `mode`、`skillsEnabled`、`selectedSkillNames`。它们在 pi 模型下要么没有
/// 对应概念（sessionId 由 pi 自己管），要么已决策砍掉（`mode: "text"`），
/// 要么留待能力清单结论（skills）。为它们报 400 就是无谓地破坏前端。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub workdir: Option<String>,
    #[serde(default)]
    pub selected_model: Option<SelectedModel>,
}

/// 与 `crates/frontend/src/lib/models/selectedModel.ts` 的 `SelectedModel` 同构。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedModel {
    pub custom_provider_id: String,
    pub model: String,
}

/// `chat_send` 的响应体。前端忽略内容，但 `parseResponse` 要求有 `ok` 包装。
#[derive(Debug, Serialize)]
pub struct ChatSendAccepted {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate: Option<bool>,
}

pub struct PiSessionManager {
    events: Arc<EventBus>,
    approvals: Arc<ApprovalRegistry>,
    sessions: Mutex<HashMap<String, Arc<PiSession>>>,
}

impl PiSessionManager {
    pub fn new(events: Arc<EventBus>, approvals: Arc<ApprovalRegistry>) -> Self {
        Self {
            events,
            approvals,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 受理一次发送。返回即表示已交给 pi，实际结果走事件。
    pub async fn chat_send(&self, request: ChatSendRequest) -> Result<ChatSendAccepted, String> {
        let conversation_id = request.conversation_id.trim();
        if conversation_id.is_empty() {
            return Err("conversationId 不能为空".to_string());
        }
        let text = request.text.trim();
        if text.is_empty() {
            return Err("text 不能为空".to_string());
        }

        // 先把所选 provider 渲染成 models.json 内容。进程按这份内容拉起，
        // 内容变了（换 provider、换 key、加模型）就重写文件、换进程——
        // pi 只在启动时读 models.json，RPC 没有重载命令，respawn 是唯一正路。
        let models_json = request
            .selected_model
            .as_ref()
            .map(render_models_json)
            .transpose()?;

        let session = self.get_or_spawn(
            conversation_id,
            request.workdir.as_deref(),
            models_json.as_deref(),
        )?;

        // 去重在拉起进程之后、发命令之前：重复请求不该产生第二条 prompt，
        // 但也不该妨碍会话本身建起来。
        let client_request_id = request
            .client_request_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if let Some(id) = client_request_id {
            if !session.remember_request_id(id) {
                return Ok(ChatSendAccepted {
                    accepted: true,
                    duplicate: Some(true),
                });
            }
        }

        if let Some(model) = &request.selected_model {
            session.apply_model(model).await?;
        }

        session.process.send(protocol::prompt(text))?;

        Ok(ChatSendAccepted {
            accepted: true,
            duplicate: None,
        })
    }

    /// 中止会话当前的运行。会话不存在或 pi 拒绝都返回 false。
    pub async fn abort(&self, conversation_id: &str) -> bool {
        let Some(session) = self.get(conversation_id) else {
            return false;
        };
        match session.process.request(protocol::abort(), COMMAND_TIMEOUT).await {
            Ok(response) => response.success,
            Err(error) => {
                eprintln!("pi abort 失败（{conversation_id}）：{error}");
                false
            }
        }
    }

    /// live 快照。内存里没有这个会话就是 None，路由据此回 404。
    pub fn live_snapshot(&self, conversation_id: &str) -> Option<Value> {
        let session = self.get(conversation_id)?;
        let state = session.live.lock().ok()?;
        Some(state.snapshot(conversation_id))
    }

    /// 关掉所有会话进程。壳/后端退出时调，避免留下孤儿 pi。
    pub fn shutdown_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => std::mem::take(&mut *sessions),
            Err(error) => {
                eprintln!("pi 会话表锁中毒，跳过清理：{error}");
                return;
            }
        };
        // drop 即 kill：`PiProcess::drop` 会 abort 三条泵并向子进程发信号。
        drop(sessions);
    }

    fn get(&self, conversation_id: &str) -> Option<Arc<PiSession>> {
        self.sessions.lock().ok()?.get(conversation_id).cloned()
    }

    /// 取会话，没有就建。整个临界区里没有 await 点——`PiProcess::spawn` 是
    /// 同步的——所以这把锁可以是普通 Mutex，也就顺带堵死了「两个并发
    /// chat_send 各拉起一个进程」。
    ///
    /// 手里的进程死了就换一个：pi 崩掉之后这个会话不该被永久判死。
    /// 检查放在取用的这一刻，而不是让退出的进程反过来清会话表——
    /// 后者要跨任务对齐「清的是不是同一个进程」，凭空多出一类竞态。
    fn get_or_spawn(
        &self,
        conversation_id: &str,
        workdir: Option<&str>,
        models_json: Option<&str>,
    ) -> Result<Arc<PiSession>, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "pi 会话表锁中毒".to_string())?;

        if let Some(session) = sessions.get(conversation_id) {
            if !session.process.has_exited() {
                // provider/model 配置没变就继续用手里的进程。变了必须换进程：
                // pi 只在启动时读 models.json。None（前端没带 selectedModel）
                // 视为「维持现状」，不触发 respawn。
                match models_json {
                    Some(next) if session.models_json.as_deref() != Some(next) => {
                        eprintln!("模型配置已变（{conversation_id}），重启 pi 进程");
                        sessions.remove(conversation_id);
                    }
                    _ => return Ok(Arc::clone(session)),
                }
            } else {
                eprintln!("pi 进程已退出（{conversation_id}），重新拉起");
                sessions.remove(conversation_id);
            }
        }

        let session = Arc::new(PiSession::spawn(
            conversation_id,
            workdir,
            models_json,
            Arc::clone(&self.events),
            Arc::clone(&self.approvals),
        )?);
        sessions.insert(conversation_id.to_string(), Arc::clone(&session));
        Ok(session)
    }
}

struct PiSession {
    process: PiProcess,
    live: Arc<Mutex<LiveState>>,
    /// 进程拉起时写进 agent dir 的 models.json 内容。get_or_spawn 拿它判断
    /// 「provider/模型配置变没变」——变了就换进程。None = 没注入过。
    models_json: Option<String>,
    /// 见过的 `clientRequestId`，FIFO 淘汰。条目少，线性查比再挂一个
    /// HashSet 便宜，也省掉「两个容器不同步」这类 bug。
    seen_request_ids: Mutex<VecDeque<String>>,
}

impl PiSession {
    fn spawn(
        conversation_id: &str,
        workdir: Option<&str>,
        models_json: Option<&str>,
        events: Arc<EventBus>,
        approvals: Arc<ApprovalRegistry>,
    ) -> Result<Self, String> {
        let session_dir = session_dir()?;
        let agent_dir = agent_dir(conversation_id)?;
        if let Some(json) = models_json {
            std::fs::write(agent_dir.join("models.json"), json)
                .map_err(|e| format!("写入 pi models.json 失败：{e}"))?;
        }
        let workdir = workdir
            .map(str::trim)
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from);

        // 扩展装不上就没有工具审批。这不该让会话起不来（多数用户没配任何
        // ask/deny 策略，审批本就不会触发），但必须吵一声。
        let extension = match install_approval_extension() {
            Ok(path) => Some(path),
            Err(error) => {
                eprintln!("警告：审批扩展安装失败，本会话没有工具审批：{error}");
                None
            }
        };

        let (process, event_rx) = PiProcess::spawn(PiSpawnConfig {
            bin: pi_binary(),
            session_id: conversation_id.to_string(),
            session_dir,
            agent_dir,
            workdir,
            extension,
        })?;

        let live = Arc::new(Mutex::new(LiveState::default()));
        tokio::spawn(pump_events(
            SessionContext {
                conversation_id: conversation_id.to_string(),
                events,
                approvals,
                session_approvals: Arc::new(SessionApprovals::default()),
                stdin: process.stdin_sender(),
            },
            event_rx,
            Arc::clone(&live),
        ));

        Ok(Self {
            process,
            live,
            models_json: models_json.map(str::to_string),
            seen_request_ids: Mutex::new(VecDeque::new()),
        })
    }

    /// 记下一个 clientRequestId。返回 false 表示这是重复请求。
    fn remember_request_id(&self, id: &str) -> bool {
        remember_request_id(&self.seen_request_ids, id)
    }

    /// 切模型。一步：models.json 已按 customProviderId 注入（provider 命名
    /// 空间两边一致），`set_model` 一次往返即命中。被拒就报错拒收这条消息：
    /// 静默换成别的模型跑，比让用户重发一次糟糕得多。
    async fn apply_model(&self, model: &SelectedModel) -> Result<(), String> {
        let response = self
            .process
            .request(
                protocol::set_model(&model.custom_provider_id, &model.model),
                COMMAND_TIMEOUT,
            )
            .await?;
        if response.success {
            return Ok(());
        }
        Err(format!(
            "无法切换到所选模型 {}/{}：{}",
            model.custom_provider_id,
            model.model,
            response.error.unwrap_or_else(|| "pi 未给出错误信息".to_string())
        ))
    }
}

/// 事件泵和审批任务共用的一套会话句柄。
///
/// 打包成一个结构体而不是逐个传：这五样东西的生命周期完全一致（都跟着会话），
/// 拆开传只会让每个函数签名多四个参数，还得靠 clippy 的豁免注释压警告。
#[derive(Clone)]
struct SessionContext {
    conversation_id: String,
    events: Arc<EventBus>,
    approvals: Arc<ApprovalRegistry>,
    session_approvals: Arc<SessionApprovals>,
    stdin: mpsc::UnboundedSender<String>,
}

/// 会话的事件泵。pi 进程没了，管道断了，任务自然结束。
///
/// 审批请求**必须**甩给独立任务：一次审批最长 3 分钟，在这个循环里 await
/// 会把同会话后续的 token 增量、工具状态全堵住——用户会看到界面卡死。
async fn pump_events(
    context: SessionContext,
    mut event_rx: mpsc::UnboundedReceiver<PiEvent>,
    live: Arc<Mutex<LiveState>>,
) {
    while let Some(event) = event_rx.recv().await {
        match event {
            PiEvent::ExtensionUiRequest { id, method, title } => {
                tokio::spawn(answer_ui_request(context.clone(), id, method, title));
            }
            other => translate::apply(
                &context.conversation_id,
                other,
                &live,
                context.events.as_ref(),
            ),
        }
    }
}

/// 裁决一次扩展对话框并把结果写回 pi。
///
/// 不是审批请求就回 `cancelled`：不回的话发起它的扩展会一直挂着。
async fn answer_ui_request(
    context: SessionContext,
    id: String,
    method: String,
    title: String,
) {
    let conversation_id = &context.conversation_id;

    // 策略现读现用，见 settings::load_tool_policies 的说明。读不到就当没配，
    // 走缺省 allow——设置库出问题不该让所有工具调用都卡在审批上。
    let policies = match crate::commands::settings::load_tool_policies() {
        Ok(policies) => policies,
        Err(error) => {
            eprintln!("读取工具审批策略失败（{conversation_id}）：{error}");
            None
        }
    };

    let verdict = super::approval::resolve_ui_request(
        conversation_id,
        &title,
        policies.as_ref(),
        &context.session_approvals,
        &context.approvals,
        Arc::clone(&context.events),
    )
    .await;

    let response = match verdict {
        Some(value) => protocol::extension_ui_value(&id, &value),
        None => {
            eprintln!("收到非审批的扩展对话框（{conversation_id} / {method}），已取消");
            protocol::extension_ui_cancel(&id)
        }
    };

    // 发不出去说明进程已经没了，扩展也随之消失，没人在等这个应答。
    let _ = context.stdin.send(response.to_string());
}

/// 把嵌进二进制的审批扩展落到数据目录，返回它的路径。
///
/// 每次都重写：升级后端后扩展内容可能变了，比对内容再决定写不写只是省
/// 几十微秒的磁盘写，却多一条「没更新成功」的失败模式。
fn install_approval_extension() -> Result<PathBuf, String> {
    let dir = crate::storage::app_storage_dir()?.join(EXTENSION_SUBDIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 pi 扩展目录失败：{e}"))?;
    let path = dir.join(EXTENSION_FILENAME);
    std::fs::write(&path, APPROVAL_EXTENSION_SOURCE)
        .map_err(|e| format!("写入审批扩展失败：{e}"))?;
    Ok(path)
}

/// 记下一个 clientRequestId，返回 false 表示见过。
///
/// 独立成函数是为了能脱开 pi 进程测——去重是真业务逻辑，
/// 不该因为「测它得先拉起一个子进程」而失去覆盖。
fn remember_request_id(seen: &Mutex<VecDeque<String>>, id: &str) -> bool {
    let Ok(mut seen) = seen.lock() else {
        // 锁中毒时宁可放行：重复跑一轮，好过把用户的消息吞掉。
        return true;
    };
    if seen.iter().any(|seen_id| seen_id == id) {
        return false;
    }
    if seen.len() >= SEEN_REQUEST_ID_CAPACITY {
        seen.pop_front();
    }
    seen.push_back(id.to_string());
    true
}

fn pi_binary() -> String {
    std::env::var(PI_BIN_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "pi".to_string())
}

fn session_dir() -> Result<PathBuf, String> {
    let dir = crate::storage::app_storage_dir()?.join(SESSION_SUBDIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 pi 会话目录失败：{e}"))?;
    Ok(dir)
}

/// 每会话独立的 agent dir：`pi-agent/<conversationId>/`。写 models.json 和
/// spawn 在同一临界区里，天然无并发写竞态。
fn agent_dir(conversation_id: &str) -> Result<PathBuf, String> {
    let dir = crate::storage::app_storage_dir()?
        .join(AGENT_DIR_SUBDIR)
        .join(conversation_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 pi agent 目录失败：{e}"))?;
    Ok(dir)
}

/// 从设置库读所选 provider 的完整配置，渲染成单 provider 的 models.json。
fn render_models_json(model: &SelectedModel) -> Result<String, String> {
    let provider_id = model.custom_provider_id.trim();
    if provider_id.is_empty() || model.model.trim().is_empty() {
        return Err("selectedModel 的 customProviderId/model 不能为空".to_string());
    }
    let payload = crate::commands::settings::load_provider_payload(provider_id)?
        .ok_or_else(|| format!("供应商配置不存在：{provider_id}"))?;
    super::models_json::build_models_json(provider_id, &payload, model.model.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_send_request_ignores_fields_pi_has_no_use_for() {
        // 前端现在就在发这些字段，多一个都不许让请求失败。
        let body = serde_json::json!({
            "conversationId": "conv-1",
            "clientRequestId": "req-1",
            "sessionId": "node-123",
            "mode": "text",
            "text": "hi",
            "workdir": "/tmp",
            "skillsEnabled": true,
            "selectedSkillNames": ["a"],
            "selectedModel": { "customProviderId": "anthropic", "model": "claude-opus-4-8" }
        });

        let request: ChatSendRequest = serde_json::from_value(body).expect("解析 chat_send 请求");
        assert_eq!(request.conversation_id, "conv-1");
        assert_eq!(request.client_request_id.as_deref(), Some("req-1"));
        assert_eq!(request.workdir.as_deref(), Some("/tmp"));
        let model = request.selected_model.expect("selectedModel");
        assert_eq!(model.custom_provider_id, "anthropic");
        assert_eq!(model.model, "claude-opus-4-8");
    }

    #[test]
    fn chat_send_request_needs_only_conversation_id_and_text() {
        let body = serde_json::json!({ "conversationId": "conv-1", "text": "hi" });
        let request: ChatSendRequest = serde_json::from_value(body).expect("解析 chat_send 请求");
        assert!(request.client_request_id.is_none());
        assert!(request.selected_model.is_none());
    }

    #[test]
    fn accepted_response_omits_duplicate_unless_it_is_one() {
        let fresh = serde_json::to_value(ChatSendAccepted {
            accepted: true,
            duplicate: None,
        })
        .expect("序列化");
        assert_eq!(fresh, serde_json::json!({ "accepted": true }));

        let repeat = serde_json::to_value(ChatSendAccepted {
            accepted: true,
            duplicate: Some(true),
        })
        .expect("序列化");
        assert_eq!(
            repeat,
            serde_json::json!({ "accepted": true, "duplicate": true })
        );
    }

    #[test]
    fn a_repeated_client_request_id_is_rejected_once_seen() {
        let seen = Mutex::new(VecDeque::new());
        assert!(remember_request_id(&seen, "req-1"));
        assert!(!remember_request_id(&seen, "req-1"));
        assert!(remember_request_id(&seen, "req-2"));
        assert!(!remember_request_id(&seen, "req-2"));
    }

    /// 窗口满了淘汰最旧的：老 id 会被重新放行，这是有意的取舍——
    /// 无限增长的去重表才是真问题，而 256 轮之前的重试不存在。
    #[test]
    fn the_dedup_window_evicts_oldest_first() {
        let seen = Mutex::new(VecDeque::new());
        for index in 0..SEEN_REQUEST_ID_CAPACITY {
            assert!(remember_request_id(&seen, &format!("req-{index}")));
        }
        assert!(!remember_request_id(&seen, "req-0"));

        assert!(remember_request_id(&seen, "overflow"));
        assert!(remember_request_id(&seen, "req-0"));
        assert_eq!(
            seen.lock().expect("seen lock").len(),
            SEEN_REQUEST_ID_CAPACITY
        );
    }
}
