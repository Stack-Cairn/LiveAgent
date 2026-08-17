//! Windows 沙箱启动器(自我再执行模型,免管理员 / 免 UAC)。
//!
//! `sandbox::wrap_command`(Windows)不直接返回真实命令,而是把它包成对本 exe 的
//! 再调用:`current_exe __sandbox_exec --write-root <root> -- <program> <args...>`。
//! 进程启动最早期(`lib::run` 首行)调用 `run_sandbox_launcher_if_requested`:若检出
//! 该子命令,就地建立“写受限”令牌并 `CreateProcessAsUserW` 真实命令,等待其退出,以
//! 其退出码退出——绝不返回去初始化 Tauri。
//!
//! 写围栏机制(见 memory `windows-sandbox-facts`,均已研究+对抗验证):
//! - `CreateRestrictedToken(WRITE_RESTRICTED)`:限制性 SID 只在“写”访问时参与判定,
//!   读/执行跳过第二遍 ⇒ 读广泛放行(工具链可用),写须“常规 SID 放行 且 至少一个
//!   限制性 SID 放行”。
//! - 限制性 SID 集 = {登录 SID(从当前令牌 TokenGroups 按 SE_GROUP_LOGON_ID 读,
//!   逐会话,不可硬编码)、WRITE RESTRICTED SID `S-1-5-33`、一个由工作区路径确定性
//!   推导的合成 SID}。省略 Everyone,否则重开“全局可写目录”漏洞;过紧(仅合成 SID)
//!   会让进程连自己的线程/管道都建不了而启动即死。
//! - 在工作区根 + 一个受围栏的临时目录上盖“可继承(OI)(CI)”的合成-SID 授权写 ACE。
//!   合成 SID 只匹配此工作区,遗留 ACE 惰性无害;绝不移除 ACE(空 DACL 陷阱)。
//!
//! 免管理员的固有边界:无法掩蔽敏感目录的“读”,无法可靠断网——故 Windows 上
//! `sandboxOffline` 不可用,`wrap_command` 已对 `!allow_network` fail-closed。
//!
//! 已知残留(严重度低,有界):`CreateProcessAsUserW` 用 `bInheritHandles=TRUE`,会把
//! 启动器此刻**所有**可继承句柄一并传给子进程,而非仅 stdin/stdout/stderr。因本启动器
//! 在 `lib::run` 首行、Tauri 初始化前即执行,此时除 shell_runner 建好的管道标准句柄外
//! 并无其它句柄打开,暴露面很小。彻底收敛需 `STARTUPINFOEX` +
//! `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 只继承这三个句柄——因无法在本机真机验证该段
//! 新 FFI,暂不引入,留作后续在 Windows 上验证后再加固。

