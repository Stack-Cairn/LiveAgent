//! OS 级沙箱(沙箱模式 v1):模型驱动的 Bash / ManagedProcess 在生成子进程前
//! 由平台原生机制包裹——macOS 走 Seatbelt(/usr/bin/sandbox-exec),Linux 走
//! bubblewrap(bwrap),Windows 联网模式走 Low Integrity 主令牌,断网模式走
//! AppContainer(均带工作区写围栏 + Job Object,免管理员/免 UAC)。
//!
//! 语义为 workspace-write:读默认放行(工具链/依赖散布全盘,default-deny 不现实),
//! 写仅限工作区根 + 临时目录,敏感目录(~/.ssh、应用配置库等)读写全掩蔽,网络可
//! 整体关断。fail-closed:沙箱被请求而平台机制不可用时直接报错,绝不静默降级为
//! 无沙箱执行。
//!
//! Windows 双后端(均免管理员/免 UAC,见 memory windows-sandbox-facts):
//! - sandbox(联网):当前用户主令牌副本降到 Low IL,网络能力与无沙箱进程一致；
//!   工作区/TEMP 同步标 Low,由 MIC NoWriteUp 围栏写入。
//! - sandboxOffline(断网):AppContainer(零 capability)。WFP 对无网络 capability
//!   的 AppContainer 默认拒绝全部网络含 loopback ⇒ 内核级强制断网,无需提权(对比
//!   Codex:unelevated 仅 env 级软断网,强制断网须提权建专用账号+防火墙)。AC 默认
//!   拒绝未授权读,系统目录靠自带的 ALL APPLICATION PACKAGES ACE 可读,用户主目录
//!   默认不可读 ⇒ 断网变体顺带获得敏感目录读掩蔽;读收紧对 offline 场景可接受。

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// 自我再执行启动器子命令标记:Windows `wrap_command` 把 (program, args) 包成
/// `current_exe __sandbox_exec --write-root <root> --net on|off [--isolated] -- <program> <args...>`;
/// 进程启动最早期 `windows_sandbox::run_sandbox_launcher_if_requested` 识别它,
/// 按 --net 建 Low IL 主令牌(联网)或 AppContainer(断网)后执行真实命令。
/// 非 Windows 平台不产生该标记。
pub(crate) const SANDBOX_EXEC_SUBCOMMAND: &str = "__sandbox_exec";

/// 启动器解析后的调用信息(纯逻辑,跨平台可测)。
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LauncherInvocation {
    pub write_root: PathBuf,
    /// 网络放行与否决定后端:true → Low IL 主令牌(联网),false → AppContainer(断网)。
    pub allow_network: bool,
    /// isolated 常驻进程须在启动器死亡后继续存活 ⇒ 启动器不得给子进程挂
    /// KILL_ON_JOB_CLOSE 的 Job Object(对齐 Linux bwrap 省略 --die-with-parent)。
    pub isolated: bool,
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// 构造传给自我再执行启动器的参数向量(含子命令标记,作为 argv[1])。
/// 形如 `[__sandbox_exec, --write-root, <root>, --net, on|off, [--isolated,] --, <program>, <args...>]`。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn build_launcher_args(
    write_root: &Path,
    allow_network: bool,
    isolated: bool,
    program: &Path,
    args: &[String],
) -> Vec<String> {
    let mut out = vec![
        SANDBOX_EXEC_SUBCOMMAND.to_string(),
        "--write-root".to_string(),
        write_root.to_string_lossy().into_owned(),
        "--net".to_string(),
        if allow_network { "on" } else { "off" }.to_string(),
    ];
    if isolated {
        out.push("--isolated".to_string());
    }
    out.push("--".to_string());
    out.push(program.to_string_lossy().into_owned());
    out.extend(args.iter().cloned());
    out
}

