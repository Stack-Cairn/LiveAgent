#!/usr/bin/env node
// Generates the axum route layer for the 195 backend commands from the Tauri
// thin-wrapper layer (crates/frontend/src-tauri/src/tauri_commands/*.rs).
//
// The wrappers are the authoritative source for the HTTP contract:
//   - command name  →  POST /api/<command_name>
//   - rename_all    →  #[serde(rename_all = ...)] on the Args struct (mirrors
//                      the tauri attribute exactly; camelCase when absent)
//   - param names   →  JSON keys (the tauri param names ARE the frontend keys)
//   - State params  →  resolved from AppState by Arc<T> type, never from body
//   - sync/async    →  whether the handler awaits the core call
//   - return type   →  non-Result returns get wrapped in Ok(...)
//
// Output is written to crates/backend/src/server/routes_gen.rs (byte-identical,
// enforced by `--check`). The ROUTED_COMMANDS const and the .route() calls in
// gen_router() are generated from the same list, so registration and the
// contract-test name list can never drift.
//
// Usage: node scripts/generate-routes.mjs [--check]
//   --check   compare against the checked-in file without writing; exits 1 on drift

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_DIR = join(repoRoot, "crates", "frontend", "src-tauri", "src", "tauri_commands");
const OUTPUT_PATH = join(repoRoot, "crates", "backend", "src", "server", "routes_gen.rs");

// State 类型 → AppState 字段（backend/src/server/state.rs 的 11 个注册表）。
const STATE_MAP = {
  EventBus: "events",
  AutomationStore: "automation_store",
  AutomationScheduler: "automation_scheduler",
  MemoryStore: "memory_store",
  ManagedProcessRegistry: "managed_processes",
  TerminalSessionRegistry: "terminals",
  SftpSessionRegistry: "sftp",
  ShellRunRegistry: "shell_runs",
  GitCloneTaskRegistry: "git_clone_tasks",
  HookScopeRegistry: "hook_scopes",
  McpRuntimeManager: "mcp",
  TunnelStore: "tunnels",
};

// 不做 HTTP 路由的命令（走 WS 事件流）。名字与 routes.rs 文档一致。
const WS_STREAM = new Set(["terminal_stream_attach", "terminal_stream_input", "terminal_stream_resize"]);

// 不在 backend.txt 里的 wrapper：删除清单（proxy）或前端专属（frontend.txt）。
// 路由它们会破坏「后端是唯一网络入口」的边界。
const SKIP = new Set(["proxy_get_server_info", "open_chat_file_link", "fs_open_workspace_path", "git_open_system_file_location"]);

// 不在 wrapper 目录里的命令：实现与 #[tauri::command] 都在 backend / commands/app，
// 扫描不到，但仍是 backend.txt 契约的一部分，手工列在这里保持路由完整。
const EXTRA_COMMANDS = [
  {
    name: "system_list_skill_files",
    renameAll: "camelCase",
    isAsync: true,
    retType: "Result<SystemListSkillFilesResponse, String>",
    callPath: "crate::services::skills::system_list_skill_files",
    stateParams: [],
    bodyParams: [],
    params: [],
    uses: ["use crate::services::skills::*;"],
  },
];

