//! Windows 沙箱启动器(自我再执行模型,免管理员 / 免 UAC)。
//!
//! `sandbox::wrap_command`(Windows)不直接返回真实命令,而是把它包成对本 exe 的再调用:
//! `current_exe __sandbox_exec --write-root <root> --net on|off [--isolated] -- <program> <args...>`。
//! 进程启动最早期(`lib::run` 首行)调用 `run_sandbox_launcher_if_requested`:若检出该
//! 子命令,就地按 `--net` 选后端执行真实命令,等待其退出,以其退出码退出——绝不返回去
//! 初始化 Tauri。
//!
//! 双后端(均免管理员/免 UAC,见 memory `windows-sandbox-facts`,均已研究+对抗验证):
//!
//! A. 联网沙箱(`--net on`)= Low Integrity 主令牌(`DuplicateTokenEx` +
//! `CreateProcessAsUserW`)
//! - 复制当前用户主令牌,保留原登录会话和 SSPI/Schannel 凭据；不设置 WFP/AppContainer
//!   网络限制,也不注入离线代理或 `*_OFFLINE` 环境变量。因此 HTTP(S)、DNS、loopback、
//!   LAN 与监听端口的语义和无沙箱进程一致。
//! - 子令牌降到 Low IL；工作区、围栏 TEMP 及 PowerShell 必需的窄运行时缓存同步标为
//!   Low。Mandatory Integrity Control 的 NoWriteUp 拒绝写入 Medium 的 home、工作区
//!   父目录和盘符根,从而保留 workspace-write 围栏。
//! - Git Bash/PowerShell 的命名对象与标准句柄继续做 Low IL / BNO 兼容处理，避免
//!   `STATUS_DLL_INIT_FAILED`；这些处理不改变网络策略。
//! - 不能改回 `CreateRestrictedToken`：restricted token 会使 Schannel
//!   `AcquireCredentialsHandle` 返回 `SEC_E_NO_CREDENTIALS`，表现为联网沙箱 HTTPS 断网。
//!
//! B. 断网沙箱(`--net off`)= AppContainer(`CreateProcessW` + `SECURITY_CAPABILITIES`)
//! - AppContainer 只携带按工作区派生的私有文件 capability,不携带任何网络 capability;
//!   WFP 因而默认拒绝**全部**网络(含 loopback)⇒ 内核级强制断网,无需提权。对比
//!   Codex:unelevated 仅 env 级软断网,强制断网须提权建专用账号 + 防火墙/WFP 规则。
//! - AC 默认拒绝未授权“读”:系统目录靠自带的 `ALL APPLICATION PACKAGES` ACE 可读(工具链
//!   可用),用户主目录默认不可读 ⇒ 断网变体顺带获得敏感目录读掩蔽(联网后端缺失项)。
//! - 写围栏:对私有 capability SID 复用同一套授权写 ACE(工作区根 + 受围栏临时目录)。
//!   不能直接给 package SID 授权:Windows 会把含具体 AppContainer SID 的对象视为
//!   package 资源,随后普通 Low-IL 联网沙箱即使命中用户 ACE 也无法读取该对象。
//! - env 叠加(防御纵深):`HTTP(S)_PROXY=http://127.0.0.1:9`、`CARGO_NET_OFFLINE` 等,让
//!   工具在内核断网之上再快速明确失败(对齐 Codex `env.rs`)。
//!
//! 两后端共用启动尾:`STARTUPINFOEXW` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 只继承 3 个
//! std 句柄(取代 `bInheritHandles=TRUE` 的全句柄表继承,收敛句柄泄漏面);显式
//! `lpDesktop = winsta0\default`(Low IL token/AC 启动必须显式设桌面,否则句柄站点解析歧义);
//! Job Object `KILL_ON_JOB_CLOSE` 在非 isolated 时兜底级联杀,isolated 常驻进程则跳过
//!(对齐 Linux bwrap 省略 `--die-with-parent`);启动失败退出码(0xC0000142/0135/0022
//! 以及 CLR `0xE0434352` / HRESULT `0x80070005`)转可读中英诊断经既有管道上传。
//! 盖章跳过等诊断默认不写子进程 stderr(会污染 ManagedProcess 日志);设置
//! `LIVEAGENT_SANDBOX_LOG=1` 才回落到 stderr。

/// 非 Windows:自我再执行启动器不存在,空操作。
#[cfg(not(windows))]
pub fn run_sandbox_launcher_if_requested() {}

/// 运行时探测两个 Windows 后端能否真的建出安全上下文(P1#4)。
/// 返回 (联网 Low IL token 后端,断网 AppContainer 后端);非 Windows 平台不参与编译。
#[cfg(windows)]
pub(crate) fn probe_backends() -> (Result<(), String>, Result<(), String>) {
    (win::probe_networked_token(), win::probe_appcontainer())
}

