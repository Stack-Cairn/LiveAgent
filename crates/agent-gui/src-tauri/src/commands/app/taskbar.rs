#[cfg(windows)]
use std::sync::OnceLock;

#[cfg(windows)]
use tauri::image::Image;
use tauri::WebviewWindow;

/// 任务栏/Dock 运行状态指示：有任务进行时图标变色并叠加数量圆点，
/// 全部结束后恢复原状。
///
/// 平台差异：
/// - Windows：`set_icon` 换成琥珀色活跃图标（变色）+ `set_overlay_icon`
///   叠加红底白字数量圆点；
/// - macOS：Dock 原生数字角标（红色圆点）；Dock 图标本体换色 Tauri 未暴露；
/// - Linux：`set_badge_count` 尽力而为（仅 Unity 系桌面生效）。
#[tauri::command]
pub fn taskbar_set_activity(window: WebviewWindow, count: u32) -> Result<(), String> {
    apply_activity(&window, count).map_err(|e| format!("更新任务栏运行状态失败：{e}"))
}

fn apply_activity(window: &WebviewWindow, count: u32) -> tauri::Result<()> {
    #[cfg(windows)]
    {
        apply_windows_activity(window, count)
    }

    #[cfg(not(windows))]
    {
        window.set_badge_count(if count == 0 { None } else { Some(count as i64) })
    }
}

/// Windows 运行时换图标用的底图。安装包窗口图标来自 icon.ico，与此同源；
/// 运行中态在解码出的像素上做琥珀色混合，结束后设回未着色底图。
#[cfg(windows)]
const BASE_ICON_PNG: &[u8] = include_bytes!("../../../icons/128x128-windows.png");

/// 活跃角标画布边长。Windows 会把 overlay 缩放到任务栏小图标尺寸。
#[cfg_attr(not(windows), allow(dead_code))]
const OVERLAY_SIZE: u32 = 32;
/// 角标底色（红）与文字色（白）。
#[cfg_attr(not(windows), allow(dead_code))]
const BADGE_BG: [u8; 4] = [0xE5, 0x3E, 0x3E, 0xFF];
#[cfg_attr(not(windows), allow(dead_code))]
const BADGE_FG: [u8; 4] = [0xFF, 0xFF, 0xFF, 0xFF];
/// 活跃态图标着色（琥珀橙）与混合强度（0-100）。
#[cfg_attr(not(windows), allow(dead_code))]
const ACTIVE_TINT: [u8; 3] = [0xF5, 0x9E, 0x0B];
#[cfg_attr(not(windows), allow(dead_code))]
const ACTIVE_TINT_STRENGTH: u32 = 55;

#[cfg(windows)]
struct IconPixels {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

#[cfg(windows)]
impl IconPixels {
    fn as_image(&self) -> Image<'_> {
        Image::new(&self.rgba, self.width, self.height)
    }
}

#[cfg(windows)]
fn apply_windows_activity(window: &WebviewWindow, count: u32) -> tauri::Result<()> {
    if count == 0 {
        window.set_overlay_icon(None)?;
        return window.set_icon(base_icon_pixels()?.as_image());
    }
    let rgba = render_overlay_badge_rgba(count);
    window.set_overlay_icon(Some(Image::new_owned(rgba, OVERLAY_SIZE, OVERLAY_SIZE)))?;
    window.set_icon(active_icon_pixels()?.as_image())
}

#[cfg(windows)]
fn base_icon_pixels() -> tauri::Result<&'static IconPixels> {
    static CACHE: OnceLock<IconPixels> = OnceLock::new();
    if let Some(pixels) = CACHE.get() {
        return Ok(pixels);
    }
    let decoded = Image::from_bytes(BASE_ICON_PNG)?;
    let pixels = IconPixels {
        rgba: decoded.rgba().to_vec(),
        width: decoded.width(),
        height: decoded.height(),
    };
    Ok(CACHE.get_or_init(|| pixels))
}

#[cfg(windows)]
fn active_icon_pixels() -> tauri::Result<&'static IconPixels> {
    static CACHE: OnceLock<IconPixels> = OnceLock::new();
    if let Some(pixels) = CACHE.get() {
        return Ok(pixels);
    }
    let base = base_icon_pixels()?;
    let pixels = IconPixels {
        rgba: tint_rgba(&base.rgba, ACTIVE_TINT, ACTIVE_TINT_STRENGTH),
        width: base.width,
        height: base.height,
    };
    Ok(CACHE.get_or_init(|| pixels))
}

/// 每个 RGB 通道向 `tint` 按 `strength`% 线性混合，alpha 原样保留。
#[cfg_attr(not(windows), allow(dead_code))]
fn tint_rgba(rgba: &[u8], tint: [u8; 3], strength: u32) -> Vec<u8> {
    let strength = strength.min(100);
    let mut out = rgba.to_vec();
    for pixel in out.chunks_exact_mut(4) {
        for (channel, target) in pixel[..3].iter_mut().zip(tint) {
            let blended = u32::from(*channel) * (100 - strength) + u32::from(target) * strength;
            *channel = (blended / 100) as u8;
        }
    }
    out
}

