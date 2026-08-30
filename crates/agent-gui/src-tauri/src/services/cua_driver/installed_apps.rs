//! 已安装应用枚举，供输入框 @ 提及（computer use 的操作目标）。
//!
//! 语义是「已安装」而不是「正在运行」——cua-driver 自己的 `list_apps`
//! 报告的是运行中的进程，而 @ 提及要的是"打开 Safari 做…"这类还没
//! 启动的目标，所以宿主自己扫应用目录。
//!
//! macOS：扫 `/Applications`、`/System/Applications` 与 `~/Applications`
//! 的顶层 `.app` bundle，读 `Contents/Info.plist` 取 bundle id 与显示名。
//!
//! Windows：扫系统与用户两处开始菜单 `Programs` 目录下的 `.lnk` 快捷
//! 方式（这正是"用户可启动的已安装应用"的用户认知边界），解析快捷方式
//! 拿到目标 `.exe` 的绝对路径作稳定身份——Windows 没有 bundle id，
//! `bundle_id` 留空，前端整条链路（token/身份键/图标注册表）本就以
//! path 兜底。MSIX/UWP 应用不在开始菜单放 `.lnk`，暂不覆盖。
//!
//! 其他平台返回空列表——cua-driver 在那些平台上按进程名/窗口寻址，
//! 没有等价的"已安装应用"稳定标识，前端对空列表的行为就是不显示应用
//! 分组，无需平台分支。
//!
//! 图标一律交给系统 API 统一取（macOS `NSWorkspace.iconForFile`、
//! Windows `SHGetFileInfoW`）而不是自己解 `.icns`/`.ico`：现代应用的
//! 图标常在 Assets.car / 资源段里，清单字段根本不存在，只有系统 API
//! 能统一取到。取回后转 32px PNG data URL（弹层行渲染 16 逻辑像素，
//! 32 物理像素覆盖 retina/高 DPI），随列表一次性返回——列表在会话内
//! 只取一次，几百 KB 的一次性载荷可接受，换来前端零额外往返。
//!
//! 宿主自己（LiveAgent.app）被有意从结果中剔除：`cuaSelfGuard` 会拒绝
//! 一切以宿主为目标的操作，把它留在候选里等于让用户选一个必然失败的项。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub name: String,
    /// macOS bundle id。理论上 Info.plist 可以缺失它；此时不返回该项，
    /// 因为没有稳定身份的应用无法被 CUA 工具可靠寻址。
    pub bundle_id: String,
    pub path: String,
    /// `data:image/png;base64,…` 形式的应用图标；取不到时省略，前端
    /// 回退到通用应用占位图标。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
}

/// 枚举已安装应用，按名称排序、按稳定身份去重。
///
/// `exclude_bundle_id` 是宿主自己的 bundle id（来自 tauri 配置），在
/// macOS 上恒被剔除，见模块注释；Windows 没有 bundle id 概念，宿主按
/// 当前进程的 exe 路径剔除，该参数不参与。
pub fn list_installed_apps(exclude_bundle_id: &str) -> Vec<InstalledApp> {
    #[cfg(target_os = "macos")]
    {
        list_macos_apps(exclude_bundle_id)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = exclude_bundle_id;
        windows::list_windows_apps()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = exclude_bundle_id;
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn list_macos_apps(exclude_bundle_id: &str) -> Vec<InstalledApp> {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    let mut roots: Vec<PathBuf> = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }

    // BTreeMap 一步拿到"按 bundle id 去重 + 稳定序"。用户目录排在系统
    // 目录之后，同 id 时保留先见的系统安装路径。
    let mut by_bundle_id: BTreeMap<String, InstalledApp> = BTreeMap::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            let Some(app) = read_macos_app_bundle(&path) else {
                continue;
            };
            if app.bundle_id.eq_ignore_ascii_case(exclude_bundle_id) {
                continue;
            }
            by_bundle_id.entry(app.bundle_id.clone()).or_insert(app);
        }
    }

    let mut apps: Vec<InstalledApp> = by_bundle_id.into_values().collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[cfg(target_os = "macos")]
