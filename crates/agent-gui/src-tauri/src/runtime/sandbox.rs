//! OS 级沙箱(沙箱模式 v1):模型驱动的 Bash / ManagedProcess 在生成子进程前
//! 由平台原生机制包裹——macOS 走 Seatbelt(/usr/bin/sandbox-exec),Linux 走
//! bubblewrap(bwrap),Windows 暂不支持(受限令牌 + Job Object + WFP 路线待实现)。
//!
//! 语义为 workspace-write:读默认放行(工具链/依赖散布全盘,default-deny 不现实),
//! 写仅限工作区根 + 临时目录,敏感目录(~/.ssh、应用配置库等)读写全掩蔽,网络可
//! 整体关断。fail-closed:沙箱被请求而平台机制不可用时直接报错,绝不静默降级为
//! 无沙箱执行。

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
pub(crate) struct SandboxOptions {
    pub allow_network: bool,
}

/// 展开后的沙箱规格:write_root 是允许写入的工作区根(须为 canonicalize 后的
/// 绝对路径,shell_runner / managed_process 的 workdir 校验已保证)。
#[derive(Debug, Clone)]
pub(crate) struct SandboxSpec {
    pub write_root: PathBuf,
    pub allow_network: bool,
    /// isolated 常驻进程须在 LiveAgent 退出后继续存活(managed_process 的 isolated
    /// 语义),因此 Linux bwrap 不能加 `--die-with-parent`。仅 bubblewrap 后端消费;
    /// macOS/Windows 无父进程死亡耦合,不读取本字段。
    #[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
    pub isolated: bool,
}

