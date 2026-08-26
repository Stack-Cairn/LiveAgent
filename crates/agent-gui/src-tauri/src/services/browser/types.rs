use serde::{Deserialize, Serialize};

/// `Browser` 工具单命令的入参：action + 各 action 的可选字段。
/// 字段校验在 dispatch 处做（缺参报错指明 action），保持 TS 侧 schema 宽松。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionArgs {
    pub action: String,
    /// navigate 目标；无 scheme 时按 https:// 处理。
    pub url: Option<String>,
    /// click / type 目标：snapshot 输出中的 ref id（如 "e12"）。
    #[serde(rename = "ref")]
    pub ref_id: Option<String>,
    /// type 输入文本。
    pub text: Option<String>,
    /// wait 等待出现的 CSS selector。
    pub selector: Option<String>,
    /// eval 表达式。
    pub expression: Option<String>,
    /// wait 的纯延时毫秒数（与 selector 二选一）。
    pub time_ms: Option<u64>,
    /// 单次操作超时；默认 30s，上限 120s。
    pub timeout_ms: Option<u64>,
    /// type 后是否追加 Enter。
    pub submit: Option<bool>,
    /// 动作完成后是否附带新 snapshot（默认 true，snapshot/screenshot/eval 除外）。
    pub include_snapshot: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionResponse {
    pub action: String,
    pub url: Option<String>,
    pub title: Option<String>,
    /// a11y 树文本（带 ref id）。
    pub snapshot: Option<String>,
    /// eval 结果 / wait 结果等文本信息。
    pub result: Option<String>,
    pub screenshot_base64: Option<String>,
    pub screenshot_mime: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatusResponse {
    pub running: bool,
    pub url: Option<String>,
    pub title: Option<String>,
    pub executable: Option<String>,
}

pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub(crate) const MAX_TIMEOUT_MS: u64 = 120_000;

pub(crate) fn effective_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS)
}