fn read_macos_app_bundle(path: &std::path::Path) -> Option<InstalledApp> {
    let info = plist::Value::from_file(path.join("Contents/Info.plist")).ok()?;
    let dict = info.as_dictionary()?;
    let string_of = |key: &str| {
        dict.get(key)
            .and_then(|value| value.as_string())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let bundle_id = string_of("CFBundleIdentifier")?;
    // 显示名优先；bundle 目录名（去掉 .app）永远存在，作最终兜底。
    let name = string_of("CFBundleDisplayName")
        .or_else(|| string_of("CFBundleName"))
        .or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned)
        })?;
    Some(InstalledApp {
        name,
        bundle_id,
        icon_data_url: macos_app_icon_data_url(path),
        path: path.to_string_lossy().into_owned(),
    })
}

/// 应用图标 → 32px PNG data URL。见模块注释：必须走 NSWorkspace，
/// Assets.car 时代自己解 .icns 会大面积取不到图标。
///
/// 提取路径是 `CGImageForProposedRect(32×32)` → `NSBitmapImageRep` →
/// PNG：NSImage 会按 proposed rect 只解码最匹配的那一档分辨率。不要换回
/// `TIFFRepresentation`——它把 16→1024 全部分辨率都物化（实测 15 个应用
/// 1GB / 8 秒），而这条路径全程 <1 秒。
///
/// AppKit 的图像对象没有标注 Send/Sync，全程只在当前调用栈上使用、不跨
/// 线程持有；iconForFile 与位图转换都是无 UI 的解码操作，允许后台线程
/// 调用（NSImage 线程安全清单），配合调用方的 spawn_blocking 安全。
#[cfg(target_os = "macos")]
fn macos_app_icon_data_url(path: &std::path::Path) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    /// 弹层行渲染 16 逻辑像素；32 物理像素在 retina 下 1:1。
    const TARGET_PIXELS: f64 = 32.0;

    let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path.to_str()?));
    let mut proposed = NSRect {
        origin: NSPoint { x: 0.0, y: 0.0 },
        size: NSSize {
            width: TARGET_PIXELS,
            height: TARGET_PIXELS,
        },
    };
    let cg_image = unsafe { icon.CGImageForProposedRect_context_hints(&mut proposed, None, None) }?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg_image);
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(png.to_vec())
    ))
}

/// MS-SHLLINK（`.lnk`）的最小子集解析：只提取目标绝对路径。
///
/// 纯字节解析、不碰任何 Windows API，因此无条件编译——单元测试在
/// macOS/Linux CI 上照跑。取路径的优先级与 shell 的解析一致：
/// LinkInfo 的 LocalBasePath（Unicode 偏移优先，ANSI 兜底）→
/// ExtraData 的 EnvironmentVariableDataBlock（安装器常用
/// `%ProgramFiles%\…` 形态，需展开环境变量）。两者都没有（如指向
/// shell 对象的快捷方式）则放弃该项。
#[allow(dead_code)]
mod lnk {
    const HEADER_SIZE: usize = 0x4C;
    /// LinkCLSID 00021401-0000-0000-C000-000000000046 的磁盘字节序
    /// （Data1-3 小端，Data4 原序）。
    const LINK_CLSID: [u8; 16] = [
        0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x46,
    ];

    const HAS_LINK_TARGET_ID_LIST: u32 = 1 << 0;
    const HAS_LINK_INFO: u32 = 1 << 1;
    const HAS_NAME: u32 = 1 << 2;
    const HAS_RELATIVE_PATH: u32 = 1 << 3;
    const HAS_WORKING_DIR: u32 = 1 << 4;
    const HAS_ARGUMENTS: u32 = 1 << 5;
    const HAS_ICON_LOCATION: u32 = 1 << 6;
    const IS_UNICODE: u32 = 1 << 7;

    const ENV_VARIABLE_BLOCK_SIGNATURE: u32 = 0xA000_0001;
    /// EnvironmentVariableDataBlock 固定载荷：260 字节 ANSI + 520 字节 UTF-16。
    const ENV_BLOCK_ANSI_LEN: usize = 260;
    const ENV_BLOCK_UNICODE_LEN: usize = 520;

    fn u16_at(data: &[u8], offset: usize) -> Option<u16> {
        Some(u16::from_le_bytes(
            data.get(offset..offset + 2)?.try_into().ok()?,
        ))
    }

    fn u32_at(data: &[u8], offset: usize) -> Option<u32> {
        Some(u32::from_le_bytes(
            data.get(offset..offset + 4)?.try_into().ok()?,
        ))
    }

