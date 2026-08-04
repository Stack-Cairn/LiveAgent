#!/usr/bin/env python3
"""Generate src/headless.rs invoke dispatch for the headless (no-tauri) runtime.

[HISTORICAL TOOL] Since the BFF proxy / route-fix commits (the headless.rs
server skeleton) src/headless.rs diverged from this generator and is now
hand-maintained. Its dispatch arms are checked against the committed manifest
by scripts/verify_headless.py in CI. This script is kept for reference only;
do not run it to overwrite src/headless.rs.

v2: Improved error handling, WebSocket backpressure, auth middleware support.
Generates the complete headless.rs file with:
  - Unified HeadlessError type (DesktopOnly / Unavailable / Business)
  - WebSocket send queue with backpressure
  - Bearer token auth middleware
  - Rate limiting support
  - Request tracing via eprintln (lightweight, no tracing crate)

Usage:
    python3 scripts/gen_headless.py [--commands /tmp/commands.json] [--types /tmp/type_map.json]
"""
import json, re, sys, argparse
from collections import OrderedDict

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
ap = argparse.ArgumentParser()
ap.add_argument('--commands', default='/tmp/commands.json')
ap.add_argument('--types', default='/tmp/type_map.json')
ap.add_argument('--out', default='crates/agent-gui/src-tauri/src/headless.rs')
args = ap.parse_args()

cmds = json.load(open(args.commands))
type_map = json.load(open(args.types))

# ---------------------------------------------------------------------------
# Path resolution helpers (shared with gen_adapters.py)
# ---------------------------------------------------------------------------
KNOWN_PATH_PREFIX = ('tauri::', 'crate::', 'super::', 'self::', 'std::')

FLAT_FILE = {
    'commands/app/app.rs': 'commands::app',
    'commands/app/system.rs': 'commands::system',
    'commands/app/tray.rs': 'commands::tray',
    'commands/app/update.rs': 'commands::update',
    'commands/automation/cron.rs': 'commands::cron',
    'commands/automation/hook.rs': 'commands::hook',
    'commands/history/history_db.rs': 'commands::history_db',
    'commands/history/subagent_store.rs': 'commands::subagent_store',
    'commands/integration/gateway.rs': 'commands::gateway',
    'commands/integration/mcp.rs': 'commands::mcp',
    'commands/integration/memory.rs': 'commands::memory',
    'commands/runtime/process.rs': 'commands::process',
    'commands/runtime/sftp.rs': 'commands::sftp',
    'commands/runtime/shell.rs': 'commands::shell',
    'commands/runtime/terminal.rs': 'commands::terminal',
    'commands/workspace/chat_file_links.rs': 'commands::chat_file_links',
    'commands/workspace/fs.rs': 'commands::fs',
    'commands/workspace/git.rs': 'commands::git',
    'commands/workspace/subagent_worktree.rs': 'commands::subagent_worktree',
}
FLAT_PREFIX = [
    ('commands/config/settings/', 'commands::settings'),
    ('commands/history/chat_history/', 'commands::chat_history'),
    ('services/memory/', 'services::memory'),
    ('runtime/terminal/', 'runtime::terminal'),
]
FLAT_TYPES = {
    'services/gateway/types.rs': 'services::gateway',
    'services/skills/types.rs': 'services::skills',
    'services/automation/types.rs': 'services::automation',
    'runtime/terminal/types.rs': 'runtime::terminal',
}

def resolve_use_path(rel):
    if rel in FLAT_FILE:
        return FLAT_FILE[rel]
    if rel in FLAT_TYPES:
        return FLAT_TYPES[rel]
    for prefix, flat in FLAT_PREFIX:
        if rel.startswith(prefix):
            return flat
    if rel.endswith('/mod.rs'):
        return rel[:-7].replace('/', '::')
    return rel[:-3].replace('/', '::')

STD_TYPE_IMPORTS = {
    'HashMap': 'std::collections::HashMap',
    'HashSet': 'std::collections::HashSet',
    'BTreeMap': 'std::collections::BTreeMap',
    'BTreeSet': 'std::collections::BTreeSet',
    'VecDeque': 'std::collections::VecDeque',
    'BinaryHeap': 'std::collections::BinaryHeap',
    'AtomicBool': 'std::sync::atomic::AtomicBool',
    'AtomicU8': 'std::sync::atomic::AtomicU8',
    'AtomicU16': 'std::sync::atomic::AtomicU16',
    'AtomicU32': 'std::sync::atomic::AtomicU32',
    'AtomicU64': 'std::sync::atomic::AtomicU64',
    'AtomicUsize': 'std::sync::atomic::AtomicUsize',
    'PathBuf': 'std::path::PathBuf',
    'Path': 'std::path::Path',
    'Duration': 'std::time::Duration',
    'Instant': 'std::time::Instant',
    'SystemTime': 'std::time::SystemTime',
    'Mutex': 'std::sync::Mutex',
    'RwLock': 'std::sync::RwLock',
    'RwLockReadGuard': 'std::sync::RwLockReadGuard',
    'RwLockWriteGuard': 'std::sync::RwLockWriteGuard',
    'MutexGuard': 'std::sync::MutexGuard',
    'Arc': 'std::sync::Arc',
    'Cow': 'std::borrow::Cow',
}

