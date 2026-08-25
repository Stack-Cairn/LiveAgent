//! CUA 跨 IPC 的结构化错误。
//!
//! 之前每个错误分支都用 `#[error("…中文…")]` 把字面量硬塞进 IPC 返回值，
//! 结果在英文 locale 下审计日志与 tool 错误都飘出中文（CUA-006）。现在改成
//! 仅由后端承载「稳定 i18n key + 模板参数 + 英文兜底消息」，由前端 `t(...)`
//! 按活动 locale 渲染。
//!
//! 不用 `thiserror` 派生：因为 key + params 都来自手工拼装而非 fmt。

use serde::{Deserialize, Serialize};

/// 跨 IPC 传递的 CUA 错误。前端拿到 `kind` 后查 i18n map；查不到时退回
/// `message`（始终是英文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaError {
    /// i18n key，例如 `"cua.errors.disabled"`。
    pub kind: String,
    /// 模板参数，键名与 i18n 文案的 `{xxx}` 占位一一对应。
    #[serde(default, skip_serializing_if = "is_null_or_empty")]
    pub params: serde_json::Value,
    /// 英文兜底消息。当前端无法识别 `kind` 时显示。
    pub message: String,
}

fn is_null_or_empty(v: &serde_json::Value) -> bool {
    v.is_null()
}

impl CuaError {
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            params: serde_json::Value::Null,
            message: message.into(),
        }
    }

    pub fn with_params(kind: impl Into<String>, message: impl Into<String>, params: serde_json::Value) -> Self {
        Self {
            kind: kind.into(),
            params,
            message: message.into(),
        }
    }

    /// 总开关未启用。
    pub fn disabled() -> Self {
        Self::new(
            "cua.errors.disabled",
            "CUA is not enabled. Open Settings → CUA Driver and turn the master switch on.",
        )
    }

    /// 目标 owner 不在白名单。
    pub fn denied_by_allowlist(target: &str, allowed: &[String]) -> Self {
        Self::with_params(
            "cua.errors.deniedByAllowlist",
            format!(
                "CUA operation denied: target \"{target}\" is not in the allowlist {allowed:?}."
            ),
            serde_json::json!({
                "target": target,
                "allowed": allowed,
            }),
        )
    }

    /// 当前 OS 尚未实现 CUA 驱动。
    pub fn unsupported_platform(os: &str) -> Self {
        Self::with_params(
            "cua.errors.unsupportedPlatform",
            format!("CUA driver is not available on {os}; only macOS is implemented."),
            serde_json::json!({ "platform": os }),
        )
    }

    /// macOS 权限拒绝（辅助功能 / 屏幕录制）。
    pub fn permission_required(permission_key: &str, display: &str) -> Self {
        Self::with_params(
            "cua.errors.permissionRequired",
            format!(
                "CUA needs macOS permission ({display}); grant LiveAgent the {permission_key} permission in System Settings → Privacy & Security, then try again."
            ),
            serde_json::json!({
                "permissionKey": permission_key,
                "permission": display,
            }),
        )
    }

    /// 驱动未执行（前置条件未满足，例如缺少 `cliclick`）。
    pub fn not_executed(detail: &str) -> Self {
        Self::with_params(
            "cua.errors.notExecuted",
            format!("CUA operation was not executed: {detail}."),
            serde_json::json!({ "detail": detail }),
        )
    }

    /// 子进程 IO 失败（osascript / screencapture 启动失败等）。
    pub fn io(detail: &str) -> Self {
        Self::with_params(
            "cua.errors.io",
            format!("CUA subprocess IO error: {detail}."),
            serde_json::json!({ "detail": detail }),
        )
    }
}

impl std::fmt::Display for CuaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CuaError {}