/// 3x5 点阵字形，每行低 3 位有效。数字 0-9 之后附加 '+'。
#[cfg_attr(not(windows), allow(dead_code))]
const GLYPHS_3X5: [[u8; 5]; 11] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b010, 0b010, 0b010], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
    [0b000, 0b010, 0b111, 0b010, 0b000], // +
];
#[cfg_attr(not(windows), allow(dead_code))]
const GLYPH_PLUS: usize = 10;

/// 圆点内展示的字形：1-9 显示数字本身，超过 9 显示 “9+”。
#[cfg_attr(not(windows), allow(dead_code))]
fn badge_glyph_indices(count: u32) -> Vec<usize> {
    if count > 9 {
        vec![9, GLYPH_PLUS]
    } else {
        vec![count.min(9) as usize]
    }
}

/// 渲染红底白字的数量圆点（RGBA，边长 `OVERLAY_SIZE`）。
#[cfg_attr(not(windows), allow(dead_code))]
fn render_overlay_badge_rgba(count: u32) -> Vec<u8> {
    let size = OVERLAY_SIZE as usize;
    let mut rgba = vec![0u8; size * size * 4];

    // 圆形底：半径留 1px 边距，超出部分保持透明。
    let center = (size as f32 - 1.0) / 2.0;
    let radius = size as f32 / 2.0 - 1.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            if dx * dx + dy * dy <= radius * radius {
                rgba[(y * size + x) * 4..][..4].copy_from_slice(&BADGE_BG);
            }
        }
    }

    // 字形：单字符 4 倍、双字符 3 倍放大，居中绘制。
    let glyphs = badge_glyph_indices(count);
    let scale = if glyphs.len() == 1 { 4 } else { 3 };
    let gap = if glyphs.len() == 1 { 0 } else { scale };
    let text_width = glyphs.len() * 3 * scale + (glyphs.len() - 1) * gap;
    let text_height = 5 * scale;
    let mut origin_x = (size - text_width) / 2;
    let origin_y = (size - text_height) / 2;
    for glyph in glyphs {
        draw_glyph_3x5(&mut rgba, size, glyph, origin_x, origin_y, scale);
        origin_x += 3 * scale + gap;
    }
    rgba
}

#[cfg_attr(not(windows), allow(dead_code))]
fn draw_glyph_3x5(
    rgba: &mut [u8],
    size: usize,
    glyph: usize,
    origin_x: usize,
    origin_y: usize,
    scale: usize,
) {
    for (row, bits) in GLYPHS_3X5[glyph].iter().enumerate() {
        for col in 0..3 {
            if bits & (0b100 >> col) == 0 {
                continue;
            }
            for dy in 0..scale {
                for dx in 0..scale {
                    let x = origin_x + col * scale + dx;
                    let y = origin_y + row * scale + dy;
                    if x < size && y < size {
                        rgba[(y * size + x) * 4..][..4].copy_from_slice(&BADGE_FG);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(rgba: &[u8], size: usize, x: usize, y: usize) -> [u8; 4] {
        let offset = (y * size + x) * 4;
        [
            rgba[offset],
            rgba[offset + 1],
            rgba[offset + 2],
            rgba[offset + 3],
        ]
    }

    #[test]
    fn badge_glyphs_show_count_up_to_nine_then_nine_plus() {
        assert_eq!(badge_glyph_indices(1), vec![1]);
        assert_eq!(badge_glyph_indices(9), vec![9]);
        assert_eq!(badge_glyph_indices(10), vec![9, GLYPH_PLUS]);
        assert_eq!(badge_glyph_indices(99), vec![9, GLYPH_PLUS]);
    }

    #[test]
    fn overlay_badge_is_round_with_readable_text() {
        let size = OVERLAY_SIZE as usize;
        for count in [1, 3, 10] {
            let rgba = render_overlay_badge_rgba(count);
            assert_eq!(rgba.len(), size * size * 4);
            // 四角在圆外保持透明，中心区域为角标底色或文字色。
            assert_eq!(pixel(&rgba, size, 0, 0)[3], 0);
            assert_eq!(pixel(&rgba, size, size - 1, size - 1)[3], 0);
            let center = pixel(&rgba, size, size / 2, size / 2);
            assert!(center == BADGE_BG || center == BADGE_FG);
            // 文字确实画上去了。
            let fg_pixels = rgba.chunks_exact(4).filter(|px| *px == BADGE_FG).count();
            assert!(fg_pixels > 0, "count={count} 应包含文字像素");
        }
    }

    #[test]
    fn overlay_badge_differs_between_counts() {
        assert_ne!(render_overlay_badge_rgba(1), render_overlay_badge_rgba(2));
        assert_ne!(render_overlay_badge_rgba(9), render_overlay_badge_rgba(10));
    }

    #[test]
    fn tint_preserves_alpha_and_blends_toward_target() {
        let rgba = vec![0u8, 0, 255, 255, 10, 20, 30, 0];
        let full = tint_rgba(&rgba, [200, 100, 0], 100);
        assert_eq!(&full[..4], &[200, 100, 0, 255]);
        assert_eq!(full[7], 0, "alpha 必须原样保留");
        let none = tint_rgba(&rgba, [200, 100, 0], 0);
        assert_eq!(none, rgba);
        let half = tint_rgba(&rgba, [200, 100, 0], 50);
        assert_eq!(&half[..4], &[100, 50, 127, 255]);
    }
}
