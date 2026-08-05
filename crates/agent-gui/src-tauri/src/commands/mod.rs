//! 壳专属命令。后端命令的实现已迁入 agent-core，Tauri 包装在 `crate::tauri_commands`。

#[path = "app/mod.rs"]
pub mod app_commands;

#[path = "integration/mod.rs"]
pub mod integration_commands;

pub use app_commands::app;
pub use app_commands::backend;
pub use app_commands::system;
pub use app_commands::tray;
pub use app_commands::update;
pub use integration_commands::provider_usage;
pub use integration_commands::workspace;