/// Windows:若本次进程是 `__sandbox_exec` 启动器,执行真实命令并以其退出码退出;
/// 否则原样返回,交由正常的 Tauri 启动流程继续。
#[cfg(windows)]
pub fn run_sandbox_launcher_if_requested() {
    use crate::runtime::sandbox::{parse_launcher_args, SANDBOX_EXEC_SUBCOMMAND};

    let raw: Vec<String> = std::env::args().collect();
    // raw[0] = exe 自身;raw[1] = 子命令标记;raw[2..] = 启动器 payload。
    if raw.get(1).map(String::as_str) != Some(SANDBOX_EXEC_SUBCOMMAND) {
        return;
    }

    let code = match parse_launcher_args(&raw[2..]) {
        Ok(inv) => {
            match win::execute(
                &inv.write_root,
                inv.allow_network,
                inv.isolated,
                &inv.program,
                &inv.args,
            ) {
                Ok(code) => code,
                Err(err) => {
                    // fail-closed:已进入沙箱启动器分支,任何建令牌/派生失败都必须让命令
                    // 整体不执行,绝不回退到无沙箱运行。
                    eprintln!("liveagent sandbox launcher failed: {err}");
                    127
                }
            }
        }
        Err(err) => {
            eprintln!("liveagent sandbox launcher: invalid arguments: {err}");
            127
        }
    };
    std::process::exit(code);
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, HANDLE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        ConvertStringSidToSidW, GetNamedSecurityInfoW, GetSecurityInfo, SetEntriesInAclW,
        SetNamedSecurityInfoW, SetSecurityInfo, EXPLICIT_ACCESS_W, TRUSTEE_W,
    };
    #[cfg(test)]
    use windows_sys::Win32::Security::CreateRestrictedToken;
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        AddAccessAllowedAce, AddAce, CopySid, DeriveCapabilitySidsFromName, DuplicateTokenEx,
        EqualSid, FreeSid, GetAce, GetAclInformation, GetLengthSid, GetSecurityDescriptorSacl,
        GetTokenInformation, InitializeAcl, IsTokenRestricted, SetTokenInformation,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, SECURITY_CAPABILITIES,
        SID_AND_ATTRIBUTES, TOKEN_DEFAULT_DACL, TOKEN_GROUPS, TOKEN_USER,
    };
    use windows_sys::Win32::System::Console::GetStdHandle;
    use windows_sys::Win32::System::Environment::SetEnvironmentVariableW;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, HKEY, HKEY_CURRENT_USER,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
        GetCurrentProcessId, GetExitCodeProcess, InitializeProcThreadAttributeList,
        OpenProcessToken, ResumeThread, UpdateProcThreadAttribute, WaitForSingleObject,
        PROCESS_INFORMATION, STARTUPINFOEXW, STARTUPINFOW,
    };

    fn sandbox_diag(msg: impl std::fmt::Display) {
        if std::env::var_os("LIVEAGENT_SANDBOX_LOG").is_some() {
            eprintln!("{msg}");
        }
    }

    // 以本地常量代替对 windows-sys 各 feature 常量导出的依赖:字段类型均为整型别名
    // (windows-sys 用 type alias 而非 newtype),直接赋整型字面量即可,极大降低
    // “某常量是否在某 feature 下导出”的编译风险。数值均取自 Win32 头文件。
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_DUPLICATE: u32 = 0x0002;
    const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
    const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;

    #[cfg(test)]
    const DISABLE_MAX_PRIVILEGE: u32 = 0x1;
    #[cfg(test)]
    const LUA_TOKEN: u32 = 0x4;
    #[cfg(test)]
    const WRITE_RESTRICTED: u32 = 0x8;

    const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
    const TOKEN_GROUPS_CLASS: i32 = 2; // TOKEN_INFORMATION_CLASS::TokenGroups
    const TOKEN_USER_CLASS: i32 = 1; // TokenUser
    const TOKEN_DEFAULT_DACL_CLASS: i32 = 6; // TOKEN_INFORMATION_CLASS::TokenDefaultDacl
    const TOKEN_INTEGRITY_LEVEL_CLASS: i32 = 25; // TokenIntegrityLevel

    const SE_FILE_OBJECT: i32 = 1; // SE_OBJECT_TYPE
    const SE_REGISTRY_KEY: i32 = 4;
    const SE_KERNEL_OBJECT: i32 = 6;
    const READ_CONTROL: u32 = 0x0002_0000;
    const WRITE_DAC: u32 = 0x0004_0000;
    const WRITE_OWNER: u32 = 0x0008_0000;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const DIRECTORY_QUERY: u32 = 0x1;
    const DIRECTORY_TRAVERSE: u32 = 0x2;
    const DIRECTORY_CREATE_OBJECT: u32 = 0x4;
    const DIRECTORY_CREATE_SUBDIRECTORY: u32 = 0x8;
    const DIRECTORY_ALL_ACCESS: u32 = 0x000F_000F;
    const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
    const OBJ_OPENIF: u32 = 0x0000_0080;
    const KEY_READ: u32 = 0x0002_0019;
    const KEY_WRITE: u32 = 0x0002_0006;
    const KEY_ALL_ACCESS: u32 = 0x000F_003F;
    const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    #[cfg(test)]
    const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;
    const LABEL_SECURITY_INFORMATION: u32 = 0x0000_0010;
    const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;
    const OBJECT_INHERIT_ACE: u32 = 0x1;
    const CONTAINER_INHERIT_ACE: u32 = 0x2;
    const GRANT_ACCESS: i32 = 1; // ACCESS_MODE
    const REVOKE_ACCESS: i32 = 4;
    const TRUSTEE_IS_SID: i32 = 0; // TRUSTEE_FORM
    const TRUSTEE_IS_UNKNOWN: i32 = 0; // TRUSTEE_TYPE
    const ACL_SIZE_INFORMATION_CLASS: i32 = 2; // ACL_INFORMATION_CLASS::AclSizeInformation
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACL_REVISION: u32 = 2;
    const GENERIC_ALL: u32 = 0x1000_0000;
    const SE_GROUP_ENABLED: u32 = 0x0000_0004;

    // 文件访问权掩码(标准值);DELETE 本地定义以回避导入位置歧义。
    const FILE_GENERIC_READ: u32 = 0x0012_0089;
    const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
    const FILE_GENERIC_EXECUTE: u32 = 0x0012_00A0;
    const DELETE_RIGHT: u32 = 0x0001_0000;

    const HANDLE_FLAG_INHERIT: u32 = 0x1;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6; // (DWORD)-10
    const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5; // -11
    const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4; // -12

    // ProcThreadAttribute 常量:低 16 位是序号,高位是标志(值取自 WinBase.h 的
    // ProcThreadAttributeValue 宏展开)。HANDLE_LIST=0x00020002、SECURITY_CAPABILITIES=0x00020009。
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
    const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;
    // ProcThreadAttributeBnoIsolation = 19, Input 标志 ⇒ 0x00020013。把 Win32
    // Local\ 名字重定向到进程私有前缀;MSYS 直调 NtCreateDirectoryObject 不受影响。
    const PROC_THREAD_ATTRIBUTE_BNO_ISOLATION: usize = 0x0002_0013;

    #[repr(C)]
    struct ProcessBnoIsolationAttribute {
        isolation_enabled: i32,
        isolation_prefix: [u16; 136],
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS: i32 = 9; // JobObjectExtendedLimitInformation

    #[cfg(test)]
    const WRITE_RESTRICTED_SID: &str = "S-1-5-33";
    const LOW_INTEGRITY_SID: &str = "S-1-16-4096";
    const LOW_INTEGRITY_SDDL: &str = "S:(ML;OICI;NW;;;LW)";

    // loader 早期失败的 NTSTATUS 退出码——子进程根本没进 main 就被内核/加载器杀死。
    // 用于把裸退出码翻成可读诊断(见 loader_failure_hint)。
    const STATUS_DLL_INIT_FAILED: u32 = 0xC000_0142;
    const STATUS_DLL_NOT_FOUND: u32 = 0xC000_0135;
    const STATUS_ACCESS_DENIED: u32 = 0xC000_0022;
    // CLR 未处理异常:PowerShell 把 CNG `NTE_PROVIDER_DLL_FAIL` 包装成“BCrypt 加载失败”
    // 后以此码退出。不是 NTSTATUS,shell 探测原先漏掉它,会把已崩溃的 pwsh 当成可用。
    const CLR_UNHANDLED_EXCEPTION: u32 = 0xE043_4352;
    const NTE_PROVIDER_DLL_FAIL: u32 = 0x8009_001D;
    // HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED):Windows PowerShell / .NET Framework
    // 写 CLR 用户缓存失败时的直接退出码,与上面的 CLR 包装码不是同一条路径。
    const E_ACCESSDENIED: u32 = 0x8007_0005;
    // powershell.exe 宿主在 CLR 初始化失败时不回传 HRESULT,而是用这个包装码。
    const POWERSHELL_CLR_INIT_FAILED: u32 = 0xFFFF_0000;

    /// PSID 别名(windows-sys 里就是 `*mut c_void`),提升可读性。
    type PSID = *mut c_void;

    // windows-sys 0.61 的 FFI 布尔返回是 `windows_sys::core::BOOL`(= i32);此处直接
    // 用 i32 作参数(透明别名,可接收所有这些函数的返回)。
    #[inline]
    fn ok(b: i32) -> bool {
        b != 0
    }

    fn last_error(ctx: &str) -> String {
        let code = unsafe { GetLastError() };
        format!("{ctx} (GetLastError={code})")
    }

    /// str → 以 NUL 结尾的 UTF-16。
    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// ConvertStringSidToSidW 分配的 SID,Drop 时 LocalFree。
    struct LocalSid(PSID);

    impl Drop for LocalSid {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0 as _);
                }
            }
        }
    }

    /// `DeriveCapabilitySidsFromName` 同时分配 SID 指针数组和每个 SID；两层都须
    /// `LocalFree`。只在派生期间持有，随后把目标 SID 复制进 Rust 自持缓冲。
    struct LocalSidArray {
        ptr: *mut PSID,
        count: u32,
    }

    impl Drop for LocalSidArray {
        fn drop(&mut self) {
            unsafe {
                if !self.ptr.is_null() {
                    for index in 0..self.count as usize {
                        let sid = *self.ptr.add(index);
                        if !sid.is_null() {
                            LocalFree(sid as _);
                        }
                    }
                    LocalFree(self.ptr as _);
                }
            }
        }
    }

    fn string_to_sid(s: &str) -> Result<LocalSid, String> {
        let wide = to_wide(s);
        let mut sid: PSID = null_mut();
        let r = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if !ok(r) || sid.is_null() {
            return Err(last_error(&format!("ConvertStringSidToSidW({s})")));
        }
        Ok(LocalSid(sid))
    }

    fn sddl_to_sd(sddl: &str) -> Result<*mut c_void, String> {
        let wide = to_wide(sddl);
        let mut sd: *mut c_void = null_mut();
        let r = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut sd,
                null_mut(),
            )
        };
        if !ok(r) || sd.is_null() {
            return Err(last_error(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
            ));
        }
        Ok(sd)
    }

    fn with_low_integrity_sacl<T>(
        f: impl FnOnce(*mut ACL) -> Result<T, String>,
    ) -> Result<T, String> {
        let sd = sddl_to_sd(LOW_INTEGRITY_SDDL)?;
        let result = unsafe {
            let mut present: i32 = 0;
            let mut sacl: *mut ACL = null_mut();
            let mut defaulted: i32 = 0;
            if !ok(GetSecurityDescriptorSacl(
                sd,
                &mut present,
                &mut sacl,
                &mut defaulted,
            )) || sacl.is_null()
            {
                LocalFree(sd as _);
                return Err(last_error("GetSecurityDescriptorSacl(low integrity)"));
            }
            f(sacl)
        };
        unsafe {
            LocalFree(sd as _);
        }
        result
    }

    /// 联网子进程保留当前用户的完整网络/登录会话能力，因此用 Low IL + NoWriteUp
    /// 拦住 Medium 的 home、盘符根和工作区父目录；工作区与围栏 TEMP 标 Low 后仍可写。
    fn set_token_low_integrity(token: HANDLE) -> Result<(), String> {
        let sid = string_to_sid(LOW_INTEGRITY_SID)?;
        let mut label = SID_AND_ATTRIBUTES {
            Sid: sid.0,
            Attributes: SE_GROUP_INTEGRITY,
        };
        let r = unsafe {
            SetTokenInformation(
                token,
                TOKEN_INTEGRITY_LEVEL_CLASS,
                &mut label as *mut _ as *mut c_void,
                std::mem::size_of::<SID_AND_ATTRIBUTES>() as u32,
            )
        };
        if !ok(r) {
            return Err(last_error("SetTokenInformation(TokenIntegrityLevel=Low)"));
        }
        Ok(())
    }

    fn set_low_integrity_label(object_type: i32, name: &str) -> Result<u32, String> {
        let mut path_wide = to_wide(name);
        with_low_integrity_sacl(|sacl| unsafe {
            Ok(SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                object_type,
                LABEL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                sacl,
            ))
        })
    }

    /// Mandatory Label 属于 SACL,但 `LABEL_SECURITY_INFORMATION` 的访问检查要求
    /// `WRITE_OWNER`;对象 owner 只隐式拥有 READ_CONTROL/WRITE_DAC,普通的 Modify DACL
    /// 因而会返回 ERROR_ACCESS_DENIED。只在该错误上给启动器用户补最小 WRITE_OWNER
    /// ACE 后重试,无需管理员/UAC,也不把其它标签/API 错误误判成 ACL 问题。
    fn ensure_low_integrity_label(
        object_type: i32,
        name: &str,
        launcher_user_sid: PSID,
    ) -> Result<(), String> {
        let first = set_low_integrity_label(object_type, name)?;
        if first == 0 {
            return Ok(());
        }
        if first != ERROR_ACCESS_DENIED {
            return Err(format!(
                "SetNamedSecurityInfoW(low IL, {name}) failed (error={first})"
            ));
        }

        ensure_named_write_ace(object_type, name, launcher_user_sid, WRITE_OWNER).map_err(
            |grant_err| {
                format!(
                    "SetNamedSecurityInfoW(low IL, {name}) failed (error={first}); \
                     granting WRITE_OWNER to the launcher user also failed: {grant_err}"
                )
            },
        )?;
        let retry = set_low_integrity_label(object_type, name)?;
        if retry != 0 {
            return Err(format!(
                "SetNamedSecurityInfoW(low IL, {name}) failed after granting WRITE_OWNER \
                 (initial error={first}, retry error={retry})"
            ));
        }
        Ok(())
    }

    fn stamp_low_integrity_tree(path: &Path, launcher_user_sid: PSID) {
        for entry in walkdir::WalkDir::new(path).into_iter().flatten() {
            let name = entry.path().to_string_lossy();
            if let Err(err) = ensure_low_integrity_label(SE_FILE_OBJECT, &name, launcher_user_sid) {
                sandbox_diag(format!("liveagent sandbox: low IL skipped ({name}): {err}"));
            }
        }
    }

    fn set_handle_low_integrity(handle: HANDLE, label: &str) {
        let invalid: HANDLE = usize::MAX as HANDLE;
        if handle.is_null() || handle == invalid {
            return;
        }
        let _ = with_low_integrity_sacl(|sacl| {
            let rc = unsafe {
                SetSecurityInfo(
                    handle,
                    SE_KERNEL_OBJECT,
                    LABEL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    sacl,
                )
            };
            if rc != 0 {
                sandbox_diag(format!(
                    "liveagent sandbox: std handle low IL skipped ({label}): error={rc}"
                ));
            }
            Ok(())
        });
    }

    fn looks_like_powershell(program: &Path) -> bool {
        let name = program.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name.eq_ignore_ascii_case("powershell.exe") || name.eq_ignore_ascii_case("pwsh.exe")
    }

    fn ensure_runtime_low_integrity_surface(
        write_root: &Path,
        temp: &Path,
        program: &Path,
        launcher_user_sid: PSID,
    ) {
        stamp_low_integrity_tree(write_root, launcher_user_sid);
        if let Err(err) =
            ensure_low_integrity_label(SE_FILE_OBJECT, &temp.to_string_lossy(), launcher_user_sid)
        {
            sandbox_diag(format!(
                "liveagent sandbox: TEMP low IL skipped ({temp:?}): {err}"
            ));
        }
        if !looks_like_powershell(program) {
            return;
        }
        use crate::runtime::sandbox::{
            clr_user_file_dirs, cng_named_registry_object, cng_user_file_dirs,
            CLR_USER_REGISTRY_SUBKEYS, CNG_USER_REGISTRY_SUBKEYS,
        };
        for subkey in CNG_USER_REGISTRY_SUBKEYS
            .iter()
            .chain(CLR_USER_REGISTRY_SUBKEYS)
        {
            let name = cng_named_registry_object(subkey);
            if let Err(err) = ensure_low_integrity_label(SE_REGISTRY_KEY, &name, launcher_user_sid)
            {
                sandbox_diag(format!(
                    "liveagent sandbox: registry low IL skipped ({name}): {err}"
                ));
            }
        }
        let (Some(appdata), Some(local)) = (dirs::data_dir(), dirs::data_local_dir()) else {
            return;
        };
        for dir in cng_user_file_dirs(&appdata, &local)
            .into_iter()
            .chain(clr_user_file_dirs(&appdata, &local))
        {
            if let Err(err) = ensure_low_integrity_label(
                SE_FILE_OBJECT,
                &dir.to_string_lossy(),
                launcher_user_sid,
            ) {
                sandbox_diag(format!(
                    "liveagent sandbox: runtime dir low IL skipped ({dir:?}): {err}"
                ));
            }
        }
    }

    /// 打开当前进程的主令牌；附带 DUPLICATE / ASSIGN_PRIMARY / ADJUST_DEFAULT，
    /// 供联网后端复制主令牌并设置 Low IL。
    fn open_process_token() -> Result<HANDLE, String> {
        let mut token: HANDLE = null_mut();
        let access = TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT;
        let r = unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) };
        if !ok(r) {
            return Err(last_error("OpenProcessToken"));
        }
        Ok(token)
    }

    /// 从令牌 TokenGroups 里读出登录 SID(SE_GROUP_LOGON_ID),复制成自持字节缓冲。
    fn logon_sid_bytes(token: HANDLE) -> Result<Vec<u8>, String> {
        let mut len: u32 = 0;
        // 首次调用取所需长度(预期失败并置 len)。
        unsafe { GetTokenInformation(token, TOKEN_GROUPS_CLASS, null_mut(), 0, &mut len) };
        if len == 0 {
            return Err(last_error("GetTokenInformation(TokenGroups) size probe"));
        }
        // 用 u64 缓冲保证 8 字节对齐(TOKEN_GROUPS 含指针,Vec<u8> 不保证对齐)。
        let mut buf: Vec<u64> = vec![0u64; ((len as usize) + 7) / 8];
        let r = unsafe {
            GetTokenInformation(
                token,
                TOKEN_GROUPS_CLASS,
                buf.as_mut_ptr() as *mut c_void,
                len,
                &mut len,
            )
        };
        if !ok(r) {
            return Err(last_error("GetTokenInformation(TokenGroups)"));
        }
        unsafe {
            let groups = buf.as_ptr() as *const TOKEN_GROUPS;
            let count = (*groups).GroupCount;
            let arr = (*groups).Groups.as_ptr();
            for i in 0..count as usize {
                let entry: &SID_AND_ATTRIBUTES = &*arr.add(i);
                if entry.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID {
                    let sid_len = GetLengthSid(entry.Sid);
                    if sid_len == 0 {
                        return Err(last_error("GetLengthSid(logon sid)"));
                    }
                    let mut sid_buf = vec![0u8; sid_len as usize];
                    if !ok(CopySid(sid_len, sid_buf.as_mut_ptr() as PSID, entry.Sid)) {
                        return Err(last_error("CopySid(logon sid)"));
                    }
                    return Ok(sid_buf);
                }
            }
        }
        Err("logon SID (SE_GROUP_LOGON_ID) not present in token".to_string())
    }

    fn token_user_sid_bytes(token: HANDLE) -> Result<Vec<u8>, String> {
        let mut len: u32 = 0;
        unsafe { GetTokenInformation(token, TOKEN_USER_CLASS, null_mut(), 0, &mut len) };
        if len == 0 {
            return Err(last_error("GetTokenInformation(TokenUser) size probe"));
        }
        let mut buf: Vec<u64> = vec![0u64; ((len as usize) + 7) / 8];
        let r = unsafe {
            GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                buf.as_mut_ptr() as *mut c_void,
                len,
                &mut len,
            )
        };
        if !ok(r) {
            return Err(last_error("GetTokenInformation(TokenUser)"));
        }
        unsafe {
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let sid_len = GetLengthSid(user.User.Sid);
            if sid_len == 0 {
                return Err(last_error("GetLengthSid(token user)"));
            }
            let mut sid_buf = vec![0u8; sid_len as usize];
            if !ok(CopySid(
                sid_len,
                sid_buf.as_mut_ptr() as PSID,
                user.User.Sid,
            )) {
                return Err(last_error("CopySid(token user)"));
            }
            Ok(sid_buf)
        }
    }

    /// 用 {登录 SID, S-1-5-33, 合成 SID} 作限制性 SID,建 WRITE_RESTRICTED 主令牌。
    #[cfg(test)]
    fn create_restricted_token(base: HANDLE, restricting: &[PSID]) -> Result<HANDLE, String> {
        let mut sids: Vec<SID_AND_ATTRIBUTES> = restricting
            .iter()
            .map(|&sid| SID_AND_ATTRIBUTES {
                Sid: sid,
                Attributes: 0,
            })
            .collect();
        let mut restricted: HANDLE = null_mut();
        let flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
        let r = unsafe {
            CreateRestrictedToken(
                base,
                flags,
                0,
                null(),
                0,
                null(),
                sids.len() as u32,
                sids.as_mut_ptr(),
                &mut restricted,
            )
        };
        if !ok(r) {
            return Err(last_error("CreateRestrictedToken"));
        }
        Ok(restricted)
    }

    fn duplicate_primary_token(base: HANDLE) -> Result<HANDLE, String> {
        let mut token: HANDLE = null_mut();
        let access = TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT;
        let r = unsafe {
            DuplicateTokenEx(
                base,
                access,
                null(),
                2, // SecurityImpersonation
                1, // TokenPrimary
                &mut token,
            )
        };
        if !ok(r) {
            return Err(last_error("DuplicateTokenEx(TokenPrimary)"));
        }
        if ok(unsafe { IsTokenRestricted(token) }) {
            unsafe {
                CloseHandle(token);
            }
            return Err(
                "DuplicateTokenEx unexpectedly returned a restricted token; HTTPS credentials \
                 would be unavailable"
                    .to_string(),
            );
        }
        Ok(token)
    }

    /// 向令牌的 default DACL 追加「登录 SID 全权」ACE。
    ///
    /// 子进程新建的内核对象(msys/cygwin 共享内存、signal pipe、事件等)套用该 DACL；
    /// 登录 SID 让同一登录会话稳定重开这些对象。GENERIC_ALL 只作用于“该进程自建”
    /// 的对象,不放宽文件写围栏。
    fn append_sid_to_default_dacl(token: HANDLE, sid: PSID) -> Result<(), String> {
        const ACL_APPEND_AT_END: u32 = 0xFFFF_FFFF; // MAXDWORD ⇒ AddAce 追加到尾部
        unsafe {
            let mut len: u32 = 0;
            GetTokenInformation(token, TOKEN_DEFAULT_DACL_CLASS, null_mut(), 0, &mut len);
            if len == 0 {
                return Err(last_error(
                    "GetTokenInformation(TokenDefaultDacl) size probe",
                ));
            }
            let mut buf: Vec<u64> = vec![0u64; ((len as usize) + 7) / 8];
            if !ok(GetTokenInformation(
                token,
                TOKEN_DEFAULT_DACL_CLASS,
                buf.as_mut_ptr() as *mut c_void,
                len,
                &mut len,
            )) {
                return Err(last_error("GetTokenInformation(TokenDefaultDacl)"));
            }
            let old_dacl = (*(buf.as_ptr() as *const TOKEN_DEFAULT_DACL)).DefaultDacl;
            // NULL default DACL ⇒ 新对象无保护(everyone 全权),两遍判定天然皆过,无需追加。
            if old_dacl.is_null() {
                return Ok(());
            }

            let mut info = ACL_SIZE_INFORMATION {
                AceCount: 0,
                AclBytesInUse: 0,
                AclBytesFree: 0,
            };
            if !ok(GetAclInformation(
                old_dacl,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                ACL_SIZE_INFORMATION_CLASS,
            )) {
                return Err(last_error("GetAclInformation(default DACL)"));
            }
            let sid_len = GetLengthSid(sid);
            if sid_len == 0 {
                return Err(last_error("GetLengthSid(default DACL trustee)"));
            }
            // ACCESS_ALLOWED_ACE 自带一个 u32 的 SidStart 占位,故净增 = 结构长 - 4 + SID 长;
            // SID 长恒为 4 的倍数,天然满足 ACL 的 DWORD 对齐。
            let ace_len = std::mem::size_of::<ACCESS_ALLOWED_ACE>() as u32 - 4 + sid_len;
            let new_len = ((info.AclBytesInUse + ace_len) + 3) & !3;

            let mut new_buf: Vec<u64> = vec![0u64; ((new_len as usize) + 7) / 8];
            let new_acl = new_buf.as_mut_ptr() as *mut ACL;
            if !ok(InitializeAcl(new_acl, new_len, ACL_REVISION)) {
                return Err(last_error("InitializeAcl(default DACL)"));
            }
            // 原 ACE 顺序照抄(default DACL 全为 allow ACE,顺序无语义,仍保守保序)。
            for i in 0..info.AceCount {
                let mut ace: *mut c_void = null_mut();
                if !ok(GetAce(old_dacl, i, &mut ace)) || ace.is_null() {
                    return Err(last_error("GetAce(default DACL)"));
                }
                let size = (*(ace as *const ACE_HEADER)).AceSize as u32;
                if !ok(AddAce(new_acl, ACL_REVISION, ACL_APPEND_AT_END, ace, size)) {
                    return Err(last_error("AddAce(copy default DACL)"));
                }
            }
            if !ok(AddAccessAllowedAce(new_acl, ACL_REVISION, GENERIC_ALL, sid)) {
                return Err(last_error("AddAccessAllowedAce(logon sid)"));
            }
            let tdd = TOKEN_DEFAULT_DACL {
                DefaultDacl: new_acl,
            };
            // SetTokenInformation 把 DACL 拷贝进令牌,new_buf 随后释放无碍。
            if !ok(SetTokenInformation(
                token,
                TOKEN_DEFAULT_DACL_CLASS,
                &tdd as *const _ as *const c_void,
                std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )) {
                return Err(last_error("SetTokenInformation(TokenDefaultDacl)"));
            }
        }
        Ok(())
    }

    /// AppContainer SID(FreeSid 释放,区别于 LocalSid 的 LocalFree)。
    struct AcSid(PSID);

    impl Drop for AcSid {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    FreeSid(self.0);
                }
            }
        }
    }

    /// AC profile 名:确定性、每工作区一个。硬限制 64 字符:前缀 18 + dir_key ≤ 43
    /// (4 段 u32 十进制,下划线连接)= ≤ 61;字符集 [0-9A-Za-z._] 合法。
    fn appcontainer_profile_name(dir_key: &str) -> String {
        format!("LiveAgent.Sandbox.{dir_key}")
    }

    /// 私有 capability 仅作为文件/注册表 ACL 的工作区身份,不对应任何 Windows
    /// 网络 capability。名字与工作区确定性绑定,因此不同工作区互不可写。
    fn workspace_capability_name(dir_key: &str) -> String {
        format!("LiveAgent.Workspace.{dir_key}")
    }

    fn workspace_capability_sid(dir_key: &str) -> Result<Vec<u8>, String> {
        let name = workspace_capability_name(dir_key);
        let name_w = to_wide(&name);
        let mut group_ptr: *mut PSID = null_mut();
        let mut group_count = 0u32;
        let mut capability_ptr: *mut PSID = null_mut();
        let mut capability_count = 0u32;
        let derived = unsafe {
            DeriveCapabilitySidsFromName(
                name_w.as_ptr(),
                &mut group_ptr,
                &mut group_count,
                &mut capability_ptr,
                &mut capability_count,
            )
        };
        let _groups = LocalSidArray {
            ptr: group_ptr,
            count: group_count,
        };
        let capabilities = LocalSidArray {
            ptr: capability_ptr,
            count: capability_count,
        };
        if !ok(derived) {
            return Err(last_error(&format!("DeriveCapabilitySidsFromName({name})")));
        }
        if capabilities.ptr.is_null() || capabilities.count == 0 {
            return Err(format!(
                "DeriveCapabilitySidsFromName({name}) returned no capability SID"
            ));
        }
        unsafe {
            let sid = *capabilities.ptr;
            if sid.is_null() {
                return Err(format!(
                    "DeriveCapabilitySidsFromName({name}) returned a null capability SID"
                ));
            }
            let sid_len = GetLengthSid(sid);
            if sid_len == 0 {
                return Err(last_error("GetLengthSid(workspace capability)"));
            }
            let mut copied = vec![0u8; sid_len as usize];
            if !ok(CopySid(sid_len, copied.as_mut_ptr() as PSID, sid)) {
                return Err(last_error("CopySid(workspace capability)"));
            }
            Ok(copied)
        }
    }

    fn derive_appcontainer_profile_sid(dir_key: &str) -> Result<AcSid, String> {
        let name = appcontainer_profile_name(dir_key);
        let name_w = to_wide(&name);
        let mut sid: PSID = null_mut();
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid) };
        if derived == 0 && !sid.is_null() {
            Ok(AcSid(sid))
        } else {
            Err(format!(
                "DeriveAppContainerSidFromAppContainerName({name}) failed hr={derived:#010X}"
            ))
        }
    }

    /// 取(必要时创建)工作区专属 AppContainer profile 的 SID。
    ///
    /// Profile 本身不注册任何 capability；启动时只注入私有工作区 capability,
    /// 不注入网络 capability,所以 WFP 仍默认拒绝全部网络含 loopback。Create 失败
    /// (典型:已存在)即走 Derive;二者都失败才报错(fail-closed)。Profile 留存不删。
    fn appcontainer_profile_sid(dir_key: &str) -> Result<AcSid, String> {
        let name = appcontainer_profile_name(dir_key);
        let name_w = to_wide(&name);
        let display_w = to_wide("LiveAgent Sandbox (offline)");
        let desc_w = to_wide("LiveAgent per-workspace offline sandbox");
        let mut sid: PSID = null_mut();
        let created = unsafe {
            CreateAppContainerProfile(
                name_w.as_ptr(),
                display_w.as_ptr(),
                desc_w.as_ptr(),
                null(), // 零 capability
                0,
                &mut sid,
            )
        };
        if created == 0 && !sid.is_null() {
            return Ok(AcSid(sid));
        }
        derive_appcontainer_profile_sid(dir_key).map_err(|derive_err| {
            format!(
                "AppContainer profile unavailable: CreateAppContainerProfile hr={created:#010X}; \
                 {derive_err}"
            )
        })
    }

    #[cfg(test)]
    pub(super) fn workspace_capability_sid_for_test(dir_key: &str) -> Result<String, String> {
        let sid = workspace_capability_sid(dir_key)?;
        sid_string(sid.as_ptr() as PSID)
    }

    #[cfg(test)]
    pub(super) fn seed_legacy_appcontainer_ace_for_test(
        path: &Path,
        dir_key: &str,
    ) -> Result<(), String> {
        let sid = derive_appcontainer_profile_sid(dir_key)?;
        ensure_write_ace(path, sid.0)
    }

    /// 测试钩子:按名字纯派生 AC SID 并转成字符串形式(不创建 profile,无系统副作用)。
    #[cfg(test)]
    pub(super) fn appcontainer_profile_sid_for_test(name: &str) -> Option<String> {
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
        let name_w = to_wide(name);
        let mut sid: PSID = null_mut();
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid) };
        if derived != 0 || sid.is_null() {
            return None;
        }
        let sid = AcSid(sid); // RAII:FreeSid
        let mut s: *mut u16 = null_mut();
        let r = unsafe { ConvertSidToStringSidW(sid.0, &mut s) };
        if !ok(r) || s.is_null() {
            return None;
        }
        let mut len = 0usize;
        unsafe {
            while *s.add(len) != 0 {
                len += 1;
            }
            let out = String::from_utf16_lossy(std::slice::from_raw_parts(s, len));
            LocalFree(s as _);
            Some(out)
        }
    }

    /// 测试钩子(真机):建受限令牌 → 追加登录 SID 到 default DACL → 读回验证 ACE
    /// 确实存在(0xC0000142 修复的可断言部分)。返回 (追加前含登录 SID, 追加后含)。
    #[cfg(test)]
    pub(super) fn default_dacl_fix_roundtrip_for_test() -> Result<(bool, bool), String> {
        fn dacl_contains(token: HANDLE, sid: PSID) -> Result<bool, String> {
            unsafe {
                let mut len: u32 = 0;
                GetTokenInformation(token, TOKEN_DEFAULT_DACL_CLASS, null_mut(), 0, &mut len);
                if len == 0 {
                    return Err(last_error("GetTokenInformation(TokenDefaultDacl) probe"));
                }
                let mut buf: Vec<u64> = vec![0u64; ((len as usize) + 7) / 8];
                if !ok(GetTokenInformation(
                    token,
                    TOKEN_DEFAULT_DACL_CLASS,
                    buf.as_mut_ptr() as *mut c_void,
                    len,
                    &mut len,
                )) {
                    return Err(last_error("GetTokenInformation(TokenDefaultDacl)"));
                }
                let dacl = (*(buf.as_ptr() as *const TOKEN_DEFAULT_DACL)).DefaultDacl;
                if dacl.is_null() {
                    return Ok(false);
                }
                let mut info = ACL_SIZE_INFORMATION {
                    AceCount: 0,
                    AclBytesInUse: 0,
                    AclBytesFree: 0,
                };
                if !ok(GetAclInformation(
                    dacl,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                    ACL_SIZE_INFORMATION_CLASS,
                )) {
                    return Err(last_error("GetAclInformation(TokenDefaultDacl)"));
                }
                for i in 0..info.AceCount {
                    let mut ace: *mut c_void = null_mut();
                    if !ok(GetAce(dacl, i, &mut ace)) || ace.is_null() {
                        continue;
                    }
                    if (*(ace as *const ACE_HEADER)).AceType == ACCESS_ALLOWED_ACE_TYPE {
                        let allow = ace as *const ACCESS_ALLOWED_ACE;
                        let sid_ptr = &(*allow).SidStart as *const u32 as PSID;
                        if ok(EqualSid(sid_ptr, sid)) {
                            return Ok(true);
                        }
                    }
                }
                Ok(false)
            }
        }

        let synthetic = string_to_sid("S-1-5-21-1-2-3-4")?;
        let write_restricted = string_to_sid(WRITE_RESTRICTED_SID)?;
        let token = OwnedHandle(open_process_token()?);
        let logon = logon_sid_bytes(token.0)?;
        let logon_ptr = logon.as_ptr() as PSID;
        let restricting: [PSID; 3] = [logon_ptr, write_restricted.0, synthetic.0];
        let rt = OwnedHandle(create_restricted_token(token.0, &restricting)?);
        let before = dacl_contains(rt.0, logon_ptr)?;
        append_sid_to_default_dacl(rt.0, logon_ptr)?;
        let after = dacl_contains(rt.0, logon_ptr)?;
        Ok((before, after))
    }

    /// CloseHandle RAII:错误提前返回时不再需要手工逐支关闭。
    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    /// ProcThreadAttributeList RAII(两段式分配;Drop 时 Delete)。
    ///
    /// 注意生命周期契约:经 `set` 挂上的 value 指针必须存活到本对象 Drop(MSDN 对
    /// UpdateProcThreadAttribute 的要求)——调用方须把 value 声明在本对象**之前**
    /// (Rust 局部量逆序析构 ⇒ 本对象先于 value 析构)。
    struct AttrList {
        buf: Vec<u64>, // u64 保证 8 字节对齐
    }

    impl AttrList {
        fn new(count: u32) -> Result<Self, String> {
            let mut size: usize = 0;
            unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size) };
            if size == 0 {
                return Err(last_error("InitializeProcThreadAttributeList size probe"));
            }
            let mut buf: Vec<u64> = vec![0u64; (size + 7) / 8];
            let r = unsafe {
                InitializeProcThreadAttributeList(
                    buf.as_mut_ptr() as *mut c_void,
                    count,
                    0,
                    &mut size,
                )
            };
            if !ok(r) {
                return Err(last_error("InitializeProcThreadAttributeList"));
            }
            Ok(Self { buf })
        }

        fn ptr(&mut self) -> *mut c_void {
            self.buf.as_mut_ptr() as *mut c_void
        }

        fn set(
            &mut self,
            attribute: usize,
            value: *const c_void,
            size: usize,
            ctx: &str,
        ) -> Result<(), String> {
            let r = unsafe {
                UpdateProcThreadAttribute(self.ptr(), 0, attribute, value, size, null_mut(), null())
            };
            if !ok(r) {
                return Err(last_error(ctx));
            }
            Ok(())
        }
    }

    impl Drop for AttrList {
        fn drop(&mut self) {
            unsafe { DeleteProcThreadAttributeList(self.buf.as_mut_ptr() as *mut c_void) };
        }
    }

    /// 子进程 loader 早期死亡(未进 main)的 NTSTATUS 退出码 → 可读诊断(中英双语,
    /// 经 stderr 走既有管道上传给模型/UI;裸退出码对用户与模型都不可行动)。
    fn loader_failure_hint(exit_code: u32) -> Option<&'static str> {
        match exit_code {
            STATUS_DLL_INIT_FAILED => Some(
                "a DLL failed to initialize under the sandbox (STATUS_DLL_INIT_FAILED); \
                 MSYS/Cygwin-based tools (e.g. Git Bash) may be incompatible here and the shell \
                 runner will try the next shell candidate / 沙箱内有 DLL 初始化失败(0xC0000142):\
                 MSYS/Cygwin 系工具(如 Git Bash)可能与该沙箱不兼容,shell 将自动尝试下一候选",
            ),
            STATUS_DLL_NOT_FOUND => Some(
                "a required DLL was not found under the sandbox (STATUS_DLL_NOT_FOUND); the tool's \
                 install directory may be unreadable in this mode / 沙箱内找不到所需 DLL(0xC0000135):\
                 该工具的安装目录在此模式下可能不可读",
            ),
            STATUS_ACCESS_DENIED => Some(
                "the sandbox denied access while starting the process (STATUS_ACCESS_DENIED); the \
                 program or its directory is not readable in this mode / 沙箱拒绝了进程启动所需的访问\
                 (0xC0000022):该程序或其目录在此模式下不可读",
            ),
            CLR_UNHANDLED_EXCEPTION | NTE_PROVIDER_DLL_FAIL => Some(
                "the runtime failed during crypto provider init under the sandbox token \
                 (CLR 0xE0434352 / NTE_PROVIDER_DLL_FAIL); this is usually HKCU certificate-store \
                 or %APPDATA%\\Microsoft\\Crypto being unwritable, not a broken BCrypt.dll. The \
                 shell runner will try the next candidate / 沙箱内加密提供程序初始化失败(0xE0434352):\
                 通常是用户证书库或 Crypto 目录不可写,并非本机 pwsh/BCrypt.dll 损坏,shell 将尝试下一候选",
            ),
            E_ACCESSDENIED | POWERSHELL_CLR_INIT_FAILED => Some(
                "the runtime was denied a write during CLR/PowerShell startup \
                 (HRESULT 0x80070005 E_ACCESSDENIED / exit 0xFFFF0000); this is usually \
                 the user CLR cache or PowerShell module-analysis directory being \
                  unwritable at Low Integrity, not a broken powershell.exe. \
                 The shell runner will try the next candidate / 沙箱内 CLR/PowerShell \
                 启动时写被拒绝(0x80070005 / 0xFFFF0000):通常是用户 CLR 缓存或 \
                 PowerShell 模块分析目录不可写,并非本机 powershell.exe 损坏,shell 将尝试下一候选",
            ),
            _ => None,
        }
    }

    /// 断网沙箱的 env 叠加(防御纵深,对齐 Codex):内核级 WFP 阻断之上,让常见工具
    /// 不必等 TCP 失败,直接按各自的 offline/代理约定快速、明确地报错。黑洞代理指向
    /// 127.0.0.1:9(discard 端口,无监听;AC 内 loopback 本就被拒)。
    /// 设置在启动器自身环境上,经 lpEnvironment=NULL 的继承传给子进程(与 TEMP 重定向同路)。
    fn set_offline_env() -> Result<(), String> {
        const BLACKHOLE: &str = "http://127.0.0.1:9";
        let pairs: &[(&str, &str)] = &[
            ("HTTP_PROXY", BLACKHOLE),
            ("HTTPS_PROXY", BLACKHOLE),
            ("ALL_PROXY", BLACKHOLE),
            ("NO_PROXY", ""), // 清空例外表,黑洞代理不留旁路(Windows env 大小写不敏感,亦覆盖小写变体)
            ("CARGO_NET_OFFLINE", "true"),
            ("PIP_NO_INDEX", "1"),
            ("NPM_CONFIG_OFFLINE", "true"),
        ];
        for (name, value) in pairs {
            let name_w = to_wide(name);
            let value_w = to_wide(value);
            unsafe {
                if !ok(SetEnvironmentVariableW(name_w.as_ptr(), value_w.as_ptr())) {
                    return Err(last_error(&format!("SetEnvironmentVariableW({name})")));
                }
            }
        }
        Ok(())
    }

    /// 命名对象 DACL 上是否已有受托 SID 且权限位足够的 ACE。命中即认为已盖章
    /// (可继承 ACE 会自动传播到后建的子对象),跳过昂贵的重新传播。任何探测失败
    /// 按“未盖章”处理。
    fn named_has_ace(object_type: i32, path_wide: &[u16], sid: PSID, required_access: u32) -> bool {
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 || dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return false;
            }
            let mut info = ACL_SIZE_INFORMATION {
                AceCount: 0,
                AclBytesInUse: 0,
                AclBytesFree: 0,
            };
            let mut found = false;
            if ok(GetAclInformation(
                dacl,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                ACL_SIZE_INFORMATION_CLASS,
            )) {
                for i in 0..info.AceCount {
                    let mut ace: *mut c_void = null_mut();
                    if !ok(GetAce(dacl, i, &mut ace)) || ace.is_null() {
                        continue;
                    }
                    let header = ace as *const ACE_HEADER;
                    if (*header).AceType == ACCESS_ALLOWED_ACE_TYPE {
                        let allow = ace as *const ACCESS_ALLOWED_ACE;
                        let sid_ptr = &(*allow).SidStart as *const u32 as PSID;
                        if ok(EqualSid(sid_ptr, sid))
                            && ((*allow).Mask & required_access) == required_access
                        {
                            found = true;
                            break;
                        }
                    }
                }
            }
            LocalFree(psd as _);
            found
        }
    }

    /// 在命名对象上盖“可继承(OI)(CI)”的授权写 ACE(不存在才盖)。
    ///
    /// 为何只授不撤(P3#8,已知取舍,非疏漏):
    /// - 受托 SID 由工作区路径确定性推导 ⇒ 每个工作区**最多一条** ACE(`named_has_ace`
    ///   幂等守卫),不随运行次数累积;
    /// - 该 SID 不映射任何活跃主体,遗留 ACE 不授予任何真实用户额外权限(惰性无害);
    /// - 同一工作区可能有多个沙箱进程并发存活(Bash + ManagedProcess + resumable
    ///   session),按进程退出撤销会打断仍在运行的兄弟进程的写围栏;
    /// - `SetNamedSecurityInfoW` 回写“撤销后的 DACL”还会踩空 DACL 陷阱(见上方
    ///   `old_dacl.is_null()` 分支)。
    ///
    /// 代价是资源管理器/注册表权限页会显示一个无法解析的 S-1-5-21-* 项,且卸载不清理。
    /// 若要提供清理,应做成显式的“清理沙箱 ACE”运维动作(遍历工作区列表按合成 SID
    /// 精确删除),而不是塞进单次命令的生命周期里。
    fn ensure_named_write_ace(
        object_type: i32,
        name: &str,
        sid: PSID,
        access: u32,
    ) -> Result<(), String> {
        let mut path_wide = to_wide(name);
        if named_has_ace(object_type, &path_wide, sid, access) {
            return Ok(());
        }
        unsafe {
            let mut old_dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 {
                return Err(format!("GetNamedSecurityInfoW({name}) failed (error={rc})"));
            }

            // NULL DACL = 隐式“everyone 全权”:目标 SID 本就被授予写,无需盖章;
            // 若仍用 SetEntriesInAclW(oldacl=NULL) 生成“仅目标 SID”的 DACL 再回写,反而把
            // 正常(无沙箱)访问锁死。故此情形直接跳过。
            if old_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Ok(());
            }

            let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
            ea.grfAccessPermissions = access;
            ea.grfAccessMode = GRANT_ACCESS;
            ea.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
            ea.Trustee = TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0, // NO_MULTIPLE_TRUSTEE
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            };

            let mut new_dacl: *mut ACL = null_mut();
            let rc = SetEntriesInAclW(1, &ea, old_dacl, &mut new_dacl);
            if rc != 0 || new_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Err(format!("SetEntriesInAclW({name}) failed (error={rc})"));
            }

            let rc = SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_dacl,
                null_mut(),
            );
            LocalFree(new_dacl as _);
            if !psd.is_null() {
                LocalFree(psd as _);
            }
            if rc != 0 {
                return Err(format!("SetNamedSecurityInfoW({name}) failed (error={rc})"));
            }
        }
        Ok(())
    }

    /// 精确撤销旧版本写入的某个受托 SID。`REVOKE_ACCESS` 只移除该 SID 的 ACE,
    /// 保留 owner、继承设置和其余 DACL；目录上的继承变化由 Windows 向下传播。
    fn remove_named_ace(object_type: i32, name: &str, sid: PSID) -> Result<(), String> {
        let mut path_wide = to_wide(name);
        if !named_has_ace(object_type, &path_wide, sid, 0) {
            return Ok(());
        }
        unsafe {
            let mut old_dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 {
                return Err(format!("GetNamedSecurityInfoW({name}) failed (error={rc})"));
            }
            if old_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Ok(());
            }

            let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
            ea.grfAccessMode = REVOKE_ACCESS;
            ea.Trustee = TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            };
            let mut new_dacl: *mut ACL = null_mut();
            let rc = SetEntriesInAclW(1, &ea, old_dacl, &mut new_dacl);
            if rc != 0 || new_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Err(format!(
                    "SetEntriesInAclW(revoke {name}) failed (error={rc})"
                ));
            }
            let rc = SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_dacl,
                null_mut(),
            );
            LocalFree(new_dacl as _);
            if !psd.is_null() {
                LocalFree(psd as _);
            }
            if rc != 0 {
                return Err(format!(
                    "SetNamedSecurityInfoW(revoke {name}) failed (error={rc})"
                ));
            }
        }
        Ok(())
    }

    fn ensure_write_ace(path: &Path, sid: PSID) -> Result<(), String> {
        ensure_named_write_ace(
            SE_FILE_OBJECT,
            &path.to_string_lossy(),
            sid,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE_RIGHT,
        )
    }

    fn remove_write_ace(path: &Path, sid: PSID) -> Result<(), String> {
        remove_named_ace(SE_FILE_OBJECT, &path.to_string_lossy(), sid)
    }

    #[cfg(test)]
    pub(super) fn prepare_modify_only_low_il_probe(path: &Path) -> Result<(), String> {
        let token = OwnedHandle(open_process_token()?);
        let user = token_user_sid_bytes(token.0)?;
        let user_sid = user.as_ptr() as PSID;
        let mut ea: EXPLICIT_ACCESS_W = unsafe { std::mem::zeroed() };
        ea.grfAccessPermissions =
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE_RIGHT;
        ea.grfAccessMode = GRANT_ACCESS;
        ea.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
        ea.Trustee = TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: user_sid as *mut u16,
        };

        let mut dacl: *mut ACL = null_mut();
        let rc = unsafe { SetEntriesInAclW(1, &ea, null_mut(), &mut dacl) };
        if rc != 0 || dacl.is_null() {
            return Err(format!(
                "SetEntriesInAclW(modify-only probe) failed (error={rc})"
            ));
        }
        let mut name_wide = to_wide(&path.to_string_lossy());
        let rc = unsafe {
            SetNamedSecurityInfoW(
                name_wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null_mut(),
            )
        };
        unsafe {
            LocalFree(dacl as _);
        }
        if rc != 0 {
            return Err(format!(
                "SetNamedSecurityInfoW(modify-only probe) failed (error={rc})"
            ));
        }

        let label_rc = set_low_integrity_label(SE_FILE_OBJECT, &path.to_string_lossy())?;
        if label_rc != ERROR_ACCESS_DENIED {
            return Err(format!(
                "modify-only probe should reject LABEL_SECURITY_INFORMATION with error 5, \
                 got {label_rc}"
            ));
        }
        Ok(())
    }

    fn create_hkcu_key(subkey: &str) -> Result<(), String> {
        let wide = to_wide(subkey);
        let mut hkey: HKEY = null_mut();
        let mut disposition: u32 = 0;
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide.as_ptr(),
                0,
                null(),
                0,
                KEY_READ | KEY_WRITE,
                null(),
                &mut hkey,
                &mut disposition,
            )
        };
        if rc != 0 {
            return Err(format!("RegCreateKeyExW({subkey}) failed (error={rc})"));
        }
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        Ok(())
    }

    fn ensure_plain_directory(path: &Path) -> Result<(), String> {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        std::fs::create_dir_all(path)
            .map_err(|err| format!("create dir {path:?} failed: {err}"))?;
        let meta = std::fs::symlink_metadata(path)
            .map_err(|err| format!("stat {path:?} failed: {err}"))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("{path:?} is a reparse point; refusing to stamp"));
        }
        Ok(())
    }

    /// 给 CAPI/CNG 用户证书库与密钥容器盖 fence_sid 写 ACE。
    ///
    /// 启动器此时仍持完整用户令牌,盖章发生在 `CreateProcessAsUserW` 之前。
    /// 单项失败只告警:探测层会把仍然崩溃的 pwsh(0xE0434352)跳过,落到 cmd,
    /// 不因证书库策略把整个沙箱判死。绝不 stamp HKLM(需管理员)。
    fn ensure_cng_user_write_surface(sid: PSID) {
        use crate::runtime::sandbox::{
            cng_named_registry_object, cng_user_file_dirs, CNG_USER_REGISTRY_SUBKEYS,
        };
        for subkey in CNG_USER_REGISTRY_SUBKEYS {
            if let Err(err) = create_hkcu_key(subkey) {
                sandbox_diag(format!(
                    "liveagent sandbox: CNG registry create skipped ({subkey}): {err}"
                ));
                continue;
            }
            let name = cng_named_registry_object(subkey);
            if let Err(err) = ensure_named_write_ace(SE_REGISTRY_KEY, &name, sid, KEY_ALL_ACCESS) {
                sandbox_diag(format!(
                    "liveagent sandbox: CNG registry ACE skipped ({name}): {err}"
                ));
            }
        }
        let (Some(appdata), Some(local)) = (dirs::data_dir(), dirs::data_local_dir()) else {
            return;
        };
        for dir in cng_user_file_dirs(&appdata, &local) {
            if let Err(err) = ensure_plain_directory(&dir).and_then(|_| ensure_write_ace(&dir, sid))
            {
                sandbox_diag(format!(
                    "liveagent sandbox: CNG dir ACE skipped ({dir:?}): {err}"
                ));
            }
        }
    }

    /// 给 .NET Framework / Windows PowerShell 的用户运行时缓存盖 fence_sid 写 ACE。
    ///
    /// 与 CNG 证书库是独立失败面:这里被拒时 powershell.exe 以 `0x80070005` 崩,
    /// 不是 `0xE0434352`。单项失败只告警,探测层会把仍然崩溃的 powershell 跳过。
    /// `assembly`(Fusion)只盖目录本身——树可能很大,新文件靠(OI)(CI)继承;
    /// CLR_v4.0 / PowerShell 缓存较小,首次盖章时向下传播到已有文件,否则
    /// `UsageLogs\powershell.exe.log` 等既有文件仍无限制性 SID,写依旧被拒。
    fn ensure_clr_user_write_surface(sid: PSID) {
        use crate::runtime::sandbox::{
            clr_user_file_dirs, cng_named_registry_object, CLR_USER_REGISTRY_SUBKEYS,
        };
        for subkey in CLR_USER_REGISTRY_SUBKEYS {
            if let Err(err) = create_hkcu_key(subkey) {
                sandbox_diag(format!(
                    "liveagent sandbox: CLR registry create skipped ({subkey}): {err}"
                ));
                continue;
            }
            let name = cng_named_registry_object(subkey);
            if let Err(err) = ensure_named_write_ace(SE_REGISTRY_KEY, &name, sid, KEY_ALL_ACCESS) {
                sandbox_diag(format!(
                    "liveagent sandbox: CLR registry ACE skipped ({name}): {err}"
                ));
            }
        }
        let (Some(appdata), Some(local)) = (dirs::data_dir(), dirs::data_local_dir()) else {
            return;
        };
        for dir in clr_user_file_dirs(&appdata, &local) {
            let stamp = if dir.file_name().is_some_and(|name| name == "assembly") {
                ensure_plain_directory(&dir).and_then(|_| ensure_write_ace(&dir, sid))
            } else {
                ensure_plain_directory(&dir).and_then(|_| ensure_write_ace_tree(&dir, sid))
            };
            if let Err(err) = stamp {
                sandbox_diag(format!(
                    "liveagent sandbox: CLR dir ACE skipped ({dir:?}): {err}"
                ));
            }
        }
    }

    /// v1.3 早期版本曾把具体 AppContainer profile SID 写进这些持久对象。
    /// 该 ACE 会让普通 Low-IL 联网进程无法访问同一对象；迁移时只撤销本工作区
    /// 的确定性 profile SID，其他用户/应用/工作区 ACE 均保持不变。
    fn remove_legacy_appcontainer_runtime_surface(sid: PSID) {
        use crate::runtime::sandbox::{
            clr_user_file_dirs, cng_named_registry_object, cng_user_file_dirs,
            CLR_USER_REGISTRY_SUBKEYS, CNG_USER_REGISTRY_SUBKEYS,
        };
        for subkey in CNG_USER_REGISTRY_SUBKEYS
            .iter()
            .chain(CLR_USER_REGISTRY_SUBKEYS)
        {
            if create_hkcu_key(subkey).is_err() {
                continue;
            }
            let name = cng_named_registry_object(subkey);
            if let Err(err) = remove_named_ace(SE_REGISTRY_KEY, &name, sid) {
                sandbox_diag(format!(
                    "liveagent sandbox: legacy AppContainer registry ACE cleanup skipped \
                     ({name}): {err}"
                ));
            }
        }
        let (Some(appdata), Some(local)) = (dirs::data_dir(), dirs::data_local_dir()) else {
            return;
        };
        for dir in cng_user_file_dirs(&appdata, &local)
            .into_iter()
            .chain(clr_user_file_dirs(&appdata, &local))
        {
            if !dir.exists() {
                continue;
            }
            if let Err(err) = remove_write_ace(&dir, sid) {
                sandbox_diag(format!(
                    "liveagent sandbox: legacy AppContainer runtime ACE cleanup skipped \
                     ({dir:?}): {err}"
                ));
            }
        }
    }

    /// 首次给目录盖写 ACE 后,把同一 ACE 推到已有子对象(最多 5 层)。
    /// 目录上已有 fence SID 时仍扫子对象:历史盖章可能只盖了目录本身,UsageLogs
    /// 里既有文件仍无限制性 SID,整棵跳过就会让 powershell 继续 0x80070005。
    fn ensure_write_ace_tree(path: &Path, sid: PSID) -> Result<(), String> {
        ensure_write_ace(path, sid)?;
        for entry in walkdir::WalkDir::new(path)
            .max_depth(5)
            .into_iter()
            .flatten()
        {
            if entry.path() == path {
                continue;
            }
            if let Err(err) = ensure_write_ace(entry.path(), sid) {
                sandbox_diag(format!(
                    "liveagent sandbox: CLR child ACE skipped ({:?}): {err}",
                    entry.path()
                ));
            }
        }
        Ok(())
    }

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: HANDLE,
        object_name: *const UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_qos: *mut c_void,
    }

    #[repr(C)]
    struct ObjectDirectoryInformation {
        name: UnicodeString,
        type_name: UnicodeString,
    }

    type NtStatusFn3 = unsafe extern "system" fn(*mut HANDLE, u32, *const ObjectAttributes) -> i32;
    type NtQueryDirectoryObjectFn =
        unsafe extern "system" fn(HANDLE, *mut c_void, u32, u8, u8, *mut u32, *mut u32) -> i32;

    fn ntdll_proc(name: &[u8]) -> Option<*const c_void> {
        unsafe {
            let ntdll = GetModuleHandleW(to_wide("ntdll.dll").as_ptr());
            if ntdll.is_null() {
                return None;
            }
            GetProcAddress(ntdll, name.as_ptr()).map(|proc| proc as *const c_void)
        }
    }

    fn with_object_attributes<R>(
        nt_path: &str,
        attributes: u32,
        security_descriptor: *mut c_void,
        body: impl FnOnce(&ObjectAttributes) -> R,
    ) -> R {
        let wide = to_wide(nt_path);
        let us = UnicodeString {
            length: ((wide.len() - 1) * 2) as u16,
            maximum_length: (wide.len() * 2) as u16,
            buffer: wide.as_ptr(),
        };
        let oa = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root_directory: null_mut(),
            object_name: &us,
            attributes,
            security_descriptor,
            security_qos: null_mut(),
        };
        body(&oa)
    }

    fn nt_open_by_name(
        fn_name: &[u8],
        nt_path: &str,
        access: u32,
        extra_attr: u32,
    ) -> Result<OwnedHandle, String> {
        let label = String::from_utf8_lossy(&fn_name[..fn_name.len().saturating_sub(1)]);
        let proc = ntdll_proc(fn_name).ok_or_else(|| format!("{label} unavailable"))?;
        let open: NtStatusFn3 = unsafe { std::mem::transmute(proc) };
        with_object_attributes(
            nt_path,
            OBJ_CASE_INSENSITIVE | extra_attr,
            null_mut(),
            |oa| {
                let mut handle = null_mut();
                let status = unsafe { open(&mut handle, access, oa) };
                if status < 0 || handle.is_null() {
                    Err(format!("{label}({nt_path}) ntstatus={status:#010X}"))
                } else {
                    Ok(OwnedHandle(handle))
                }
            },
        )
    }

    fn open_directory_object(nt_path: &str, access: u32) -> Result<OwnedHandle, String> {
        nt_open_by_name(b"NtOpenDirectoryObject\0", nt_path, access, 0)
    }

    fn create_directory_object(
        nt_path: &str,
        access: u32,
        sd: *mut c_void,
    ) -> Result<OwnedHandle, String> {
        let proc = ntdll_proc(b"NtCreateDirectoryObject\0")
            .ok_or_else(|| "NtCreateDirectoryObject unavailable".to_string())?;
        let create: NtStatusFn3 = unsafe { std::mem::transmute(proc) };
        with_object_attributes(nt_path, OBJ_CASE_INSENSITIVE | OBJ_OPENIF, sd, |oa| {
            let mut handle = null_mut();
            let status = unsafe { create(&mut handle, access, oa) };
            if status < 0 || handle.is_null() {
                Err(format!(
                    "NtCreateDirectoryObject({nt_path}) ntstatus={status:#010X}"
                ))
            } else {
                Ok(OwnedHandle(handle))
            }
        })
    }

    fn sid_string(sid: PSID) -> Result<String, String> {
        unsafe {
            let mut s: *mut u16 = null_mut();
            if !ok(ConvertSidToStringSidW(sid, &mut s)) || s.is_null() {
                return Err(last_error("ConvertSidToStringSidW"));
            }
            let mut len = 0usize;
            while *s.add(len) != 0 {
                len += 1;
            }
            let out = String::from_utf16_lossy(std::slice::from_raw_parts(s, len));
            LocalFree(s as _);
            Ok(out)
        }
    }

    fn namespace_security_descriptor(sids: &[PSID]) -> Result<*mut c_void, String> {
        let mut sddl = String::from("D:(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)(A;OICI;GA;;;WD)");
        for &sid in sids {
            match sid_string(sid) {
                Ok(s) => sddl.push_str(&format!("(A;OICI;GA;;;{s})")),
                Err(err) => sandbox_diag(format!("liveagent sandbox: SID to SDDL skipped: {err}")),
            }
        }
        let wide = to_wide(&sddl);
        let mut sd: *mut c_void = null_mut();
        let r = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut sd,
                null_mut(),
            )
        };
        if !ok(r) || sd.is_null() {
            return Err(last_error(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
            ));
        }
        Ok(sd)
    }

    fn rtl_upcase_wchar(ch: u16) -> u16 {
        ntdll_proc(b"RtlUpcaseUnicodeChar\0")
            .map(|proc| {
                type RtlUpcaseUnicodeCharFn = unsafe extern "system" fn(u16) -> u16;
                let f: RtlUpcaseUnicodeCharFn = unsafe { std::mem::transmute(proc) };
                unsafe { f(ch) }
            })
            .unwrap_or_else(|| {
                if (b'a' as u16..=b'z' as u16).contains(&ch) {
                    ch - 32
                } else {
                    ch
                }
            })
    }

    /// cygwin `hash_path_name`: `hash = RtlUpcase(c) + (hash<<6) + (hash<<16) - hash`
    /// (`ino_t` = u64).安装 key 是该哈希的 16 位小写十六进制。
    fn hash_path_name(nt_path: &str) -> u64 {
        let mut hash: u64 = 0;
        for ch in nt_path.encode_utf16() {
            let u = rtl_upcase_wchar(ch) as u64;
            hash = u
                .wrapping_add(hash.wrapping_shl(6))
                .wrapping_add(hash.wrapping_shl(16))
                .wrapping_sub(hash);
        }
        hash
    }

    fn nt_path_for_msys_hash(dll: &Path) -> Option<String> {
        let lossy = dll.to_string_lossy();
        let prefixed = if lossy.starts_with(r"\\?\") {
            lossy.into_owned()
        } else if lossy.starts_with(r"\\") {
            format!(r"\\?\UNC\{}", lossy.trim_start_matches(r"\\"))
        } else {
            format!(r"\\?\{lossy}")
        };
        let mut chars: Vec<u16> = prefixed.encode_utf16().collect();
        if chars.len() >= 2 {
            chars[1] = b'?' as u16;
        }
        Some(String::from_utf16_lossy(&chars))
    }

    fn msys_runtime_dll(program: &Path) -> Option<PathBuf> {
        let parent = program.parent()?;
        let candidates = [
            parent.join("msys-2.0.dll"),
            parent
                .join("..")
                .join("usr")
                .join("bin")
                .join("msys-2.0.dll"),
            parent.join("cygwin1.dll"),
        ];
        for candidate in candidates {
            if candidate.is_file() {
                return Some(candidate.canonicalize().unwrap_or(candidate));
            }
        }
        None
    }

    fn msys_object_dir_names(program: &Path) -> Vec<String> {
        let Some(dll) = msys_runtime_dll(program) else {
            return Vec::new();
        };
        let Some(nt) = nt_path_for_msys_hash(&dll) else {
            return Vec::new();
        };
        let key = format!("{:016x}", hash_path_name(&nt));
        sandbox_diag(format!(
            "liveagent sandbox: msys install key {key} from {nt}"
        ));
        let prefix = if dll
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("cygwin1.dll"))
        {
            "cygwin1S5"
        } else {
            "msys-2.0S5"
        };
        let mut names = vec![format!(r"\BaseNamedObjects\{prefix}-{key}")];
        if let Some(session) = current_session_id() {
            names.push(format!(r"\Sessions\BNOLINKS\{session}\{prefix}-{key}"));
        }
        names
    }

    #[cfg(test)]
    pub(super) fn msys_object_dir_names_for_test(program: &Path) -> Vec<String> {
        msys_object_dir_names(program)
    }

    /// 真机钩子:盖章 msys 目录后,用 WRITE_RESTRICTED 令牌模拟打开
    /// (DesiredAccess = cygwin CYG_SHARED_DIR_ACCESS)。用来把 DACL 问题与
    /// bash DllMain 其它失败面分开。
    #[cfg(test)]
    pub(super) fn restricted_token_can_open_msys_dir(program: &Path) -> Result<(), String> {
        use windows_sys::Win32::Security::{ImpersonateLoggedOnUser, RevertToSelf};
        let names = msys_object_dir_names(program);
        let Some(name) = names.first() else {
            return Err("no msys object directory names".into());
        };
        let synthetic_str = crate::runtime::sandbox::synthetic_workspace_sid(Path::new(
            "liveagent-sandbox-msys-probe",
        ));
        let synthetic = string_to_sid(&synthetic_str)?;
        let wr = string_to_sid(WRITE_RESTRICTED_SID)?;
        let token = OwnedHandle(open_process_token()?);
        let logon = logon_sid_bytes(token.0)?;
        let logon_ptr = logon.as_ptr() as PSID;
        let restricting = [logon_ptr, wr.0, synthetic.0];
        let _held = ensure_named_directory_write_surface(name, &restricting)
            .ok_or_else(|| format!("failed to create/hold {name}"))?;
        let rt = OwnedHandle(create_restricted_token(token.0, &restricting)?);
        append_sid_to_default_dacl(rt.0, logon_ptr)?;
        if !ok(unsafe { ImpersonateLoggedOnUser(rt.0) }) {
            return Err(last_error("ImpersonateLoggedOnUser"));
        }
        let access = DIRECTORY_QUERY
            | DIRECTORY_TRAVERSE
            | DIRECTORY_CREATE_OBJECT
            | DIRECTORY_CREATE_SUBDIRECTORY
            | READ_CONTROL;
        let opened = nt_open_by_name(b"NtOpenDirectoryObject\0", name, access, 0);
        unsafe {
            RevertToSelf();
        }
        opened.map(|_| ())
    }

    fn kernel_handle_has_ace(handle: HANDLE, sid: PSID) -> bool {
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 || dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return false;
            }
            let mut info = ACL_SIZE_INFORMATION {
                AceCount: 0,
                AclBytesInUse: 0,
                AclBytesFree: 0,
            };
            let mut found = false;
            if ok(GetAclInformation(
                dacl,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                ACL_SIZE_INFORMATION_CLASS,
            )) {
                for i in 0..info.AceCount {
                    let mut ace: *mut c_void = null_mut();
                    if !ok(GetAce(dacl, i, &mut ace)) || ace.is_null() {
                        continue;
                    }
                    if (*(ace as *const ACE_HEADER)).AceType == ACCESS_ALLOWED_ACE_TYPE {
                        let allow = ace as *const ACCESS_ALLOWED_ACE;
                        let sid_ptr = &(*allow).SidStart as *const u32 as PSID;
                        if ok(EqualSid(sid_ptr, sid)) {
                            found = true;
                            break;
                        }
                    }
                }
            }
            LocalFree(psd as _);
            found
        }
    }

    fn ensure_kernel_handle_write_ace(
        handle: HANDLE,
        sid: PSID,
        access: u32,
        label: &str,
    ) -> Result<(), String> {
        if kernel_handle_has_ace(handle, sid) {
            return Ok(());
        }
        unsafe {
            let mut old_dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 {
                return Err(format!("GetSecurityInfo({label}) failed (error={rc})"));
            }
            if old_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Ok(());
            }
            let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
            ea.grfAccessPermissions = access;
            ea.grfAccessMode = GRANT_ACCESS;
            ea.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
            ea.Trustee = TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            };
            let mut new_dacl: *mut ACL = null_mut();
            let rc = SetEntriesInAclW(1, &ea, old_dacl, &mut new_dacl);
            if rc != 0 || new_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Err(format!("SetEntriesInAclW({label}) failed (error={rc})"));
            }
            let rc = SetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_dacl,
                null_mut(),
            );
            LocalFree(new_dacl as _);
            if !psd.is_null() {
                LocalFree(psd as _);
            }
            if rc != 0 {
                return Err(format!("SetSecurityInfo({label}) failed (error={rc})"));
            }
        }
        Ok(())
    }

    fn stamp_kernel_handle(handle: HANDLE, sids: &[PSID], access: u32, label: &str) {
        for (i, &sid) in sids.iter().enumerate() {
            if let Err(err) = ensure_kernel_handle_write_ace(handle, sid, access, label) {
                sandbox_diag(format!(
                    "liveagent sandbox: kernel ACE skipped ({label}#{i}): {err}"
                ));
            }
        }
    }

    fn nt_set_dacl(handle: HANDLE, sd: *mut c_void, label: &str) {
        let Some(proc) = ntdll_proc(b"NtSetSecurityObject\0") else {
            sandbox_diag("liveagent sandbox: NtSetSecurityObject unavailable");
            return;
        };
        type NtSetSecurityObjectFn = unsafe extern "system" fn(HANDLE, u32, *mut c_void) -> i32;
        let set: NtSetSecurityObjectFn = unsafe { std::mem::transmute(proc) };
        let status = unsafe { set(handle, DACL_SECURITY_INFORMATION, sd) };
        if status < 0 {
            sandbox_diag(format!(
                "liveagent sandbox: NtSetSecurityObject({label}) ntstatus={status:#010X}"
            ));
        }
    }

    fn stamp_directory_object(nt_path: &str, sids: &[PSID]) {
        // 标准用户对 `\BaseNamedObjects` 没有 DIRECTORY_ALL_ACCESS;对自己创建的
        // msys 子目录则有 WRITE_DAC。按“查询+写 DACL”打开,失败只告警。
        let access = DIRECTORY_QUERY | DIRECTORY_TRAVERSE | READ_CONTROL | WRITE_DAC;
        match open_directory_object(nt_path, access) {
            Ok(dir) => stamp_kernel_handle(
                dir.0,
                sids,
                DIRECTORY_ALL_ACCESS | GENERIC_ALL | WRITE_DAC,
                nt_path,
            ),
            Err(err) => sandbox_diag(format!("liveagent sandbox: open {nt_path} skipped: {err}")),
        }
    }

    fn ensure_named_directory_write_surface(nt_path: &str, sids: &[PSID]) -> Option<OwnedHandle> {
        let sd = match namespace_security_descriptor(sids) {
            Ok(sd) => sd,
            Err(err) => {
                sandbox_diag(format!(
                    "liveagent sandbox: namespace SD skipped ({nt_path}): {err}"
                ));
                stamp_directory_object(nt_path, sids);
                stamp_directory_children(nt_path, sids, false);
                return None;
            }
        };
        let access = DIRECTORY_ALL_ACCESS
            | DIRECTORY_CREATE_OBJECT
            | DIRECTORY_CREATE_SUBDIRECTORY
            | READ_CONTROL
            | WRITE_DAC;
        let handle = match create_directory_object(nt_path, access, sd) {
            Ok(dir) => Some(dir),
            Err(err) => {
                sandbox_diag(format!(
                    "liveagent sandbox: create {nt_path} skipped: {err}"
                ));
                open_directory_object(nt_path, access).ok()
            }
        };
        if let Some(dir) = handle.as_ref() {
            // OBJ_OPENIF 命中已有对象时创建时的 SD 不会覆盖 everyone_sd;
            // 必须再 NtSetSecurityObject 把限制性 SID 写进 DACL。
            nt_set_dacl(dir.0, sd, nt_path);
            set_handle_low_integrity(dir.0, nt_path);
            stamp_kernel_handle(
                dir.0,
                sids,
                DIRECTORY_ALL_ACCESS | GENERIC_ALL | WRITE_DAC,
                nt_path,
            );
        }
        unsafe {
            LocalFree(sd as _);
        }
        stamp_directory_children(nt_path, sids, false);
        handle
    }

    #[repr(C)]
    struct IoStatusBlock {
        status: isize,
        information: usize,
    }

    fn open_file_object(nt_path: &str, access: u32) -> Result<OwnedHandle, String> {
        let proc =
            ntdll_proc(b"NtOpenFile\0").ok_or_else(|| "NtOpenFile unavailable".to_string())?;
        type NtOpenFileFn = unsafe extern "system" fn(
            *mut HANDLE,
            u32,
            *const ObjectAttributes,
            *mut IoStatusBlock,
            u32,
            u32,
        ) -> i32;
        let open: NtOpenFileFn = unsafe { std::mem::transmute(proc) };
        const FILE_SHARE_ALL: u32 = 0x7;
        with_object_attributes(nt_path, OBJ_CASE_INSENSITIVE, null_mut(), |oa| {
            let mut handle = null_mut();
            let mut iosb = IoStatusBlock {
                status: 0,
                information: 0,
            };
            let status = unsafe { open(&mut handle, access, oa, &mut iosb, FILE_SHARE_ALL, 0) };
            if status < 0 || handle.is_null() {
                Err(format!("NtOpenFile({nt_path}) ntstatus={status:#010X}"))
            } else {
                Ok(OwnedHandle(handle))
            }
        })
    }

    fn stamp_nt_path_dacl(nt_path: &str, sids: &[PSID]) {
        let access = READ_CONTROL | WRITE_DAC;
        let handle =
            open_directory_object(nt_path, access).or_else(|_| open_file_object(nt_path, access));
        match handle {
            Ok(h) => stamp_kernel_handle(
                h.0,
                sids,
                DIRECTORY_ALL_ACCESS | GENERIC_ALL | WRITE_DAC,
                nt_path,
            ),
            Err(err) => sandbox_diag(format!("liveagent sandbox: stamp {nt_path} skipped: {err}")),
        }
    }

    fn utf16_to_string(us: &UnicodeString) -> String {
        if us.buffer.is_null() || us.length == 0 {
            return String::new();
        }
        let n = (us.length as usize) / 2;
        unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(us.buffer, n)) }
    }

    fn stamp_directory_children(nt_dir: &str, sids: &[PSID], only_msys: bool) {
        let Ok(dir) = open_directory_object(nt_dir, DIRECTORY_QUERY | DIRECTORY_TRAVERSE) else {
            return;
        };
        let Some(query_ptr) = ntdll_proc(b"NtQueryDirectoryObject\0") else {
            return;
        };
        let query: NtQueryDirectoryObjectFn = unsafe { std::mem::transmute(query_ptr) };
        let mut buf = vec![0u8; 4096];
        let mut context: u32 = 0;
        let mut restart = 1u8;
        let mut children: Vec<(String, String)> = Vec::new();
        loop {
            let mut ret_len: u32 = 0;
            let status = unsafe {
                query(
                    dir.0,
                    buf.as_mut_ptr() as *mut c_void,
                    buf.len() as u32,
                    1, // ReturnSingleEntry:避免自己解析 packed 目录项
                    restart,
                    &mut context,
                    &mut ret_len,
                )
            };
            restart = 0;
            const STATUS_NO_MORE_ENTRIES: u32 = 0x8000_001A;
            if status as u32 == STATUS_NO_MORE_ENTRIES {
                break;
            }
            if status < 0 {
                break;
            }
            if buf.len() < std::mem::size_of::<ObjectDirectoryInformation>() {
                break;
            }
            let info = unsafe { &*(buf.as_ptr() as *const ObjectDirectoryInformation) };
            let name = utf16_to_string(&info.name);
            let ty = utf16_to_string(&info.type_name);
            if name.is_empty() {
                continue;
            }
            if only_msys {
                let lower = name.to_ascii_lowercase();
                if !(lower.starts_with("msys-") || lower.starts_with("cygwin")) {
                    continue;
                }
            }
            children.push((name, ty));
        }
        drop(dir);
        for (name, ty) in children {
            let child = format!("{nt_dir}\\{name}");
            let open_fn: &[u8] = match ty.as_str() {
                "Directory" => b"NtOpenDirectoryObject\0",
                "Section" => b"NtOpenSection\0",
                "Event" => b"NtOpenEvent\0",
                "Mutant" => b"NtOpenMutant\0",
                "Semaphore" => b"NtOpenSemaphore\0",
                "Timer" => b"NtOpenTimer\0",
                _ => b"",
            };
            if !open_fn.is_empty() {
                if let Ok(h) = nt_open_by_name(open_fn, &child, READ_CONTROL | WRITE_DAC, 0) {
                    stamp_kernel_handle(h.0, sids, GENERIC_ALL | WRITE_DAC, &child);
                }
            }
            if ty == "Directory" {
                // msys 目录内部的 section/event 全部盖章(这些才是 DllMain 要重开的对象)。
                stamp_directory_children(&child, sids, false);
            }
        }
    }

    fn current_session_id() -> Option<u32> {
        unsafe {
            let k32 = GetModuleHandleW(to_wide("kernel32.dll").as_ptr());
            if k32.is_null() {
                return None;
            }
            let proc = GetProcAddress(k32, b"ProcessIdToSessionId\0".as_ptr())?;
            type ProcessIdToSessionIdFn = unsafe extern "system" fn(u32, *mut u32) -> i32;
            let f: ProcessIdToSessionIdFn = std::mem::transmute(proc);
            let mut id = 0u32;
            if f(GetCurrentProcessId(), &mut id) == 0 {
                return None;
            }
            Some(id)
        }
    }

    fn looks_like_msys_bash(program: &Path) -> bool {
        let name = program.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.eq_ignore_ascii_case("bash.exe") {
            return false;
        }
        let Some(parent) = program.parent() else {
            return false;
        };
        parent.join("msys-2.0.dll").is_file()
            || parent
                .join("..")
                .join("usr")
                .join("bin")
                .join("msys-2.0.dll")
                .is_file()
    }

    /// 对象目录默认不是 permanent:最后句柄关闭就会从命名空间消失。
    /// 启动器必须把返回的句柄活到沙箱子进程退出,子进程的 OBJ_OPENIF 才能命中
    /// 已有目录,而不去 `\BaseNamedObjects` 上做第二遍写检查。
    fn ensure_object_namespace_write_surface(
        sids: &[PSID],
        program: &Path,
        isolation_prefix: &str,
    ) -> Vec<OwnedHandle> {
        let mut held = Vec::new();
        if let Some(h) = ensure_named_directory_write_surface(
            &format!(r"\BaseNamedObjects\{isolation_prefix}"),
            sids,
        ) {
            held.push(h);
        }
        if looks_like_msys_bash(program) {
            for name in msys_object_dir_names(program) {
                if let Some(h) = ensure_named_directory_write_surface(&name, sids) {
                    held.push(h);
                }
            }
        }
        // Git Bash 信号管线是 `\\.\pipe\msys-<key>-<pid>-sigwait`,创建时要过
        // `\Device\NamedPipe` 的第二遍写检查。盖不上只告警。
        stamp_nt_path_dacl(r"\Device\NamedPipe", sids);
        held
    }

    /// 创建并盖章一个受围栏的临时目录(系统 temp 下,按工作区确定性命名),把
    /// TEMP/TMP/TMPDIR 指向它——否则沙箱进程写默认 %TEMP% 会被限制性判定拒绝。
    fn setup_fenced_temp(
        write_root: &Path,
        sid: PSID,
        legacy_appcontainer_sid: PSID,
        dir_key: &str,
        extra_sids: &[PSID],
    ) -> Result<PathBuf, String> {
        let base = std::env::temp_dir().join(format!("liveagent-sandbox-{dir_key}"));
        // 路径确定性且可预测 ⇒ 另一同用户进程可能抢先把它建成 junction/symlink 指向敏感
        // 目录,使授权写 ACE 盖到目标、TEMP 重定向落进目标。拒绝 reparse point 以堵此路
        //(残留 TOCTOU:盖章/使用之间的替换需另一恶意同用户进程,严重度低)。
        ensure_plain_directory(&base)?;
        remove_write_ace(&base, legacy_appcontainer_sid)?;
        ensure_write_ace(&base, sid)?;
        for (i, &extra) in extra_sids.iter().enumerate() {
            if let Err(err) = ensure_write_ace(&base, extra) {
                sandbox_diag(format!(
                    "liveagent sandbox: TEMP extra ACE skipped (#{i}): {err}"
                ));
            }
        }
        let _ = write_root; // 保留签名清晰度;temp 独立于工作区。
        let base_wide = to_wide(&base.to_string_lossy());
        for name in ["TEMP", "TMP", "TMPDIR"] {
            let name_wide = to_wide(name);
            unsafe {
                if !ok(SetEnvironmentVariableW(
                    name_wide.as_ptr(),
                    base_wide.as_ptr(),
                )) {
                    return Err(last_error(&format!("SetEnvironmentVariableW({name})")));
                }
            }
        }
        Ok(base)
    }

    /// 令三个标准句柄可继承,并作为 STARTF_USESTDHANDLES 传给子进程(stdin=NUL、
    /// stdout/stderr=父层管道,均由 shell_runner 建好后经继承落到本启动器)。
    fn inheritable_std_handles() -> Result<(HANDLE, HANDLE, HANDLE), String> {
        // GetStdHandle 在句柄缺失时返回 INVALID_HANDLE_VALUE(-1)而非 null;两者都跳过。
        let invalid: HANDLE = usize::MAX as HANDLE;
        unsafe {
            let stdin = GetStdHandle(STD_INPUT_HANDLE);
            let stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            let stderr = GetStdHandle(STD_ERROR_HANDLE);
            for h in [stdin, stdout, stderr] {
                if !h.is_null() && h != invalid {
                    // 失败不致命:句柄可能本就可继承;继续尝试。
                    SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
                }
            }
            Ok((stdin, stdout, stderr))
        }
    }

    /// 运行时探测:联网后端(Low IL 主令牌副本)能否真的建起来。
    ///
    /// 走与 `execute` 相同的令牌核心序列(打开主令牌 → DuplicateTokenEx → 降 Low IL),
    /// 只是不启动进程、不修改任何文件系统标签。
    /// 组策略、EDR hook、受限 SKU 会让其中任一步在真机失败;探测把失败提前反映到
    /// `capability().supported`,从而让 `wrap_command` 的 fail-closed 守卫在 Windows
    /// 上真正可达(此前硬编码 `supported: true`,该守卫恒不触发)。
    /// 令牌句柄经 `OwnedHandle` 立即释放,无系统级副作用。
    pub(super) fn probe_networked_token() -> Result<(), String> {
        let token = OwnedHandle(open_process_token()?);
        let networked = OwnedHandle(duplicate_primary_token(token.0)?);
        set_token_low_integrity(networked.0)?;
        Ok(())
    }

    /// 运行时探测:断网后端能否派生 AppContainer profile SID 与私有 capability
    /// SID。均为纯派生,不创建 profile、无系统副作用；任一步失败都不能宣称具备
    /// 断网沙箱能力。
    pub(super) fn probe_appcontainer() -> Result<(), String> {
        let name = appcontainer_profile_name("probe");
        let name_w = to_wide(&name);
        let mut sid: PSID = null_mut();
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid) };
        if derived != 0 || sid.is_null() {
            return Err(format!(
                "DeriveAppContainerSidFromAppContainerName hr={derived:#010X}"
            ));
        }
        let _sid = AcSid(sid); // RAII:FreeSid
        let _capability = workspace_capability_sid("probe")?;
        Ok(())
    }

    pub(super) fn execute(
        write_root: &Path,
        allow_network: bool,
        isolated: bool,
        program: &Path,
        args: &[String],
    ) -> Result<i32, String> {
        use crate::runtime::sandbox::{
            build_command_line, is_msix_windowsapps_path, resolve_program_in_path,
            synthetic_workspace_sid, validate_workspace,
        };

        // P3#8:启动器是独立进程,不能依赖父进程侧 wrap_command 已做过校验——两个入口
        // 必须共用同一套前置条件,否则任一侧演进就会漂移出 fail-closed 不对称。
        // (幂等纯校验,重复执行无副作用。)
        validate_workspace(write_root)?;

        let synthetic_str = synthetic_workspace_sid(write_root);
        // temp 目录 / AC profile 名沿用合成 SID 的数值段,确定性且文件系统安全。
        let dir_key = synthetic_str
            .trim_start_matches("S-1-5-21-")
            .replace('-', "_");

        // 先解析程序；绝不从模型可写的工作区按相对路径启动映像。
        let path_env = std::env::var("PATH").unwrap_or_default();
        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let resolved = resolve_program_in_path(program, &path_env, &pathext, &|p| p.is_file())
            .ok_or_else(|| {
                format!(
                    "sandbox refuses to resolve program {program:?}: not found in any absolute \
                     PATH directory (the workspace cwd is intentionally never searched)"
                )
            })?;
        if is_msix_windowsapps_path(&resolved) {
            return Err(format!(
                "sandbox refuses Microsoft Store / MSIX program {resolved:?}: WindowsApps \
                 binaries cannot be started through the sandbox security contexts \
                 (CreateProcessAsUserW returns 5). Install PowerShell via MSI or use \
                 powershell.exe / cmd.exe"
            ));
        }
        // --- 后端安全上下文 ---
        // fence_sid = 文件写 ACE 的受托 SID(联网=当前用户 SID,断网=工作区私有
        // capability SID)。profile/capability/user/token 的自持内存全部声明在外层,
        // 确保其 PSID 指针活到 CreateProcess* 返回之后。
        let appcontainer_sid = if allow_network {
            derive_appcontainer_profile_sid(&dir_key)?
        } else {
            appcontainer_profile_sid(&dir_key)?
        };
        let workspace_capability = if allow_network {
            None
        } else {
            Some(workspace_capability_sid(&dir_key)?)
        };
        let network_token: Option<OwnedHandle>;
        let fence_sid: PSID;
        let logon_sid: Option<Vec<u8>>;
        let user_sid: Option<Vec<u8>>;
        if allow_network {
            let token = OwnedHandle(open_process_token()?);
            let logon = logon_sid_bytes(token.0)?;
            let logon_ptr = logon.as_ptr() as PSID;
            let user = token_user_sid_bytes(token.0)?;
            let user_ptr = user.as_ptr() as PSID;
            let rt = OwnedHandle(duplicate_primary_token(token.0)?);
            // 登录 SID 进入 default DACL，保证子进程自建的命名对象在同一登录会话可重开。
            append_sid_to_default_dacl(rt.0, logon_ptr)?;
            // 联网模式不能使用 restricted token：SSPI/Schannel 会在 HTTPS 初始化时以
            // SEC_E_NO_CREDENTIALS 失败。复制当前用户主令牌并降到 Low IL，网络语义
            // 保持不变，NTFS 写围栏由 NoWriteUp + Low workspace/TEMP 强制执行。
            set_token_low_integrity(rt.0)?;
            network_token = Some(rt);
            fence_sid = user_ptr;
            logon_sid = Some(logon);
            user_sid = Some(user);
        } else {
            // 私有 capability 只授权本工作区文件面，不是网络 capability；WFP 仍
            // 对该 AppContainer 内核级全断网(含 loopback)。
            set_offline_env()?;
            network_token = None;
            fence_sid = workspace_capability
                .as_ref()
                .map(|sid| sid.as_ptr() as PSID)
                .ok_or_else(|| "offline workspace capability SID is unavailable".to_string())?;
            logon_sid = None;
            user_sid = None;
        }

        // --- 文件系统写围栏(受托人 = fence_sid) ---
        // 迁移旧版直接授给 package SID 的 ACE。该 ACE 与普通 Low-IL 联网令牌
        // 不共存，必须先精确撤销，再授予用户 SID / 私有 capability SID。
        remove_write_ace(write_root, appcontainer_sid.0)?;
        ensure_write_ace(write_root, fence_sid)?;
        let extra_temp: Vec<PSID> = logon_sid
            .as_ref()
            .map(|logon| logon.as_ptr() as PSID)
            .into_iter()
            .collect();
        let fenced_temp = setup_fenced_temp(
            write_root,
            fence_sid,
            appcontainer_sid.0,
            &dir_key,
            &extra_temp,
        )?;
        if allow_network {
            let launcher_user_sid = user_sid
                .as_ref()
                .map(|sid| sid.as_ptr() as PSID)
                .ok_or_else(|| "sandbox launcher user SID is unavailable".to_string())?;
            // 工作区根必须标上 Low,否则 Low 子进程连新建文件都会被 NoWriteUp 拒绝。
            ensure_low_integrity_label(
                SE_FILE_OBJECT,
                &write_root.to_string_lossy(),
                launcher_user_sid,
            )?;
            ensure_runtime_low_integrity_surface(
                write_root,
                &fenced_temp,
                &resolved,
                launcher_user_sid,
            );
        }
        // CNG/CLR:PowerShell 启动会写用户证书库和运行时缓存；只给这组窄路径补访问面。
        remove_legacy_appcontainer_runtime_surface(appcontainer_sid.0);
        let mut runtime_sids: Vec<PSID> = vec![fence_sid];
        if let Some(ref logon) = logon_sid {
            runtime_sids.push(logon.as_ptr() as PSID);
        }
        for &sid in &runtime_sids {
            ensure_cng_user_write_surface(sid);
            ensure_clr_user_write_surface(sid);
        }

        // --- 标准句柄 + 命令行 ---
        let (h_in, h_out, h_err) = inheritable_std_handles()?;
        if allow_network {
            // Low 子进程写 Medium 匿名管道会被 NoWriteUp 挡住;尽力把继承来的
            // stdout/stderr 也标成 Low。没有 WRITE_OWNER 时只告警,多数匿名管道
            // 实际仍可写(与 AppContainer 启动子进程重定向 stdout 同款路径)。
            set_handle_low_integrity(h_in, "stdin");
            set_handle_low_integrity(h_out, "stdout");
            set_handle_low_integrity(h_err, "stderr");
        }

        // NT 对象命名空间:须在 CreateProcess* 之前,且 SID 缓冲仍活着。
        let mut namespace_sids: Vec<PSID> = Vec::with_capacity(4);
        if let Some(ref logon) = logon_sid {
            namespace_sids.push(logon.as_ptr() as PSID);
        }
        if let Some(ref user) = user_sid {
            namespace_sids.push(user.as_ptr() as PSID);
        }
        namespace_sids.push(fence_sid);
        let isolation_prefix = format!("LiveAgent.Sandbox.{dir_key}");
        let _held_namespace =
            ensure_object_namespace_write_surface(&namespace_sids, &resolved, &isolation_prefix);

        let program_str = program.to_string_lossy(); // argv[0] 保留原始名(对齐非沙箱路径)
        let app_wide = to_wide(&resolved.to_string_lossy()); // lpApplicationName = 解析出的绝对路径
        let mut cmdline = build_command_line(&program_str, args); // 已含结尾 NUL

        // --- STARTUPINFOEXW:显式桌面 + 白名单句柄继承(+ AC capabilities) ---
        // Low IL token / AC 启动必须显式指定桌面:NULL 交由系统推断,在沙箱上下文下解析
        // 歧义甚至失败(Codex 同款修复)。
        let mut desktop = to_wide("winsta0\\default");

        // 句柄白名单:去重 + 滤掉 NULL/INVALID(列表含无效或重复句柄会让 CreateProcess*
        // 直接 ERROR_INVALID_PARAMETER)。取代旧 bInheritHandles=TRUE 的全句柄表继承,
        // 收敛句柄泄漏面。
        let invalid: HANDLE = usize::MAX as HANDLE;
        let mut handle_list: Vec<HANDLE> = Vec::with_capacity(3);
        for h in [h_in, h_out, h_err] {
            if !h.is_null() && h != invalid && !handle_list.contains(&h) {
                handle_list.push(h);
            }
        }
        let inherit = !handle_list.is_empty();

        // AC capabilities:声明须早于 attrs(局部量逆序析构 ⇒ attrs 先亡),满足
        // UpdateProcThreadAttribute 的 value 存活契约(见 AttrList 文档)。
        let mut capability_attrs: Vec<SID_AND_ATTRIBUTES> = workspace_capability
            .as_ref()
            .map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid.as_ptr() as PSID,
                Attributes: SE_GROUP_ENABLED,
            })
            .into_iter()
            .collect();
        let sec_caps = SECURITY_CAPABILITIES {
            AppContainerSid: appcontainer_sid.0,
            Capabilities: capability_attrs.as_mut_ptr(),
            CapabilityCount: capability_attrs.len() as u32,
            Reserved: 0,
        };

        // AppContainer 已有独立命名空间，Windows 不支持再叠加 BNO isolation
        // (CreateProcessW error 50)；联网 Low-IL 进程继续用 BNO 隔离命名对象。
        let attr_count = 2;
        let mut bno_attr = ProcessBnoIsolationAttribute {
            isolation_enabled: 1,
            isolation_prefix: [0u16; 136],
        };
        {
            for (i, unit) in isolation_prefix.encode_utf16().take(135).enumerate() {
                bno_attr.isolation_prefix[i] = unit;
            }
        }
        let mut attrs = AttrList::new(attr_count)?;
        if inherit {
            attrs.set(
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handle_list.as_ptr() as *const c_void,
                handle_list.len() * std::mem::size_of::<HANDLE>(),
                "UpdateProcThreadAttribute(handle list)",
            )?;
        }
        if !allow_network {
            attrs.set(
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                &sec_caps as *const _ as *const c_void,
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                "UpdateProcThreadAttribute(security capabilities)",
            )?;
        }
        if allow_network {
            attrs.set(
                PROC_THREAD_ATTRIBUTE_BNO_ISOLATION,
                &bno_attr as *const _ as *const c_void,
                std::mem::size_of::<ProcessBnoIsolationAttribute>(),
                "UpdateProcThreadAttribute(bno isolation)",
            )?;
        }

        // --- 启动子进程(挂起态,便于先入 Job 再放行) ---
        let result = unsafe {
            let mut si: STARTUPINFOEXW = std::mem::zeroed();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.lpDesktop = desktop.as_mut_ptr();
            si.StartupInfo.hStdInput = h_in;
            si.StartupInfo.hStdOutput = h_out;
            si.StartupInfo.hStdError = h_err;
            si.lpAttributeList = attrs.ptr();

            let flags = CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let created = if let Some(rt) = &network_token {
                CreateProcessAsUserW(
                    rt.0,
                    app_wide.as_ptr(),
                    cmdline.as_mut_ptr(),
                    null(),
                    null(),
                    i32::from(inherit),
                    flags,
                    null(), // lpEnvironment = NULL ⇒ 继承本启动器环境(含 temp 重定向)
                    null(), // lpCurrentDirectory = NULL ⇒ 继承本启动器 cwd(= 实际工作目录)
                    &si as *const _ as *const STARTUPINFOW,
                    &mut pi,
                )
            } else {
                // AC:普通 CreateProcessW,内核按 SECURITY_CAPABILITIES 生成 lowbox 令牌;
                // 环境额外携带 set_offline_env 的断网叠加。
                CreateProcessW(
                    app_wide.as_ptr(),
                    cmdline.as_mut_ptr(),
                    null(),
                    null(),
                    i32::from(inherit),
                    flags,
                    null(),
                    null(),
                    &si as *const _ as *const STARTUPINFOW,
                    &mut pi,
                )
            };
            if !ok(created) {
                return Err(last_error(if network_token.is_some() {
                    "CreateProcessAsUserW(low-integrity token)"
                } else {
                    "CreateProcessW(AppContainer)"
                }));
            }

            // Job Object(KILL_ON_JOB_CLOSE):启动器意外死亡时连带杀子进程,为
            // taskkill /T 之外的兜底。尽力而为,失败仅告警。isolated 常驻进程刻意
            // 不入 Job:它必须在启动器/LiveAgent 亡后继续存活(对齐 Linux bwrap
            // 省略 --die-with-parent)。
            let job = if isolated {
                null_mut()
            } else {
                CreateJobObjectW(null(), null())
            };
            if !job.is_null() {
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if !ok(AssignProcessToJobObject(job, pi.hProcess)) {
                    sandbox_diag(format!(
                        "liveagent sandbox: {}",
                        last_error(
                            "AssignProcessToJobObject (continuing; taskkill /T still cascades)"
                        )
                    ));
                }
            }

            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);

            WaitForSingleObject(pi.hProcess, INFINITE);
            let mut exit_code: u32 = 0;
            let got = GetExitCodeProcess(pi.hProcess, &mut exit_code);
            CloseHandle(pi.hProcess);
            // job 句柄须保持打开直到子进程退出;此刻关闭即可(KILL_ON_JOB_CLOSE 无害)。
            if !job.is_null() {
                CloseHandle(job);
            }
            if !ok(got) {
                return Err(last_error("GetExitCodeProcess"));
            }
            // loader 早期死亡(0xC0000142 等)只体现为裸退出码;补一条可读诊断,经
            // stderr 走既有管道上传(shell_runner 的候选探测回退也依赖这个退出码)。
            if let Some(hint) = loader_failure_hint(exit_code) {
                eprintln!("liveagent sandbox: process exited with {exit_code:#010X}: {hint}");
            }
            exit_code as i32
        };
        Ok(result)
    }
}

