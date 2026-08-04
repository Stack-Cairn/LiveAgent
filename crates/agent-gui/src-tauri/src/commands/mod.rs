//! 壳专属命令。后端命令的实现已迁入 agent-core，Tauri 包装在 `crate::tauri_commands`。

#[path = "app/mod.rs"]
pub mod app_commands;

/// Gateway 的 20 个命令：阶段 4 随 Gateway 一并删除，所以不拆、不迁。
#[path = "integration/gateway.rs"]
pub mod gateway;

pub use app_commands::app;
pub use app_commands::system;
pub use app_commands::tray;
pub use app_commands::update;