def extract_type_names(t):
    names = []
    def split_top(s):
        parts, d, cur = [], 0, []
        for ch in s:
            if ch == '<': d += 1
            elif ch == '>': d -= 1
            if ch == ',' and d == 0:
                parts.append(''.join(cur).strip()); cur = []
            else:
                cur.append(ch)
        if cur: parts.append(''.join(cur).strip())
        return parts
    queue = [t.strip()]; seen = set()
    while queue:
        expr = queue.pop(0)
        if not expr: continue
        expr = re.sub(r'^&(mut )?', '', expr.strip())
        if expr.startswith('fn(') or expr.startswith('impl ') or expr.startswith('dyn '): continue
        m = re.match(r'([A-Za-z_:][A-Za-z0-9_:]*)\s*(<.*>)?', expr, re.S)
        if not m: continue
        base, rest = m.group(1), m.group(2)
        seen.add(base)
        if not base.startswith(KNOWN_PATH_PREFIX): names.append(base)
        if rest:
            for part in split_top(rest[1:-1]): queue.append(part)
    return names

# ---------------------------------------------------------------------------
# State mapping
# ---------------------------------------------------------------------------
STATE_MAP = {
    'Arc<GatewayController>': '&state.ctx.gateway_controller',
    'Arc<MemoryStore>': '&state.ctx.memory_store',
    'Arc<TerminalSessionRegistry>': '&state.ctx.terminal_registry',
    'Arc<SftpSessionRegistry>': '&state.ctx.sftp_registry',
    'Arc<AutomationStore>': '&state.ctx.automation_store',
    'Arc<McpRuntimeManager>': '&state.mcp_runtime',
    'Arc<ManagedProcessRegistry>': '&state.ctx.managed_process_registry',
    'Arc<GitCloneTaskRegistry>': '&state.ctx.git_clone_task_registry',
    'Arc<HookScopeRegistry>': '&state.hook_scopes',
    'Arc<ShellRunRegistry>': '&state.shell_runs',
    'Arc<PowerActivityManager>': '&state.ctx.power_activity',
    'Arc<ProviderUsageService>': '&state.ctx.provider_usage_service',
    'Arc<CloseWindowBehaviorState>': '&state.ctx.close_window_behavior',
    'Arc<AtomicBool>': '&state.ctx.allow_exit',
    'Arc<AutomationScheduler>': '&state.ctx.automation_scheduler',
    'Arc<ProxyServerState>': '&state.proxy_server',
}
DESKTOP_ONLY_STATES = {'Arc<WindowPinState>', 'Arc<GlobalShortcutRegistry>', 'Arc<TrayMenuHandles>'}
STATE_RE = re.compile(r"^(tauri::)?State<'_, (Arc<[^>]+>)>$")

# Commands that are truly unavailable in headless (not just desktop-only)
# The original gen_headless.py had system_pick_folder here but the actual
# headless.rs implements a path-based fallback. We only block truly unusable ones.
HEADLESS_UNAVAILABLE = {
    'system_pick_file': 'native file picker',
}

def is_state(t): return bool(STATE_RE.match(t.strip()))
def state_inner(t): return STATE_RE.match(t.strip()).group(2)
def is_option(t): return bool(re.match(r'^Option<(.+)>$', t.strip(), re.S))
def option_inner(t): return re.match(r'^Option<(.+)>$', t.strip(), re.S).group(1)

def call_target(c):
    if c['module'] == 'proxy':
        return 'crate::services::proxy::proxy_get_server_info'
    return f"crate::commands::{c['module']}::{c['name']}"

def is_desktop_only(c):
    for p in c['params']:
        t = p['type'].strip()
        if re.search(r'AppHandle|tauri::Window', t): return True
        if is_state(t) and state_inner(t) in DESKTOP_ONLY_STATES: return True
    return False

def _arm_system_pick_folder():
    """Generate headless fallback for system_pick_folder.
    
    Accepts a `path` argument from the frontend inline input dialog.
    If no path, returns home directory as default.
    Validates the path is a directory before returning.
    """
    return [
        '    "system_pick_folder" => {',
        '        let path_v: Option<String> = take_arg_opt(&mut args, "path")?;',
        '        let initial_v: Option<String> = take_arg_opt(&mut args, "initial_workdir")?;',
        '        let target = path_v',
        '            .or(initial_v)',
        '            .unwrap_or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_else(|| "/".to_string()));',
        '        let p = std::path::Path::new(&target);',
        '        if p.is_dir() {',
        '            to_value(target)',
        '        } else {',
        '            Err(HeadlessError::Business(format!("路径不存在或不是目录: {target}")))',
        '        }',
        '    },',
    ]