/// 非 Windows:自我再执行启动器不存在,空操作。
#[cfg(not(windows))]
pub fn run_sandbox_launcher_if_requested() {}

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
        Ok(inv) => match win::execute(&inv.write_root, &inv.program, &inv.args) {
            Ok(code) => code,
            Err(err) => {
                // fail-closed:已进入沙箱启动器分支,任何建令牌/派生失败都必须让命令
                // 整体不执行,绝不回退到无沙箱运行。
                eprintln!("liveagent sandbox launcher failed: {err}");
                127
            }
        },
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
    use windows_sys::Win32::Security::{
        CopySid, CreateRestrictedToken, EqualSid, GetAce, GetAclInformation, GetLengthSid,
        GetTokenInformation, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION,
        SID_AND_ATTRIBUTES, TOKEN_GROUPS,
    };
    use windows_sys::Win32::System::Console::GetStdHandle;
    use windows_sys::Win32::System::Environment::SetEnvironmentVariableW;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
        ResumeThread, WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOW,
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

    const SE_FILE_OBJECT: i32 = 1; // SE_OBJECT_TYPE
    const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    const OBJECT_INHERIT_ACE: u32 = 0x1;
    const CONTAINER_INHERIT_ACE: u32 = 0x2;
    const GRANT_ACCESS: i32 = 1; // ACCESS_MODE
    const TRUSTEE_IS_SID: i32 = 0; // TRUSTEE_FORM
    const TRUSTEE_IS_UNKNOWN: i32 = 0; // TRUSTEE_TYPE
    const ACL_SIZE_INFORMATION_CLASS: i32 = 2; // ACL_INFORMATION_CLASS::AclSizeInformation
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    // 文件访问权掩码(标准值);DELETE 本地定义以回避导入位置歧义。
    const FILE_GENERIC_READ: u32 = 0x0012_0089;
    const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
    const FILE_GENERIC_EXECUTE: u32 = 0x0012_00A0;
    const DELETE_RIGHT: u32 = 0x0001_0000;

    const HANDLE_FLAG_INHERIT: u32 = 0x1;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6; // (DWORD)-10
    const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5; // -11
    const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4; // -12

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS: i32 = 9; // JobObjectExtendedLimitInformation

    const WRITE_RESTRICTED_SID: &str = "S-1-5-33";

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

    pub(super) fn execute(
        write_root: &Path,
        program: &Path,
        args: &[String],
    ) -> Result<i32, String> {
        use crate::runtime::sandbox::{
            build_command_line, resolve_program_in_path, synthetic_workspace_sid,
        };

        let synthetic_str = synthetic_workspace_sid(write_root);
        // temp 目录名沿用合成 SID 的数值段,确定性且文件系统安全。
        let dir_key = synthetic_str.trim_start_matches("S-1-5-21-").replace('-', "_");

        // --- SID 准备 ---
        let synthetic = string_to_sid(&synthetic_str)?;
        let write_restricted = string_to_sid(WRITE_RESTRICTED_SID)?;
        let token = open_process_token()?;
        let logon = logon_sid_bytes(token);
        // logon SID 缺失时不能保证进程能操作自有内核对象,fail-closed。
        let logon = match logon {
            Ok(bytes) => bytes,
            Err(err) => {
                unsafe { CloseHandle(token) };
                return Err(err);
            }
        };
        let logon_ptr = logon.as_ptr() as PSID;

        let restricting: [PSID; 3] = [logon_ptr, write_restricted.0, synthetic.0];
        let restricted_token = match create_restricted_token(token, &restricting) {
            Ok(t) => t,
            Err(err) => {
                unsafe { CloseHandle(token) };
                return Err(err);
            }
        };
        unsafe { CloseHandle(token) };

        // --- 文件系统写围栏 ---
        let stamp = ensure_write_ace(write_root, synthetic.0)
            .and_then(|_| setup_fenced_temp(write_root, synthetic.0, &dir_key));
        if let Err(err) = stamp {
            unsafe { CloseHandle(restricted_token) };
            return Err(err);
        }

        // --- 标准句柄 + 命令行 ---
        let (h_in, h_out, h_err) = inheritable_std_handles()?;

        // lpApplicationName 必须是绝对路径:CreateProcessAsUserW 对“部分名”只按当前目录
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

        // --- 启动子进程(挂起态,便于先入 Job 再放行) ---
        let result = unsafe {
            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = h_in;
            si.hStdOutput = h_out;
            si.hStdError = h_err;

            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let created = CreateProcessAsUserW(
                restricted_token,
                app_wide.as_ptr(),
                cmdline.as_mut_ptr(),
                null(),
                null(),
                1, // bInheritHandles = TRUE
                CREATE_NO_WINDOW | CREATE_SUSPENDED,
                null(),     // lpEnvironment = NULL ⇒ 子进程继承本启动器环境(含代理/temp 重定向)
                null(),     // lpCurrentDirectory = NULL ⇒ 继承本启动器 cwd(= 实际工作目录)
                &si,
                &mut pi,
            );
            if !ok(created) {
                return Err(last_error("CreateProcessAsUserW"));
            }

            // Job Object(KILL_ON_JOB_CLOSE):启动器意外死亡时连带杀子进程,为
            // taskkill /T 之外的兜底。尽力而为,失败仅告警。
            let job = CreateJobObjectW(null(), null());
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
            exit_code as i32
        };

        unsafe { CloseHandle(restricted_token) };
        Ok(result)
    }
}
