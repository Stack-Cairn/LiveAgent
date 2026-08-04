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

pub mod events;
