//! OS 级沙箱(沙箱模式 v1):模型驱动的 Bash / ManagedProcess 在生成子进程前
//! 由平台原生机制包裹——macOS 走 Seatbelt(/usr/bin/sandbox-exec),Linux 走
//! bubblewrap(bwrap),Windows 走受限令牌(CreateRestrictedToken WRITE_RESTRICTED
//! + 工作区继承写 ACE + Job Object,免管理员/免 UAC)。
//!
//! 语义为 workspace-write:读默认放行(工具链/依赖散布全盘,default-deny 不现实),
//! 写仅限工作区根 + 临时目录,敏感目录(~/.ssh、应用配置库等)读写全掩蔽,网络可
//! 整体关断。fail-closed:沙箱被请求而平台机制不可用时直接报错,绝不静默降级为
//! 无沙箱执行。
//!
//! Windows 平台限制(免管理员方案的固有边界,见 memory windows-sandbox-facts):
//! WRITE_RESTRICTED 只围栏“写”,读无法在无管理员下掩蔽敏感目录;断网只能靠
//! AppContainer 而它会连带默认拒读、破坏工具链。故 Windows 上 sandbox 仅提供写
//! 围栏,sandboxOffline(断网)不可用 —— `network_control=false`,前端据此禁用,
//! `wrap_command` 对 `!allow_network` 直接 fail-closed 报错。

use serde::Serialize;
use std::path::{Path, PathBuf};

/// 自我再执行启动器子命令标记:Windows `wrap_command` 把 (program, args) 包成
/// `current_exe __sandbox_exec --write-root <root> -- <program> <args...>`;
/// 进程启动最早期 `windows_sandbox::run_sandbox_launcher_if_requested` 识别它,
/// 建受限令牌后 `CreateProcessAsUserW` 真实命令。非 Windows 平台不产生该标记。
pub(crate) const SANDBOX_EXEC_SUBCOMMAND: &str = "__sandbox_exec";

/// 启动器解析后的调用信息(纯逻辑,跨平台可测)。
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LauncherInvocation {
    pub write_root: PathBuf,
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// 构造传给自我再执行启动器的参数向量(含子命令标记,作为 argv[1])。
/// 形如 `[__sandbox_exec, --write-root, <root>, --, <program>, <args...>]`。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn build_launcher_args(write_root: &Path, program: &Path, args: &[String]) -> Vec<String> {
    let mut out = vec![
        SANDBOX_EXEC_SUBCOMMAND.to_string(),
        "--write-root".to_string(),
        write_root.to_string_lossy().into_owned(),
        "--".to_string(),
        program.to_string_lossy().into_owned(),
    ];
    out.extend(args.iter().cloned());
    out
}

/// 解析启动器 payload(子命令标记之后的部分):`--write-root <root> -- <program> [args...]`。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parse_launcher_args(payload: &[String]) -> Result<LauncherInvocation, String> {
    let mut it = payload.iter();
    let mut write_root: Option<PathBuf> = None;
    let mut program: Option<PathBuf> = None;
    let mut rest: Vec<String> = Vec::new();
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--write-root" => {
                let value = it
                    .next()
                    .ok_or_else(|| "--write-root requires a value".to_string())?;
                write_root = Some(PathBuf::from(value));
            }
            "--" => {
                program = it.next().map(PathBuf::from);
                rest = it.cloned().collect();
                break;
            }
            other => return Err(format!("unexpected launcher argument: {other}")),
        }
    }
    let write_root = write_root.ok_or_else(|| "missing --write-root".to_string())?;
    let program = program.ok_or_else(|| "missing program after `--`".to_string())?;
    Ok(LauncherInvocation {
        write_root,
        program,
        args: rest,
    })
}