def arm_for(c):
    name = c['name']
    # Truly headless-unavailable
    if name in HEADLESS_UNAVAILABLE:
        return [f'    "{name}" => Err(HeadlessError::Unavailable("{HEADLESS_UNAVAILABLE[name]}")),']
    # Special case: system_pick_folder has a path-based fallback in headless mode
    if name == 'system_pick_folder':
        return _arm_system_pick_folder()
    # Desktop-only
    if is_desktop_only(c):
        return [f'    "{name}" => Err(HeadlessError::DesktopOnly("{name}")),']

    prelude, call_args = [], []
    for p in c['params']:
        t = p['type'].strip()
        if is_state(t):
            call_args.append(STATE_MAP[state_inner(t)])
        elif is_option(t):
            inner = option_inner(t)
            prelude.append(f'        let {p["name"]}_v: Option<{inner}> = take_arg_opt(&mut args, "{p["name"]}")?;')
            call_args.append(f'{p["name"]}_v')
        else:
            prelude.append(f'        let {p["name"]}_v: {t} = take_arg(&mut args, "{p["name"]}")?;')
            call_args.append(f'{p["name"]}_v')

    call = f"{call_target(c)}({', '.join(call_args)})" + ('.await' if c['is_async'] else '')
    ret = (c['ret'] or '').strip()
    if re.match(r'^Result<', ret):
        m = re.match(r'^Result<(.+), (.+)>$', ret, re.S)
        err_t = m.group(2).strip() if m else ''
        if err_t == 'String':
            body = f'        match {call} {{\n            Ok(v) => to_value(v),\n            Err(e) => Err(HeadlessError::Business(e)),\n        }}'
        else:
            body = f'        match {call} {{\n            Ok(v) => to_value(v),\n            Err(e) => Err(HeadlessError::Business(format!("{{e:?}}"))),\n        }}'
    elif not ret:
        body = f'        {{ {call}; Ok(Value::Null) }}'
    else:
        body = f'        to_value({call})'
    return [f'    "{name}" => {{'] + prelude + [body] + ['    },']

# ---------------------------------------------------------------------------
# Code generation
# ---------------------------------------------------------------------------
L = []  # output lines
def w(s=''): L.append(s)

# --- Header ---
w('//! Headless runtime (no Tauri): an axum HTTP/WebSocket server that')
w('//! exposes the same business command surface the desktop build exposes')
w('//! via `#[tauri::command]`. Compiled only when the `desktop` feature is')
w('//! off (`--no-default-features`).')
w('//!')
w('//! Routes:')
w('//!   GET  /health      -> { ok, version, mode }')
w('//!   GET  /api/status  -> gateway status snapshot')
w('//!   POST /api/invoke  -> { cmd, args } -> { ok, value | error }')
w('//!   GET  /ws          -> WebSocket broadcast of frontend events')
w('//!   GET  /*           -> WebUI static assets (SPA fallback)')
w('//!')
w('//! The invoke dispatch below is AUTO-GENERATED by')
w('//! scripts/gen_headless.py — do not edit by hand.')
w('#![cfg(not(feature = "desktop"))]')
w()

# --- Imports ---
w('use std::collections::HashMap;')
w('use std::path::PathBuf;')
w('use std::sync::Arc;')
w('use std::time::Instant;')
w()
w('use dirs;')
w()
w('use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};')
w('use axum::extract::{Path as AxumPath, State as AxumState};')
w('use axum::http::{header, StatusCode};')
w('use axum::middleware::{self, Next};')
w('use axum::response::{IntoResponse, Response};')
w('use axum::routing::{get, post};')
w('use axum::{Json, Router};')
w('use serde::de::DeserializeOwned;')
w('use serde::Deserialize;')
w('use serde_json::Value;')
w('use tokio::sync::broadcast;')
w('use tower_http::cors::{Any, CorsLayer};')
w()

# Module-level type imports
needed_uses = {}
std_needed = set()
for c in cmds:
    if is_desktop_only(c) or c['name'] in HEADLESS_UNAVAILABLE:
        continue
    for p in c['params']:
        if is_state(p['type'].strip()): continue
        for name in extract_type_names(p['type']):
            if name in type_map and name != 'Arc':
                needed_uses[name] = type_map[name]
            elif name in STD_TYPE_IMPORTS and name != 'Arc':
                std_needed.add(name)

module_imports = {}
for name, rel in sorted(needed_uses.items()):
    modpath = resolve_use_path(rel)
    module_imports.setdefault(modpath, []).append(name)
for modpath in sorted(module_imports):
    names = sorted(set(module_imports[modpath]))
    w(f'use crate::{modpath}::{{{", ".join(names)}}};')

w()
w('use crate::app_context::AppContext;')
w('use crate::events::WsEventEmitter;')
w('use crate::runtime::shell_runner::ShellRunRegistry;')
w('use crate::services::proxy::ProxyServerState;')
w()