/// 解析启动器 payload(子命令标记之后的部分):
/// `--write-root <root> --net on|off [--isolated] -- <program> [args...]`。
/// `--net` 为必填:构造与解析同版本(同一 exe 自我再执行),不存在旧格式兼容问题;
/// 缺失即拒绝,绝不隐式默认成某个后端。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parse_launcher_args(payload: &[String]) -> Result<LauncherInvocation, String> {
    let mut it = payload.iter();
    let mut write_root: Option<PathBuf> = None;
    let mut allow_network: Option<bool> = None;
    let mut isolated = false;
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
            "--net" => {
                let value = it
                    .next()
                    .ok_or_else(|| "--net requires a value".to_string())?;
                allow_network = Some(match value.as_str() {
                    "on" => true,
                    "off" => false,
                    other => return Err(format!("--net expects on|off, got: {other}")),
                });
            }
            "--isolated" => isolated = true,
            "--" => {
                program = it.next().map(PathBuf::from);
                rest = it.cloned().collect();
                break;
            }
            other => return Err(format!("unexpected launcher argument: {other}")),
        }
    }
    let write_root = write_root.ok_or_else(|| "missing --write-root".to_string())?;
    let allow_network = allow_network.ok_or_else(|| "missing --net on|off".to_string())?;
    let program = program.ok_or_else(|| "missing program after `--`".to_string())?;
    Ok(LauncherInvocation {
        write_root,
        allow_network,
        isolated,
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
/// 算法逐字复刻 Rust 标准库 `make_command_line`/`append_arg`,以保证 Low IL token 下
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

/// Microsoft Store / MSIX 执行别名位于 `WindowsApps`。沙箱安全上下文不能直接
/// 通过 `CreateProcess*` 启动这类打包二进制,因此不能把它当作 shell。
/// 同时按 `/` 与 `\` 分段,以便在非 Windows 宿主上用 Windows 路径字面量做单测。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn is_msix_windowsapps_path(path: &Path) -> bool {
    path.to_string_lossy()
        .split(['\\', '/'])
        .any(|seg| seg.eq_ignore_ascii_case("WindowsApps"))
}

/// HKCU 子键:CAPI/CNG 在 provider 初始化时会对它们 `RegCreateKey`(创建即写)。
/// Low IL token 若面对 Medium 标签会被 NoWriteUp 拒绝，最终被 PowerShell/.NET
/// 误报成 “BCrypt.dll 加载失败”(exit `0xE0434352`)。
/// 这是用户证书/密钥库的窄例外,不是放开整个 HKCU。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const CNG_USER_REGISTRY_SUBKEYS: &[&str] = &[
    r"Software\Microsoft\SystemCertificates",
    r"Software\Microsoft\SystemCertificates\CA",
    r"Software\Microsoft\SystemCertificates\Root",
    r"Software\Microsoft\SystemCertificates\My",
    r"Software\Policies\Microsoft\SystemCertificates",
    r"Software\Policies\Microsoft\SystemCertificates\CA",
    r"Software\Microsoft\Cryptography",
];

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn cng_named_registry_object(subkey: &str) -> String {
    format!("CURRENT_USER\\{subkey}")
}

/// CNG 还会把密钥容器 / DPAPI / 证书 URL 缓存写到用户配置目录
/// (非 TEMP;沙箱的 TEMP 重定向覆盖不到这里)。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn cng_user_file_dirs(appdata: &Path, localappdata: &Path) -> Vec<PathBuf> {
    vec![
        appdata.join("Microsoft").join("Crypto"),
        appdata.join("Microsoft").join("Protect"),
        localappdata.join("Microsoft").join("CryptnetUrlCache"),
    ]
}

/// HKCU 子键:Windows PowerShell 5.1 / .NET Framework CLR 启动会 `RegCreateKey`。
/// 与 CNG 证书库是另一条失败面——这里被拒时进程以 HRESULT `0x80070005`
/// (E_ACCESSDENIED)退出,而不是 `0xE0434352` / `NTE_PROVIDER_DLL_FAIL`。
/// 仍是用户运行时缓存的窄例外,不是放开整个 HKCU。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const CLR_USER_REGISTRY_SUBKEYS: &[&str] = &[
    r"Software\Microsoft\PowerShell",
    r"Software\Microsoft\PowerShell\1",
    r"Software\Microsoft\Windows\PowerShell",
    r"Software\Microsoft\.NETFramework",
];

/// .NET Framework / Windows PowerShell 启动还会写用户 CLR 缓存与模块分析目录
/// (Fusion、UsageLogs、ModuleAnalysisCache)。不盖这些路径时,powershell.exe
/// 在 Low IL token 下不可写时会以 `0x80070005` 立即崩溃。
///
/// 故意不含 `%LOCALAPPDATA%\Temp`:TEMP 已重定向到围栏目录,给用户真实 Temp
/// 盖写 ACE 会把围栏撕开。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn clr_user_file_dirs(appdata: &Path, localappdata: &Path) -> Vec<PathBuf> {
    vec![
        localappdata.join("Microsoft").join("CLR_v4.0"),
        localappdata.join("Microsoft").join("CLR_v4.0_32"),
        localappdata.join("assembly"),
        localappdata
            .join("Microsoft")
            .join("Windows")
            .join("PowerShell"),
        localappdata.join("Microsoft").join("PowerShell"),
        appdata.join("Microsoft").join("Windows").join("PowerShell"),
        appdata.join("Microsoft").join("CLR Security Config"),
        localappdata.join("IsolatedStorage"),
    ]
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
    /// 语义)。Linux bwrap 据此省略 `--die-with-parent`;Windows 启动器据此省略
    /// KILL_ON_JOB_CLOSE 的 Job Object(经 `--isolated` 穿透自我再执行边界)。
    /// macOS Seatbelt 无父进程死亡耦合,不读取本字段。
    #[cfg_attr(target_os = "macos", allow(dead_code))]
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

