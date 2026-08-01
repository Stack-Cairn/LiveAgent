use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::runtime::shell_runner::{
    run_shell_script_with_envs, ShellCancelFlag, ShellCancelToken, ShellRunResponse,
};
use crate::runtime::task_runner::{
    build_http_client, resolve_workdir, run_single_http_request, HttpRequestInput,
};
use crate::services::automation::validate::{MAX_HOOK_TIMEOUT_MS, MIN_HOOK_TIMEOUT_MS};

const DEFAULT_HOOK_SCRIPT_TIMEOUT_MS: u64 = 60_000;
const MAX_REMEMBERED_CANCELLED_SCOPES: usize = 256;
const MAX_HOOK_HTTP_RESPONSE_CHARS: usize = 4_000;

/// Conversation-scoped cancellation for hook executions. A scope is created
/// implicitly by the first run that names it and cancelled exactly once when
/// the conversation run ends or aborts; late invocations against a cancelled
/// scope are refused before spawning anything.
#[derive(Default)]
pub struct HookScopeRegistry {
    inner: Mutex<HookScopeState>,
}

#[derive(Default)]
struct HookScopeState {
    active_tokens: HashMap<String, Vec<ShellCancelToken>>,
    cancelled: HashSet<String>,
    cancelled_order: VecDeque<String>,
}

impl HookScopeRegistry {
    fn register(&self, scope_id: &str) -> Result<ShellCancelToken, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "hook scope registry poisoned".to_string())?;
        if state.cancelled.contains(scope_id) {
            return Err("Hook scope has been cancelled.".to_string());
        }
        let token: ShellCancelToken = Arc::new(ShellCancelFlag::default());
        state
            .active_tokens
            .entry(scope_id.to_string())
            .or_default()
            .push(Arc::clone(&token));
        Ok(token)
    }

    fn unregister(&self, scope_id: &str, token: &ShellCancelToken) {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(tokens) = state.active_tokens.get_mut(scope_id) {
                tokens.retain(|item| !Arc::ptr_eq(item, token));
                if tokens.is_empty() {
                    state.active_tokens.remove(scope_id);
                }
            }
        }
    }

    fn is_cancelled(&self, scope_id: &str) -> bool {
        self.inner
            .lock()
            .map(|state| state.cancelled.contains(scope_id))
            .unwrap_or(false)
    }

    fn cancel(&self, scope_id: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "hook scope registry poisoned".to_string())?;
        if state.cancelled.insert(scope_id.to_string()) {
            state.cancelled_order.push_back(scope_id.to_string());
            while state.cancelled_order.len() > MAX_REMEMBERED_CANCELLED_SCOPES {
                if let Some(evicted) = state.cancelled_order.pop_front() {
                    state.cancelled.remove(&evicted);
                }
            }
        }
        if let Some(tokens) = state.active_tokens.remove(scope_id) {
            for token in tokens {
                token.cancel();
            }
        }
        Ok(())
    }
}

fn normalize_scope_id(scope_id: Option<String>) -> Option<String> {
    scope_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_timeout(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .unwrap_or(DEFAULT_HOOK_SCRIPT_TIMEOUT_MS)
        .clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS)
}

/// Context forwarded to hook scripts as environment variables. Keys are
/// namespaced by the caller (e.g. LIVEAGENT_HOOK_EVENT); values are passed
/// through verbatim.
fn normalize_context(context: Option<HashMap<String, String>>) -> Vec<(String, String)> {
    context
        .unwrap_or_default()
        .into_iter()
        .filter(|(key, _)| key.starts_with("LIVEAGENT_"))
        .collect()
}

