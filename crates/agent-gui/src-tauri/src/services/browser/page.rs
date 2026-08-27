//! 页面级高层操作：每个动作对应一组 CDP 调用。会话持有 page target 的
//! sessionId 与最近一次 snapshot 的 ref→backendDOMNodeId 映射。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};

use super::cdp::CdpConnection;
use super::snapshot::{render_ax_tree, SnapshotOutcome};

/// snapshot 预算按 UTF-8 字节数（非字符数）控制：bytes/token 跨文字系统近似
/// 恒定（ASCII ~1B/char、4 chars/token ≈ 4B/token；CJK ~3B/char、~1.5 chars/token
/// ≈ 4.5B/token），28k 字节 ≈ 6-7k tokens，稳守 <8k tokens 验收线。若按字符数
/// 计，CJK 页面会放大到 ~3 倍 tokens 直接超线。
const SNAPSHOT_MAX_BYTES: usize = 28_000;
const EVAL_RESULT_MAX_CHARS: usize = 8_000;

pub(crate) struct PageSession {
    connection: Arc<CdpConnection>,
    session_id: String,
    target_id: String,
    ref_to_backend_node: HashMap<String, i64>,
}

impl PageSession {
    /// attach 到首个 page target 并启用所需 domain。
    pub(crate) async fn attach(connection: Arc<CdpConnection>) -> Result<Self, String> {
        let timeout = Duration::from_secs(10);
        let targets = connection
            .call(None, "Target.getTargets", json!({}), timeout)
            .await?;
        let target_id = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .and_then(|infos| {
                infos.iter().find(|info| {
                    info.get("type").and_then(Value::as_str) == Some("page")
                        && info
                            .get("url")
                            .and_then(Value::as_str)
                            .map(|url| !url.starts_with("devtools://"))
                            .unwrap_or(false)
                })
            })
            .and_then(|info| info.get("targetId").and_then(Value::as_str))
            .map(str::to_string)
            .ok_or_else(|| "未找到可附着的页面 target".to_string())?;
        Self::attach_target(connection, target_id).await
    }

    /// 扩展桥接模式入口：在用户浏览器里新开一个自动化标签页并附着。
    /// 不 attach 既有标签页——自动化的可见/可控范围要严格限定在自己
    /// 创建的 tab（扩展侧同样只授权该 tab 的 chrome.debugger）。
    pub(crate) async fn attach_new_tab(connection: Arc<CdpConnection>) -> Result<Self, String> {
        let timeout = Duration::from_secs(10);
        let created = connection
            .call(
                None,
                "Target.createTarget",
                json!({ "url": "about:blank" }),
                timeout,
            )
            .await?;
        let target_id = created
            .get("targetId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Target.createTarget 未返回 targetId".to_string())?;
        Self::attach_target(connection, target_id).await
    }