/// 命令安全模式 → 沙箱参数。`ask`/`auto` 不启用 OS 沙箱(`ask` 是前端的逐次人工放行
/// 闸门,不改变执行隔离),`sandbox` 联网、`sandboxOffline` 断网。
pub(crate) fn options_from_mode(mode: &str) -> Option<SandboxOptions> {
    match mode.trim() {
        "sandbox" => Some(SandboxOptions {
            allow_network: true,
        }),
        "sandboxOffline" => Some(SandboxOptions {
            allow_network: false,
        }),
        _ => None,
    }
}

/// 取更严格的一方。严格度:无沙箱 < 联网沙箱 < 断网沙箱。
pub(crate) fn strictest(
    a: Option<SandboxOptions>,
    b: Option<SandboxOptions>,
) -> Option<SandboxOptions> {
    match (a, b) {
        (Some(x), Some(y)) => Some(SandboxOptions {
            allow_network: x.allow_network && y.allow_network,
        }),
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    }
}

/// 后端独立下限(P1#3):渲染进程送来的 `sandbox` / `sandbox_allow_network` 只能"加严",
/// 绝不能放宽。后端在命令边界回查持久化的 `settings.system.commandSafetyMode` 自行推出
/// 下限,并与请求值取更严格者——不论请求来自桌面 UI、网关(远端 WebUI)还是 Cron 调度器,
/// 同一下限强制生效(对齐 `load_runtime_ssh_host` 的"服务端重解析持久化配置"范式)。
///
/// 读取持久化配置失败 ⇒ 直接报错(fail-closed),绝不因为读不到设置就无沙箱执行。
pub(crate) fn resolve_effective_options(
    requested: Option<SandboxOptions>,
) -> Result<Option<SandboxOptions>, String> {
    let mode = crate::commands::settings::load_runtime_command_safety_mode().map_err(|err| {
        format!(
            "Cannot verify the persisted sandbox floor (settings.system.commandSafetyMode): {err}. \
Refusing to run the command unsandboxed."
        )
    })?;
    Ok(strictest(requested, options_from_mode(&mode)))
}

#[derive(Debug, Clone, Serialize)]
pub struct SandboxCapability {
    pub supported: bool,
    pub mechanism: &'static str,
    pub platform: &'static str,
    /// 是否支持断网变体(sandboxOffline)。macOS/Linux 在 `supported` 时为 true;
    /// Windows 由运行时探测决定(能否派生 AppContainer SID)。`supported=false` 时
    /// 该字段无意义(整体不可用)。
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

/// 词法比较前的路径归一(P2#5)。
///
/// `canonical_or_self` 只在路径存在时才 canonicalize,而 Windows 的 canonicalize 会
/// 加上 verbatim 前缀(`\\?\C:\...`、UNC 形式 `\\?\UNC\server\share`);不存在的路径
/// 则保持原始形态。`Path::starts_with` 是纯词法的组件比较,不做前缀归一,于是两侧
/// 前缀形态不一致时(write_root 存在而某敏感目录不存在,或反之)比较恒为 false ——
/// 围栏校验被静默跳过,属 fail-open。这里统一剥掉 verbatim 前缀,并在 Windows 上折叠
/// 大小写(NTFS 路径大小写不敏感),让比较在两种形态下都成立。
fn normalize_for_compare(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let stripped: String = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.to_string()
    };
    if cfg!(windows) {
        PathBuf::from(stripped.to_lowercase())
    } else {
        PathBuf::from(stripped)
    }
}

/// `ancestor` 是否包含或等于 `descendant`(归一后按组件比较)。
fn path_encloses(ancestor: &Path, descendant: &Path) -> bool {
    normalize_for_compare(descendant).starts_with(normalize_for_compare(ancestor))
}