    /// 从 `offset` 读 NUL 结尾的 ANSI 字符串（截止 `end`）。系统 ANSI
    /// 代码页不可移植，这里按 UTF-8 lossy 解码：安装路径几乎全 ASCII，
    /// 非 ASCII 的老式 ANSI 路径在 Unicode 偏移缺失时才会走到这，宁可
    /// 出现替换符也不整项丢弃。
    fn ansi_z_at(data: &[u8], offset: usize, end: usize) -> Option<String> {
        let slice = data.get(offset..end.min(data.len()))?;
        let nul = slice.iter().position(|&byte| byte == 0)?;
        Some(String::from_utf8_lossy(&slice[..nul]).into_owned())
    }

    /// 从 `offset` 读 NUL 结尾的 UTF-16LE 字符串（截止 `end`）。
    fn utf16_z_at(data: &[u8], offset: usize, end: usize) -> Option<String> {
        let slice = data.get(offset..end.min(data.len()))?;
        let mut units = Vec::new();
        for pair in slice.chunks_exact(2) {
            let unit = u16::from_le_bytes([pair[0], pair[1]]);
            if unit == 0 {
                return Some(String::from_utf16_lossy(&units));
            }
            units.push(unit);
        }
        None
    }

    /// LinkInfo → LocalBasePath (+ CommonPathSuffix)。
    fn link_info_local_path(data: &[u8], base: usize, size: usize) -> Option<String> {
        let end = base.checked_add(size)?;
        if end > data.len() || size < 0x1C {
            return None;
        }
        let header_size = u32_at(data, base + 0x04)? as usize;
        let info_flags = u32_at(data, base + 0x08)?;
        // bit0 = VolumeIDAndLocalBasePath；没有本地路径（纯网络快捷方式）直接放弃。
        if info_flags & 1 == 0 {
            return None;
        }
        // HeaderSize >= 0x24 时才有 Unicode 偏移对（MS-SHLLINK 2.3）。
        let unicode = header_size >= 0x24;
        let base_path = unicode
            .then(|| u32_at(data, base + 0x1C))
            .flatten()
            .and_then(|offset| utf16_z_at(data, base + offset as usize, end))
            .or_else(|| {
                let offset = u32_at(data, base + 0x10)? as usize;
                ansi_z_at(data, base + offset, end)
            })?;
        let suffix = unicode
            .then(|| u32_at(data, base + 0x20))
            .flatten()
            .and_then(|offset| utf16_z_at(data, base + offset as usize, end))
            .or_else(|| {
                let offset = u32_at(data, base + 0x18)? as usize;
                ansi_z_at(data, base + offset, end)
            })
            .unwrap_or_default();
        if base_path.is_empty() {
            return None;
        }
        if suffix.is_empty() {
            return Some(base_path);
        }
        let mut joined = base_path;
        if !joined.ends_with('\\') {
            joined.push('\\');
        }
        joined.push_str(&suffix);
        Some(joined)
    }

    /// 展开 `%VAR%` 形态的环境变量引用；未定义的变量原样保留（与
    /// shell 行为一致，后续存在性检查会滤掉无效路径）。
    fn expand_env(value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
        let mut out = String::with_capacity(value.len());
        let mut rest = value;
        while let Some(start) = rest.find('%') {
            out.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            match after.find('%') {
                Some(close) => {
                    let name = &after[..close];
                    match lookup(name) {
                        Some(resolved) => out.push_str(&resolved),
                        None => {
                            out.push('%');
                            out.push_str(name);
                            out.push('%');
                        }
                    }
                    rest = &after[close + 1..];
                }
                None => {
                    out.push_str(&rest[start..]);
                    rest = "";
                }
            }
        }
        out.push_str(rest);
        out
    }

