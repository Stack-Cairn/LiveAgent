//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use agent_core::services::skills::*;

#[tauri::command]
pub async fn system_list_skill_files() -> Result<SystemListSkillFilesResponse, String> {
    agent_core::services::skills::system_list_skill_files().await
}

