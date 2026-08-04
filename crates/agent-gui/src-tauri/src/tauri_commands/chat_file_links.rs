//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use agent_core::commands::chat_file_links::*;
use agent_core::runtime::platform::expand_tilde_path;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

#[tauri::command(rename_all = "snake_case")]
pub async fn open_chat_file_link(
    conversation_id: String,
    workdir: String,
    path: String,
    source: String,
    line: Option<u32>,
    end_line: Option<u32>,
    column: Option<u32>,
    open_in_file_manager: Option<bool>,
) -> Result<ChatFileLinkOpenResponse, ChatFileLinkError> {
    agent_core::commands::chat_file_links::open_chat_file_link(
        conversation_id,
        workdir,
        path,
        source,
        line,
        end_line,
        column,
        open_in_file_manager,
    )
    .await
}
