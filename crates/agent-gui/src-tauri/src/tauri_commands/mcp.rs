//! 由 #[tauri::command] 拆分出来的薄包装。
//!
//! 实现在 agent-core，本文件只做「Tauri IPC → 普通函数调用」这一件事。
//! 属性逐命令沿用原状（含 rename_all）——前端现在就在按这些名字传参，
//! 统一风格等于 177 次破坏前端的机会。

#![allow(unused_imports)]

use agent_core::commands::mcp::*;
use agent_core::runtime::platform::{
    expand_tilde_path, maybe_augment_macos_path, resolve_program_path_with_current_dir,
};
use agent_core::runtime::process::{
    configure_child_process_group, kill_child_process_tree_best_effort,
};
use agent_core::runtime::shell_runner::ShellRunRegistry;
use reqwest::blocking::Client as HttpClient;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use reqwest::StatusCode;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Barrier;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_list_tools(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    servers: Vec<McpServerConfig>,
) -> Result<Vec<McpToolInfo>, String> {
    agent_core::commands::mcp::mcp_list_tools(state.inner(), servers).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_call_tool(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    run_registry: tauri::State<'_, Arc<ShellRunRegistry>>,
    server_id: String,
    tool_name: String,
    arguments: Value,
    run_id: Option<String>,
) -> Result<McpCallToolResponse, String> {
    agent_core::commands::mcp::mcp_call_tool(
        state.inner(),
        run_registry.inner(),
        server_id,
        tool_name,
        arguments,
        run_id,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_runtime_status(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server_id: String,
) -> Result<McpRuntimeStatus, String> {
    agent_core::commands::mcp::mcp_runtime_status(state.inner(), server_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_stop_server(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server_id: String,
) -> Result<McpStopServerResponse, String> {
    agent_core::commands::mcp::mcp_stop_server(state.inner(), server_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_test_server(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server: McpServerConfig,
    include_schema: Option<bool>,
    persist: Option<bool>,
) -> Result<McpRuntimeTestResponse, String> {
    agent_core::commands::mcp::mcp_test_server(state.inner(), server, include_schema, persist).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_restart_server(
    state: tauri::State<'_, Arc<McpRuntimeManager>>,
    server: McpServerConfig,
    include_schema: Option<bool>,
    persist: Option<bool>,
) -> Result<McpRuntimeTestResponse, String> {
    agent_core::commands::mcp::mcp_restart_server(state.inner(), server, include_schema, persist)
        .await
}