// 按深度切分参数列表，正确处理嵌套泛型（Option<HashMap<String,String>>、Vec<McpServerConfig>）。
function splitParams(paramStr) {
  const params = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < paramStr.length; i++) {
    const c = paramStr[i];
    if (c === "<" || c === "(" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      params.push(paramStr.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = paramStr.slice(start).trim();
  if (last) params.push(last);
  return params;
}

// 解析单个参数：State 参数返回 { state: Arc<T> 的 T }，body 参数返回 { type }。
function parseParam(paramStr) {
  const idx = paramStr.indexOf(":");
  const name = paramStr.slice(0, idx).trim();
  const type = paramStr.slice(idx + 1).trim();
  const stateMatch = type.match(/^tauri::State<'_, Arc<([^>]+)>>$/);
  if (stateMatch) return { name, state: stateMatch[1] };
  return { name, type };
}

function parseWrapperFile(filePath) {
  const text = readFileSync(filePath, "utf8");

  // 该文件的 backend:: use 行（含跨行块）——每个命令模块原样复制，保证
  // 参数类型与 wrapper 用同一来源，且不会跨文件撞 E0252。
  const uses = [];
  const useRe = /\buse\s+backend::[\s\S]*?;/g;
  let um;
  while ((um = useRe.exec(text)) !== null) {
    const before = text.slice(0, um.index);
    const lineStart = before.lastIndexOf("\n");
    const prefix = before.slice(lineStart + 1).trimStart();
    if (prefix.startsWith("//")) continue; // 注释里的字面量
    // wrapper（frontend crate）里写的是 backend::…；生成的文件在 backend
    // crate 内部，同一路径要写成 crate::…。
    uses.push(um[0].replace(/\bbackend::/g, "crate::"));
  }

  const lines = text.split("\n");
  const commands = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 跳过文件头注释（里面就有 #[tauri::command] 字样）。
    if (line.trimStart().startsWith("//")) {
      i++;
      continue;
    }
    const attrMatch = line.match(/^#\[tauri::command(.*)\]\s*$/);
    if (!attrMatch) {
      i++;
      continue;
    }
    const attr = attrMatch[1].trim();
    const renameAll = (attr.match(/rename_all\s*=\s*"([^"]+)"/) || [])[1] || "camelCase";

    // 收集签名行直到含 { 的结束行。
    const sigLines = [];
    i++;
    while (i < lines.length && !lines[i].includes("{")) {
      sigLines.push(lines[i]);
      i++;
    }
    sigLines.push(lines[i]);
    i++;

    const sig = sigLines.join(" ").trim();
    const fnMatch = sig.match(/^pub\s+(async\s+)?fn\s+(\w+)\s*\((.*)\)\s*->\s*(.+)$/);
    if (!fnMatch) {
      throw new Error(`PARSE_FAIL: 无法解析签名 ${filePath}:\n${sig}`);
    }
    const isAsync = !!fnMatch[1];
    const name = fnMatch[2];
    const paramStr = fnMatch[3];
    const retType = fnMatch[4].trim().replace(/\s*\{\s*$/, "").trim();

    // SKIP（前端专属/删除）与 WS_STREAM（流式走 WS）命令不生成路由，直接跳过，
    // 它们的 body 也不走标准 backend 调用（如 proxy_get_server_info 调 services::proxy::）。
    if (WS_STREAM.has(name) || SKIP.has(name)) continue;

    const params = splitParams(paramStr).map(parseParam).filter((p) => p.name !== "");
    const stateParams = params.filter((p) => p.state);
    const bodyParams = params.filter((p) => !p.state);
    const callRe = new RegExp(`backend::[\\w:]+?${name}\\s*\\(`);
    const callMatch = text.match(callRe);
    if (!callMatch) {
      throw new Error(`PARSE_FAIL: ${name} 的 body 里找不到 backend 调用`);
    }
    const callPath = callMatch[0].replace(/\(\s*$/, "").replace(/^backend::/, "crate::");
    const callIdents = callPath.split("::");
    const lastIdent = callIdents[callIdents.length - 1];
    if (lastIdent !== name) {
      throw new Error(`PARSE_FAIL: ${name} 的调用路径末段是 ${lastIdent}，与命令名不符`);
    }

    // 校验 State 类型都在映射表里。
    for (const sp of stateParams) {
      if (!STATE_MAP[sp.state]) {
        throw new Error(`PARSE_FAIL: ${name} 的 State 类型 Arc<${sp.state}> 不在 AppState 映射表`);
      }
    }

    // params 保留 wrapper 的原始顺序：backend 函数签名就是 wrapper 参数顺序
    // （body 里 x.inner() 原样转发），乱序会导致参数错位甚至静默交换。
    commands.push({ name, renameAll, isAsync, retType, callPath, stateParams, bodyParams, params, uses });
  }
  return commands;
}

function toPascal(name) {
  return name
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function render() {
  const wrapperFiles = readdirFiles();
  const commands = [];
  for (const f of wrapperFiles) {
    const parsed = parseWrapperFile(join(WRAPPER_DIR, f));
    for (const cmd of parsed) {
      commands.push(cmd);
    }
  }

  for (const cmd of EXTRA_COMMANDS) {
    commands.push(cmd);
  }

  // 确定性排序：按命令名，保证输出稳定。
  commands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = commands.map((c) => c.name);

  const out = [];
  out.push("// Generated by scripts/generate-routes.mjs — DO NOT EDIT.");
  out.push("//");
  out.push("// 每个命令一条 handler，POST /api/<command_name>，body 的 JSON key 与");
  out.push("// #[tauri::command] 参数名逐字一致。rename_all 逐命令镜像 tauri 属性。");
  out.push("#![allow(unused_imports, clippy::too_many_arguments)]");
  out.push("use axum::extract::State;");
  out.push("use axum::response::Response;");
  out.push("use axum::routing::post;");
  out.push("use axum::Router;");
  out.push("use serde::Deserialize;");
  out.push("use serde_json::Value;");
  out.push("use std::collections::HashMap;");
  out.push("// 不用 axum::Json：它的提取失败是 422/415 纯文本，违反「所有失败都是");
  out.push("// 400 + {error}」的契约（server/mod.rs）。crate::server::json::Json 把它们折进同一形状。");
  out.push("use crate::server::json::Json;");
  out.push("use crate::server::respond;");
  out.push("use crate::server::state::AppState;");
  out.push("");

  for (const cmd of commands) {
    const pascal = toPascal(cmd.name);
    const argsStruct = `${pascal}RouteArgs`;
    const hasBody = cmd.bodyParams.length > 0;

    // 每个命令一个私有模块，复制其源 wrapper 文件的 backend:: use 行：
    // 参数类型与 wrapper 同一来源，跨文件同名符号互不干扰（E0252 不跨模块）。
    out.push(`mod ${cmd.name} {`);
    out.push(`    use super::*;`);
    for (const u of cmd.uses) out.push(`    ${u}`);
    out.push(``);

    if (hasBody) {
      out.push(`    #[derive(Deserialize)]`);
      out.push(`    #[serde(rename_all = "${cmd.renameAll}")]`);
      out.push(`    pub struct ${argsStruct} {`);
      for (const p of cmd.bodyParams) out.push(`        ${p.name}: ${p.type},`);
      out.push(`    }`);
      out.push(``);
    }

    const extractors = [];
    if (cmd.stateParams.length > 0) extractors.push("    State(state): State<AppState>,");
    if (hasBody) extractors.push(`    Json(args): Json<${argsStruct}>,`);

    if (extractors.length > 0) {
      out.push(`    pub async fn handle(`);
      out.push(extractors.join("\n"));
      out.push(`    ) -> Response {`);
    } else {
      out.push(`    pub async fn handle() -> Response {`);
    }

    // 拼调用：按 wrapper 原始参数顺序，body 参数 → args.<name>，State 参数 → &state.<field>。
    const callArgs = [];
    for (const p of cmd.params) {
      if (p.state) callArgs.push(`&state.${STATE_MAP[p.state]}`);
      else callArgs.push(`args.${p.name}`);
    }
    let call = `${cmd.callPath}(${callArgs.join(", ")})`;
    if (cmd.isAsync) call += ".await";

    const isResult = cmd.retType.startsWith("Result");
    if (isResult) {
      out.push(`        respond(${call})`);
    } else {
      // 非 Result 返回包成 Result<T, String> 交给 respond；显式指定 E 让类型可推断。
      out.push(`        respond(Ok::<_, String>(${call}))`);
    }
    out.push(`    }`);
    out.push(`}`);
    out.push(``);
  }

  out.push(`pub fn gen_router() -> Router<AppState> {`);
  out.push(`    Router::new()`);
  for (const n of names) out.push(`        .route("/${n}", post(${n}::handle))`);
  out.push(`}`);
  out.push(``);
  out.push(`/// 已挂路由的命令名。契约测试拿它和 backend.txt 清单比对，`);
  out.push(`/// 「新增 command 未加路由」必须导致测试失败。`);
  out.push(`pub const ROUTED_COMMANDS: &[&str] = &[`);
  for (const n of names) out.push(`    "${n}",`);
  out.push(`];`);
  out.push(``);

  return out.join("\n");
}

function readdirFiles() {
  return readdirSync(WRAPPER_DIR).filter((f) => f.endsWith(".rs"));
}

const check = process.argv.includes("--check");
const generated = render();
if (check) {
  let current;
  try {
    current = readFileSync(OUTPUT_PATH, "utf8");
  } catch {
    console.error(`routes_gen.rs 不存在，先运行 node scripts/generate-routes.mjs`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error("routes_gen.rs 与 wrapper 层不一致，请运行 node scripts/generate-routes.mjs 重新生成");
    process.exit(1);
  }
  console.log("routes_gen.rs 与 wrapper 层一致");
} else {
  writeFileSync(OUTPUT_PATH, generated);
  const names = (generated.match(/ROUTED_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/) || [])[1] || "";
  const count = (names.match(/"/g) || []).length / 2;
  console.log(`已生成 routes_gen.rs（${count} 条路由）`);
}
