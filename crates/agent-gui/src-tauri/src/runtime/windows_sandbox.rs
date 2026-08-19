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
//! A. 联网沙箱(`--net on`)= 受限令牌(`CreateProcessAsUserW`)
//! - `CreateRestrictedToken(WRITE_RESTRICTED)`:限制性 SID 只在“写”访问时参与判定,
//!   读/执行跳过第二遍 ⇒ 读广泛放行(工具链可用),写须“常规 SID 放行 且 至少一个
//!   限制性 SID 放行”。
//! - 限制性 SID 集 = {登录 SID(从当前令牌 TokenGroups 按 SE_GROUP_LOGON_ID 读,
//!   逐会话,不可硬编码)、WRITE RESTRICTED SID `S-1-5-33`、一个由工作区路径确定性
//!   推导的合成 SID}。省略 Everyone,否则重开“全局可写目录”漏洞;过紧(仅合成 SID)
//!   会让进程连自己的线程/管道都建不了而启动即死。
//! - 在工作区根 + 一个受围栏的临时目录上盖“可继承(OI)(CI)”的合成-SID 授权写 ACE。
//!   合成 SID 只匹配此工作区,遗留 ACE 惰性无害;绝不移除 ACE(空 DACL 陷阱)。
//! - **令牌 default DACL 补授权(修 0xC0000142)**:`CreateRestrictedToken` 后,受限
//!   令牌的 default DACL 仍只含用户 SID + SYSTEM。子进程新建的命名内核对象(msys/cygwin
//!   的共享内存、signal pipe 等)继承此 DACL;而 msys `DllMain` 需以“写”重开这些对象,
//!   第二遍(限制性 SID)判定失败 ⇒ `DllMain` 返回 FALSE ⇒ loader 报
//!   `STATUS_DLL_INIT_FAILED`(0xC0000142),Git Bash 启动即死。修复:向 default DACL
//!   追加“登录 SID 全权”ACE(登录 SID 同时在两张 SID 表 ⇒ 两遍判定皆过),对齐 Chromium
//!   `AddSidToDefaultDacl`。
//!
//! B. 断网沙箱(`--net off`)= AppContainer(`CreateProcessW` + `SECURITY_CAPABILITIES`)
//! - 零 capability 的 AppContainer:WFP 对无网络 capability 的 AC 默认拒绝**全部**网络
//!   (含 loopback)⇒ 内核级强制断网,无需提权。对比 Codex:unelevated 仅 env 级软断网,
//!   强制断网须提权建专用账号 + 防火墙/WFP 规则。
//! - AC 默认拒绝未授权“读”:系统目录靠自带的 `ALL APPLICATION PACKAGES` ACE 可读(工具链
//!   可用),用户主目录默认不可读 ⇒ 断网变体顺带获得敏感目录读掩蔽(联网后端缺失项)。
//! - 写围栏:对 AC SID 复用同一套授权写 ACE(工作区根 + 受围栏临时目录)。
//! - env 叠加(防御纵深):`HTTP(S)_PROXY=http://127.0.0.1:9`、`CARGO_NET_OFFLINE` 等,让
//!   工具在内核断网之上再快速明确失败(对齐 Codex `env.rs`)。
//!
//! 两后端共用启动尾:`STARTUPINFOEXW` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 只继承 3 个
//! std 句柄(取代 `bInheritHandles=TRUE` 的全句柄表继承,收敛句柄泄漏面);显式
//! `lpDesktop = winsta0\default`(受限令牌/AC 启动必须显式设桌面,否则句柄站点解析歧义);
//! Job Object `KILL_ON_JOB_CLOSE` 在非 isolated 时兜底级联杀,isolated 常驻进程则跳过
//!(对齐 Linux bwrap 省略 `--die-with-parent`);“启动即死”退出码转可读中英诊断经既有
//! 管道上传 —— 含 loader NTSTATUS(0xC0000142/0135/0022)与 CLR 托管初始化失败
//! (0xE0434352)。
//!
//! # 已知限制:两个后端都跑不了托管 shell
//!
//! `WRITE_RESTRICTED` 令牌下,写类访问要过第二遍判定(对象 DACL 必须显式授权给我们的
//! 限制性 SID);`\Device\CNG` 的 DACL 不含它们,故 CNG 初始化失败 ⇒ `BCrypt.dll` 起不来
//! ⇒ 托管运行时抛未处理异常退出 0xE0434352。AppContainer 后端零 capability,同类风险。
//! 受影响的是 pwsh(CoreCLR)与 powershell.exe(.NET Framework);cmd.exe 是纯原生 PE,
//! 不受影响,故沙箱下候选顺序把它提到队首(见 `shell_runner::platform_shell_candidates`)。
//!
//! Chromium 的规避手法(降权前先 warmup RNG/CNG)在此**不适用**:那要求进程先以正常令牌
//! 启动再自我降权,而我们是父进程造好受限令牌后 `CreateProcessAsUserW` 拉起全新 shell,
//! 子进程从第一条指令起就受限,不存在 warmup 窗口。把 `Everyone`(S-1-1-0)塞进限制性 SID
//! 能让 CNG 通过,但那等于第二遍判定对几乎所有对象放行 —— 写围栏当场失效,绝不可取。

