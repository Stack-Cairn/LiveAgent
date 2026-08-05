//! LiveAgent 后端核心。
//!
//! 这里装的是「执行 agent 所需的一切」：文件系统、git、终端、SFTP、进程管理、
//! 存储、定时任务、MCP。**不含任何 UI 框架依赖**——见 Cargo.toml 的说明。
//!
//! 两个消费者：
//! - `crates/agent-gui/src-tauri` 桌面壳，通过 `#[tauri::command]` 薄包装调用
//! - `crates/agent-backend` HTTP/WS 服务，通过 JSON 路由调用
//!
//! 两者调的是同一批函数，所以行为不可能不一致。
//!
//! 模块划分沿用搬迁前的形状（`runtime` / `services` / `commands`）。三者互相引用，
//! 不存在无环的拆分顺序，所以是一次搬完而不是分三步——分步只会制造一堆
//! 「为了让这一步编译过」的临时垫片，然后在下一步删掉。

pub mod commands;
pub mod events;
pub mod runtime;
pub mod services;
pub mod storage;

use std::sync::OnceLock;

static APP_VERSION: OnceLock<String> = OnceLock::new();

/// 由宿主进程在启动时注入版本号。
///
/// 版本是**部署事实**不是核心事实：它来自 `package.json` / git tag，由打包流程决定。
/// 搬迁前 `app_version()` 靠 src-tauri 的 build.rs 塞 `env!`，那条路在这里走不通——
/// agent-core 编译时根本不知道自己会被装进哪个产物。所以改成注入。
///
/// 重复注入是无操作（`OnceLock`），因为「谁先启动」不该影响结果。
pub fn set_app_version(version: impl Into<String>) {
    let _ = APP_VERSION.set(version.into());
}

/// 宿主未注入时返回 `0.0.0-unknown`，不 panic：版本号只用于 MCP `clientInfo`
/// 这类自报家门的场合，拿不到不该让整个后端起不来。
pub fn app_version() -> &'static str {
    APP_VERSION
        .get()
        .map(String::as_str)
        .unwrap_or("0.0.0-unknown")
}