    async fn attach_target(
        connection: Arc<CdpConnection>,
        target_id: String,
    ) -> Result<Self, String> {
        let timeout = Duration::from_secs(10);
        let attached = connection
            .call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target_id.as_str(), "flatten": true }),
                timeout,
            )
            .await?;
        let session_id = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Target.attachToTarget 未返回 sessionId".to_string())?
            .to_string();

        let session = Self {
            connection,
            session_id,
            target_id,
            ref_to_backend_node: HashMap::new(),
        };
        for domain in [
            "Page.enable",
            "Runtime.enable",
            "Accessibility.enable",
            "DOM.enable",
        ] {
            session.call(domain, json!({}), timeout).await?;
        }
        Ok(session)
    }

    /// 关闭附着的页面 target（extension 模式收尾：关自动化标签页）。
    pub(crate) async fn close_target(&self) -> Result<(), String> {
        self.connection
            .call(
                None,
                "Target.closeTarget",
                json!({ "targetId": self.target_id.as_str() }),
                Duration::from_secs(5),
            )
            .await
            .map(|_| ())
    }

    async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.connection
            .call(Some(&self.session_id), method, params, timeout)
            .await
    }

    pub(crate) fn is_connected(&self) -> bool {
        !self.connection.is_closed()
    }

    /// 附着的页面 target 是否仍存在。用户只关掉自动化窗口/标签页（browser-level
    /// WS 不断）或 tab 崩溃时，session 已死但 `is_connected` 仍为真，需以此探测。
    /// 走 browser-level 命令，不受页面 JS 卡死影响；探测失败一律按已失效处理。
    pub(crate) async fn target_alive(&self) -> bool {
        let Ok(targets) = self
            .connection
            .call(None, "Target.getTargets", json!({}), Duration::from_secs(3))
            .await
        else {
            return false;
        };
        targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .map(|infos| {
                infos.iter().any(|info| {
                    info.get("targetId").and_then(Value::as_str) == Some(self.target_id.as_str())
                })
            })
            .unwrap_or(false)
    }

    pub(crate) async fn current_url_and_title(&self) -> Result<(String, String), String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": "JSON.stringify({url: location.href, title: document.title})",
                    "returnByValue": true
                }),
                Duration::from_secs(5),
            )
            .await?;
        let raw = result
            .pointer("/result/value")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        Ok((
            parsed
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            parsed
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ))
    }

    pub(crate) async fn navigate(&mut self, url: &str, timeout: Duration) -> Result<(), String> {
        let normalized = if url.contains("://") {
            url.to_string()
        } else {
            format!("https://{url}")
        };
        // 只放行 http/https：file:// 可绕过应用文件权限模型读任意本地文件，
        // chrome://、devtools:// 等特权页面同理，一律拒绝（fail-closed）。
        let scheme_allowed = {
            let lower = normalized.trim_start().to_ascii_lowercase();
            lower.starts_with("https://") || lower.starts_with("http://")
        };
        if !scheme_allowed {
            return Err(format!(
                "仅支持 http/https URL，拒绝打开 \"{normalized}\"（file://、chrome:// 等本地或特权 scheme 不可用）"
            ));
        }
        let result = self
            .call("Page.navigate", json!({ "url": normalized }), timeout)
            .await?;
        if let Some(error_text) = result.get("errorText").and_then(Value::as_str) {
            if !error_text.is_empty() {
                return Err(format!("导航失败：{error_text}"));
            }
        }
        // loaderId 精确绑定本次导航：轮询到该 loader 的文档提交且就绪才算完成，
        // 不依赖 Page.loadEventFired——按 (method, session) 匹配的事件 waiter 会被
        // 迟到的旧导航 load 事件误触发，且未提交前读 readyState 会读到旧文档。
        // 同文档导航（锚点等）不产生新 loader（无 loaderId 返回），立即完成。
        if let Some(loader_id) = result.get("loaderId").and_then(Value::as_str) {
            let loader_id = loader_id.to_string();
            self.wait_for_navigation_commit(&loader_id, timeout).await?;
        }
        self.ref_to_backend_node.clear();
        Ok(())
    }

    /// 等待指定 loader 的文档提交（frame 当前 loaderId 与之相符）且 readyState
    /// 达到 interactive/complete。
    async fn wait_for_navigation_commit(
        &self,
        loader_id: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let started = Instant::now();
        loop {
            let frame_tree = self
                .call("Page.getFrameTree", json!({}), Duration::from_secs(5))
                .await?;
            let committed = frame_tree
                .pointer("/frameTree/frame/loaderId")
                .and_then(Value::as_str)
                == Some(loader_id);
            if committed && self.ready_state_ok().await? {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err("等待页面加载超时".to_string());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    async fn ready_state_ok(&self) -> Result<bool, String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": "document.readyState", "returnByValue": true }),
                Duration::from_secs(5),
            )
            .await?;
        Ok(matches!(
            result.pointer("/result/value").and_then(Value::as_str),
            Some("interactive") | Some("complete")
        ))
    }

    async fn wait_for_ready_state(&self, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        loop {
            if self.ready_state_ok().await? {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err("等待页面加载超时".to_string());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    pub(crate) async fn snapshot(&mut self, timeout: Duration) -> Result<String, String> {
        let tree = self
            .call("Accessibility.getFullAXTree", json!({}), timeout)
            .await?;
        let nodes = tree
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| "Accessibility.getFullAXTree 未返回 nodes".to_string())?;
        let SnapshotOutcome {
            text,
            ref_to_backend_node,
        } = render_ax_tree(nodes, SNAPSHOT_MAX_BYTES);
        self.ref_to_backend_node = ref_to_backend_node;
        Ok(text)
    }

    fn backend_node_for_ref(&self, ref_id: &str) -> Result<i64, String> {
        self.ref_to_backend_node
            .get(ref_id.trim().trim_start_matches("ref="))
            .copied()
            .ok_or_else(|| format!("未知 ref \"{ref_id}\"：请先执行 snapshot 获取最新 ref 列表"))
    }

    /// ref → 元素中心视口坐标；必要时先滚动进视口。
    async fn center_of_ref(&self, ref_id: &str, timeout: Duration) -> Result<(f64, f64), String> {
        let backend_node_id = self.backend_node_for_ref(ref_id)?;
        let _ = self
            .call(
                "DOM.scrollIntoViewIfNeeded",
                json!({ "backendNodeId": backend_node_id }),
                timeout,
            )
            .await;
        let box_model = self
            .call(
                "DOM.getBoxModel",
                json!({ "backendNodeId": backend_node_id }),
                timeout,
            )
            .await
            .map_err(|e| format!("元素不可见或已从页面移除（{e}）"))?;
        let quad = box_model
            .pointer("/model/content")
            .and_then(Value::as_array)
            .ok_or_else(|| "DOM.getBoxModel 未返回 content quad".to_string())?;
        let numbers: Vec<f64> = quad.iter().filter_map(Value::as_f64).collect();
        if numbers.len() < 8 {
            return Err("content quad 数据不完整".to_string());
        }
        let center_x = (numbers[0] + numbers[2] + numbers[4] + numbers[6]) / 4.0;
        let center_y = (numbers[1] + numbers[3] + numbers[5] + numbers[7]) / 4.0;
        Ok((center_x, center_y))
    }

    pub(crate) async fn click(&mut self, ref_id: &str, timeout: Duration) -> Result<(), String> {
        let (x, y) = self.center_of_ref(ref_id, timeout).await?;
        for (event_type, click_count) in [("mousePressed", 1), ("mouseReleased", 1)] {
            self.call(
                "Input.dispatchMouseEvent",
                json!({
                    "type": event_type,
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": click_count
                }),
                timeout,
            )
            .await?;
        }
        Ok(())
    }

    pub(crate) async fn type_text(
        &mut self,
        ref_id: &str,
        text: &str,
        submit: bool,
        timeout: Duration,
    ) -> Result<(), String> {
        self.click(ref_id, timeout).await?;
        // 先清空既有内容（全选后插入覆盖）。
        let backend_node_id = self.backend_node_for_ref(ref_id)?;
        let _ = self
            .call(
                "DOM.focus",
                json!({ "backendNodeId": backend_node_id }),
                timeout,
            )
            .await;
        self.call(
            "Runtime.evaluate",
            json!({
                "expression": "document.execCommand('selectAll', false, null)",
                "returnByValue": true
            }),
            timeout,
        )
        .await?;
        if text.is_empty() {
            // 空文本 = 清空字段：Input.insertText 传空串是 no-op，改为删除全选内容。
            self.call(
                "Runtime.evaluate",
                json!({
                    "expression": "document.execCommand('delete', false, null)",
                    "returnByValue": true
                }),
                timeout,
            )
            .await?;
        } else {
            self.call("Input.insertText", json!({ "text": text }), timeout)
                .await?;
        }
        if submit {
            // keyDown 必须带 text 才会产生 keypress 语义：无 text 时 CDP 按
            // rawKeyDown 派发，多数表单/搜索框不会触发隐式提交（Puppeteer 对
            // Enter 同样发 text:"\r"）。keyUp 不带 text。
            for (event_type, key_text) in [("keyDown", Some("\r")), ("keyUp", None)] {
                let mut params = json!({
                    "type": event_type,
                    "key": "Enter",
                    "code": "Enter",
                    "windowsVirtualKeyCode": 13,
                    "nativeVirtualKeyCode": 13
                });
                if let Some(key_text) = key_text {
                    params["text"] = Value::String(key_text.to_string());
                    params["unmodifiedText"] = Value::String(key_text.to_string());
                }
                self.call("Input.dispatchKeyEvent", params, timeout).await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn screenshot(&self, timeout: Duration) -> Result<(String, String), String> {
        let result = self
            .call(
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": 80 }),
                timeout,
            )
            .await?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "Page.captureScreenshot 未返回数据".to_string())?;
        // 校验 base64 合法性，避免坏数据进聊天渲染链路。
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| format!("截图 base64 解码失败：{e}"))?;
        Ok((data.to_string(), "image/jpeg".to_string()))
    }

    pub(crate) async fn eval(&self, expression: &str, timeout: Duration) -> Result<String, String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true
                }),
                timeout,
            )
            .await?;
        // 有 exceptionDetails 即失败。message 依可用性取：Error 有 description；
        // 抛出原语（throw "..."/Promise.reject(42)）只有 value；再退 text 字段。
        if let Some(details) = result.get("exceptionDetails") {
            let message = details
                .pointer("/exception/description")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    details
                        .pointer("/exception/value")
                        .map(|value| value.to_string())
                })
                .or_else(|| {
                    details
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "unknown".to_string());
            return Err(format!("eval 抛出异常：{message}"));
        }
        let value = result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null);
        let mut rendered = match value {
            Value::String(text) => text,
            other => serde_json::to_string(&other).unwrap_or_default(),
        };
        if rendered.chars().count() > EVAL_RESULT_MAX_CHARS {
            rendered = rendered.chars().take(EVAL_RESULT_MAX_CHARS).collect();
            rendered.push_str("…(truncated)");
        }
        Ok(rendered)
    }

    pub(crate) async fn wait_for_selector(
        &self,
        selector: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let started = Instant::now();
        let escaped = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
        loop {
            let result = self
                .call(
                    "Runtime.evaluate",
                    json!({
                        "expression": format!("document.querySelector({escaped}) !== null"),
                        "returnByValue": true
                    }),
                    Duration::from_secs(5),
                )
                .await?;
            if result.pointer("/result/value").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err(format!("等待 selector 超时：{selector}"));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    pub(crate) async fn back(&mut self, timeout: Duration) -> Result<(), String> {
        let history = self
            .call("Page.getNavigationHistory", json!({}), timeout)
            .await?;
        let current_index = history
            .get("currentIndex")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if current_index <= 0 {
            return Err("没有可回退的历史记录".to_string());
        }
        let entries = history
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| "Page.getNavigationHistory 未返回 entries".to_string())?;
        let entry_id = entries
            .get((current_index - 1) as usize)
            .and_then(|entry| entry.get("id"))
            .and_then(Value::as_i64)
            .ok_or_else(|| "历史记录条目缺少 id".to_string())?;
        let load_event = self
            .connection
            .wait_event("Page.loadEventFired", Some(&self.session_id));
        self.call(
            "Page.navigateToHistoryEntry",
            json!({ "entryId": entry_id }),
            timeout,
        )
        .await?;
        // load 事件只作快路径信号（同文档回退不产生 load 事件），最多等 3s，
        // 无论是否等到都以 readyState 复核——事件 waiter 可能被迟到的旧导航
        // 事件误触发；慢页面由 readyState 轮询在完整 timeout 内兜住。
        let _ = tokio::time::timeout(timeout.min(Duration::from_secs(3)), load_event).await;
        self.wait_for_ready_state(timeout).await?;
        self.ref_to_backend_node.clear();
        Ok(())
    }
}