# --- HeadlessError ---
w('// ---- Unified error type for headless command dispatch ----')
w()
w('#[derive(Debug)]')
w('pub enum HeadlessError {')
w('    /// Command only available in the desktop build (requires AppHandle / Window).')
w('    DesktopOnly(&\'static str),')
w('    /// Feature unavailable in headless (e.g. native file picker).')
w('    Unavailable(&\'static str),')
w('    /// Business-logic error forwarded from the underlying command.')
w('    Business(String),')
w('}')
w()
w('impl std::fmt::Display for HeadlessError {')
w('    fn fmt(&self, f: &mut std::fmt::Formatter<\'_>) -> std::fmt::Result {')
w('        match self {')
w('            HeadlessError::DesktopOnly(cmd) => write!(f, "command `{cmd}` is only available in desktop mode"),')
w('            HeadlessError::Unavailable(what) => write!(f, "{what} is unavailable in headless mode"),')
w('            HeadlessError::Business(msg)    => write!(f, "{msg}"),')
w('        }')
w('    }')
w('}')
w()
w('impl std::error::Error for HeadlessError {}')
w()
w('impl From<String> for HeadlessError {')
w('    fn from(s: String) -> Self { HeadlessError::Business(s) }')
w('}')
w()

# --- HeadlessState ---
w('// ---- Shared headless state ----')
w()
w('#[derive(Clone)]')
w('pub struct HeadlessState {')
w('    pub ctx: Arc<AppContext>,')
w('    pub emitter: Arc<WsEventEmitter>,')
w('    pub mcp_runtime: Arc<crate::commands::mcp::McpRuntimeManager>,')
w('    pub shell_runs: Arc<ShellRunRegistry>,')
w('    pub hook_scopes: Arc<crate::commands::hook::HookScopeRegistry>,')
w('    pub proxy_server: Arc<ProxyServerState>,')
w('}')
w()

# --- Arg helpers ---
w('// ---- Argument helpers ----')
w()
w('fn camelize(name: &str) -> String {')
w('    let mut out = String::with_capacity(name.len());')
w('    let mut upper = false;')
w('    for ch in name.chars() {')
w('        if ch == \'_\' { upper = true; }')
w('        else if upper { out.extend(ch.to_uppercase()); upper = false; }')
w('        else { out.push(ch); }')
w('    }')
w('    out')
w('}')
w()
w('fn remove_arg(obj: &mut serde_json::Map<String, Value>, name: &str) -> Option<Value> {')
w('    if let Some(v) = obj.remove(name) { return Some(v); }')
w('    let camel = camelize(name);')
w('    if camel != name { obj.remove(&camel) } else { None }')
w('}')
w()
w('fn take_arg<T: DeserializeOwned>(args: &mut Value, name: &str) -> Result<T, HeadlessError> {')
w('    let obj = args.as_object_mut().ok_or_else(|| HeadlessError::Business("args must be a JSON object".into()))?;')
w('    let value = remove_arg(obj, name).ok_or_else(|| HeadlessError::Business(format!("missing argument `{name}`")))?;')
w('    serde_json::from_value(value).map_err(|e| HeadlessError::Business(format!("argument `{name}`: {e}")))')
w('}')
w()
w('fn take_arg_opt<T: DeserializeOwned>(args: &mut Value, name: &str) -> Result<Option<T>, HeadlessError> {')
w('    let obj = args.as_object_mut().ok_or_else(|| HeadlessError::Business("args must be a JSON object".into()))?;')
w('    match remove_arg(obj, name) {')
w('        None | Some(Value::Null) => Ok(None),')
w('        Some(value) => serde_json::from_value(value).map(Some)')
w('            .map_err(|e| HeadlessError::Business(format!("argument `{name}`: {e}"))),')
w('    }')
w('}')
w()
w('fn to_value<T: serde::Serialize>(v: T) -> Result<Value, HeadlessError> {')
w('    serde_json::to_value(v).map_err(|e| HeadlessError::Business(format!("serialize result: {e}")))')
w('}')
w()

# --- Dispatch ---
n_arms = 0
w('// ---- Command dispatch (AUTO-GENERATED) ----')
w()
w('pub async fn dispatch(state: &HeadlessState, cmd: &str, args: Value) -> Result<Value, HeadlessError> {')
w('    let mut args = args;')
w('    match cmd {')
by_mod = OrderedDict()
for c in cmds:
    by_mod.setdefault(c['module'], []).append(c)
for module, clist in by_mod.items():
    w(f'        // ===== {module} =====')
    for c in clist:
        L.extend(arm_for(c))
        n_arms += 1
w('        _ => Err(HeadlessError::Business(format!("unknown command: {{cmd}}"))),')
w('    }')
w('}')
w()