// AC profile 名的确定性与硬约束校验只在 Windows 有意义(win 模块整体 cfg(windows)),
// 但公式本身平台无关——为了让 mac/Linux 的开发机与 CI 也能守住它,这里用一份独立的
// 纯逻辑镜像测试(与 win::appcontainer_profile_name 的实现保持字面一致)。
#[cfg(test)]
mod tests {
    /// 镜像 `win::appcontainer_profile_name` + `execute` 里的 dir_key 推导:
    /// AppContainer profile 名硬限制 64 字符,字符集须落在 [0-9A-Za-z._]。
    fn profile_name_for(synthetic_sid: &str) -> String {
        let dir_key = synthetic_sid
            .trim_start_matches("S-1-5-21-")
            .replace('-', "_");
        format!("LiveAgent.Sandbox.{dir_key}")
    }

    #[test]
    fn appcontainer_profile_name_is_deterministic_and_within_limits() {
        // 合成 SID 是 4 段 u32(Codex 形式 S-1-5-21-{4×u32}),取各段极值验证最坏长度。
        let worst = profile_name_for("S-1-5-21-4294967295-4294967295-4294967295-4294967295");
        assert_eq!(
            worst,
            "LiveAgent.Sandbox.4294967295_4294967295_4294967295_4294967295"
        );
        assert!(
            worst.len() <= 64,
            "profile name exceeds AC 64-char limit: {}",
            worst.len()
        );
        assert!(worst
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_'));
        // 同一 SID 恒得同一名(确定性 ⇒ profile 可跨次运行复用)。
        assert_eq!(
            profile_name_for("S-1-5-21-1-2-3-4"),
            profile_name_for("S-1-5-21-1-2-3-4")
        );
        assert_eq!(
            profile_name_for("S-1-5-21-1-2-3-4"),
            "LiveAgent.Sandbox.1_2_3_4"
        );
    }

    #[cfg(windows)]
    mod win_only {
        use super::super::win;

        static SANDBOX_EXEC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        const SANDBOX_ENV_VARS: &[&str] = &[
            "TEMP",
            "TMP",
            "TMPDIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "CARGO_NET_OFFLINE",
            "PIP_NO_INDEX",
            "NPM_CONFIG_OFFLINE",
        ];

        struct SandboxTestGuard {
            _lock: std::sync::MutexGuard<'static, ()>,
            saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
        }

        impl SandboxTestGuard {
            fn acquire() -> Self {
                let lock = SANDBOX_EXEC_LOCK
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let saved = SANDBOX_ENV_VARS
                    .iter()
                    .map(|name| (*name, std::env::var_os(name)))
                    .collect();
                Self { _lock: lock, saved }
            }

            fn restore_env(&self) {
                for (name, value) in &self.saved {
                    if let Some(value) = value {
                        std::env::set_var(name, value);
                    } else {
                        std::env::remove_var(name);
                    }
                }
            }
        }

        impl Drop for SandboxTestGuard {
            fn drop(&mut self) {
                self.restore_env();
            }
        }

        // 真机(Windows)校验:实际 API 派生的 AC SID 确定性 —— 同名两次派生须相等。
        // 该测试不创建 profile(仅 Derive 纯计算),无系统副作用。
        #[test]
        fn derive_appcontainer_sid_is_deterministic() {
            let a = win::appcontainer_profile_sid_for_test("LiveAgent.Sandbox.test_1_2_3_4");
            let b = win::appcontainer_profile_sid_for_test("LiveAgent.Sandbox.test_1_2_3_4");
            assert!(
                a.is_some(),
                "DeriveAppContainerSidFromAppContainerName failed"
            );
            assert_eq!(a, b);
            // AC SID 固定以 S-1-15-2- 开头(APPLICATION PACKAGE AUTHORITY)。
            assert!(a.unwrap().starts_with("S-1-15-2-"));
        }

        #[test]
        fn derive_workspace_capability_sid_is_deterministic() {
            let a = win::workspace_capability_sid_for_test("test_1_2_3_4")
                .expect("derive workspace capability");
            let b = win::workspace_capability_sid_for_test("test_1_2_3_4")
                .expect("derive workspace capability again");
            assert_eq!(a, b);
            assert!(
                a.starts_with("S-1-15-3-1024-"),
                "custom capability SID has unexpected form: {a}"
            );
        }

        // 真机(Windows)校验 0xC0000142 修复:append 后受限令牌的 default DACL 必须
        // 含登录 SID(修复的可断言后置条件;是否“原本就含”因环境而异,不作断言,仅
        // 打印供诊断)。只动测试自建的令牌副本,无系统副作用。
        #[test]
        fn default_dacl_append_adds_logon_sid() {
            let (before, after) =
                win::default_dacl_fix_roundtrip_for_test().expect("roundtrip failed");
            println!("default DACL contained logon SID before append: {before}");
            assert!(
                after,
                "append_sid_to_default_dacl did not add the logon SID"
            );
        }

        fn sandbox_exec(program: &std::path::Path, args: &[String]) -> Result<i32, String> {
            let _guard = SandboxTestGuard::acquire();
            let dir = tempfile::tempdir().expect("workspace");
            win::execute(dir.path(), true, false, program, args)
        }

        /// 真机:cmd 不走 CLR,联网 Low IL token 下必须能作为沙箱 shell 兜底。
        #[test]
        fn networked_sandbox_cmd_exit_zero() {
            let code = sandbox_exec(
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), "exit 0".into()],
            )
            .expect("networked sandbox cmd execute");
            assert_eq!(
                code as u32, 0,
                "cmd under networked sandbox exited {code:#010X}"
            );
        }

