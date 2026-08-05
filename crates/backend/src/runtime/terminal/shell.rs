use portable_pty::CommandBuilder;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::runtime::platform::{expand_tilde_path, strip_windows_verbatim_prefix};
#[cfg(windows)]
use crate::runtime::process::configure_child_process_group;

use super::*;

pub(crate) fn terminate_terminal_entry(entry: &Arc<TerminalSessionEntry>) {
    match &entry.backend {
        TerminalSessionBackend::Local { child, .. } => {
            let pid = entry.record.lock().ok().and_then(|record| record.pid);
            terminate_process_tree_best_effort(pid);
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }
        TerminalSessionBackend::Ssh { runtime } => {
            if let Some(shutdown_tx) = runtime.close() {
                let _ = shutdown_tx.try_send(());
            }
        }
    }
}

pub(crate) fn terminate_process_tree_best_effort(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        // `taskkill` is a console app; hide its window so app exit stays clean.
        let mut command = std::process::Command::new("taskkill");
        configure_child_process_group(&mut command);
        let _ = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub(crate) fn canonicalize_workdir(workdir: &str) -> Result<PathBuf, String> {
    let raw = workdir.trim();
    if raw.is_empty() {
        return Err("workdir is required".to_string());
    }
    let path = expand_tilde_path(raw);
    if !path.is_absolute() {
        return Err(format!("workdir must be absolute: {workdir}"));
    }
    let metadata = fs::metadata(&path).map_err(|_| format!("workdir does not exist: {workdir}"))?;
    if !metadata.is_dir() {
        return Err(format!("workdir must be a directory: {workdir}"));
    }
    let canonical =
        fs::canonicalize(&path).map_err(|err| format!("failed to canonicalize workdir: {err}"))?;
    Ok(strip_windows_verbatim_prefix(canonical))
}

pub(crate) fn is_program_on_path(program: &str) -> bool {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        if dir.join(program).is_file() {
            return true;
        }
    }
    false
}

pub(crate) fn scrub_terminal_shell_env(cmd: &mut CommandBuilder) {
    for key in ["npm_config_prefix", "NPM_CONFIG_PREFIX"] {
        cmd.env_remove(key);
    }
}

pub(crate) fn configure_terminal_shell_env(cmd: &mut CommandBuilder, shell_command: &str) {
    scrub_terminal_shell_env(cmd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if is_zsh_shell(shell_command) {
        configure_zsh_colored_prompt(cmd);
    }
}

pub(crate) fn configure_zsh_colored_prompt(cmd: &mut CommandBuilder) {
    let colored_prompt = "%F{green}%n%f%F{yellow}@%f%F{blue}%m%f %F{magenta}%1~%f %F{cyan}%#%f ";
    let zdotdir = create_zsh_prompt_overlay(colored_prompt);
    if let Some(dir) = zdotdir {
        cmd.env("ZDOTDIR", dir.to_string_lossy().as_ref());
    }
}

pub(crate) fn create_zsh_prompt_overlay(prompt: &str) -> Option<PathBuf> {
    let base = dirs::cache_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);
    let zdotdir = base.join("liveagent-zsh");
    if fs::create_dir_all(&zdotdir).is_err() {
        return None;
    }

    let home = dirs::home_dir().unwrap_or_default();
    let user_zshrc = home.join(".zshrc");
    let user_zshenv = home.join(".zshenv");

    let zshenv_content = format!(
        "export _LIVEAGENT_REAL_ZDOTDIR=\"$HOME\"\n\
         [[ -f \"{}\" ]] && source \"{}\"\n",
        user_zshenv.display(),
        user_zshenv.display(),
    );
    let zshrc_content = format!(
        "[[ -f \"{}\" ]] && source \"{}\"\n\
         PROMPT='{}'\n\
         unset ZDOTDIR\n",
        user_zshrc.display(),
        user_zshrc.display(),
        prompt,
    );

    if fs::write(zdotdir.join(".zshenv"), zshenv_content).is_err() {
        return None;
    }
    if fs::write(zdotdir.join(".zshrc"), zshrc_content).is_err() {
        return None;
    }
    Some(zdotdir)
}

pub(crate) struct ShellSpec {
    pub(crate) label: String,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
}

pub(crate) fn resolve_shell(shell: Option<String>) -> Result<ShellSpec, String> {
    let requested = shell
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string());

    if cfg!(windows) {
        let powershell_args = vec![
            "-NoLogo".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
        ];
        match requested.as_str() {
            "pwsh" => Ok(ShellSpec {
                label: "PowerShell 7".to_string(),
                command: "pwsh.exe".to_string(),
                args: powershell_args,
            }),
            "powershell" | "default" => Ok(ShellSpec {
                label: "PowerShell".to_string(),
                command: "powershell.exe".to_string(),
                args: powershell_args,
            }),
            "cmd" => Ok(ShellSpec {
                label: "Cmd".to_string(),
                command: "cmd.exe".to_string(),
                args: Vec::new(),
            }),
            other => Err(format!("unsupported Windows terminal shell: {other}")),
        }
    } else {
        let command = std::env::var("SHELL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && Path::new(value).is_absolute())
            .or_else(resolve_unix_shell_fallback)
            .ok_or_else(|| "failed to resolve login shell".to_string())?;
        let label = Path::new(&command)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("shell")
            .to_string();
        Ok(ShellSpec {
            label,
            args: unix_shell_args(&command),
            command,
        })
    }
}

pub(crate) fn unix_shell_args(command: &str) -> Vec<String> {
    if is_zsh_shell(command) {
        return vec!["-o".to_string(), "NO_PROMPT_SP".to_string()];
    }
    Vec::new()
}

pub(crate) fn is_zsh_shell(command: &str) -> bool {
    Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("zsh"))
        .unwrap_or(false)
}

pub(crate) fn resolve_unix_shell_fallback() -> Option<String> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &["/bin/zsh", "/bin/bash", "/bin/sh"]
    } else {
        &["/bin/bash", "/bin/zsh", "/bin/sh"]
    };
    candidates
        .iter()
        .find(|candidate| Path::new(candidate).exists())
        .map(|value| (*value).to_string())
}

pub fn terminal_shell_options() -> TerminalShellOptionsResponse {
    if cfg!(windows) {
        let mut options = vec![
            TerminalShellOption {
                id: "powershell".to_string(),
                label: "PowerShell".to_string(),
                command: "powershell.exe".to_string(),
            },
            TerminalShellOption {
                id: "cmd".to_string(),
                label: "Cmd".to_string(),
                command: "cmd.exe".to_string(),
            },
        ];
        if is_program_on_path("pwsh.exe") {
            options.insert(
                0,
                TerminalShellOption {
                    id: "pwsh".to_string(),
                    label: "PowerShell 7".to_string(),
                    command: "pwsh.exe".to_string(),
                },
            );
        }
        TerminalShellOptionsResponse {
            default_shell: "powershell".to_string(),
            options,
        }
    } else {
        let shell = resolve_shell(None).unwrap_or_else(|_| ShellSpec {
            label: "sh".to_string(),
            command: "/bin/sh".to_string(),
            args: Vec::new(),
        });
        TerminalShellOptionsResponse {
            default_shell: "default".to_string(),
            options: vec![TerminalShellOption {
                id: "default".to_string(),
                label: shell.label,
                command: shell.command,
            }],
        }
    }
}
