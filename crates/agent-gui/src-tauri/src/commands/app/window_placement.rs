//! 启动时把主窗口放到所在显示器的工作区中央。
//!
//! 窗口状态插件只保存尺寸和最大化（位置会和未托管的多显示器布局打架），
//! 首次显示时位置交给系统：Windows 层叠、macOS 靠左上，恢复的大尺寸还可能
//! 落到屏幕外。这里只在本进程首次显示、且未最大化时调整一次；之后托盘、
//! 快捷键唤起都不移动窗口。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, PhysicalPosition, PhysicalSize};

/// 本进程是否已经处理过首次显示。前端就绪标记会在每次页面加载时被
/// `on_page_load` 清掉（WebView 重载要重新等就绪），不能用来判断首次。
static STARTUP_PLACEMENT_CLAIMED: AtomicBool = AtomicBool::new(false);

/// 只有本进程第一次调用返回 true；之后的重载、唤起都不再调整窗口。
pub fn claim_startup_placement() -> bool {
    !STARTUP_PLACEMENT_CLAIMED.swap(true, Ordering::SeqCst)
}

/// 工作区（去掉任务栏/Dock 后的显示器区域），物理像素。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 把外框尺寸 `outer` 收进工作区（不小于 `min`）并居中，返回外框的位置与尺寸。
/// 最小尺寸大于工作区时保留最小尺寸并贴齐工作区左上，保证标题栏可见。
pub fn centered_bounds(
    work: WorkArea,
    outer: PhysicalSize<u32>,
    min: PhysicalSize<u32>,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let width = outer.width.min(work.width).max(min.width);
    let height = outer.height.min(work.height).max(min.height);
    let offset = |space: u32, size: u32| (space.saturating_sub(size) / 2) as i32;
    (
        PhysicalPosition::new(
            work.x.saturating_add(offset(work.width, width)),
            work.y.saturating_add(offset(work.height, height)),
        ),
        PhysicalSize::new(width, height),
    )
}

/// 逻辑像素的最小尺寸按显示器缩放换算成物理像素（向上取整，不小于配置）。
pub fn physical_min_size(logical_width: f64, logical_height: f64, scale: f64) -> PhysicalSize<u32> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let to_physical = |value: f64| (value.max(0.0) * scale).ceil() as u32;
    PhysicalSize::new(to_physical(logical_width), to_physical(logical_height))
}