# --- Auth middleware ---
w('// ---- Authentication middleware ----')
w()
w('/// Bearer token configuration loaded from environment.')
w('#[derive(Clone)]')
w('pub struct AuthConfig {')
w('    /// Expected Bearer token; `None` = auth disabled.')
w('    pub api_token: Option<String>,')
w('}')
w()
w('impl AuthConfig {')
w('    pub fn from_env() -> Self {')
w('        let api_token = std::env::var("LIVEAGENT_API_TOKEN")')
w('            .ok().filter(|t| !t.is_empty());')
w('        Self { api_token }')
w('    }')
w('}')
w()
w('async fn auth_middleware(')
w('    State(config): State<AuthConfig>,')
w('    req: axum::http::Request<axum::body::Body>,')
w('    next: Next,')
w(') -> Result<Response, StatusCode> {')
w('    // Health check and WebSocket are always public.')
w('    let path = req.uri().path().to_string();')
w('    if path == "/health" || path == "/api/status" || path == "/ws" || path == "/" {')
w('        return Ok(next.run(req).await);')
w('    }')
w('    match &config.api_token {')
w('        None => Ok(next.run(req).await),')
w('        Some(expected) => {')
w('            let ok = req.headers().get(header::AUTHORIZATION)')
w('                .and_then(|v| v.to_str().ok())')
w('                .and_then(|v| v.strip_prefix("Bearer "))')
w('                .map_or(false, |t| t == expected.as_str());')
w('            if ok { Ok(next.run(req).await) } else { Err(StatusCode::UNAUTHORIZED) }')
w('        }')
w('    }')
w('}')
w()

# --- Rate limiter (simple per-IP token bucket) ---
w('// ---- Rate limiting ----')
w()
w('use std::sync::Mutex;')
w('use std::collections::hash_map::Entry;')
w()
w('/// Simple in-memory per-IP rate limiter (token bucket).')
w('#[derive(Clone)]')
w('pub struct RateLimiter {')
w('    inner: Arc<Mutex<HashMap<String, (u32, Instant)>>>,')
w('    max_tokens: u32,')
w('    refill_interval: std::time::Duration,')
w('}')
w()
w('impl RateLimiter {')
w('    pub fn new(max_tokens: u32, refill_interval: std::time::Duration) -> Self {')
w('        Self { inner: Arc::new(Mutex::new(HashMap::new())), max_tokens, refill_interval }')
w('    }')
w('    /// Returns `true` if the request is allowed.')
w('    pub fn allow(&self, key: &str) -> bool {')
w('        let mut map = self.inner.lock().unwrap();')
w('        let now = Instant::now();')
w('        let entry = map.entry(key.to_string()).or_insert((self.max_tokens, now));')
w('        let elapsed = now.duration_since(entry.1).as_secs_f64();')
w('        let refill = (elapsed / self.refill_interval.as_secs_f64() * self.max_tokens as f64) as u32;')
w('        if refill > 0 {')
w('            entry.0 = (entry.0 + refill).min(self.max_tokens);')
w('            entry.1 = now;')
w('        }')
w('        if entry.0 > 0 { entry.0 -= 1; true } else { false }')
w('    }')
w('}')
w()
w('async fn rate_limit_middleware(')
w('    State(limiter): State<RateLimiter>,')
w('    req: axum::http::Request<axum::body::Body>,')
w('    next: Next,')
w(') -> Result<Response, StatusCode> {')
w('    // Only rate-limit /api/invoke')
w('    if req.uri().path() != "/api/invoke" {')
w('        return Ok(next.run(req).await);')
w('    }')
w('    // Extract IP from X-Forwarded-For or socket addr')
w('    let ip = req.headers().get("x-forwarded-for")')
w('        .and_then(|v| v.to_str().ok())')
w("        .and_then(|v| v.split(',').next())")
w('        .unwrap_or("127.0.0.1")')
w('        .trim().to_string();')
w('    // Loopback (local web UI) is trusted tooling: exempt from rate limiting.')
w('    // Without this, the browser\'s parallel frontend requests quickly exhaust')
w('    // the token bucket and the UI shows HTTP 429 for every invoke.')
w('    let loopback = ip == "127.0.0.1"')
w('        || ip == "::1"')
w('        || ip.starts_with("::1%")')
w('        || ip == "localhost";')
w('    if loopback {')
w('        return Ok(next.run(req).await);')
w('    }')
w('    if limiter.allow(&ip) {')
w('        Ok(next.run(req).await)')
w('    } else {')
w('        eprintln!("[rate-limit] rejected {ip}");')
w('        Err(StatusCode::TOO_MANY_REQUESTS)')
w('    }')
w('}')
w()

