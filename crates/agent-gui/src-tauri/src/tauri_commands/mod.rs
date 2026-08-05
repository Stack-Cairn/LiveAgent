//! Tauri IPC 薄包装层。桌面壳独有；HTTP 路由在 agent-backend 里另有一套。

pub mod chat_file_links;
pub mod chat_history;
pub mod cron;
pub mod fs;
pub mod git;
pub mod hook;
pub mod mcp;
pub mod memory;
pub mod process;
pub mod proxy;
pub mod settings;
pub mod sftp;
pub mod shell;
pub mod subagent_store;
pub mod subagent_worktree;
pub mod system;
pub mod terminal;
pub mod tunnel;