    /// 解析 `.lnk` 字节流，返回目标绝对路径。`env` 注入环境变量查询，
    /// 测试可传假值，Windows 运行时传 `std::env::var`。
    pub fn resolve_target(data: &[u8], env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        if data.len() < HEADER_SIZE
            || u32_at(data, 0)? as usize != HEADER_SIZE
            || data[4..20] != LINK_CLSID
        {
            return None;
        }
        let flags = u32_at(data, 0x14)?;
        let mut offset = HEADER_SIZE;
        if flags & HAS_LINK_TARGET_ID_LIST != 0 {
            offset = offset.checked_add(2 + u16_at(data, offset)? as usize)?;
        }
        if flags & HAS_LINK_INFO != 0 {
            let size = u32_at(data, offset)? as usize;
            if let Some(path) = link_info_local_path(data, offset, size) {
                return Some(path);
            }
            offset = offset.checked_add(size)?;
        }
        // 逐段跳过 StringData（字符计数不含结尾 NUL；Unicode 时字节数翻倍）。
        for flag in [
            HAS_NAME,
            HAS_RELATIVE_PATH,
            HAS_WORKING_DIR,
            HAS_ARGUMENTS,
            HAS_ICON_LOCATION,
        ] {
            if flags & flag == 0 {
                continue;
            }
            let chars = u16_at(data, offset)? as usize;
            let bytes = if flags & IS_UNICODE != 0 { chars * 2 } else { chars };
            offset = offset.checked_add(2 + bytes)?;
        }
        // ExtraData：找 EnvironmentVariableDataBlock。BlockSize < 8 即终结哨兵。
        loop {
            let size = u32_at(data, offset)? as usize;
            if size < 8 {
                return None;
            }
            let signature = u32_at(data, offset + 4)?;
            if signature == ENV_VARIABLE_BLOCK_SIGNATURE
                && size >= 8 + ENV_BLOCK_ANSI_LEN + ENV_BLOCK_UNICODE_LEN
            {
                let block_end = offset.checked_add(size)?;
                let raw = utf16_z_at(data, offset + 8 + ENV_BLOCK_ANSI_LEN, block_end)
                    .filter(|value| !value.is_empty())
                    .or_else(|| {
                        ansi_z_at(data, offset + 8, offset + 8 + ENV_BLOCK_ANSI_LEN)
                            .filter(|value| !value.is_empty())
                    })?;
                return Some(expand_env(&raw, env));
            }
            offset = offset.checked_add(size)?;
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{lnk, InstalledApp};
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    /// 与 macOS 一致：弹层行渲染 16 逻辑像素，32 物理像素覆盖高 DPI。
    /// SHGFI_LARGEICON 取回的正是系统大图标（默认 32×32）。
    pub fn list_windows_apps() -> Vec<InstalledApp> {
        let mut roots: Vec<PathBuf> = Vec::new();
        // 系统开始菜单在前、用户在后：同一目标先见者胜，对齐 macOS
        // "系统安装路径优先"的去重取向。
        if let Ok(program_data) = std::env::var("ProgramData") {
            roots.push(PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"));
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            roots.push(PathBuf::from(app_data).join(r"Microsoft\Windows\Start Menu\Programs"));
        }

        let host_exe = std::env::current_exe()
            .ok()
            .map(|path| normalize_identity(&path.to_string_lossy()));

        // SHGetFileInfoW 要求调用线程已初始化 COM（调用方在 spawn_blocking
        // 线程上，进程主线程的初始化覆盖不到这里）。
        let _com = ComInit::new();

        let mut by_identity: BTreeMap<String, InstalledApp> = BTreeMap::new();
        for root in roots {
            // 开始菜单的厂商子目录一般只有一层，容错到 4 层防跑飞。
            for entry in walkdir::WalkDir::new(&root)
                .max_depth(4)
                .into_iter()
                .flatten()
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                let lnk_path = entry.path();
                if !lnk_path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
                {
                    continue;
                }
                let Some(target) = resolve_lnk_file(lnk_path) else {
                    continue;
                };
                let Some(name) = lnk_path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(str::trim)
                    .filter(|stem| !stem.is_empty())
                    .map(str::to_owned)
                else {
                    continue;
                };
                if is_uninstaller(&name, &target) {
                    continue;
                }
                let identity = normalize_identity(&target);
                if host_exe.as_deref() == Some(identity.as_str()) {
                    continue;
                }
                by_identity.entry(identity).or_insert_with(|| InstalledApp {
                    name,
                    // Windows 没有 bundle id；空串经前端映射为 undefined，
                    // token/身份键/图标注册表全部以 path 兜底。
                    bundle_id: String::new(),
                    icon_data_url: app_icon_data_url(Path::new(&target)),
                    path: target,
                });
            }
        }

        let mut apps: Vec<InstalledApp> = by_identity.into_values().collect();
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        apps
    }

    /// 读取并解析 `.lnk`，只保留"存在的 `.exe`"目标——开始菜单里的
    /// 文档/网页/shell 对象快捷方式都不是可寻址的应用。
    fn resolve_lnk_file(path: &Path) -> Option<String> {
        // 快捷方式本体几 KB；1 MB 上限防御损坏文件。
        let metadata = std::fs::metadata(path).ok()?;
        if metadata.len() > 1024 * 1024 {
            return None;
        }
        let data = std::fs::read(path).ok()?;
        let target = lnk::resolve_target(&data, &|name| std::env::var(name).ok())?;
        if !target.to_lowercase().ends_with(".exe") || !Path::new(&target).is_file() {
            return None;
        }
        Some(target)
    }

    /// 卸载器是"已安装应用"里的常客噪声（"Uninstall Foo.lnk"），按
    /// 快捷方式名与目标文件名双向过滤。
    fn is_uninstaller(name: &str, target: &str) -> bool {
        let name = name.to_lowercase();
        let file = Path::new(target)
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_lowercase)
            .unwrap_or_default();
        name.contains("uninstall") || name.contains("卸载") || file.starts_with("unins")
    }

    /// 身份键 = 小写化目标路径（NTFS 不区分大小写）。
    fn normalize_identity(path: &str) -> String {
        path.to_lowercase()
    }

    /// COM 初始化守卫：成功才在 Drop 时配对 CoUninitialize；
    /// RPC_E_CHANGED_MODE（线程已按其他模型初始化）视作可用、不配对。
    struct ComInit {
        initialized: bool,
    }

    impl ComInit {
        fn new() -> Self {
            use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            let hr = unsafe {
                CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32)
            };
            Self { initialized: hr >= 0 }
        }
    }