# --- WebSocket with backpressure ---
w('// ---- WebSocket broadcast with backpressure ----')
w()
w('/// Maximum pending messages per WebSocket client before oldest are dropped.')
w('const WS_SEND_QUEUE_LIMIT: usize = 256;')
w('/// Log every N dropped events to avoid log flooding.')
w('const WS_LAGGED_LOG_INTERVAL: u64 = 100;')
w()
w('async fn handle_ws(mut socket: WebSocket, state: HeadlessState) {')
w('    let mut rx = state.emitter.subscribe();')
w('    let mut lagged_total: u64 = 0;')
w('    let mut pending: Vec<String> = Vec::new();')
w()
w('    loop {')
w('        // Phase 1: receive new events and enqueue')
w('        while let Ok(event) = rx.try_recv() {')
w('            match event {')
w('                Ok(ev) => {')
w('                    if let Ok(text) = serde_json::to_string(&ev) {')
w('                        if pending.len() >= WS_SEND_QUEUE_LIMIT {')
w('                            pending.remove(0);')
w('                            lagged_total += 1;')
w('                            if lagged_total % WS_LAGGED_LOG_INTERVAL == 0 {')
w('                                eprintln!("[ws] backpressure: {lagged_total} events dropped");')
w('                            }')
w('                        }')
w('                        pending.push(text);')
w('                    }')
w('                }')
w('                Err(broadcast::error::RecvError::Lagged(n)) => {')
w('                    lagged_total += n as u64;')
w('                    if lagged_total % WS_LAGGED_LOG_INTERVAL == 0 {')
w('                        eprintln!("[ws] broadcast lagged: {lagged_total} total");')
w('                    }')
w('                }')
w('                Err(broadcast::error::RecvError::Closed) => return,')
w('            }')
w('        }')
w()
w('        // Phase 2: flush pending to socket')
w('        while let Some(text) = pending.first() {')
w('            match tokio::time::timeout(')
w('                std::time::Duration::from_millis(50),')
w('                socket.send(Message::Text(text.as_str().into())),')
w('            ).await {')
w('                Ok(Ok(_)) => { pending.remove(0); }')
w('                _ => {')
w('                    // Send failed or timed out — client is slow')
w('                    eprintln!("[ws] send timeout/failure, dropping {} pending", pending.len());')
w('                    pending.clear();')
w('                    if lagged_total > 0 {')
w('                        eprintln!("[ws] client disconnected after {lagged_total} total drops");')
w('                    }')
w('                    return;')
w('                }')
w('            }')
w('        }')
w()
w('        // Phase 3: wait for next event or yield')
w('        match tokio::time::timeout(std::time::Duration::from_millis(10), rx.recv()).await {')
w('            Ok(Ok(event)) => {')
w('                match event {')
w('                    Ok(ev) => {')
w('                        if let Ok(text) = serde_json::to_string(&ev) { pending.push(text); }')
w('                    }')
w('                    Err(broadcast::error::RecvError::Lagged(n)) => {')
w('                        lagged_total += n as u64;')
w('                    }')
w('                    Err(broadcast::error::RecvError::Closed) => return,')
w('                }')
w('            }')
w('            _ => {} // timeout — loop back to receive more')
w('        }')
w('    }')
w('}')
w()

# --- Health / status ---
w('// ---- HTTP handlers ----')
w()
w('async fn health(AxumState(_state): AxumState<HeadlessState>) -> Json<Value> {')
w('    Json(serde_json::json!({')
w('        "ok": true,')
w('        "version": crate::app_version(),')
w('        "mode": "headless",')
w('    }))')
w('}')
w()
w('async fn api_status(AxumState(state): AxumState<HeadlessState>) -> Json<Value> {')
w('    match crate::commands::gateway::gateway_status(&state.ctx.gateway_controller) {')
w('        Ok(snapshot) => Json(serde_json::json!({ "ok": true, "gateway": snapshot })),')
w('        Err(error)   => Json(serde_json::json!({ "ok": false, "error": error })),')
w('    }')
w('}')
w()

# --- Invoke handler ---
w('#[derive(Deserialize)]')
w('struct InvokeRequest {')
w('    cmd: String,')
w('    args: Option<Value>,')
w('}')
w()
w('async fn invoke_handler(')
w('    AxumState(state): AxumState<HeadlessState>,')
w('    Json(req): Json<InvokeRequest>,')
w(') -> Json<Value> {')
w('    let t0 = Instant::now();')
w('    let args = req.args.unwrap_or(Value::Null);')
w('    let result = dispatch(&state, &req.cmd, args).await;')
w('    let elapsed_ms = t0.elapsed().as_millis();')
w('    match result {')
w('        Ok(value) => {')
w('            if elapsed_ms > 1000 {')
w('                eprintln!("[invoke] {} ok in {elapsed_ms}ms", req.cmd);')
w('            }')
w('            Json(serde_json::json!({ "ok": true, "value": value }))')
w('        }')
w('        Err(error) => {')
w('            let error_code = match &error {')
w('                HeadlessError::DesktopOnly(_) => "DESKTOP_ONLY",')
w('                HeadlessError::Unavailable(_) => "UNAVAILABLE",')
w('                HeadlessError::Business(_)    => "BUSINESS_ERROR",')
w('            };')
w('            eprintln!("[invoke] {} err ({error_code}): {error}", req.cmd);')
w('            Json(serde_json::json!({')
w('                "ok": false,')
w('                "error": error.to_string(),')
w('                "code": error_code,')
w('            }))')
w('        }')
w('    }')
w('}')
w()

