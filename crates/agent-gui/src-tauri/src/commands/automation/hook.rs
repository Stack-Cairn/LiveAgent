use crate::runtime::shell_runner::{run_shell_script, ShellRunResponse};
use crate::runtime::task_runner::{
    resolve_workdir, run_http_requests_sync, HttpExecutionResult, HttpRequestInput,
};

const DEFAULT_HOOK_SCRIPT_TIMEOUT_MS: u64 = 60_000;

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

pub(crate) fn run_hook_script_sync(
    workdir: Option<String>,
    script: String,
) -> Result<ShellRunResponse, String> {
    let cwd = resolve_workdir(workdir)?;
    let result = run_shell_script(
        cwd.display().to_string(),
        script,
        None,
        Some(DEFAULT_HOOK_SCRIPT_TIMEOUT_MS),
        None,
        None,
        None,
    )?;

    if result.exit_code != 0 || result.timed_out || result.cancelled {
        return Err(format_hook_script_failure(&result));
    }

    Ok(result)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn hook_run_script(
    workdir: Option<String>,
    script: String,
) -> Result<ShellRunResponse, String> {
    tauri::async_runtime::spawn_blocking(move || run_hook_script_sync(workdir, script))
        .await
        .map_err(|e| format!("hook_run_script join 失败：{e}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn hook_run_http_requests(
    requests: Vec<HttpRequestInput>,
) -> Result<Vec<HttpExecutionResult>, String> {
    tauri::async_runtime::spawn_blocking(move || run_http_requests_sync(requests))
        .await
        .map_err(|e| format!("hook_run_http_requests join 失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_hook_script_sync_executes_shell_script() {
        let script = if cfg!(windows) {
            "Write-Output hook-ready"
        } else {
            "printf hook-ready"
        };
        let result = run_hook_script_sync(None, script.to_string()).expect("run hook script");
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("hook-ready"));
        assert_eq!(result.effective_timeout_ms, DEFAULT_HOOK_SCRIPT_TIMEOUT_MS);
    }

    #[test]
    fn run_hook_script_sync_rejects_failed_shell_script() {
        let script = if cfg!(windows) {
            "Write-Output hook-out; Write-Error hook-err; exit 7"
        } else {
            "printf hook-out; printf hook-err >&2; exit 7"
        };
        let error =
            run_hook_script_sync(None, script.to_string()).expect_err("reject failed hook script");

        assert!(error.contains("exit=7"));
        assert!(error.contains("hook-out"));
        assert!(error.contains("hook-err"));
    }
}