fn format_hook_script_failure(result: &ShellRunResponse) -> String {
    let mut message = if result.timed_out {
        format!(
            "Hook 脚本超时（timeout={}ms, shell={}）",
            result.effective_timeout_ms, result.shell
        )
    } else if result.cancelled {
        format!("Hook 脚本已取消（shell={}）", result.shell)
    } else {
        format!(
            "Hook 脚本执行失败（exit={}, shell={}）",
            result.exit_code, result.shell
        )
    };

    if !result.stderr.trim().is_empty() {
        message.push_str(&format!("\nstderr:\n{}", result.stderr.trim()));
    }
    if !result.stdout.trim().is_empty() {
        message.push_str(&format!("\nstdout:\n{}", result.stdout.trim()));
    }
    message
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_hook_script_sync(
    registry: &HookScopeRegistry,
    workdir: Option<String>,
    script: String,
    timeout_ms: Option<u64>,
    scope_id: Option<String>,
    context: Vec<(String, String)>,
) -> Result<ShellRunResponse, String> {
    let workdir = workdir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Hook 需要一个工作目录（请先在会话中选择项目目录）".to_string())?;
    let cwd = resolve_workdir(Some(workdir))?;

    let scope_id = normalize_scope_id(scope_id);
    let token = match &scope_id {
        Some(scope) => Some(registry.register(scope)?),
        None => None,
    };

    let result = run_shell_script_with_envs(
        cwd.display().to_string(),
        script,
        None,
        Some(normalize_timeout(timeout_ms)),
        Some(MAX_HOOK_TIMEOUT_MS),
        None,
        token.clone(),
        &context,
    );

    if let (Some(scope), Some(token)) = (&scope_id, &token) {
        registry.unregister(scope, token);
    }

    let result = result?;
    if result.exit_code != 0 || result.timed_out || result.cancelled {
        return Err(format_hook_script_failure(&result));
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookHttpRequestResult {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookHttpRunResponse {
    pub ok: bool,
    pub results: Vec<HookHttpRequestResult>,
}

/// Executes every request even when an earlier one fails; the aggregate `ok`
/// reflects whether all requests succeeded.
pub(crate) fn run_hook_http_requests_sync(
    registry: &HookScopeRegistry,
    requests: Vec<HttpRequestInput>,
    scope_id: Option<String>,
) -> Result<HookHttpRunResponse, String> {
    if requests.is_empty() {
        return Err("Hook 至少需要一个 HTTP 请求".to_string());
    }
    let scope_id = normalize_scope_id(scope_id);
    let client = build_http_client(None)?;

    let mut results = Vec::with_capacity(requests.len());
    let mut all_ok = true;
    for request in requests {
        if let Some(scope) = &scope_id {
            if registry.is_cancelled(scope) {
                return Err("Hook scope has been cancelled.".to_string());
            }
        }
        let request_id = request.id.clone();
        match run_single_http_request(&client, request) {
            Ok(result) => {
                let ok = (200..400).contains(&result.status);
                if !ok {
                    all_ok = false;
                }
                results.push(HookHttpRequestResult {
                    id: request_id,
                    ok,
                    status: Some(result.status),
                    duration_ms: result.duration_ms as u64,
                    error: if ok {
                        None
                    } else {
                        Some(truncate_response(&result.response_body))
                    },
                });
            }
            Err(failure) => {
                all_ok = false;
                results.push(HookHttpRequestResult {
                    id: request_id,
                    ok: false,
                    status: None,
                    duration_ms: failure.duration_ms as u64,
                    error: Some(truncate_response(&failure.to_string())),
                });
            }
        }
    }

    Ok(HookHttpRunResponse {
        ok: all_ok,
        results,
    })
}

fn truncate_response(text: &str) -> String {
    if text.chars().count() <= MAX_HOOK_HTTP_RESPONSE_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_HOOK_HTTP_RESPONSE_CHARS).collect();
    out.push_str("...[truncated]");
    out
}

pub async fn hook_run_script(
    workdir: Option<String>,
    script: String,
    timeout_ms: Option<u64>,
    scope_id: Option<String>,
    context: Option<HashMap<String, String>>,
    registry: &Arc<HookScopeRegistry>,
) -> Result<ShellRunResponse, String> {
    let registry = Arc::clone(registry);
    let envs = normalize_context(context);
    crate::compat::async_runtime::spawn_blocking(move || {
        run_hook_script_sync(&registry, workdir, script, timeout_ms, scope_id, envs)
    })
    .await
    .map_err(|e| format!("hook_run_script join 失败：{e}"))?
}

pub async fn hook_run_http_requests(
    requests: Vec<HttpRequestInput>,
    scope_id: Option<String>,
    registry: &Arc<HookScopeRegistry>,
) -> Result<HookHttpRunResponse, String> {
    let registry = Arc::clone(registry);
    crate::compat::async_runtime::spawn_blocking(move || {
        run_hook_http_requests_sync(&registry, requests, scope_id)
    })
    .await
    .map_err(|e| format!("hook_run_http_requests join 失败：{e}"))?
}

pub async fn hook_cancel_scope(
    scope_id: String,
    registry: &Arc<HookScopeRegistry>,
) -> Result<(), String> {
    registry.cancel(scope_id.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_workdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp workdir")
    }

    #[test]
    fn run_hook_script_sync_executes_and_injects_context() {
        let registry = HookScopeRegistry::default();
        let dir = temp_workdir();
        let script = if cfg!(windows) {
            "Write-Output \"event=$env:LIVEAGENT_HOOK_EVENT\""
        } else {
            "printf \"event=$LIVEAGENT_HOOK_EVENT\""
        };
        let result = run_hook_script_sync(
            &registry,
            Some(dir.path().display().to_string()),
            script.to_string(),
            None,
            Some(format!("scope-{}", Uuid::new_v4())),
            vec![("LIVEAGENT_HOOK_EVENT".to_string(), "agent_end".to_string())],
        )
        .expect("run hook script");
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("event=agent_end"));
    }

    #[test]
    fn run_hook_script_sync_rejects_failed_script() {
        let registry = HookScopeRegistry::default();
        let dir = temp_workdir();
        let script = if cfg!(windows) {
            "Write-Output hook-out; Write-Error hook-err; exit 7"
        } else {
            "printf hook-out; printf hook-err >&2; exit 7"
        };
        let error = run_hook_script_sync(
            &registry,
            Some(dir.path().display().to_string()),
            script.to_string(),
            None,
            None,
            Vec::new(),
        )
        .expect_err("reject failed hook script");
        assert!(error.contains("exit=7"));
        assert!(error.contains("hook-out"));
        assert!(error.contains("hook-err"));
    }

    #[test]
    fn run_hook_script_sync_requires_workdir() {
        let registry = HookScopeRegistry::default();
        let error = run_hook_script_sync(
            &registry,
            None,
            "echo hi".to_string(),
            None,
            None,
            Vec::new(),
        )
        .expect_err("reject missing workdir");
        assert!(error.contains("工作目录"));
    }

    #[test]
    fn cancelled_scope_refuses_new_runs() {
        let registry = HookScopeRegistry::default();
        let dir = temp_workdir();
        registry.cancel("scope-a").expect("cancel scope");
        let error = run_hook_script_sync(
            &registry,
            Some(dir.path().display().to_string()),
            "echo hi".to_string(),
            None,
            Some("scope-a".to_string()),
            Vec::new(),
        )
        .expect_err("refuse cancelled scope");
        assert!(error.contains("cancelled"));
    }
}