# --- WebSocket upgrade ---
w('async fn ws_handler(')
w('    ws: WebSocketUpgrade,')
w('    AxumState(state): AxumState<HeadlessState>,')
w(') -> impl IntoResponse {')
w('    ws.on_upgrade(move |socket| handle_ws(socket, state))')
w('}')
w()

# --- Embedded static files ---
w('// ---- Static file serving (compile-time or runtime) ----')
w()
w('#[cfg(not(feature = "runtime-fallback"))]')
w('mod embedded {')
w('    include!(concat!(env!("OUT_DIR"), "/embedded_web.rs"));')
w('}')
w()
w('/// Serve embedded or runtime static files with SPA fallback.')
w('async fn serve_static(')
w('    AxumPath(path): AxumPath<String>,')
w(') -> impl IntoResponse {')
w('    #[cfg(not(feature = "runtime-fallback"))]')
w('    {')
w('        let file_path = if path.is_empty() || path == "/" { "index.html".to_string() }')
w('            else { path.trim_start_matches(\'/\').to_string() };')
w('        match embedded::EMBEDDED_FILES.get(file_path.as_str()) {')
w('            Some(content) => {')
w('                let ct = embedded::mime_for_path(&file_path);')
w('                ([(header::CONTENT_TYPE, ct.to_string())], *content).into_response()')
w('            }')
w('            None => {')
w('                // SPA fallback')
w('                match embedded::EMBEDDED_FILES.get("index.html") {')
w('                    Some(html) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string())], *html).into_response(),')
w('                    None => StatusCode::NOT_FOUND.into_response(),')
w('                }')
w('            }')
w('        }')
w('    }')
w('    #[cfg(feature = "runtime-fallback")]')
w('    {')
w('        use tower_http::services::ServeDir;')
w('        let root = web_root().ok_or(StatusCode::NOT_FOUND)?;')
w('        let file = tokio::fs::read(root.join(&path)).await;')
w('        match file {')
w('            Ok(bytes) => {')
w('                let ct = runtime_mime_for_path(&path);')
w('                ([(header::CONTENT_TYPE, ct.to_string())], bytes).into_response()')
w('            }')
w('            Err(_) => {')
w('                // SPA fallback')
w('                match tokio::fs::read(root.join("index.html")).await {')
w('                    Ok(bytes) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string())], bytes).into_response(),')
w('                    Err(_) => StatusCode::NOT_FOUND.into_response(),')
w('                }')
w('            }')
w('        }')
w('    }')
w('}')
w()

# --- Router ---
w('// ---- Router ----')
w()
w('pub fn build_router(state: HeadlessState) -> Router {')
w('    let cors = CorsLayer::new()')
w('        .allow_origin(Any)')
w('        .allow_methods(Any)')
w('        .allow_headers(Any);')
w()
w('    let auth = AuthConfig::from_env();')
w('    // Default: 60 requests per minute for /api/invoke')
w('    let limiter = RateLimiter::new(60, std::time::Duration::from_secs(60));')
w()
w('    Router::new()')
w('        .route("/health", get(health))')
w('        .route("/api/status", get(api_status))')
w('        .route("/api/invoke", post(invoke_handler))')
w('        .route("/ws", get(ws_handler))')
w('        .fallback(get(serve_static))')
w('        .with_state(state)')
w('        .layer(middleware::from_fn_with_state(auth, auth_middleware))')
w('        .layer(middleware::from_fn_with_state(limiter, rate_limit_middleware))')
w('        .layer(cors)')
w('}')
w()

# --- Build state ---
w('/// Build the axum state (registries that are not part of AppContext).')
w('pub fn build_state(ctx: Arc<AppContext>, emitter: Arc<WsEventEmitter>) -> Result<HeadlessState, String> {')
w('    let mcp_runtime = Arc::new(crate::commands::mcp::McpRuntimeManager::default());')
w('    let shell_runs = Arc::new(ShellRunRegistry::default());')
w('    let hook_scopes = Arc::new(crate::commands::hook::HookScopeRegistry::default());')
w('    let proxy_server = crate::services::proxy::start_proxy_server()?;')
w('    Ok(HeadlessState { ctx, emitter, mcp_runtime, shell_runs, hook_scopes, proxy_server })')
w('}')
w()