impl SandboxSpec {
    pub(crate) fn from_options(write_root: PathBuf, options: SandboxOptions) -> Self {
        Self {
            write_root,
            allow_network: options.allow_network,
            // 默认非 isolated(Bash 工具子进程随 LiveAgent 退出而终止);
            // managed_process 的 isolated 常驻进程构造后显式置 true。
            isolated: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SandboxCapability {
    pub supported: bool,
    pub mechanism: &'static str,
    pub platform: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 敏感目录掩蔽表(相对 home)。应用自身配置目录(provider 密钥、审批策略所在的
/// config.sqlite)一并掩蔽;默认工作区在其内部,由 write_root 的后置 allow 规则
/// 重新放行,不受影响。
fn sensitive_home_subdirs() -> [&'static str; 4] {
    [".ssh", ".aws", ".gnupg", ".config/gh"]
}

fn app_config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(format!(".{}", env!("CARGO_PKG_NAME"))))
}

fn sensitive_dirs() -> Vec<PathBuf> {
    let mut dirs_out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for sub in sensitive_home_subdirs() {
            dirs_out.push(home.join(sub));
        }
    }
    if let Some(config) = app_config_dir() {
        dirs_out.push(config);
    }
    dirs_out
}

fn canonical_or_self(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// fail-closed 工作区校验(P1#2):拒绝会让写围栏重新暴露敏感目录的工作区。
///
/// 写围栏对 write_root 有后置 re-allow(macOS)/后置 --bind(Linux),因此:
/// - **祖先或相等**:工作区包含或等于任一敏感目录(如工作区取 home 或 /),
///   re-allow 会把该敏感目录重新放行 → 一律拒绝。
/// - **后代**:工作区落在敏感目录内部。凭据目录(~/.ssh/.aws/.gnupg/.config/gh)
///   下的工作区一律拒绝;应用配置目录(~/.liveagent)豁免——默认工作区
///   ~/.liveagent/default-project 正位于其内,拒绝它会直接打断开箱即用。
fn validate_workspace(write_root: &Path) -> Result<(), String> {
    let root = canonical_or_self(write_root);
    let app_config = app_config_dir().map(|p| canonical_or_self(&p));

    for dir in sensitive_dirs() {
        let dir = canonical_or_self(&dir);
        if dir.starts_with(&root) {
            return Err(format!(
                "Sandbox refuses workspace \"{}\": it encloses or equals the sensitive directory \
\"{}\", which the workspace write fence would re-expose. Choose a workspace that does not \
contain credential or app-config directories.",
                root.display(),
                dir.display()
            ));
        }
        if root.starts_with(&dir) {
            // 应用配置目录内部豁免(默认工作区在此),其余敏感目录内部一律拒绝。
            if app_config.as_deref() == Some(dir.as_path()) {
                continue;
            }
            return Err(format!(
                "Sandbox refuses workspace \"{}\": it lives inside the sensitive directory \"{}\". \
Choose a workspace outside credential directories.",
                root.display(),
                dir.display()
            ));
        }
    }
    Ok(())
}

/// 临时目录允许写入集合:TMPDIR(macOS 上归并到 /var/folders 的用户私有目录,
/// 取其父级同时覆盖 confstr 缓存目录)、std::env::temp_dir、以及系统级 tmp。
fn writable_temp_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push_canonical = |path: PathBuf| {
        let canonical = std::fs::canonicalize(&path).unwrap_or(path);
        if !out.iter().any(|existing| *existing == canonical) {
            out.push(canonical);
        }
    };

    if let Ok(tmpdir) = std::env::var("TMPDIR") {
        let tmpdir = PathBuf::from(tmpdir.trim_end_matches('/'));
        if tmpdir.is_absolute() && tmpdir.is_dir() {
            // /var/folders/xx/yyy/T → 放行父级 /var/folders/xx/yyy,同时覆盖
            // DARWIN_USER_CACHE_DIR(…/C,clang 模块缓存等会写它)。
            #[cfg(target_os = "macos")]
            if let Some(parent) = tmpdir.parent() {
                push_canonical(parent.to_path_buf());
            }
            push_canonical(tmpdir);
        }
    }
    push_canonical(std::env::temp_dir());
    for path in ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"] {
        let path = Path::new(path);
        if path.is_dir() {
            push_canonical(path.to_path_buf());
        }
    }
    out
}

pub fn capability() -> SandboxCapability {
    platform::capability()
}

/// 把即将执行的 (program, args) 包进平台沙箱,返回替换后的
/// (program, args, mechanism)。平台不支持或依赖缺失时报错(fail-closed)。
pub(crate) fn wrap_command(
    spec: &SandboxSpec,
    program: &Path,
    args: &[String],
) -> Result<(PathBuf, Vec<String>, &'static str), String> {
    let capability = capability();
    if !capability.supported {
        return Err(format!(
            "Sandbox mode is enabled but unavailable on this platform: {}. \
Disable sandbox mode in Settings → System, or resolve the issue and retry.",
            capability.reason.as_deref().unwrap_or("unsupported platform")
        ));
    }
    validate_workspace(&spec.write_root)?;
    platform::wrap_command(spec, program, args)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

    pub(super) fn capability() -> SandboxCapability {
        if Path::new(SANDBOX_EXEC).exists() {
            SandboxCapability {
                supported: true,
                mechanism: "seatbelt",
                platform: "macos",
                reason: None,
            }
        } else {
            SandboxCapability {
                supported: false,
                mechanism: "seatbelt",
                platform: "macos",
                reason: Some(format!("{SANDBOX_EXEC} not found")),
            }
        }
    }

    /// Seatbelt 字符串字面量转义:反斜杠与双引号。
    fn escape(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"")
    }