/// 非 Windows:自我再执行启动器不存在,空操作。
#[cfg(not(windows))]
pub fn run_sandbox_launcher_if_requested() {}

/// 运行时探测两个 Windows 后端能否真的建出安全上下文(P1#4)。
/// 返回 (受限令牌后端, AppContainer 后端);非 Windows 平台不参与编译。
#[cfg(windows)]
pub(crate) fn probe_backends() -> (Result<(), String>, Result<(), String>) {
    (win::probe_restricted_token(), win::probe_appcontainer())
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
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, HANDLE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        AddAccessAllowedAce, AddAce, CopySid, CreateRestrictedToken, EqualSid, FreeSid, GetAce,
        GetAclInformation, GetLengthSid, GetTokenInformation, InitializeAcl, SetTokenInformation,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, SECURITY_CAPABILITIES,
        SID_AND_ATTRIBUTES, TOKEN_DEFAULT_DACL, TOKEN_GROUPS,
    };
    use windows_sys::Win32::System::Console::GetStdHandle;
    use windows_sys::Win32::System::Environment::SetEnvironmentVariableW;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
        GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread,
        UpdateProcThreadAttribute, WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOEXW,
        STARTUPINFOW,
    };

    // 以本地常量代替对 windows-sys 各 feature 常量导出的依赖:字段类型均为整型别名
    // (windows-sys 用 type alias 而非 newtype),直接赋整型字面量即可,极大降低
    // “某常量是否在某 feature 下导出”的编译风险。数值均取自 Win32 头文件。
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_DUPLICATE: u32 = 0x0002;
    const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
    const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;

    const DISABLE_MAX_PRIVILEGE: u32 = 0x1;
    const LUA_TOKEN: u32 = 0x4;
    const WRITE_RESTRICTED: u32 = 0x8;

    const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
    const TOKEN_GROUPS_CLASS: i32 = 2; // TOKEN_INFORMATION_CLASS::TokenGroups
    const TOKEN_DEFAULT_DACL_CLASS: i32 = 6; // TOKEN_INFORMATION_CLASS::TokenDefaultDacl

    const SE_FILE_OBJECT: i32 = 1; // SE_OBJECT_TYPE
    const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    const OBJECT_INHERIT_ACE: u32 = 0x1;
    const CONTAINER_INHERIT_ACE: u32 = 0x2;
    const GRANT_ACCESS: i32 = 1; // ACCESS_MODE
    const TRUSTEE_IS_SID: i32 = 0; // TRUSTEE_FORM
    const TRUSTEE_IS_UNKNOWN: i32 = 0; // TRUSTEE_TYPE
    const ACL_SIZE_INFORMATION_CLASS: i32 = 2; // ACL_INFORMATION_CLASS::AclSizeInformation
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACL_REVISION: u32 = 2;
    const GENERIC_ALL: u32 = 0x1000_0000;

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

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS: i32 = 9; // JobObjectExtendedLimitInformation

    const WRITE_RESTRICTED_SID: &str = "S-1-5-33";

    // loader 早期失败的 NTSTATUS 退出码——子进程根本没进 main 就被内核/加载器杀死。
    // 用于把裸退出码翻成可读诊断(见 sandbox_exit_hint)。
    const STATUS_DLL_INIT_FAILED: u32 = 0xC000_0142;
    const STATUS_DLL_NOT_FOUND: u32 = 0xC000_0135;
    const STATUS_ACCESS_DENIED: u32 = 0xC000_0022;
    /// CLR 未处理托管异常。loader 已通过、CLR 原生部分已起来,死在托管层。
    const COMPLUS_E_UNHANDLED: u32 = 0xE043_4352;

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

    fn string_to_sid(s: &str) -> Result<LocalSid, String> {
        let wide = to_wide(s);
        let mut sid: PSID = null_mut();
        let r = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if !ok(r) || sid.is_null() {
            return Err(last_error(&format!("ConvertStringSidToSidW({s})")));
        }
        Ok(LocalSid(sid))
    }

    /// 打开当前进程的主令牌(建受限令牌需 DUPLICATE|QUERY;附带 ASSIGN_PRIMARY|
    /// ADJUST_DEFAULT 与 Chromium 一致,便于后续以其派生的令牌启动进程)。
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

    /// 用 {登录 SID, S-1-5-33, 合成 SID} 作限制性 SID,建 WRITE_RESTRICTED 主令牌。
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

    /// 向受限令牌的 default DACL 追加「登录 SID 全权」ACE(0xC0000142 修复核心)。
    ///
    /// 受限令牌复制了基令牌的 default DACL(仅用户 SID + SYSTEM)。子进程新建的内核
    /// 对象(msys/cygwin 共享内存、signal pipe、事件等)套用该 DACL;WRITE_RESTRICTED
    /// 令牌以“写”重开它们时第二遍(限制性 SID)判定无一命中 ⇒ 拒绝 ⇒ msys `DllMain`
    /// 失败 ⇒ loader 杀进程报 STATUS_DLL_INIT_FAILED。登录 SID 同时位于常规组表和
    /// 限制性 SID 表,把它写进 default DACL 后两遍判定皆过(对齐 Chromium
    /// `AddSidToDefaultDacl`)。GENERIC_ALL 只作用于“该进程自建”的对象,不放宽文件写围栏。
    fn append_sid_to_default_dacl(token: HANDLE, sid: PSID) -> Result<(), String> {
        const ACL_APPEND_AT_END: u32 = 0xFFFF_FFFF; // MAXDWORD ⇒ AddAce 追加到尾部
        unsafe {
            let mut len: u32 = 0;
            GetTokenInformation(token, TOKEN_DEFAULT_DACL_CLASS, null_mut(), 0, &mut len);
            if len == 0 {
                return Err(last_error("GetTokenInformation(TokenDefaultDacl) size probe"));
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

    /// 取(必要时创建)工作区专属 AppContainer profile 的 SID。
    ///
    /// 零 capability ⇒ WFP 默认拒绝全部网络含 loopback。Create 失败(典型:已存在)
    /// 即走 Derive;二者都失败才报错(fail-closed)。Profile 留存不删:确定性名字
    /// 下次直接复用,与写 ACE 的“遗留惰性无害”策略一致。
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
        let mut sid2: PSID = null_mut();
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid2) };
        if derived == 0 && !sid2.is_null() {
            return Ok(AcSid(sid2));
        }
        Err(format!(
            "AppContainer profile unavailable: CreateAppContainerProfile hr={created:#010X}, \
             DeriveAppContainerSidFromAppContainerName hr={derived:#010X}"
        ))
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
                InitializeProcThreadAttributeList(buf.as_mut_ptr() as *mut c_void, count, 0, &mut size)
            };
            if !ok(r) {
                return Err(last_error("InitializeProcThreadAttributeList"));
            }
            Ok(Self { buf })
        }

        fn ptr(&mut self) -> *mut c_void {
            self.buf.as_mut_ptr() as *mut c_void
        }

        fn set(&mut self, attribute: usize, value: *const c_void, size: usize, ctx: &str) -> Result<(), String> {
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

    /// 子进程“启动即死”的退出码 → 可读诊断(中英双语,经 stderr 走既有管道上传给
    /// 模型/UI;裸退出码对用户与模型都不可行动)。
    ///
    /// 覆盖两个失败层:loader 早期死亡(未进 main 的 NTSTATUS),以及 CLR 托管初始化
    /// 失败(0xE0434352,loader 已过)。两者 `shell_runner` 侧都算沙箱不兼容并推进候选链。
    fn sandbox_exit_hint(exit_code: u32) -> Option<&'static str> {
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
            COMPLUS_E_UNHANDLED => Some(
                "the .NET runtime threw an unhandled exception during startup (0xE0434352). This is \
                 not a broken install: the loader and the native CLR came up fine, then managed \
                 init failed - typically BCrypt/CNG, which a WRITE_RESTRICTED token or an \
                 AppContainer cannot open for write. Managed shells (pwsh = CoreCLR, \
                 powershell.exe = .NET Framework) are therefore structurally unreliable in this \
                 mode; the shell runner falls back to cmd.exe, the only fully native candidate. \
                 / .NET 运行时在启动阶段抛出未处理异常(0xE0434352)。这不是安装损坏:loader 与 \
                 CLR 原生部分都已正常起来,随后托管初始化失败——通常是 BCrypt/CNG,而受限令牌\
                 (WRITE_RESTRICTED)或 AppContainer 无法以写方式打开它。故托管 shell(pwsh 为 \
                 CoreCLR、powershell.exe 为 .NET Framework)在此模式下结构性不可靠,shell 将回退到\
                 唯一纯原生的候选 cmd.exe",
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

    /// 目录根 DACL 上是否已含合成 SID 的 ACE。命中即认为整棵树已盖章(可继承 ACE 会
    /// 自动传播到后建的文件),跳过昂贵的重新传播。任何探测失败按“未盖章”处理。
    fn root_has_ace(path_wide: &[u16], sid: PSID) -> bool {
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                SE_FILE_OBJECT,
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

    /// 在 path 上盖“可继承(OI)(CI)”的合成-SID 授权写 ACE(不存在才盖)。
    ///
    /// 为何只授不撤(P3#8,已知取舍,非疏漏):
    /// - 受托 SID 由工作区路径确定性推导 ⇒ 每个工作区**最多一条** ACE(`root_has_ace`
    ///   幂等守卫),不随运行次数累积;
    /// - 该 SID 不映射任何活跃主体,遗留 ACE 不授予任何真实用户额外权限(惰性无害);
    /// - 同一工作区可能有多个沙箱进程并发存活(Bash + ManagedProcess + resumable
    ///   session),按进程退出撤销会打断仍在运行的兄弟进程的写围栏;
    /// - `SetNamedSecurityInfoW` 回写“撤销后的 DACL”还会踩空 DACL 陷阱(见上方
    ///   `old_dacl.is_null()` 分支)。
    ///
    /// 代价是资源管理器的权限页会显示一个无法解析的 S-1-5-21-* 项,且卸载不清理。
    /// 若要提供清理,应做成显式的“清理沙箱 ACE”运维动作(遍历工作区列表按合成 SID
    /// 精确删除),而不是塞进单次命令的生命周期里。
    fn ensure_write_ace(path: &Path, sid: PSID) -> Result<(), String> {
        let mut path_wide = to_wide(&path.to_string_lossy());
        if root_has_ace(&path_wide, sid) {
            return Ok(());
        }
        unsafe {
            let mut old_dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 {
                return Err(format!("GetNamedSecurityInfoW failed (error={rc})"));
            }

            // NULL DACL = 隐式“everyone 全权”:受限令牌的合成 SID 本就被授予写,无需盖章;
            // 若仍用 SetEntriesInAclW(oldacl=NULL) 生成“仅合成 SID”的 DACL 再回写,反而把
            // 正常(无沙箱)访问锁死。故此情形直接跳过。
            if old_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Ok(());
            }

            let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
            ea.grfAccessPermissions =
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE_RIGHT;
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
                return Err(format!("SetEntriesInAclW failed (error={rc})"));
            }

            let rc = SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                SE_FILE_OBJECT,
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
                return Err(format!("SetNamedSecurityInfoW failed (error={rc})"));
            }
        }
        Ok(())
    }

    /// 创建并盖章一个受围栏的临时目录(系统 temp 下,按工作区确定性命名),把
    /// TEMP/TMP/TMPDIR 指向它——否则沙箱进程写默认 %TEMP% 会被限制性判定拒绝。
    fn setup_fenced_temp(write_root: &Path, sid: PSID, dir_key: &str) -> Result<(), String> {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

        let base = std::env::temp_dir().join(format!("liveagent-sandbox-{dir_key}"));
        std::fs::create_dir_all(&base)
            .map_err(|err| format!("create fenced temp dir failed: {err}"))?;
        // 路径确定性且可预测 ⇒ 另一同用户进程可能抢先把它建成 junction/symlink 指向敏感
        // 目录,使授权写 ACE 盖到目标、TEMP 重定向落进目标。拒绝 reparse point 以堵此路
        //(残留 TOCTOU:盖章/使用之间的替换需另一恶意同用户进程,严重度低)。
        let meta = std::fs::symlink_metadata(&base)
            .map_err(|err| format!("stat fenced temp dir failed: {err}"))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("fenced temp dir is a reparse point; refusing to stamp".to_string());
        }
        ensure_write_ace(&base, sid)?;
        let _ = write_root; // 保留签名清晰度;temp 独立于工作区。
        let base_wide = to_wide(&base.to_string_lossy());
        for name in ["TEMP", "TMP", "TMPDIR"] {
            let name_wide = to_wide(name);
            unsafe {
                if !ok(SetEnvironmentVariableW(name_wide.as_ptr(), base_wide.as_ptr())) {
                    return Err(last_error(&format!("SetEnvironmentVariableW({name})")));
                }
            }
        }
        Ok(())
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

    /// 运行时探测:联网后端(受限令牌)能否真的建起来。
    ///
    /// 走与 `execute` 完全相同的调用序列(打开主令牌 → 读登录 SID →
    /// `CreateRestrictedToken(WRITE_RESTRICTED)` → 补 default DACL),只是不启动进程。
    /// 组策略、EDR hook、受限 SKU 会让其中任一步在真机失败;探测把失败提前反映到
    /// `capability().supported`,从而让 `wrap_command` 的 fail-closed 守卫在 Windows
    /// 上真正可达(此前硬编码 `supported: true`,该守卫恒不触发)。
    /// 令牌句柄经 `OwnedHandle` 立即释放,无系统级副作用。
    pub(super) fn probe_restricted_token() -> Result<(), String> {
        // 探测用合成 SID:任取一个确定性路径键即可,不落任何文件系统 ACE。
        let synthetic_str =
            crate::runtime::sandbox::synthetic_workspace_sid(Path::new("liveagent-sandbox-probe"));
        let synthetic = string_to_sid(&synthetic_str)?;
        let write_restricted = string_to_sid(WRITE_RESTRICTED_SID)?;
        let token = OwnedHandle(open_process_token()?);
        let logon = logon_sid_bytes(token.0)?;
        let logon_ptr = logon.as_ptr() as PSID;
        let restricting: [PSID; 3] = [logon_ptr, write_restricted.0, synthetic.0];
        let restricted = OwnedHandle(create_restricted_token(token.0, &restricting)?);
        append_sid_to_default_dacl(restricted.0, logon_ptr)?;
        Ok(())
    }

    /// 运行时探测:断网后端(AppContainer)能否派生 AC SID。纯派生,不创建 profile,
    /// 无系统副作用;失败 ⇒ 仅 `network_control=false`(联网写围栏仍可用)。
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
            build_command_line, resolve_program_in_path, synthetic_workspace_sid,
            validate_workspace,
        };

        // P3#8:启动器是独立进程,不能依赖父进程侧 wrap_command 已做过校验——两个入口
        // 必须共用同一套前置条件,否则任一侧演进就会漂移出 fail-closed 不对称。
        // (幂等纯校验,重复执行无副作用。)
        validate_workspace(write_root)?;

        let synthetic_str = synthetic_workspace_sid(write_root);
        // temp 目录 / AC profile 名沿用合成 SID 的数值段,确定性且文件系统安全。
        let dir_key = synthetic_str.trim_start_matches("S-1-5-21-").replace('-', "_");

        // --- 后端安全上下文 ---
        // fence_sid = 文件写 ACE 的受托 SID(联网=合成 SID,断网=AC SID)。持有其内存的
        // RAII(synthetic / ac_sid / restricted_token)全部声明在函数最外层,存活到
        // CreateProcess* 之后,尾部统一析构。
        let synthetic;
        let ac_sid;
        let restricted_token: Option<OwnedHandle>;
        let fence_sid: PSID;
        if allow_network {
            // 受限令牌后端:{登录 SID, S-1-5-33, 合成 SID} 三限制性 SID。
            synthetic = string_to_sid(&synthetic_str)?;
            let write_restricted = string_to_sid(WRITE_RESTRICTED_SID)?;
            let token = OwnedHandle(open_process_token()?);
            // logon SID 缺失时不能保证进程能操作自有内核对象,fail-closed。
            let logon = logon_sid_bytes(token.0)?;
            let logon_ptr = logon.as_ptr() as PSID;
            let restricting: [PSID; 3] = [logon_ptr, write_restricted.0, synthetic.0];
            let rt = OwnedHandle(create_restricted_token(token.0, &restricting)?);
            // 0xC0000142 修复:default DACL 追加登录 SID,让子进程自建的命名内核对象
            // (msys/cygwin 共享内存、signal pipe)过得了写受限的第二遍判定。
            append_sid_to_default_dacl(rt.0, logon_ptr)?;
            restricted_token = Some(rt);
            fence_sid = synthetic.0;
        } else {
            // AppContainer 后端:零 capability ⇒ WFP 内核级全断网(含 loopback)。
            ac_sid = appcontainer_profile_sid(&dir_key)?;
            set_offline_env()?;
            restricted_token = None;
            fence_sid = ac_sid.0;
        }

        // --- 文件系统写围栏(受托人 = fence_sid) ---
        ensure_write_ace(write_root, fence_sid)?;
        setup_fenced_temp(write_root, fence_sid, &dir_key)?;

        // --- 标准句柄 + 命令行 ---
        let (h_in, h_out, h_err) = inheritable_std_handles()?;

        // lpApplicationName 必须是绝对路径:CreateProcess* 对“部分名”只按当前目录
        // (= 工作区,模型可写)补全且不查 PATH。用 PATH 里的绝对目录预解析,绝不搜工作区
        //  —— 既保证系统 shell 能找到,又杜绝工作区投毒的同名二进制被当作 shell 执行。
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
        let program_str = program.to_string_lossy(); // argv[0] 保留原始名(对齐非沙箱路径)
        let app_wide = to_wide(&resolved.to_string_lossy()); // lpApplicationName = 解析出的绝对路径
        let mut cmdline = build_command_line(&program_str, args); // 已含结尾 NUL

        // --- STARTUPINFOEXW:显式桌面 + 白名单句柄继承(+ AC capabilities) ---
        // 受限令牌/AC 启动必须显式指定桌面:NULL 交由系统推断,在受限上下文下解析
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
        let sec_caps = SECURITY_CAPABILITIES {
            AppContainerSid: fence_sid,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };

        let attr_count = if allow_network { 1 } else { 2 };
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
            let created = if let Some(rt) = &restricted_token {
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
                return Err(last_error(if restricted_token.is_some() {
                    "CreateProcessAsUserW"
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
                    eprintln!(
                        "liveagent sandbox: {}",
                        last_error("AssignProcessToJobObject (continuing; taskkill /T still cascades)")
                    );
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
            // 启动即死(0xC0000142 等 loader NTSTATUS、或 CLR 的 0xE0434352)只体现为裸
            // 退出码;补一条可读诊断,经 stderr 走既有管道上传(shell_runner 的候选探测
            // 回退也依赖这个退出码)。
            if let Some(hint) = sandbox_exit_hint(exit_code) {
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
        let dir_key = synthetic_sid.trim_start_matches("S-1-5-21-").replace('-', "_");
        format!("LiveAgent.Sandbox.{dir_key}")
    }

    #[test]
    fn appcontainer_profile_name_is_deterministic_and_within_limits() {
        // 合成 SID 是 4 段 u32(Codex 形式 S-1-5-21-{4×u32}),取各段极值验证最坏长度。
        let worst = profile_name_for("S-1-5-21-4294967295-4294967295-4294967295-4294967295");
        assert_eq!(worst, "LiveAgent.Sandbox.4294967295_4294967295_4294967295_4294967295");
        assert!(worst.len() <= 64, "profile name exceeds AC 64-char limit: {}", worst.len());
        assert!(worst
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_'));
        // 同一 SID 恒得同一名(确定性 ⇒ profile 可跨次运行复用)。
        assert_eq!(
            profile_name_for("S-1-5-21-1-2-3-4"),
            profile_name_for("S-1-5-21-1-2-3-4")
        );
        assert_eq!(profile_name_for("S-1-5-21-1-2-3-4"), "LiveAgent.Sandbox.1_2_3_4");
    }

    #[cfg(windows)]
    mod win_only {
        use super::super::win;

        // 真机(Windows)校验:实际 API 派生的 AC SID 确定性 —— 同名两次派生须相等。
        // 该测试不创建 profile(仅 Derive 纯计算),无系统副作用。
        #[test]
        fn derive_appcontainer_sid_is_deterministic() {
            let a = win::appcontainer_profile_sid_for_test("LiveAgent.Sandbox.test_1_2_3_4");
            let b = win::appcontainer_profile_sid_for_test("LiveAgent.Sandbox.test_1_2_3_4");
            assert!(a.is_some(), "DeriveAppContainerSidFromAppContainerName failed");
            assert_eq!(a, b);
            // AC SID 固定以 S-1-15-2- 开头(APPLICATION PACKAGE AUTHORITY)。
            assert!(a.unwrap().starts_with("S-1-15-2-"));
        }

        // 真机(Windows)校验 0xC0000142 修复:append 后受限令牌的 default DACL 必须
        // 含登录 SID(修复的可断言后置条件;是否“原本就含”因环境而异,不作断言,仅
        // 打印供诊断)。只动测试自建的令牌副本,无系统副作用。
        #[test]
        fn default_dacl_append_adds_logon_sid() {
            let (before, after) =
                win::default_dacl_fix_roundtrip_for_test().expect("roundtrip failed");
            println!("default DACL contained logon SID before append: {before}");
            assert!(after, "append_sid_to_default_dacl did not add the logon SID");
        }
    }
}