/// 由工作区规范路径确定性推导合成 SID(Codex 形式 `S-1-5-21-{4×u32}`)。
/// 稳定 + 无状态:同一路径永远得同一 SID —— 遗留的继承 ACE 在下次运行仍精确匹配,
/// 无需持久化。用稳定的 FNV-1a(不用 DefaultHasher,其算法跨版本不保证稳定)。
/// Windows 路径大小写不敏感,先小写化再哈希,`C:\Foo` 与 `c:\foo` 得同一 SID。
/// 边角:Rust 的 Unicode 小写化与 Windows 的 upcase 折叠(如 dotted/dotless I、ß)
/// 不完全一致,非 ASCII 工作区路径的两种大小写可能得不同 SID,导致遗留继承 ACE 不匹配
/// → 写被拒。这是 fail-closed(功能受限,非逃逸),ASCII 路径不受影响。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn synthetic_workspace_sid(write_root: &Path) -> String {
    fn fnv1a64(bytes: &[u8]) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }
    let canonical = write_root.to_string_lossy().to_lowercase();
    let h1 = fnv1a64(canonical.as_bytes());
    // 二次哈希掺入盐,得到独立的低 64 位,凑满 4×u32 子权限。
    let mut salted = canonical.into_bytes();
    salted.push(0);
    salted.extend_from_slice(b"liveagent-sandbox");
    let h2 = fnv1a64(&salted);
    let a = (h1 >> 32) as u32;
    let b = h1 as u32;
    let c = (h2 >> 32) as u32;
    let d = h2 as u32;
    format!("S-1-5-21-{a}-{b}-{c}-{d}")
}

/// 按 Windows(CommandLineToArgvW)规则拼装命令行,并以 NUL 结尾成 UTF-16。
/// 算法逐字复刻 Rust 标准库 `make_command_line`/`append_arg`,以保证受限令牌下
/// `CreateProcessAsUserW` 的子进程收到与非沙箱 `std::process::Command` 完全一致的
/// argv —— 行为对齐,不引入解析差异。纯逻辑,跨平台可测。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn build_command_line(program: &str, args: &[String]) -> Vec<u16> {
    fn append_arg(cmd: &mut Vec<u16>, arg: &str) {
        let arg: Vec<u16> = arg.encode_utf16().collect();
        let space = u16::from(b' ');
        let tab = u16::from(b'\t');
        let quote = u16::from(b'"');
        let backslash = u16::from(b'\\');
        let needs_quote = arg.is_empty() || arg.iter().any(|&c| c == space || c == tab);
        if needs_quote {
            cmd.push(quote);
        }
        let mut backslashes: usize = 0;
        for &w in &arg {
            if w == backslash {
                backslashes += 1;
            } else {
                if w == quote {
                    // 把 " 之前的反斜杠翻倍,再补一个,最后加转义的 "。
                    for _ in 0..=backslashes {
                        cmd.push(backslash);
                    }
                }
                backslashes = 0;
            }
            cmd.push(w);
        }
        if needs_quote {
            for _ in 0..backslashes {
                cmd.push(backslash);
            }
            cmd.push(quote);
        }
    }

    let mut cmd: Vec<u16> = Vec::new();
    append_arg(&mut cmd, program);
    for a in args {
        cmd.push(u16::from(b' '));
        append_arg(&mut cmd, a);
    }
    cmd.push(0);
    cmd
}