    fn subpath_filters(paths: &[PathBuf]) -> String {
        paths
            .iter()
            .map(|p| format!("(subpath \"{}\")", escape(p)))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// allow-default + 写入围栏的 Seatbelt profile。规则匹配以“最后命中者优先”,
    /// 顺序:全局 allow → 全盘写 deny → 工作区/临时目录写 allow → 设备节点写
    /// allow → 敏感目录读 deny → 工作区读写 re-allow(默认工作区位于应用配置目录
    /// 内,须排在敏感目录 deny 之后)→ 可选网络 deny。
    pub(super) fn seatbelt_profile(spec: &SandboxSpec) -> String {
        let mut writable = vec![spec.write_root.clone()];
        writable.extend(writable_temp_dirs());

        let mut profile = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");
        profile.push_str(&format!("(allow file-write* {})\n", subpath_filters(&writable)));
        profile.push_str(
            "(allow file-write-data file-ioctl (literal \"/dev/null\") (literal \"/dev/zero\") \
(literal \"/dev/tty\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") \
(literal \"/dev/dtracehelper\"))\n(allow file-write* (subpath \"/dev/fd\"))\n",
        );
        let sensitive = sensitive_dirs();
        if !sensitive.is_empty() {
            profile.push_str(&format!("(deny file-read* {})\n", subpath_filters(&sensitive)));
        }
        profile.push_str(&format!(
            "(allow file-read* file-write* (subpath \"{}\"))\n",
            escape(&spec.write_root)
        ));
        if !spec.allow_network {
            profile.push_str("(deny network*)\n");
        }
        profile
    }

    pub(super) fn wrap_command(
        spec: &SandboxSpec,
        program: &Path,
        args: &[String],
    ) -> Result<(PathBuf, Vec<String>, &'static str), String> {
        let mut out = vec!["-p".to_string(), seatbelt_profile(spec)];
        out.push(program.to_string_lossy().into_owned());
        out.extend(args.iter().cloned());
        Ok((PathBuf::from(SANDBOX_EXEC), out, "seatbelt"))
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
mod platform {
    use super::*;
    use std::process::Command;
    use std::sync::OnceLock;

    static CAPABILITY: OnceLock<SandboxCapability> = OnceLock::new();

    fn probe() -> SandboxCapability {
        let unsupported = |reason: String| SandboxCapability {
            supported: false,
            mechanism: "bubblewrap",
            platform: "linux",
            reason: Some(reason),
        };
        // 探测真实可用性(容器/受限内核里 bwrap 可能存在但无法建 namespace)。
        match Command::new("bwrap")
            .args([
                "--die-with-parent",
                "--unshare-pid",
                "--ro-bind",
                "/",
                "/",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--",
                "/bin/true",
            ])
            .output()
        {
            Ok(output) if output.status.success() => SandboxCapability {
                supported: true,
                mechanism: "bubblewrap",
                platform: "linux",
                reason: None,
            },
            Ok(output) => unsupported(format!(
                "bubblewrap probe failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(err) => unsupported(format!(
                "bubblewrap (bwrap) is not available: {err}. Install it, e.g. `apt install bubblewrap`."
            )),
        }
    }

    pub(super) fn capability() -> SandboxCapability {
        CAPABILITY.get_or_init(probe).clone()
    }

    pub(super) fn bwrap_args(spec: &SandboxSpec) -> Vec<String> {
        // isolated 常驻进程须在 LiveAgent 退出后存活,不能与父进程死亡耦合;
        // 非 isolated(Bash 工具子进程)保持 --die-with-parent,避免遗留孤儿。
        let mut args: Vec<String> = Vec::new();
        if !spec.isolated {
            args.push("--die-with-parent".to_string());
        }
        args.extend(
            [
                "--unshare-pid",
                "--ro-bind",
                "/",
                "/",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
            ]
            .into_iter()
            .map(String::from),
        );

        for tmp in writable_temp_dirs() {
            let tmp = tmp.to_string_lossy().into_owned();
            args.extend(["--bind".to_string(), tmp.clone(), tmp]);
        }
        // 掩蔽须在 write_root 绑定之前:默认工作区位于应用配置目录内,后置的
        // --bind 会在 tmpfs 掩蔽之上重新暴露工作区。
        for dir in sensitive_dirs() {
            if dir.is_dir() {
                args.extend(["--tmpfs".to_string(), dir.to_string_lossy().into_owned()]);
            }
        }
        let root = spec.write_root.to_string_lossy().into_owned();
        args.extend(["--bind".to_string(), root.clone(), root]);
        if !spec.allow_network {
            args.push("--unshare-net".to_string());
        }
        args.push("--".to_string());
        args
    }

    pub(super) fn wrap_command(
        spec: &SandboxSpec,
        program: &Path,
        args: &[String],
    ) -> Result<(PathBuf, Vec<String>, &'static str), String> {
        let mut out = bwrap_args(spec);
        out.push(program.to_string_lossy().into_owned());
        out.extend(args.iter().cloned());
        Ok((PathBuf::from("bwrap"), out, "bubblewrap"))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;

    pub(super) fn capability() -> SandboxCapability {
        SandboxCapability {
            supported: false,
            mechanism: "none",
            platform: "windows",
            reason: Some(
                "Windows sandbox (restricted token + job object + WFP) is not implemented yet"
                    .to_string(),
            ),
        }
    }

    pub(super) fn wrap_command(
        _spec: &SandboxSpec,
        _program: &Path,
        _args: &[String],
    ) -> Result<(PathBuf, Vec<String>, &'static str), String> {
        Err("Windows sandbox is not implemented yet".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_profile_contains_write_root_and_ordering() {
        let spec = SandboxSpec {
            write_root: PathBuf::from("/tmp/liveagent \"quoted\" ws"),
            allow_network: false,
            isolated: false,
        };
        let profile = platform::seatbelt_profile(&spec);
        assert!(profile.starts_with("(version 1)\n(allow default)\n(deny file-write*)\n"));
        assert!(profile.contains("liveagent \\\"quoted\\\" ws"));
        assert!(profile.ends_with("(deny network*)\n"));
        // 工作区 re-allow 必须位于敏感目录 deny 之后(最后命中者优先)。
        let deny_read = profile.find("(deny file-read*").expect("deny file-read rule");
        let reallow = profile
            .find("(allow file-read* file-write*")
            .expect("workspace re-allow rule");
        assert!(reallow > deny_read);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_network_allowed_omits_network_rule() {
        let spec = SandboxSpec {
            write_root: PathBuf::from("/tmp/ws"),
            allow_network: true,
            isolated: false,
        };
        assert!(!platform::seatbelt_profile(&spec).contains("network"));
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn bwrap_args_order_masks_before_write_root_bind() {
        let spec = SandboxSpec {
            write_root: PathBuf::from("/home/user/project"),
            allow_network: false,
            isolated: false,
        };
        let args = platform::bwrap_args(&spec);
        assert_eq!(args.first().map(String::as_str), Some("--die-with-parent"));
        assert!(args.contains(&"--unshare-net".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("--"));
        let root_bind = args
            .iter()
            .position(|a| a == "/home/user/project")
            .expect("write root bind");
        if let Some(mask) = args.iter().position(|a| a == "--tmpfs") {
            assert!(mask < root_bind);
        }
    }

    // P1#3:isolated 常驻进程不能与父进程死亡耦合,bwrap 须省略 --die-with-parent。
    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn bwrap_args_isolated_omits_die_with_parent() {
        let base = PathBuf::from("/home/user/project");
        let attached = platform::bwrap_args(&SandboxSpec {
            write_root: base.clone(),
            allow_network: false,
            isolated: false,
        });
        assert!(attached.contains(&"--die-with-parent".to_string()));

        let isolated = platform::bwrap_args(&SandboxSpec {
            write_root: base,
            allow_network: false,
            isolated: true,
        });
        assert!(!isolated.contains(&"--die-with-parent".to_string()));
        // 省略死亡耦合后,其余围栏(pid namespace、根只读绑定)保持不变。
        assert_eq!(isolated.first().map(String::as_str), Some("--unshare-pid"));
        assert_eq!(isolated.last().map(String::as_str), Some("--"));
    }

    // P1#2:工作区若包含/等于敏感目录,写围栏 re-allow 会重新暴露之 → 拒绝。
    #[test]
    fn validate_workspace_rejects_ancestor_of_sensitive_dir() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        // home 本身包含 ~/.ssh 等敏感目录。
        assert!(validate_workspace(&home).is_err());
    }

    // P1#2:凭据目录内部的工作区一律拒绝。
    #[test]
    fn validate_workspace_rejects_inside_credential_dir() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let inside_ssh = home.join(".ssh").join("ws");
        assert!(validate_workspace(&inside_ssh).is_err());
    }

    // P1#2:应用配置目录内部豁免——默认工作区 ~/.liveagent/default-project 必须放行。
    #[test]
    fn validate_workspace_allows_default_project_under_app_config() {
        let Some(config) = app_config_dir() else {
            return;
        };
        let default_project = config.join("default-project");
        assert!(validate_workspace(&default_project).is_ok());
    }

    // P1#2:与任何敏感目录无祖先/后代关系的普通工作区放行。
    #[test]
    fn validate_workspace_allows_ordinary_workspace() {
        assert!(validate_workspace(Path::new("/tmp/liveagent-ordinary-ws")).is_ok());
    }
}