    impl Drop for ComInit {
        fn drop(&mut self) {
            if self.initialized {
                unsafe { windows_sys::Win32::System::Com::CoUninitialize() };
            }
        }
    }

    /// 目标 exe 的系统图标 → 32px PNG data URL。取图标交给
    /// `SHGetFileInfoW`（与 macOS 交给 NSWorkspace 同理，见模块注释），
    /// HICON → GDI 位图取 BGRA 像素 → `image` crate 编码 PNG。
    fn app_icon_data_url(target: &Path) -> Option<String> {
        use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{
            SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

        let wide: Vec<u16> = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            SHGetFileInfoW(
                wide.as_ptr(),
                0,
                &mut info,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            )
        };
        if ok == 0 || info.hIcon.is_null() {
            return None;
        }
        let png = icon_to_png(info.hIcon);
        unsafe { DestroyIcon(info.hIcon) };
        Some(format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(png?)
        ))
    }

    /// HICON → PNG 字节。彩色位图按 32bpp 顶朝下取出（BGRA），alpha
    /// 全零说明是老式掩码图标——再取掩码位图补出透明度。
    fn icon_to_png(icon: windows_sys::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
        use windows_sys::Win32::Graphics::Gdi::DeleteObject;
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

        let mut icon_info: ICONINFO = unsafe { std::mem::zeroed() };
        if unsafe { GetIconInfo(icon, &mut icon_info) } == 0 {
            return None;
        }
        let color = icon_info.hbmColor;
        let mask = icon_info.hbmMask;
        let png = bitmaps_to_png(color, mask);
        // GetIconInfo 的位图归调用方释放（两只都可能非空）。
        if !color.is_null() {
            unsafe { DeleteObject(color) };
        }
        if !mask.is_null() {
            unsafe { DeleteObject(mask) };
        }
        png
    }

    fn bitmaps_to_png(
        color: windows_sys::Win32::Graphics::Gdi::HBITMAP,
        mask: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    ) -> Option<Vec<u8>> {
        use windows_sys::Win32::Graphics::Gdi::{GetObjectW, BITMAP};

        // hbmColor 为空是 1bpp 全掩码图标（Win16 时代产物），不值得支持。
        if color.is_null() {
            return None;
        }
        let mut bitmap: BITMAP = unsafe { std::mem::zeroed() };
        let read = unsafe {
            GetObjectW(
                color,
                std::mem::size_of::<BITMAP>() as i32,
                &mut bitmap as *mut BITMAP as *mut _,
            )
        };
        if read == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
            return None;
        }
        let width = bitmap.bmWidth as u32;
        let height = bitmap.bmHeight as u32;

        let mut pixels = bitmap_pixels_bgra(color, width, height)?;
        // BGRA → RGBA。
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
        if pixels.chunks_exact(4).all(|chunk| chunk[3] == 0) {
            // alpha 通道全零：老式图标靠掩码表达透明（掩码位 1 = 透明）。
            match (!mask.is_null())
                .then(|| bitmap_pixels_bgra(mask, width, height))
                .flatten()
            {
                Some(mask_pixels) => {
                    for (pixel, mask_pixel) in pixels
                        .chunks_exact_mut(4)
                        .zip(mask_pixels.chunks_exact(4))
                    {
                        pixel[3] = if mask_pixel[0] == 0 { 255 } else { 0 };
                    }
                }
                None => {
                    for chunk in pixels.chunks_exact_mut(4) {
                        chunk[3] = 255;
                    }
                }
            }
        }

        let buffer = image::RgbaImage::from_raw(width, height, pixels)?;
        let mut png = Vec::new();
        buffer
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        Some(png)
    }

    /// 任意 GDI 位图 → 32bpp 顶朝下 BGRA 像素（GetDIBits 负责格式转换）。
    fn bitmap_pixels_bgra(
        bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
        width: u32,
        height: u32,
    ) -> Option<Vec<u8>> {
        use windows_sys::Win32::Graphics::Gdi::{
            GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BI_RGB, DIB_RGB_COLORS,
        };

        let hdc = unsafe { GetDC(std::ptr::null_mut()) };
        if hdc.is_null() {
            return None;
        }
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader.biSize = std::mem::size_of_val(&info.bmiHeader) as u32;
        info.bmiHeader.biWidth = width as i32;
        // 负高度 = 顶朝下行序，免去手动翻转。
        info.bmiHeader.biHeight = -(height as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB as u32;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let lines = unsafe {
            GetDIBits(
                hdc,
                bitmap,
                0,
                height,
                pixels.as_mut_ptr() as *mut _,
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        unsafe { ReleaseDC(std::ptr::null_mut(), hdc) };
        (lines == height as i32).then_some(pixels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excluded_bundle_id_never_appears() {
        // 非 macOS 平台列表恒空，断言自然成立；macOS 上跑真实扫描，
        // 用一个必然存在的系统应用当宿主替身验证剔除逻辑。
        let apps = list_installed_apps("com.apple.finder");
        assert!(apps
            .iter()
            .all(|app| !app.bundle_id.eq_ignore_ascii_case("com.apple.finder")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_listing_is_sorted_and_deduplicated() {
        let apps = list_installed_apps("");
        let mut names: Vec<String> = apps.iter().map(|app| app.name.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        names.clear();
        let mut ids: Vec<&str> = apps.iter().map(|app| app.bundle_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), apps.len());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_listing_is_sorted_deduplicated_and_path_addressed() {
        let apps = list_installed_apps("com.xiaofei.liveagent");
        let names: Vec<String> = apps.iter().map(|app| app.name.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        let mut identities: Vec<String> = apps.iter().map(|app| app.path.to_lowercase()).collect();
        identities.sort_unstable();
        identities.dedup();
        assert_eq!(identities.len(), apps.len());
        for app in &apps {
            // Windows 无 bundle id：身份由 path 承担，前端以 path 兜底。
            assert!(app.bundle_id.is_empty());
            assert!(app.path.to_lowercase().ends_with(".exe"));
            if let Some(icon) = &app.icon_data_url {
                assert!(icon.starts_with("data:image/png;base64,"));
            }
        }
    }

    /* ---- .lnk 解析（纯字节，跨平台跑） ---- */

    /// 最小合法 ShellLinkHeader：HeaderSize + LinkCLSID + LinkFlags。
    fn lnk_header(flags: u32) -> Vec<u8> {
        let mut data = vec![0u8; 0x4C];
        data[0..4].copy_from_slice(&0x4Cu32.to_le_bytes());
        data[4..20].copy_from_slice(&[
            0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x46,
        ]);
        data[0x14..0x18].copy_from_slice(&flags.to_le_bytes());
        data
    }

    #[test]
    fn lnk_parser_reads_link_info_local_base_path() {
        let path = b"C:\\Program Files\\Demo\\demo.exe\0";
        let path_offset = 0x1Cu32;
        // 后缀偏移指向路径的结尾 NUL → 空后缀。
        let suffix_offset = path_offset + path.len() as u32 - 1;
        let total = 0x1C + path.len();
        let mut link_info = Vec::new();
        link_info.extend((total as u32).to_le_bytes());
        link_info.extend(0x1Cu32.to_le_bytes()); // LinkInfoHeaderSize：无 Unicode 偏移
        link_info.extend(1u32.to_le_bytes()); // VolumeIDAndLocalBasePath
        link_info.extend(0u32.to_le_bytes()); // VolumeIDOffset（解析器不读）
        link_info.extend(path_offset.to_le_bytes());
        link_info.extend(0u32.to_le_bytes()); // CommonNetworkRelativeLinkOffset
        link_info.extend(suffix_offset.to_le_bytes());
        link_info.extend_from_slice(path);

        let mut data = lnk_header(1 << 1); // HasLinkInfo
        data.extend(link_info);
        assert_eq!(
            lnk::resolve_target(&data, &|_| None).as_deref(),
            Some("C:\\Program Files\\Demo\\demo.exe"),
        );
    }

    #[test]
    fn lnk_parser_prefers_unicode_local_base_path() {
        let ansi = b"C:\\legacy\\demo.exe\0";
        let unicode: Vec<u8> = "C:\\应用\\演示.exe\0"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let ansi_offset = 0x24u32;
        let unicode_offset = ansi_offset + ansi.len() as u32;
        // 两个后缀偏移各指向对应字符串的结尾 NUL → 空后缀。
        let suffix_ansi_offset = ansi_offset + ansi.len() as u32 - 1;
        let suffix_unicode_offset = unicode_offset + unicode.len() as u32 - 2;
        let total = 0x24 + ansi.len() + unicode.len();
        let mut link_info = Vec::new();
        link_info.extend((total as u32).to_le_bytes());
        link_info.extend(0x24u32.to_le_bytes()); // 带 Unicode 偏移对
        link_info.extend(1u32.to_le_bytes());
        link_info.extend(0u32.to_le_bytes());
        link_info.extend(ansi_offset.to_le_bytes());
        link_info.extend(0u32.to_le_bytes());
        link_info.extend(suffix_ansi_offset.to_le_bytes());
        link_info.extend(unicode_offset.to_le_bytes());
        link_info.extend(suffix_unicode_offset.to_le_bytes());
        link_info.extend_from_slice(ansi);
        link_info.extend_from_slice(&unicode);

        let mut data = lnk_header(1 << 1);
        data.extend(link_info);
        assert_eq!(
            lnk::resolve_target(&data, &|_| None).as_deref(),
            Some("C:\\应用\\演示.exe"),
        );
    }

    #[test]
    fn lnk_parser_expands_environment_block_after_string_data() {
        // HasName | IsUnicode：先正确跳过一段 UTF-16 StringData，再命中
        // EnvironmentVariableDataBlock 并展开 %VAR%。
        let mut data = lnk_header((1 << 2) | (1 << 7));
        let name: Vec<u16> = "Demo App".encode_utf16().collect();
        data.extend((name.len() as u16).to_le_bytes());
        for unit in name {
            data.extend(unit.to_le_bytes());
        }
        let target = "%ProgramFiles%\\Demo\\demo.exe";
        let mut ansi = [0u8; 260];
        ansi[..target.len()].copy_from_slice(target.as_bytes());
        let mut unicode = [0u8; 520];
        for (i, unit) in target.encode_utf16().enumerate() {
            unicode[i * 2..i * 2 + 2].copy_from_slice(&unit.to_le_bytes());
        }
        data.extend(788u32.to_le_bytes()); // 8 + 260 + 520
        data.extend(0xA000_0001u32.to_le_bytes());
        data.extend_from_slice(&ansi);
        data.extend_from_slice(&unicode);
        data.extend(0u32.to_le_bytes()); // 终结哨兵块

        let resolved = lnk::resolve_target(&data, &|name| {
            (name == "ProgramFiles").then(|| "C:\\Program Files".to_owned())
        });
        assert_eq!(
            resolved.as_deref(),
            Some("C:\\Program Files\\Demo\\demo.exe"),
        );
    }

    #[test]
    fn lnk_parser_rejects_non_lnk_payloads() {
        assert_eq!(lnk::resolve_target(b"not a shortcut", &|_| None), None);
        // 头合法但没有任何可用目标段。
        assert_eq!(lnk::resolve_target(&lnk_header(0), &|_| None), None);
    }
}
