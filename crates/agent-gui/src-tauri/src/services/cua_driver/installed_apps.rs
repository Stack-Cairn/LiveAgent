//! 已安装应用枚举，供输入框 @ 提及（computer use 的操作目标）。
//!
//! 语义是「已安装」而不是「正在运行」——cua-driver 自己的 `list_apps`
//! 报告的是运行中的进程，而 @ 提及要的是"打开 Safari 做…"这类还没
//! 启动的目标，所以宿主自己扫应用目录。
//!
//! 只在 macOS 实现：扫 `/Applications`、`/System/Applications` 与
//! `~/Applications` 的顶层 `.app` bundle，读 `Contents/Info.plist` 取
//! bundle id 与显示名。其他平台返回空列表——cua-driver 在那些平台上
//! 按进程名/窗口寻址，没有等价的"已安装应用"稳定标识，前端对空列表
//! 的行为就是不显示应用分组，无需平台分支。
//!
//! 图标走 `NSWorkspace.iconForFile` 而不是自己解 `.icns`：现代应用的
//! 图标常在 Assets.car 里，Info.plist 的 CFBundleIconFile 根本不存在，
//! 只有系统 API 能统一取到。取回后挑最接近 32px 的位图转 PNG data URL
//! （弹层行渲染 16 逻辑像素，32 物理像素覆盖 retina），随列表一次性
//! 返回——列表在会话内只取一次，几百 KB 的一次性载荷可接受，换来前端
//! 零额外往返。
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

/// 枚举已安装应用，按名称排序、按 bundle id 去重。
///
/// `exclude_bundle_id` 是宿主自己的 bundle id（来自 tauri 配置），恒被
/// 剔除，见模块注释。
pub fn list_installed_apps(exclude_bundle_id: &str) -> Vec<InstalledApp> {
    #[cfg(target_os = "macos")]
    {
        list_macos_apps(exclude_bundle_id)
    }
    #[cfg(not(target_os = "macos"))]
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
}