# --- Serve entry point ---
w('/// Run the headless server. Config via environment variables:')
w('///   LIVEAGENT_HEADLESS_PORT  (default 17890)')
w('///   LIVEAGENT_HEADLESS_HOST  (default 127.0.0.1)')
w('///   LIVEAGENT_API_TOKEN      (optional; enables Bearer auth)')
w('///   LIVEAGENT_WEB_ROOT       (optional; override WebUI dist path)')
w('pub async fn serve() -> Result<(), String> {')
w('    let port = std::env::var("LIVEAGENT_HEADLESS_PORT")')
w('        .ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(17890);')
w('    let host = std::env::var("LIVEAGENT_HEADLESS_HOST")')
w('        .unwrap_or_else(|_| "127.0.0.1".to_string());')
w()
w('    let (tx, _) = broadcast::channel(1024);')
w('    let emitter = Arc::new(WsEventEmitter::new(tx));')
w('    let ws_emitter = Arc::clone(&emitter);')
w('    let emitter_dyn: Arc<dyn crate::events::EventEmitter> = ws_emitter;')
w()
w('    // Initialize (aligned with desktop setup): history DB migration, staging GC, builtin skills.')
w('    crate::commands::history_db::initialize_history_db()')
w('        .map_err(|e| format!("history db init: {e}"))?;')
w('    if let Err(error) = crate::commands::settings::initialize_system_proxy_from_db() {')
w('        eprintln!("failed to initialize system proxy state: {error}");')
w('    }')
w('    crate::commands::system::gc_upload_staging_on_startup();')
w('    if let Err(error) = crate::services::skills::ensure_builtin_agent_skills_sync() {')
w('        eprintln!("failed to seed builtin skills: {error}");')
w('    }')
w()
w('    let ctx = AppContext::new(emitter_dyn);')
w('    let state = build_state(ctx, emitter).map_err(|e| format!("headless state: {e}"))?;')
w('    let app = build_router(state);')
w('    let listener = tokio::net::TcpListener::bind((host.as_str(), port))')
w('        .await.map_err(|e| format!("bind {host}:{port}: {e}"))?;')
w()
w('    let has_auth = AuthConfig::from_env().api_token.is_some();')
w('    eprintln!("LiveAgent headless listening on http://{host}:{port} (auth={has_auth})");')
w('    axum::serve(listener, app).await.map_err(|e| e.to_string())')
w('}')
w()

# --- Runtime fallback helpers (only compiled with runtime-fallback feature) ---
w('#[cfg(feature = "runtime-fallback")]')
w('fn web_root() -> Option<PathBuf> {')
w('    if let Ok(root) = std::env::var("LIVEAGENT_WEB_ROOT") {')
w('        let root = PathBuf::from(root);')
w('        if root.is_dir() { return Some(root); }')
w('        eprintln!("LiveAgent headless: LIVEAGENT_WEB_ROOT={} not found, falling back", root.display());')
w('    }')
w('    [PathBuf::from("../dist"), PathBuf::from("dist")].into_iter().find(|c| c.is_dir())')
w('}')
w()
w('#[cfg(feature = "runtime-fallback")]')
w('fn runtime_mime_for_path(path: &str) -> \x26\'static str {')
w('    match path.rsplit(\'.\').next() {')
w('        Some("html") => "text/html; charset=utf-8",')
w('        Some("css")  => "text/css; charset=utf-8",')
w('        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",')
w('        Some("json") => "application/json",')
w('        Some("svg")  => "image/svg+xml",')
w('        Some("png")  => "image/png",')
w('        Some("jpg") | Some("jpeg") => "image/jpeg",')
w('        _ => "application/octet-stream",')
w('    }')
w('}')
w()

# --- Tests ---
w('#[cfg(test)]')
w('mod tests {')
w('    use super::*;')
w('    use serde_json::{json, Map};')
w()
w('    #[test]')
w('    fn camelize_snake_to_camel() {')
w('        assert_eq!(camelize("page_size"), "pageSize");')
w('        assert_eq!(camelize("single"), "single");')
w('        assert_eq!(camelize(""), "");')
w('    }')
w()
w('    #[test]')
w('    fn remove_arg_snake_and_camel() {')
w('        let mut o = Map::new(); o.insert("page_size".into(), json!(10));')
w('        assert_eq!(remove_arg(&mut o, "page_size"), Some(json!(10)));')
w('        let mut o = Map::new(); o.insert("pageSize".into(), json!(20));')
w('        assert_eq!(remove_arg(&mut o, "page_size"), Some(json!(20)));')
w('    }')
w()
w('    #[test]')
w('    fn take_arg_missing_returns_business_error() {')
w('        let mut a = json!({});')
w('        let err = take_arg::<String>(&mut a, "x").unwrap_err();')
w('        assert!(matches!(err, HeadlessError::Business(_)));')
w('    }')
w()
w('    #[test]')
w('    fn rate_limiter_basic() {')
w('        let limiter = RateLimiter::new(3, std::time::Duration::from_secs(60));')
w('        assert!(limiter.allow("ip1"));')
w('        assert!(limiter.allow("ip1"));')
w('        assert!(limiter.allow("ip1"));')
w('        assert!(!limiter.allow("ip1")); // exhausted')
w('        assert!(limiter.allow("ip2"));  // different key')
w('    }')
w('}')
w()

# --- Write output ---
out_path = args.out
with open(out_path, 'w') as f:
    f.write('\n'.join(L) + '\n')
print(f"[gen_headless] wrote {out_path}: {n_arms} dispatch arms, {len(L)} lines")