/// 按窗口所在显示器（取不到时用主显示器）的工作区收拢尺寸并居中。
pub fn center_in_work_area(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    // 取显示器失败只是这次不居中；当前显示器出错或取不到时退回主显示器。
    let monitor = match window.current_monitor() {
        Ok(Some(monitor)) => Some(monitor),
        _ => window.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let area = monitor.work_area();
    let work = WorkArea {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    };
    let (min_width, min_height) = window
        .app_handle()
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == window.label())
        .map(|config| {
            (
                config.min_width.unwrap_or(0.0),
                config.min_height.unwrap_or(0.0),
            )
        })
        .unwrap_or((0.0, 0.0));
    let min_inner = physical_min_size(min_width, min_height, monitor.scale_factor());
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    // 有系统标题栏的平台外框大于内容区；最小尺寸和 set_size 都针对内容区，按差值换算。
    let frame = PhysicalSize::new(
        outer.width.saturating_sub(inner.width),
        outer.height.saturating_sub(inner.height),
    );
    let min_outer = PhysicalSize::new(
        min_inner.width.saturating_add(frame.width),
        min_inner.height.saturating_add(frame.height),
    );
    let (position, target) = centered_bounds(work, outer, min_outer);
    if target != outer {
        window.set_size(PhysicalSize::new(
            target.width.saturating_sub(frame.width),
            target.height.saturating_sub(frame.height),
        ))?;
    }
    window.set_position(position)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(width: u32, height: u32) -> PhysicalSize<u32> {
        PhysicalSize::new(width, height)
    }

    const PRIMARY: WorkArea = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1032,
    };

    #[test]
    fn startup_placement_is_claimed_once_per_process() {
        assert!(claim_startup_placement());
        assert!(!claim_startup_placement());
        assert!(!claim_startup_placement());
    }

    #[test]
    fn centers_a_window_that_fits() {
        let (position, bounds) = centered_bounds(PRIMARY, size(1400, 800), size(480, 600));
        assert_eq!(bounds, size(1400, 800));
        assert_eq!(position, PhysicalPosition::new(260, 116));
    }

    #[test]
    fn shrinks_a_window_larger_than_the_work_area() {
        let (position, bounds) = centered_bounds(PRIMARY, size(2560, 1440), size(480, 600));
        assert_eq!(bounds, size(1920, 1032));
        assert_eq!(position, PhysicalPosition::new(0, 0));

        let (position, bounds) = centered_bounds(PRIMARY, size(1000, 1300), size(480, 600));
        assert_eq!(bounds, size(1000, 1032));
        assert_eq!(position, PhysicalPosition::new(460, 0));
    }

    #[test]
    fn centers_on_a_secondary_monitor_with_offset_origin() {
        // 副屏在主屏左侧、上沿错开：坐标为负且以工作区原点为基准。
        let left = WorkArea {
            x: -2560,
            y: -200,
            width: 2560,
            height: 1400,
        };
        let (position, bounds) = centered_bounds(left, size(1400, 800), size(480, 600));
        assert_eq!(bounds, size(1400, 800));
        assert_eq!(position, PhysicalPosition::new(-2560 + 580, -200 + 300));
    }

    #[test]
    fn converts_logical_minimum_size_for_high_dpi() {
        assert_eq!(physical_min_size(480.0, 600.0, 1.5), size(720, 900));
        assert_eq!(physical_min_size(480.0, 600.0, 1.25), size(600, 750));
        assert_eq!(physical_min_size(481.0, 601.0, 1.25), size(602, 752));
        assert_eq!(physical_min_size(480.0, 600.0, 0.0), size(480, 600));
        assert_eq!(physical_min_size(480.0, 600.0, f64::NAN), size(480, 600));

        // 150% 缩放的 2880x1800 屏：恢复的物理尺寸按物理工作区收拢。
        let work = WorkArea {
            x: 0,
            y: 0,
            width: 2880,
            height: 1728,
        };
        let min = physical_min_size(480.0, 600.0, 1.5);
        let (position, bounds) = centered_bounds(work, size(2100, 1200), min);
        assert_eq!(bounds, size(2100, 1200));
        assert_eq!(position, PhysicalPosition::new(390, 264));
    }

    #[test]
    fn keeps_the_minimum_size_when_it_exceeds_the_work_area() {
        let small = WorkArea {
            x: 100,
            y: 50,
            width: 400,
            height: 500,
        };
        let (position, bounds) = centered_bounds(small, size(1400, 800), size(480, 600));
        assert_eq!(bounds, size(480, 600));
        assert_eq!(position, PhysicalPosition::new(100, 50));
    }

    /// RFC 7396 merge patch（tauri-utils `config::parse` 用 `json_patch::merge` 合并平台配置，
    /// 数组整体替换）。
    fn merge_patch(target: &mut serde_json::Value, patch: &serde_json::Value) {
        if let serde_json::Value::Object(patch_map) = patch {
            if !target.is_object() {
                *target = serde_json::Value::Object(Default::default());
            }
            let target_map = target.as_object_mut().unwrap();
            for (key, value) in patch_map {
                if value.is_null() {
                    target_map.remove(key);
                } else {
                    merge_patch(
                        target_map
                            .entry(key.clone())
                            .or_insert(serde_json::Value::Null),
                        value,
                    );
                }
            }
        } else {
            *target = patch.clone();
        }
    }

    fn merged_main_window_visible(platform: &str) -> bool {
        let mut config: serde_json::Value =
            serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();
        let patch: serde_json::Value = serde_json::from_str(platform).unwrap();
        merge_patch(&mut config, &patch);
        // WindowConfig::visible 缺省为 true。
        config["app"]["windows"][0]["visible"]
            .as_bool()
            .unwrap_or(true)
    }

    /// 居中依赖"首次显示前窗口不可见"。平台配置会整体替换 windows 数组，漏写
    /// `visible: false` 时窗口一创建就在系统默认位置可见，随后才被居中，用户会看到换位。
    #[test]
    fn main_window_starts_hidden_on_every_platform_config() {
        for (name, patch) in [
            (
                "tauri.windows.conf.json",
                include_str!("../../../tauri.windows.conf.json"),
            ),
            (
                "tauri.windows.release.conf.json",
                include_str!("../../../tauri.windows.release.conf.json"),
            ),
            (
                "tauri.macos.conf.json",
                include_str!("../../../tauri.macos.conf.json"),
            ),
            (
                "tauri.macos.release.conf.json",
                include_str!("../../../tauri.macos.release.conf.json"),
            ),
            (
                "tauri.macos.preview.conf.json",
                include_str!("../../../tauri.macos.preview.conf.json"),
            ),
            (
                "tauri.linux.release.conf.json",
                include_str!("../../../tauri.linux.release.conf.json"),
            ),
        ] {
            assert!(
                !merged_main_window_visible(patch),
                "{name}: main window is created visible"
            );
        }
    }

    #[test]
    fn extreme_inputs_do_not_panic_or_wrap() {
        // 工作区原点接近 i32::MAX：saturating，不回绕成负数。
        let far = WorkArea {
            x: i32::MAX - 10,
            y: i32::MAX - 10,
            width: 4000,
            height: 3000,
        };
        let (position, bounds) = centered_bounds(far, size(1400, 800), size(720, 900));
        assert_eq!(bounds, size(1400, 900));
        assert_eq!(position, PhysicalPosition::new(i32::MAX, i32::MAX));
        // 偏移最大 u32::MAX/2 == i32::MAX，cast 不回绕。
        let huge = WorkArea {
            x: i32::MIN,
            y: 0,
            width: u32::MAX,
            height: u32::MAX,
        };
        let (position, _) = centered_bounds(huge, size(1, 1), size(0, 0));
        assert_eq!(
            position,
            PhysicalPosition::new(i32::MIN + i32::MAX, i32::MAX)
        );
        // 0 尺寸工作区：保留最小尺寸贴左上。
        let empty = WorkArea {
            x: -5,
            y: -7,
            width: 0,
            height: 0,
        };
        let (position, bounds) = centered_bounds(empty, size(1400, 800), size(720, 900));
        assert_eq!(
            (position, bounds),
            (PhysicalPosition::new(-5, -7), size(720, 900))
        );
        // 外框为 0、最小为 0。
        let (position, bounds) = centered_bounds(PRIMARY, size(0, 0), size(0, 0));
        assert_eq!(
            (position, bounds),
            (PhysicalPosition::new(960, 516), size(0, 0))
        );
        // 负/无穷 scale 回退 1.0；负/NaN/无穷逻辑尺寸饱和。
        assert_eq!(physical_min_size(480.0, 600.0, -2.0), size(480, 600));
        assert_eq!(
            physical_min_size(480.0, 600.0, f64::INFINITY),
            size(480, 600)
        );
        assert_eq!(physical_min_size(-1.0, f64::NAN, 2.0), size(0, 0));
        assert_eq!(
            physical_min_size(f64::INFINITY, 1e30, 2.0),
            size(u32::MAX, u32::MAX)
        );
        // Retina 2.0 与 175%（非整数结果向上取整）。
        assert_eq!(physical_min_size(480.0, 600.0, 2.0), size(960, 1200));
        assert_eq!(physical_min_size(481.0, 601.0, 1.75), size(842, 1052));
    }
}
