//! CUA (Computer Use Agent) 驱动：把 macOS 屏幕 / 输入抽象为一组结构化操作，
//! 暴露给 Tauri Command，再由前端 MCP 工具层注入给 Agent。
//!
//! MVP 范围：窗口枚举 + 截屏 + 点击 + 输入 + 按键 + 滚动 + 拖拽 + 焦点。
//! 平台支持：macOS 通过 `osascript`（System Events）与 `screencapture` 完成；
//! Windows / Linux 暂以 stub + 明确错误回绝（避免静默失败），后续再补。
//!
//! 设计原则：
//! - **KISS**：直接走系统自带命令行（osascript / screencapture），不引入
//!   `core-graphics` / `core-foundation` 等原生依赖，编译与体积代价最小。
//! - **DRY**：状态、审计日志、配额放同一个 `CuaStore`；所有命令统一过
//!   `enforce_enabled + check_allowed` 守卫。

pub mod driver;
pub mod error;
pub mod installer;
pub mod store;

#[allow(unused_imports)]
pub use driver::{platform_driver, ClickButton, CuaDriver, PlatformError, WindowInfo};
pub use error::CuaError;
pub use installer::{
    build_install_command, build_install_preview, detect as detect_driver, install as install_driver,
    is_daemon_running, start_daemon as start_driver_daemon, update as update_driver,
    CuaDriverDetection, CuaInstallResult, CuaUpdateResult, InstallCommand, InstallPreview,
    InstallerProgressEvent, InstallerStage,
};
pub use store::{CuaAuditEntry, CuaRuntimeConfig, CuaStore, CuaStoreSnapshot};