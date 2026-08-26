//! 页面级高层操作：每个动作对应一组 CDP 调用。会话持有 page target 的
//! sessionId 与最近一次 snapshot 的 ref→backendDOMNodeId 映射。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};

use super::cdp::CdpConnection;
use super::snapshot::{render_ax_tree, SnapshotOutcome};

/// snapshot 字符预算：a11y 树控制在 <8k tokens（验收线），按 ~4 chars/token 取 28k。
const SNAPSHOT_MAX_CHARS: usize = 28_000;
const EVAL_RESULT_MAX_CHARS: usize = 8_000;

pub(crate) struct PageSession {
    connection: Arc<CdpConnection>,
    session_id: String,
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
        let attached = connection
            .call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
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

    async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.connection
            .call(Some(&self.session_id), method, params, timeout)
            .await
    }

    pub(crate) fn is_connected(&self) -> bool {
        !self.connection.is_closed()
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
        let load_event = self
            .connection
            .wait_event("Page.loadEventFired", Some(&self.session_id));
        let result = self
            .call("Page.navigate", json!({ "url": normalized }), timeout)
            .await?;
        if let Some(error_text) = result.get("errorText").and_then(Value::as_str) {
            if !error_text.is_empty() {
                return Err(format!("导航失败：{error_text}"));
            }
        }
        // load 事件可能已错过（如同页锚点），失败则回退轮询 readyState。
        if tokio::time::timeout(timeout, load_event).await.is_err() {
            self.wait_for_ready_state(timeout).await?;
        }
        self.ref_to_backend_node.clear();
        Ok(())
    }

    async fn wait_for_ready_state(&self, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        loop {
            let result = self
                .call(
                    "Runtime.evaluate",
                    json!({ "expression": "document.readyState", "returnByValue": true }),
                    Duration::from_secs(5),
                )
                .await?;
            let state = result.pointer("/result/value").and_then(Value::as_str);
            if matches!(state, Some("interactive") | Some("complete")) {
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
        } = render_ax_tree(nodes, SNAPSHOT_MAX_CHARS);
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
        self.call("Input.insertText", json!({ "text": text }), timeout)
            .await?;
        if submit {
            for event_type in ["keyDown", "keyUp"] {
                self.call(
                    "Input.dispatchKeyEvent",
                    json!({
                        "type": event_type,
                        "key": "Enter",
                        "code": "Enter",
                        "windowsVirtualKeyCode": 13,
                        "nativeVirtualKeyCode": 13
                    }),
                    timeout,
                )
                .await?;
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
        if let Some(exception) = result.pointer("/exceptionDetails/exception/description") {
            return Err(format!(
                "eval 抛出异常：{}",
                exception.as_str().unwrap_or("unknown")
            ));
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
        if tokio::time::timeout(timeout, load_event).await.is_err() {
            self.wait_for_ready_state(timeout).await?;
        }
        self.ref_to_backend_node.clear();
        Ok(())
    }
}
