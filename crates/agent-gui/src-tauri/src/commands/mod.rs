#[path = "app/mod.rs"]
pub mod app_commands;
#[path = "automation/mod.rs"]
pub mod automation_commands;
#[path = "config/mod.rs"]
pub mod config_commands;
#[path = "history/mod.rs"]
pub mod history_commands;
#[path = "integration/mod.rs"]
pub mod integration_commands;
#[path = "runtime/mod.rs"]
pub mod runtime_commands;
#[path = "workspace/mod.rs"]
pub mod workspace_commands;

pub use app_commands::app;
pub use app_commands::system;
pub use app_commands::system_tools;
pub use app_commands::update;

pub use automation_commands::cron;
pub use automation_commands::hook;

pub use config_commands::settings;

pub use history_commands::chat_history;
pub use history_commands::history_db;
pub use history_commands::subagent_history;

pub use integration_commands::gateway;
pub use integration_commands::mcp;
pub use integration_commands::memory;

pub use runtime_commands::process;
pub use runtime_commands::sftp;
pub use runtime_commands::shell;
pub use runtime_commands::terminal;

pub use workspace_commands::delegate;
pub use workspace_commands::fs;
pub use workspace_commands::git;
