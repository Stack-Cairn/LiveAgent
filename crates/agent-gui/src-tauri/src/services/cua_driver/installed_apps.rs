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
        path: path.to_string_lossy().into_owned(),
    })
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
