use serde::{Deserialize, Serialize};

/// `Browser` 工具单命令的入参：action + 各 action 的可选字段。
/// 字段校验在 dispatch 处做（缺参报错指明 action），保持 TS 侧 schema 宽松。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionArgs {
    pub action: String,
    /// 浏览器接入模式（settings.system.browserAutomationMode，TS 侧每次调用
    /// 透传）："auto"（缺省，扩展优先、可回退）/ "userProfile"（只走扩展，
    /// 未连接报错引导）/ "isolated"（只走独立 profile）。
    pub browser_mode: Option<String>,
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
    /// 动作完成后是否附带新 snapshot。缺省按 action 定：改变/读取页面状态的
    /// 动作（navigate/snapshot/click/type/back/wait）为 true，screenshot/eval
    /// 为 false（见 mod.rs default_include）。
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
    /// "extension"（驱动用户日常浏览器的自动化标签页）或 "launcher"
    /// （独立 profile 子进程）；未运行时为 None。
    pub mode: Option<String>,
    /// 桥接服务当前是否有存活的扩展连接（下一次会话将走 extension 模式）。
    pub extension_connected: bool,
    pub url: Option<String>,
    pub title: Option<String>,
    /// launcher 模式的浏览器可执行文件路径；extension 模式为 None。
    pub executable: Option<String>,
}

pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub(crate) const MAX_TIMEOUT_MS: u64 = 120_000;

pub(crate) fn effective_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS)
}