/// fail-closed 工作区校验(P1#2):拒绝会让写围栏重新暴露敏感目录的工作区。
///
/// 写围栏对 write_root 有后置 re-allow(macOS)/后置 --bind(Linux),因此:
/// - **祖先或相等**:工作区包含或等于任一敏感目录(如工作区取 home 或 /),
///   re-allow 会把该敏感目录重新放行 → 一律拒绝。
/// - **后代**:工作区落在敏感目录内部。凭据目录(~/.ssh/.aws/.gnupg/.config/gh)
///   下的工作区一律拒绝;应用配置目录(~/.liveagent)豁免——默认工作区
///   ~/.liveagent/default-project 正位于其内,拒绝它会直接打断开箱即用。
///
/// wrap 路径(`wrap_command`)与 Windows 自我再执行启动器(`windows_sandbox::win::execute`)
/// 两个入口都必须调用它,否则同一 write_root 在两条链上前置条件不对称(P3#8)。
pub(crate) fn validate_workspace(write_root: &Path) -> Result<(), String> {
    let root = canonical_or_self(write_root);
    let app_config = app_config_dir().map(|p| canonical_or_self(&p));

    for dir in sensitive_dirs() {
        let dir = canonical_or_self(&dir);
        if path_encloses(&root, &dir) {
            return Err(format!(
                "Sandbox refuses workspace \"{}\": it encloses or equals the sensitive directory \
\"{}\", which the workspace write fence would re-expose. Choose a workspace that does not \
contain credential or app-config directories.",
                root.display(),
                dir.display()
            ));
        }
        if path_encloses(&dir, &root) {
            // 应用配置目录内部豁免(默认工作区在此),其余敏感目录内部一律拒绝。
            let dir_key = normalize_for_compare(&dir);
            if app_config
                .as_deref()
                .is_some_and(|config| normalize_for_compare(config) == dir_key)
            {
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

/// Darwin 用户临时目录形如 `/var/folders/<xx>/<rand>/T`(或 `/private/var/folders/.../T`)。
/// 只有这种布局才允许把写放行提升到父目录,以同时覆盖 confstr 的 `T` 与 `C`
/// (clang 模块缓存等)。对 `/tmp`、`/private/tmp`、`$HOME` 做 `parent()` 会得到
/// `/` 或 `$HOME`,Seatbelt last-match-wins 会把整盘(含 ~/.ssh)重新放行。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn darwin_user_temp_parent(tmpdir: &Path) -> Option<PathBuf> {
    let mut names: Vec<&str> = Vec::new();
    for component in tmpdir.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => names.push(name.to_str()?),
            _ => return None,
        }
    }
    let n = names.len();
    if n < 4 || names[n - 1] != "T" || names[n - 4] != "folders" {
        return None;
    }
    let prefix = &names[..n - 4];
    if prefix != ["var"] && prefix != ["private", "var"] {
        return None;
    }
    tmpdir.parent().map(Path::to_path_buf)
}

/// 临时写根是否安全:不得等于或包住 `/`、`$HOME`、或任一敏感目录,否则后置
/// write-allow / bwrap `--bind` 会重新暴露凭据(与 `validate_workspace` 同一理由)。
#[cfg(any(not(windows), test))]
pub(crate) fn temp_write_root_is_safe(path: &Path) -> bool {
    let root = canonical_or_self(path);
    let cmp = normalize_for_compare(&root);
    if cmp == Path::new("/") || cmp.as_os_str().is_empty() {
        return false;
    }
    #[cfg(windows)]
    {
        if cmp.components().count() <= 1 {
            return false;
        }
    }
    if let Some(home) = dirs::home_dir() {
        if path_encloses(&root, &canonical_or_self(&home)) {
            return false;
        }
    }
    for dir in sensitive_dirs() {
        if path_encloses(&root, &canonical_or_self(&dir)) {
            return false;
        }
    }
    true
}

/// 把 `bwrap` 解析成绝对路径,绝不搜索 cwd / 相对 PATH。
///
/// 优先 `/usr/bin/bwrap` 与 `/usr/local/bin/bwrap`,避免项目 PATH 前缀
/// (`node_modules/.bin`、`.venv/bin`)里的同名投毒二进制胜出。随后只走绝对 PATH
/// 目录;`skip_under` 用于 wrap 时跳过工作区(模型可写)内的命中。
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub(crate) fn resolve_bwrap_executable(
    path_env: &str,
    is_file: &dyn Fn(&Path) -> bool,
    skip_under: Option<&Path>,
) -> Option<PathBuf> {
    const PINNED: &[&str] = &["/usr/bin/bwrap", "/usr/local/bin/bwrap"];
    let skipped = |candidate: &Path| skip_under.is_some_and(|root| path_encloses(root, candidate));
    for candidate in PINNED {
        let path = Path::new(candidate);
        if is_file(path) && !skipped(path) {
            return Some(path.to_path_buf());
        }
    }
    for dir in path_env.split(':').map(str::trim) {
        let dir_path = Path::new(dir);
        if !dir_path.is_absolute() || skipped(dir_path) {
            continue;
        }
        let candidate = dir_path.join("bwrap");
        if is_file(&candidate) && !skipped(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// 临时目录允许写入集合:TMPDIR(仅 Darwin 用户私有 `/var/folders/.../T` 才提升
/// 到父级以覆盖 confstr 缓存目录)、std::env::temp_dir、以及系统级 tmp。
/// 会包住 `/` 或 `$HOME` 的根一律丢弃,绝不写进 Seatbelt allow / bwrap `--bind`。
#[cfg(not(windows))]
fn writable_temp_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push_canonical = |path: PathBuf| {
        if !temp_write_root_is_safe(&path) {
            return;
        }
        let canonical = std::fs::canonicalize(&path).unwrap_or(path);
        if !temp_write_root_is_safe(&canonical) {
            return;
        }
        if !out.contains(&canonical) {
            out.push(canonical);
        }
    };

    if let Ok(tmpdir) = std::env::var("TMPDIR") {
        let tmpdir = PathBuf::from(tmpdir.trim_end_matches('/'));
        if tmpdir.is_absolute() && tmpdir.is_dir() {
            // /var/folders/xx/yyy/T → 放行父级 /var/folders/xx/yyy,同时覆盖
            // DARWIN_USER_CACHE_DIR(…/C)。其它布局(含 TMPDIR=/tmp)禁止提升。
            #[cfg(target_os = "macos")]
            if let Some(parent) = darwin_user_temp_parent(&tmpdir) {
                push_canonical(parent);
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
            capability
                .reason
                .as_deref()
                .unwrap_or("unsupported platform")
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
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
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
        profile.push_str(&format!(
            "(allow file-write* {})\n",
            subpath_filters(&writable)
        ));
        profile.push_str(
            "(allow file-write-data file-ioctl (literal \"/dev/null\") (literal \"/dev/zero\") \
(literal \"/dev/tty\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") \
(literal \"/dev/dtracehelper\"))\n(allow file-write* (subpath \"/dev/fd\"))\n",
        );
        let sensitive = sensitive_dirs();
        if !sensitive.is_empty() {
            profile.push_str(&format!(
                "(deny file-read* {})\n",
                subpath_filters(&sensitive)
            ));
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

    fn resolve_installed_bwrap() -> Option<PathBuf> {
        resolve_bwrap_executable(
            &std::env::var("PATH").unwrap_or_default(),
            &|path| path.is_file(),
            None,
        )
    }

    fn probe() -> SandboxCapability {
        let unsupported = |reason: String| SandboxCapability {
            supported: false,
            mechanism: "bubblewrap",
            platform: "linux",
            network_control: false,
            reason: Some(reason),
        };
        let Some(bwrap) = resolve_installed_bwrap() else {
            return unsupported(
                "bubblewrap (bwrap) is not available. Install it, e.g. `apt install bubblewrap`."
                    .to_string(),
            );
        };
        // 探测真实可用性(容器/受限内核里 bwrap 可能存在但无法建 namespace)。
        // 必须用解析出的绝对路径,绝不用 PATH 上的相对名(工作区可写目录可能抢先)。
        match Command::new(&bwrap)
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
            Err(err) => unsupported(format!("bubblewrap (bwrap) is not available: {err}.")),
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
        let bwrap = resolve_bwrap_executable(
            &std::env::var("PATH").unwrap_or_default(),
            &|path| path.is_file(),
            Some(&spec.write_root),
        )
        .ok_or_else(|| {
            "Sandbox mode is enabled but bwrap was not found outside the workspace. \
Install bubblewrap to a system path such as /usr/bin/bwrap (a binary inside the \
project folder is never used)."
                .to_string()
        })?;
        let mut out = bwrap_args(spec);
        out.push(program.to_string_lossy().into_owned());
        out.extend(args.iter().cloned());
        Ok((bwrap, out, "bubblewrap"))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::OnceLock;

    static CAPABILITY: OnceLock<SandboxCapability> = OnceLock::new();

    /// 运行时探测(P1#4):不再硬编码"恒可用"。两个后端都实际建一次安全上下文——
    /// 联网后端复制当前用户主令牌并降到 Low IL,断网后端派生
    /// AppContainer SID。组策略、EDR hook、受限 SKU 会让这些调用在真机上失败;
    /// 探测把失败提前暴露成 `supported=false` / `network_control=false`,
    /// `wrap_command` 的 fail-closed 守卫因而在 Windows 上真正可达。
    fn probe() -> SandboxCapability {
        let unsupported = |reason: String| SandboxCapability {
            supported: false,
            mechanism: "low-integrity-token",
            platform: "windows",
            network_control: false,
            reason: Some(reason),
        };
        // 自我再执行启动器以 current_exe 为壳,解析不出来则整体不可用。
        if let Err(err) = std::env::current_exe() {
            return unsupported(format!("cannot resolve current executable: {err}"));
        }
        let (networked_token, appcontainer) = crate::runtime::windows_sandbox::probe_backends();
        if let Err(err) = networked_token {
            return unsupported(format!("low-integrity token backend unavailable: {err}"));
        }
        SandboxCapability {
            supported: true,
            mechanism: "low-integrity-token",
            platform: "windows",
            // 断网变体走 AppContainer:派生不出 AC SID ⇒ 仅 sandboxOffline 不可用,
            // 联网写围栏仍然可用(UI 据此只禁用断网项)。
            network_control: appcontainer.is_ok(),
            reason: appcontainer
                .err()
                .map(|err| format!("offline (AppContainer) backend unavailable: {err}")),
        }
    }

    pub(super) fn capability() -> SandboxCapability {
        CAPABILITY.get_or_init(probe).clone()
    }

    pub(super) fn wrap_command(
        spec: &SandboxSpec,
        program: &Path,
        args: &[String],
    ) -> Result<(PathBuf, Vec<String>, &'static str), String> {
        // 自我再执行:把真实命令包进 current_exe 的 __sandbox_exec 启动器。启动器在
        // 进程最早期按 --net 选后端:on → Low IL 主令牌(CreateProcessAsUserW),off →
        // AppContainer(CreateProcessW + SECURITY_CAPABILITIES);见 windows_sandbox。
        if !spec.allow_network && !capability().network_control {
            return Err(format!(
                "Offline sandbox is enabled but the AppContainer backend is unavailable on this \
machine: {}. Switch to the networked sandbox mode or resolve the issue and retry.",
                capability()
                    .reason
                    .as_deref()
                    .unwrap_or("AppContainer SID could not be derived")
            ));
        }
        let current_exe = std::env::current_exe()
            .map_err(|err| format!("failed to resolve current executable for sandbox: {err}"))?;
        let launcher_args = build_launcher_args(
            &spec.write_root,
            spec.allow_network,
            spec.isolated,
            program,
            args,
        );
        let mechanism = if spec.allow_network {
            "low-integrity-token"
        } else {
            "appcontainer"
        };
        Ok((current_exe, launcher_args, mechanism))
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
        let deny_read = profile
            .find("(deny file-read*")
            .expect("deny file-read rule");
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

    // P2#5:verbatim 前缀必须在词法比较前剥掉,否则 canonicalize 过的一侧与未
    // canonicalize 的一侧永不匹配(fail-open)。
    #[test]
    fn normalize_for_compare_strips_verbatim_prefixes() {
        assert_eq!(
            normalize_for_compare(Path::new(r"\\?\C:\ws\proj")).to_string_lossy(),
            if cfg!(windows) {
                r"c:\ws\proj".to_string()
            } else {
                r"C:\ws\proj".to_string()
            }
        );
        assert_eq!(
            normalize_for_compare(Path::new(r"\\?\UNC\server\share\ws")).to_string_lossy(),
            r"\\server\share\ws"
        );
    }

    #[test]
    fn path_encloses_matches_ancestor_and_self() {
        assert!(path_encloses(
            Path::new("/home/user"),
            Path::new("/home/user/.ssh")
        ));
        assert!(path_encloses(
            Path::new("/home/user"),
            Path::new("/home/user")
        ));
        assert!(!path_encloses(
            Path::new("/home/user/.ssh"),
            Path::new("/home/user")
        ));
        // 前缀形态不同(一侧 canonicalize 过)仍须匹配。
        #[cfg(windows)]
        {
            assert!(path_encloses(
                Path::new(r"C:\Users\Me"),
                Path::new(r"\\?\C:\Users\Me\.ssh")
            ));
            assert!(path_encloses(
                Path::new(r"\\?\C:\Users\Me"),
                Path::new(r"c:\users\me\.aws")
            ));
        }
    }

    // P1#3:下限与请求值取更严格者;两者皆无沙箱才不围栏。
    #[test]
    fn strictest_takes_the_tighter_side() {
        let online = Some(SandboxOptions {
            allow_network: true,
        });
        let offline = Some(SandboxOptions {
            allow_network: false,
        });
        assert!(strictest(None, None).is_none());
        assert_eq!(strictest(None, online).map(|o| o.allow_network), Some(true));
        assert_eq!(strictest(online, None).map(|o| o.allow_network), Some(true));
        // 一侧断网 ⇒ 结果断网(不允许被另一侧放宽回联网)。
        assert_eq!(
            strictest(online, offline).map(|o| o.allow_network),
            Some(false)
        );
        assert_eq!(
            strictest(offline, online).map(|o| o.allow_network),
            Some(false)
        );
    }

    #[test]
    fn options_from_mode_only_sandbox_modes_fence() {
        assert!(options_from_mode("auto").is_none());
        assert!(options_from_mode("ask").is_none());
        assert!(options_from_mode("nonsense").is_none());
        assert_eq!(
            options_from_mode("sandbox").map(|o| o.allow_network),
            Some(true)
        );
        assert_eq!(
            options_from_mode("sandboxOffline").map(|o| o.allow_network),
            Some(false)
        );
    }

    #[test]
    fn launcher_args_roundtrip() {
        let program = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
        let args = vec!["-lc".to_string(), "echo \"hi there\" && ls".to_string()];
        for (allow_network, isolated) in
            [(true, false), (false, false), (true, true), (false, true)]
        {
            let built = build_launcher_args(
                Path::new(r"C:\ws\proj"),
                allow_network,
                isolated,
                &program,
                &args,
            );
            assert_eq!(built[0], SANDBOX_EXEC_SUBCOMMAND);
            // payload = built[1..](去掉 argv[1] 子命令标记),即启动器实际解析的部分。
            let parsed = parse_launcher_args(&built[1..]).expect("parse");
            assert_eq!(parsed.write_root, PathBuf::from(r"C:\ws\proj"));
            assert_eq!(parsed.allow_network, allow_network);
            assert_eq!(parsed.isolated, isolated);
            assert_eq!(parsed.program, program);
            assert_eq!(parsed.args, args);
        }
    }

    #[test]
    fn parse_launcher_args_rejects_incomplete() {
        assert!(parse_launcher_args(&["--write-root".to_string()]).is_err());
        assert!(parse_launcher_args(&["--".to_string()]).is_err());
        assert!(parse_launcher_args(&[]).is_err());
        // 缺 --write-root。
        assert!(parse_launcher_args(&[
            "--net".to_string(),
            "on".to_string(),
            "--".to_string(),
            "cmd.exe".to_string(),
        ])
        .is_err());
        // 缺 --net(必填,绝不隐式默认后端)。
        assert!(parse_launcher_args(&[
            "--write-root".to_string(),
            r"C:\ws".to_string(),
            "--".to_string(),
            "cmd.exe".to_string(),
        ])
        .is_err());
        // --net 值非法。
        assert!(parse_launcher_args(&[
            "--write-root".to_string(),
            r"C:\ws".to_string(),
            "--net".to_string(),
            "maybe".to_string(),
            "--".to_string(),
            "cmd.exe".to_string(),
        ])
        .is_err());
    }

    #[test]
    fn parse_launcher_args_program_without_extra_args() {
        let parsed = parse_launcher_args(&[
            "--write-root".to_string(),
            r"C:\ws".to_string(),
            "--net".to_string(),
            "off".to_string(),
            "--".to_string(),
            "cmd.exe".to_string(),
        ])
        .expect("parse");
        assert_eq!(parsed.program, PathBuf::from("cmd.exe"));
        assert!(!parsed.allow_network);
        assert!(!parsed.isolated);
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
            &[
                "--flag".to_string(),
                "a b".to_string(),
                r#"say "hi""#.to_string(),
            ],
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
        let got =
            resolve_program_in_path(Path::new("sh"), "/nonexist;/usr/bin;/bin", ".EXE", &is_file);
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
            assert!(
                p.is_absolute(),
                "resolver probed a non-absolute path: {p:?}"
            );
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

    #[test]
    fn msix_windowsapps_path_is_detected_case_insensitively() {
        assert!(is_msix_windowsapps_path(Path::new(
            r"C:\Users\Me\AppData\Local\Microsoft\WindowsApps\pwsh.exe"
        )));
        assert!(is_msix_windowsapps_path(Path::new(
            r"C:\Program Files\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe"
        )));
        assert!(!is_msix_windowsapps_path(Path::new(
            r"C:\Program Files\PowerShell\7\pwsh.exe"
        )));
        assert!(!is_msix_windowsapps_path(Path::new(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        )));
    }

    #[test]
    fn cng_user_write_surface_is_narrow_user_store_not_home() {
        assert!(CNG_USER_REGISTRY_SUBKEYS
            .iter()
            .all(|key| key.starts_with(r"Software\")));
        assert!(CNG_USER_REGISTRY_SUBKEYS
            .iter()
            .all(|key| { key.contains("SystemCertificates") || key.contains("Cryptography") }));
        assert_eq!(
            cng_named_registry_object(r"Software\Microsoft\SystemCertificates"),
            r"CURRENT_USER\Software\Microsoft\SystemCertificates"
        );
        let dirs = cng_user_file_dirs(Path::new("/roaming"), Path::new("/local"));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/roaming/Microsoft/Crypto"),
                PathBuf::from("/roaming/Microsoft/Protect"),
                PathBuf::from("/local/Microsoft/CryptnetUrlCache"),
            ]
        );
        assert!(!dirs
            .iter()
            .any(|path| path == Path::new("/roaming") || path == Path::new("/local")));
    }

    #[test]
    fn clr_user_write_surface_is_narrow_runtime_cache_not_home() {
        assert!(CLR_USER_REGISTRY_SUBKEYS
            .iter()
            .all(|key| key.starts_with(r"Software\Microsoft\")));
        assert!(CLR_USER_REGISTRY_SUBKEYS
            .iter()
            .all(|key| { key.contains("PowerShell") || key.contains(".NETFramework") }));
        let dirs = clr_user_file_dirs(Path::new("/roaming"), Path::new("/local"));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/local/Microsoft/CLR_v4.0"),
                PathBuf::from("/local/Microsoft/CLR_v4.0_32"),
                PathBuf::from("/local/assembly"),
                PathBuf::from("/local/Microsoft/Windows/PowerShell"),
                PathBuf::from("/local/Microsoft/PowerShell"),
                PathBuf::from("/roaming/Microsoft/Windows/PowerShell"),
                PathBuf::from("/roaming/Microsoft/CLR Security Config"),
                PathBuf::from("/local/IsolatedStorage"),
            ]
        );
        assert!(!dirs.iter().any(|path| {
            path == Path::new("/roaming")
                || path == Path::new("/local")
                || path == Path::new("/local/Temp")
                || path == Path::new("/local/Microsoft")
        }));
    }

    #[test]
    fn darwin_user_temp_parent_only_matches_var_folders_layout() {
        assert_eq!(
            darwin_user_temp_parent(Path::new("/var/folders/zz/abc123/T")),
            Some(PathBuf::from("/var/folders/zz/abc123"))
        );
        assert_eq!(
            darwin_user_temp_parent(Path::new("/private/var/folders/zz/abc123/T")),
            Some(PathBuf::from("/private/var/folders/zz/abc123"))
        );
        // /tmp 的父级是 `/`,绝不能提升。
        assert_eq!(darwin_user_temp_parent(Path::new("/tmp")), None);
        assert_eq!(darwin_user_temp_parent(Path::new("/private/tmp")), None);
        assert_eq!(darwin_user_temp_parent(Path::new("/var/tmp")), None);
        assert_eq!(darwin_user_temp_parent(Path::new("/tmp/T")), None);
        assert_eq!(
            darwin_user_temp_parent(Path::new("/var/folders/zz/abc123")),
            None
        );
    }

    #[test]
    fn temp_write_root_rejects_filesystem_root_and_home() {
        assert!(!temp_write_root_is_safe(Path::new("/")));
        if let Some(home) = dirs::home_dir() {
            assert!(!temp_write_root_is_safe(&home));
        }
        assert!(temp_write_root_is_safe(Path::new("/tmp")));
        assert!(temp_write_root_is_safe(Path::new("/var/folders/zz/abc123")));
    }

    #[test]
    fn resolve_bwrap_prefers_system_path_over_workspace_path_prefix() {
        let present: std::collections::HashSet<PathBuf> = [
            PathBuf::from("/workspace/node_modules/.bin/bwrap"),
            PathBuf::from("/usr/bin/bwrap"),
        ]
        .into_iter()
        .collect();
        let is_file = |p: &Path| present.contains(p);
        let got = resolve_bwrap_executable("/workspace/node_modules/.bin:/usr/bin", &is_file, None);
        assert_eq!(got, Some(PathBuf::from("/usr/bin/bwrap")));
    }

    #[test]
    fn resolve_bwrap_skips_workspace_and_relative_path_entries() {
        let present: std::collections::HashSet<PathBuf> = [
            PathBuf::from("/workspace/node_modules/.bin/bwrap"),
            PathBuf::from("/opt/nix/bin/bwrap"),
        ]
        .into_iter()
        .collect();
        let is_file = |p: &Path| present.contains(p);
        let got = resolve_bwrap_executable(
            ".:/workspace/node_modules/.bin:/opt/nix/bin",
            &is_file,
            Some(Path::new("/workspace")),
        );
        assert_eq!(got, Some(PathBuf::from("/opt/nix/bin/bwrap")));
    }

    #[test]
    fn resolve_bwrap_refuses_when_only_workspace_copy_exists() {
        let is_file = |p: &Path| p == Path::new("/workspace/.venv/bin/bwrap");
        let got = resolve_bwrap_executable(
            "/workspace/.venv/bin",
            &is_file,
            Some(Path::new("/workspace")),
        );
        assert_eq!(got, None);
    }
}
