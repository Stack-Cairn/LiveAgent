//! CUA (Computer Use Agent) 服务层：把桌面 / 屏幕 / 输入抽象为一组结构化操作，
//! 暴露给 Tauri Command，再由前端 MCP 工具层注入给 Agent。
//!
//! 范围：窗口枚举 + 截屏 + 点击 + 输入 + 按键 + 滚动 + 拖拽 + 焦点。
//! 平台：跨 macOS / Windows / Linux（cua-driver 提供）。
//!
//! 设计原则：
//! - **KISS**：所有 OS 行为走 `cua-driver mcp --direct` 子进程 JSON-RPC，
//!   不在 Rust 内复刻 AX / 像素路径，体积与维护代价最小。
//! - **DRY**：状态、审计日志、配额放同一个 `CuaStore`；所有命令统一过
//!   `enforce + check_allowed + audit` 守卫。
//! - **审计 + 策略边界在后端**：sandboxOffline / 白名单 / trustMode 都
//!   在 `CuaStore::enforce` 里统一决策，前端只能改 `CuaRuntimeConfig`、
//!   不能绕过审计。

pub mod cua_client;
pub mod error;
pub mod installer;
pub mod store;

pub use cua_client::CuaClient;
pub use error::CuaError;
#[allow(unused_imports)]
pub use installer::{
    build_install_command, build_install_preview, detect as detect_driver, install as install_driver,
    is_daemon_running, start_daemon as start_driver_daemon, update as update_driver,
    CuaDriverDetection, CuaInstallResult, CuaUpdateResult, InstallCommand, InstallPreview,
    InstallerProgressEvent, InstallerStage,
};
pub use store::{CuaAuditEntry, CuaRuntimeConfig, CuaStore, CuaStoreSnapshot};