/// 把裸程序名解析成 PATH 中的绝对路径(Windows 语义:`;` 分隔、套用 PATHEXT),
/// **只搜索 PATH 里的绝对目录,绝不搜索当前/工作目录**。
///
/// 缘由:`CreateProcessAsUserW` 的 `lpApplicationName` 若是“部分名”,Win32 只用当前
/// 盘符+当前目录补全且**不查 PATH**(见 CreateProcess 文档)。而沙箱启动器的 cwd 就是
/// 工作区(模型可写),裸名 `cmd.exe` 会在工作区里被补全:轻则找不到而整体失败,重则
/// 命中模型投毒的同名二进制并被当作 shell 执行。故这里预解析成系统 shell 的绝对路径,
/// 剔除 PATH 里的相对项(含 `"."`),即便用户 PATH 带 `.` 也不会落到工作区。
///
/// 绝对路径入参原样返回。纯逻辑;`is_file` 谓词注入以便跨平台单测(Windows 路径语义
/// 由 Windows 编译+真机验证,`is_absolute`/`join` 在本机按 Unix 规则)。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn resolve_program_in_path(
    program: &Path,
    path_env: &str,
    pathext: &str,
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if program.is_absolute() {
        return Some(program.to_path_buf());
    }
    let name = program.as_os_str();
    // 候选扩展名:先原样(""),再逐个 PATHEXT 项(裸名 pwsh → pwsh.EXE)。
    let mut exts: Vec<String> = vec![String::new()];
    exts.extend(
        pathext
            .split(';')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_string),
    );
    for dir in path_env.split(';').map(str::trim) {
        let dir_path = Path::new(dir);
        // 只认绝对目录:剔除 ""、"."、相对项 —— 杜绝落回工作区。
        if !dir_path.is_absolute() {
            continue;
        }
        for ext in &exts {
            let mut file = name.to_os_string();
            file.push(ext);
            let candidate = dir_path.join(&file);
            if is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

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
    /// 是否支持断网变体(sandboxOffline)。macOS/Linux 在 `supported` 时为 true;
    /// Windows 免管理员方案无法可靠断网,恒为 false —— 前端据此仅禁用 sandboxOffline,
    /// 保留 sandbox。`supported=false` 时该字段无意义(整体不可用)。
    pub network_control: bool,
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
                network_control: true,
                reason: None,
            }
        } else {
            SandboxCapability {
                supported: false,
                mechanism: "seatbelt",
                platform: "macos",
                network_control: false,
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
            network_control: false,
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
                network_control: true,
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
        // 免管理员写围栏(CreateRestrictedToken WRITE_RESTRICTED + 工作区继承写 ACE)
        // 无需任何依赖或提权,恒可用。断网(sandboxOffline)不可用:见模块注释。
        SandboxCapability {
            supported: true,
            mechanism: "restricted-token",
            platform: "windows",
            network_control: false,
            reason: None,
        }
    }

    pub(super) fn wrap_command(
        spec: &SandboxSpec,
        program: &Path,
        args: &[String],
    ) -> Result<(PathBuf, Vec<String>, &'static str), String> {
        // fail-closed:免管理员方案无法断网,sandboxOffline 在 Windows 上直接报错,
        // 绝不静默当作联网沙箱执行。capability.network_control=false 已让前端禁用该项,
        // 这里是执行层的兜底(设置可能同步自 macOS)。
        if !spec.allow_network {
            return Err(
                "Offline sandbox (no network) is not available on Windows without elevation. \
Use the plain Sandbox mode, or run on macOS/Linux for the offline variant."
                    .to_string(),
            );
        }
        // 自我再执行:把真实命令包进 current_exe 的 __sandbox_exec 启动器。启动器在
        // 进程最早期建受限令牌并 CreateProcessAsUserW 真实命令(见 windows_sandbox)。
        let current_exe = std::env::current_exe()
            .map_err(|err| format!("failed to resolve current executable for sandbox: {err}"))?;
        let launcher_args = build_launcher_args(&spec.write_root, program, args);
        Ok((current_exe, launcher_args, "restricted-token"))
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

    // --- 跨平台纯逻辑(Windows 启动器所依赖,可在任意宿主上运行) ---

    #[test]
    fn launcher_args_roundtrip() {
        let program = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
        let args = vec!["-lc".to_string(), "echo \"hi there\" && ls".to_string()];
        let built = build_launcher_args(Path::new(r"C:\ws\proj"), &program, &args);
        assert_eq!(built[0], SANDBOX_EXEC_SUBCOMMAND);
        // payload = built[1..](去掉 argv[1] 子命令标记),即启动器实际解析的部分。
        let parsed = parse_launcher_args(&built[1..]).expect("parse");
        assert_eq!(parsed.write_root, PathBuf::from(r"C:\ws\proj"));
        assert_eq!(parsed.program, program);
        assert_eq!(parsed.args, args);
    }

    #[test]
    fn parse_launcher_args_rejects_incomplete() {
        assert!(parse_launcher_args(&["--write-root".to_string()]).is_err());
        assert!(parse_launcher_args(&["--".to_string()]).is_err());
        assert!(parse_launcher_args(&[]).is_err());
        // 缺 --write-root。
        assert!(parse_launcher_args(&["--".to_string(), "cmd.exe".to_string()]).is_err());
    }

    #[test]
    fn parse_launcher_args_program_without_extra_args() {
        let parsed = parse_launcher_args(&[
            "--write-root".to_string(),
            r"C:\ws".to_string(),
            "--".to_string(),
            "cmd.exe".to_string(),
        ])
        .expect("parse");
        assert_eq!(parsed.program, PathBuf::from("cmd.exe"));
        assert!(parsed.args.is_empty());
    }

    #[test]
    fn synthetic_sid_is_deterministic_and_case_insensitive() {
        let a = synthetic_workspace_sid(Path::new(r"C:\Users\Me\Project"));
        let b = synthetic_workspace_sid(Path::new(r"c:\users\me\project"));
        assert_eq!(a, b, "Windows 路径大小写不敏感,应得同一 SID");
        assert!(a.starts_with("S-1-5-21-"));
        // 形如 S-1-5-21-<a>-<b>-<c>-<d>:S,1,5,21 + 4 段子权限 = 8 段。
        assert_eq!(a.split('-').count(), 8);
        let other = synthetic_workspace_sid(Path::new(r"C:\Users\Me\Other"));
        assert_ne!(a, other, "不同路径应得不同 SID");
    }

    #[test]
    fn command_line_quotes_spaces_and_escapes_quotes() {
        let line = build_command_line(
            r"C:\Program Files\App\app.exe",
            &["--flag".to_string(), "a b".to_string(), r#"say "hi""#.to_string()],
        );
        assert_eq!(line.last(), Some(&0u16), "须以 NUL 结尾");
        let decoded = String::from_utf16(&line[..line.len() - 1]).unwrap();
        // 含空格的程序路径整体加引号(反斜杠不因无 `"` 而翻倍)。
        assert!(decoded.starts_with(r#""C:\Program Files\App\app.exe""#));
        // 无特殊字符的参数不加引号。
        assert!(decoded.contains(" --flag "));
        // 含空格的参数加引号。
        assert!(decoded.contains(r#" "a b" "#));
        // 内部的 " 用反斜杠转义。
        assert!(decoded.ends_with(r#""say \"hi\"""#));
    }

    #[test]
    fn command_line_doubles_trailing_backslashes_before_closing_quote() {
        // 参数含空格需加引号,且以反斜杠结尾时,收尾反斜杠必须翻倍,
        // 否则会转义掉闭合引号(CommandLineToArgvW 经典陷阱)。
        let line = build_command_line("prog", &[r"a\b c\".to_string()]);
        let decoded = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert!(decoded.ends_with(r#""a\b c\\""#));
    }

    // resolve_program_in_path:本机(Unix)按 Unix 绝对/分隔规则验证“搜绝对目录、套
    // PATHEXT、跳相对项、绝对入参直通”这套算法;Windows 路径语义由 Windows 编译+真机验证。
    #[test]
    fn resolve_program_searches_absolute_dirs_first_match_wins() {
        let present: std::collections::HashSet<PathBuf> =
            [PathBuf::from("/usr/bin/sh")].into_iter().collect();
        let is_file = |p: &Path| present.contains(p);
        let got = resolve_program_in_path(
            Path::new("sh"),
            "/nonexist;/usr/bin;/bin",
            ".EXE",
            &is_file,
        );
        assert_eq!(got, Some(PathBuf::from("/usr/bin/sh")));
    }

    #[test]
    fn resolve_program_applies_pathext_to_bare_name() {
        let present: std::collections::HashSet<PathBuf> =
            [PathBuf::from("/tools/pwsh.EXE")].into_iter().collect();
        let is_file = |p: &Path| present.contains(p);
        let got = resolve_program_in_path(Path::new("pwsh"), "/tools", ".COM;.EXE", &is_file);
        assert_eq!(got, Some(PathBuf::from("/tools/pwsh.EXE")));
    }

    #[test]
    fn resolve_program_never_probes_relative_or_dot_dirs() {
        // PATH 里的 "." 与相对项绝不被探测:谓词只应收到绝对候选。
        let is_file = |p: &Path| {
            assert!(p.is_absolute(), "resolver probed a non-absolute path: {p:?}");
            false
        };
        let got = resolve_program_in_path(Path::new("cmd.exe"), ".;rel/dir;/abs", ".EXE", &is_file);
        assert_eq!(got, None);
    }

    #[test]
    fn resolve_program_passes_absolute_input_through_without_probing() {
        let is_file = |_: &Path| panic!("absolute input must not be probed");
        let got = resolve_program_in_path(Path::new("/bin/sh"), "/other", ".EXE", &is_file);
        assert_eq!(got, Some(PathBuf::from("/bin/sh")));
    }
}