        #[test]
        fn networked_sandbox_token_is_not_restricted() {
            win::probe_networked_token()
                .expect("networked sandbox must preserve the user's full logon context");
        }

        #[test]
        fn appcontainer_cmd_exit_zero() {
            let _guard = SandboxTestGuard::acquire();
            let workspace = tempfile::tempdir().expect("workspace");
            let result = win::execute(
                workspace.path(),
                false,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), "exit 0".into()],
            );
            let code = result.expect("AppContainer cmd execute");
            assert_eq!(
                code as u32, 0,
                "cmd under AppContainer sandbox exited {code:#010X}"
            );
        }

        #[test]
        fn legacy_appcontainer_acl_migrates_across_sandbox_modes() {
            let guard = SandboxTestGuard::acquire();
            let workspace = tempfile::tempdir().expect("workspace");
            let read_path = workspace.path().join("read.txt");
            let offline_path = workspace.path().join("offline.txt");
            let online_path = workspace.path().join("online.txt");
            let outside_path = unique_probe(
                workspace.path().parent().expect("workspace parent"),
                "offline-outside",
            );
            let _ = std::fs::remove_file(&outside_path);
            std::fs::write(&read_path, "read-ok").expect("seed readable file");

            let synthetic = crate::runtime::sandbox::synthetic_workspace_sid(workspace.path());
            let dir_key = synthetic.trim_start_matches("S-1-5-21-").replace('-', "_");
            win::seed_legacy_appcontainer_ace_for_test(workspace.path(), &dir_key)
                .expect("seed legacy package SID ACE");

            let online_script = format!(
                "dir /a /b {} >nul && type {} >nul && echo online>{}",
                workspace.path().display(),
                read_path.display(),
                online_path.display(),
            );
            let first_online = win::execute(
                workspace.path(),
                true,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), online_script.clone()],
            )
            .expect("online sandbox should migrate the legacy package SID ACE");
            assert_eq!(first_online as u32, 0);
            assert!(online_path.is_file());
            guard.restore_env();

            let offline_script = format!(
                "echo outside>{} && exit /b 42 || echo offline>{}",
                outside_path.display(),
                offline_path.display(),
            );
            let offline = win::execute(
                workspace.path(),
                false,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), offline_script],
            );
            assert_eq!(offline.expect("offline capability sandbox") as u32, 0);
            assert!(offline_path.is_file());
            assert!(
                !outside_path.exists(),
                "offline capability sandbox wrote outside workspace: {outside_path:?}"
            );
            guard.restore_env();

            std::fs::remove_file(&online_path).expect("reset online probe");
            let second_online = win::execute(
                workspace.path(),
                true,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), online_script],
            )
            .expect("online sandbox after offline capability sandbox");
            assert_eq!(second_online as u32, 0);
            assert!(online_path.is_file());
            let _ = std::fs::remove_file(outside_path);
        }

        /// 真机:从 Git for Windows 的 msys-2.0.dll 算出的对象目录名必须是
        /// `\BaseNamedObjects\msys-2.0S5-` + 16 位 hex(与 cygwin hash_path_name 对齐)。
        #[test]
        fn msys_object_dir_name_from_git_bash() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let names = win::msys_object_dir_names_for_test(bash);
            println!("msys object dirs: {names:?}");
            assert!(
                names
                    .iter()
                    .any(|n| n.starts_with(r"\BaseNamedObjects\msys-2.0S5-")),
                "missing hashed msys BNO directory: {names:?}"
            );
            let key = names[0].rsplit('-').next().expect("hash suffix");
            assert_eq!(key.len(), 16, "install key should be 16 hex chars: {key}");
            assert!(
                key.chars().all(|c| c.is_ascii_hexdigit()),
                "install key should be hex: {key}"
            );
        }

        #[test]
        fn restricted_token_can_open_stamped_msys_dir() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            win::restricted_token_can_open_msys_dir(bash)
                .expect("WRITE_RESTRICTED token should open stamped msys directory");
        }

        /// 真机:Git Bash 在联网 Low IL token 沙箱内必须能启动。
        #[test]
        fn networked_sandbox_git_bash_exit_zero() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let code = sandbox_exec(bash, &["-c".into(), "exit 0".into()])
                .expect("networked sandbox Git Bash execute");
            assert_eq!(
                code as u32, 0,
                "Git Bash under networked sandbox exited {code:#010X}"
            );
        }

        #[test]
        fn networked_sandbox_git_bash_echo() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let code = sandbox_exec(bash, &["-c".into(), "echo sandbox-ok".into()])
                .expect("networked sandbox Git Bash echo");
            assert_eq!(
                code as u32, 0,
                "Git Bash echo under networked sandbox exited {code:#010X}"
            );
        }

        #[test]
        fn low_integrity_label_recovers_from_modify_only_owner_dacl() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let _guard = SandboxTestGuard::acquire();
            let workspace = tempfile::tempdir().expect("workspace");
            win::prepare_modify_only_low_il_probe(workspace.path())
                .expect("modify-only ACL should reproduce ERROR_ACCESS_DENIED");
            let code = win::execute(
                workspace.path(),
                true,
                false,
                bash,
                &["-c".into(), "echo low-il-acl-recovered".into()],
            )
            .expect("launcher should grant minimal WRITE_OWNER and retry");
            assert_eq!(
                code as u32, 0,
                "git bash under modify-only workspace ACL exited {code:#010X}"
            );
        }

        /// 真机:Windows PowerShell 5.1 在联网 Low IL token 沙箱内必须能启动
        /// (CLR/CNG 用户面 + 会话 BNO / BNO isolation)。
        #[test]
        fn networked_sandbox_powershell_exit_zero() {
            let powershell =
                std::path::Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
            if !powershell.is_file() {
                return;
            }
            let code = sandbox_exec(
                powershell,
                &[
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-Command".into(),
                    "exit 0".into(),
                ],
            )
            .expect("networked sandbox PowerShell execute");
            assert_eq!(
                code as u32, 0,
                "PowerShell under networked sandbox exited {code:#010X}"
            );
        }

        fn posix_win_path(path: &std::path::Path) -> String {
            let raw = path.to_string_lossy();
            let trimmed = raw.trim_start_matches(r"\\?\");
            let bytes = trimmed.as_bytes();
            if bytes.len() >= 2 && bytes[1] == b':' {
                let drive = (bytes[0] as char).to_ascii_lowercase();
                let rest = trimmed[2..].replace('\\', "/");
                format!("/{drive}{rest}")
            } else {
                trimmed.replace('\\', "/")
            }
        }

        fn unique_probe(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
            dir.join(format!(
                "liveagent-sandbox-fence-{name}-{}.txt",
                std::process::id()
            ))
        }

        /// 真机:Git Bash 必须能写工作区,但不能写工作区父目录 / 用户 home / 盘符根。
        /// 回归的是 TokenUser 限制性 SID 把“用户可写”路径全部重开的洞。
        #[test]
        fn networked_sandbox_git_bash_write_fence() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let _guard = SandboxTestGuard::acquire();
            let outer = tempfile::tempdir().expect("outer");
            let workspace = outer.path().join("workspace");
            let sibling = outer.path().join("sibling");
            std::fs::create_dir(&workspace).expect("workspace");
            std::fs::create_dir(&sibling).expect("sibling");

            let inside = unique_probe(&workspace, "inside");
            let outside = unique_probe(&sibling, "outside");
            let home_dir = dirs::home_dir().expect("home");
            let home = unique_probe(&home_dir, "home");
            let drive_root = unique_probe(std::path::Path::new(r"D:\"), "drive");
            let _ = std::fs::remove_file(&home);
            let _ = std::fs::remove_file(&drive_root);

            let script = format!(
                "echo inside > '{inside}' || exit 1; \
                 if echo outside > '{outside}'; then exit 42; fi; \
                 if echo home > '{home}'; then exit 43; fi; \
                 if echo drive > '{drive}'; then exit 44; fi; \
                 exit 0",
                inside = posix_win_path(&inside),
                outside = posix_win_path(&outside),
                home = posix_win_path(&home),
                drive = posix_win_path(&drive_root),
            );
            let code = win::execute(&workspace, true, false, bash, &["-c".into(), script])
                .expect("networked sandbox Git Bash write fence");
            let _ = std::fs::remove_file(&home);
            let _ = std::fs::remove_file(&drive_root);
            assert_eq!(
                code as u32, 0,
                "git bash write-fence script exited {code:#010X} \
                 (42=sibling writable, 43=home writable, 44=drive root writable)"
            );
            assert_eq!(
                std::fs::read_to_string(&inside).unwrap_or_default().trim(),
                "inside"
            );
            assert!(
                !outside.exists(),
                "git bash sandbox wrote outside the workspace: {outside:?}"
            );
            assert!(
                !home.exists(),
                "git bash sandbox wrote to the user profile: {home:?}"
            );
            assert!(
                !drive_root.exists(),
                "git bash sandbox wrote to the drive root: {drive_root:?}"
            );
        }

        /// 真机:cmd 的三 SID 严令牌本来就应挡住工作区外写入。
        #[test]
        fn networked_sandbox_cmd_write_fence() {
            let _guard = SandboxTestGuard::acquire();
            let outer = tempfile::tempdir().expect("outer");
            let workspace = outer.path().join("workspace");
            let sibling = outer.path().join("sibling");
            std::fs::create_dir(&workspace).expect("workspace");
            std::fs::create_dir(&sibling).expect("sibling");
            let inside = unique_probe(&workspace, "cmd-inside");
            let outside = unique_probe(&sibling, "cmd-outside");
            let script = format!(
                "echo inside>{0}&echo outside>{1}&exit /b 0",
                inside.display(),
                outside.display()
            );
            win::execute(
                &workspace,
                true,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), script],
            )
            .expect("networked sandbox cmd write fence");
            assert_eq!(
                std::fs::read_to_string(&inside).unwrap_or_default().trim(),
                "inside"
            );
            assert!(
                !outside.exists(),
                "cmd sandbox wrote outside the workspace: {outside:?}"
            );
        }
    }
}
