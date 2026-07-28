//! 托盘菜单的「视图层」：固定骨架 + 单一 apply 写入路径。
//!
//! 设计约束（勿破坏）：
//! - 菜单骨架只建一次（bootstrap 用 zh-CN 默认文案），此后所有更新都走
//!   [`apply_tray_menu`] 改内容（set_text/set_checked/set_enabled + 子菜单重建），
//!   绝不整棵 `set_menu` 替换——Linux 托盘菜单一旦设置不可替换，macOS 菜单
//!   展开时替换会闪烁。
//! - 文案单一真源在前端 i18n（`i18n/config.ts`），Rust 不建翻译表也不猜
//!   locale；前端经 `app_tray_menu_sync` 推送已本地化的 [`TrayMenuModel`]。
//! - 会话标题等用户数据进菜单前必须过 [`sanitize_menu_label`]（`&` 转义、
//!   控制字符剥离、显示宽度截断）。
//! - 动作分发不在本模块：菜单项 ID 由 `lib.rs` 的动作总线解析执行。

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIcon;
use tauri::AppHandle;

// ---- 静态菜单项 ID（lib.rs 动作总线按这些 ID 解析）----
pub const TRAY_STATUS_ID: &str = "tray-status";
pub const TRAY_SHOW_ID: &str = "tray-show";
pub const TRAY_NEW_CHAT_ID: &str = "tray-new-chat";
pub const TRAY_PIN_ID: &str = "tray-pin";
pub const TRAY_RECENT_MENU_ID: &str = "tray-recent-menu";
pub const TRAY_RECENT_VIEW_ALL_ID: &str = "tray-recent-view-all";
pub const TRAY_WORKSPACES_MENU_ID: &str = "tray-workspaces-menu";
pub const TRAY_RUNS_MENU_ID: &str = "tray-runs-menu";
pub const TRAY_RUN_STOP_ALL_ID: &str = "tray-run-stop-all";
pub const TRAY_CRON_MENU_ID: &str = "tray-cron-menu";
pub const TRAY_GATEWAY_ID: &str = "tray-gateway";
pub const TRAY_APPEARANCE_MENU_ID: &str = "tray-appearance-menu";
pub const TRAY_THEME_LIGHT_ID: &str = "tray-theme:light";
pub const TRAY_THEME_DARK_ID: &str = "tray-theme:dark";
pub const TRAY_THEME_SYSTEM_ID: &str = "tray-theme:system";
pub const TRAY_SETTINGS_ID: &str = "tray-settings";
pub const TRAY_CHECK_UPDATES_ID: &str = "tray-check-updates";
pub const TRAY_OPEN_DATA_DIR_ID: &str = "tray-open-data-dir";
pub const TRAY_QUIT_ID: &str = "tray-quit";

// ---- 动态子项 ID 前缀（`<前缀><业务 id>`）----
pub const TRAY_RECENT_PREFIX: &str = "tray-recent:";
pub const TRAY_WORKSPACE_PREFIX: &str = "tray-ws:";
pub const TRAY_RUN_PREFIX: &str = "tray-run:";
pub const TRAY_CRON_PREFIX: &str = "tray-cron:";

/// 动态列表的显示宽度上限（半角单位；CJK 记 2）。
const TRAY_LABEL_MAX_WIDTH: usize = 40;
/// 单个子菜单条目数上限（前端已截断，这里是防御性兜底）。
const TRAY_SUBMENU_MAX_ENTRIES: usize = 20;

/// 前端推送的动态子项：`id` 是业务 id（会话/工作空间/cron 任务），
/// `label` 已本地化但**未**消毒——消毒统一在 Rust apply 时做。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuEntry {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub checked: bool,
}

/// 静态菜单项的本地化文案。空字符串 = 保持现值（bootstrap 文案）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayMenuLabels {
    pub show: String,
    pub new_chat: String,
    pub pin: String,
    pub recent: String,
    pub recent_view_all: String,
    pub workspaces: String,
    pub runs: String,
    pub stop_all: String,
    pub cron: String,
    pub gateway: String,
    pub appearance: String,
    pub theme_light: String,
    pub theme_dark: String,
    pub theme_system: String,
    pub settings: String,
    pub check_updates: String,
    pub open_data_dir: String,
    pub quit: String,
}

/// 前端推送的完整托盘模型。缺省字段语义为「保持/清空该区块」，
/// 与 settings sync 的 keep-current 语义不同：托盘模型每次全量推送。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayMenuModel {
    pub labels: TrayMenuLabels,
    /// 状态行后缀（如「远程已连接」）；None 时只显示 `LiveAgent <version>`。
    pub status_suffix: Option<String>,
    pub recent: Vec<TrayMenuEntry>,
    /// 最近对话被截断时在子菜单尾部追加「查看全部…」。
    pub recent_truncated: bool,
    pub workspaces: Vec<TrayMenuEntry>,
    pub runs: Vec<TrayMenuEntry>,
    pub cron: Vec<TrayMenuEntry>,
    /// "light" | "dark" | "system"；其余值不更新勾选。
    pub theme: String,
    /// 远程网关行是否可点（未配置远程时禁用）。
    pub gateway_enabled: bool,
    /// summon / newChat 全局快捷键回显（muda accelerator 格式，仅显示不注册）。
    pub show_accelerator: Option<String>,
    pub new_chat_accelerator: Option<String>,
    pub tooltip: Option<String>,
    /// macOS 状态栏文字徽标（如「2」）；None 清除。其他平台忽略。
    pub badge_text: Option<String>,
}

/// 固定骨架的全部句柄。菜单项句柄是主线程代理（Send+Sync），
/// 所有变更经 [`apply_tray_menu`] 串行化。
pub struct TrayMenuHandles {
    apply_lock: Mutex<()>,
    app_version: &'static str,
    status: MenuItem<tauri::Wry>,
    show: MenuItem<tauri::Wry>,
    new_chat: MenuItem<tauri::Wry>,
    pin: CheckMenuItem<tauri::Wry>,
    recent: Submenu<tauri::Wry>,
    workspaces: Submenu<tauri::Wry>,
    runs: Submenu<tauri::Wry>,
    cron: Submenu<tauri::Wry>,
    gateway: MenuItem<tauri::Wry>,
    appearance: Submenu<tauri::Wry>,
    theme_light: CheckMenuItem<tauri::Wry>,
    theme_dark: CheckMenuItem<tauri::Wry>,
    theme_system: CheckMenuItem<tauri::Wry>,
    settings: MenuItem<tauri::Wry>,
    check_updates: MenuItem<tauri::Wry>,
    open_data_dir: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    tray_icon: TrayIcon,
}

/// 骨架构建的中间产物：菜单 + 各项句柄（托盘图标 build 后再并入）。
pub struct TrayMenuSkeleton {
    pub menu: Menu<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    show: MenuItem<tauri::Wry>,
    new_chat: MenuItem<tauri::Wry>,
    pin: CheckMenuItem<tauri::Wry>,
    recent: Submenu<tauri::Wry>,
    workspaces: Submenu<tauri::Wry>,
    runs: Submenu<tauri::Wry>,
    cron: Submenu<tauri::Wry>,
    gateway: MenuItem<tauri::Wry>,
    appearance: Submenu<tauri::Wry>,
    theme_light: CheckMenuItem<tauri::Wry>,
    theme_dark: CheckMenuItem<tauri::Wry>,
    theme_system: CheckMenuItem<tauri::Wry>,
    settings: MenuItem<tauri::Wry>,
    check_updates: MenuItem<tauri::Wry>,
    open_data_dir: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// 建固定骨架。bootstrap 文案用 zh-CN（i18n DEFAULT_LOCALE），
/// 前端挂载后首次 sync 即被真实本地化内容替换。
pub fn build_tray_menu_skeleton(
    app: &tauri::App,
    app_version: &str,
) -> tauri::Result<TrayMenuSkeleton> {
    let status = MenuItem::with_id(
        app,
        TRAY_STATUS_ID,
        compose_status_line(app_version, None),
        false,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(app, TRAY_SHOW_ID, "显示主窗口", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, TRAY_NEW_CHAT_ID, "新建对话", true, None::<&str>)?;
    let pin = CheckMenuItem::with_id(app, TRAY_PIN_ID, "窗口置顶", true, false, None::<&str>)?;
    let recent = Submenu::with_id(app, TRAY_RECENT_MENU_ID, "最近对话", false)?;
    let workspaces = Submenu::with_id(app, TRAY_WORKSPACES_MENU_ID, "工作空间", false)?;
    let runs = Submenu::with_id(app, TRAY_RUNS_MENU_ID, "运行中", false)?;
    let cron = Submenu::with_id(app, TRAY_CRON_MENU_ID, "定时任务", false)?;
    let gateway = MenuItem::with_id(app, TRAY_GATEWAY_ID, "远程网关", false, None::<&str>)?;
    let theme_light =
        CheckMenuItem::with_id(app, TRAY_THEME_LIGHT_ID, "浅色", true, false, None::<&str>)?;
    let theme_dark =
        CheckMenuItem::with_id(app, TRAY_THEME_DARK_ID, "深色", true, false, None::<&str>)?;
    let theme_system = CheckMenuItem::with_id(
        app,
        TRAY_THEME_SYSTEM_ID,
        "跟随系统",
        true,
        false,
        None::<&str>,
    )?;
    let appearance = Submenu::with_id_and_items(
        app,
        TRAY_APPEARANCE_MENU_ID,
        "外观",
        true,
        &[&theme_light, &theme_dark, &theme_system],
    )?;
    let settings = MenuItem::with_id(app, TRAY_SETTINGS_ID, "设置…", true, None::<&str>)?;
    let check_updates =
        MenuItem::with_id(app, TRAY_CHECK_UPDATES_ID, "检查更新…", true, None::<&str>)?;
    let open_data_dir = MenuItem::with_id(
        app,
        TRAY_OPEN_DATA_DIR_ID,
        "打开数据目录",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &show,
            &new_chat,
            &pin,
            &PredefinedMenuItem::separator(app)?,
            &recent,
            &workspaces,
            &PredefinedMenuItem::separator(app)?,
            &runs,
            &cron,
            &gateway,
            &PredefinedMenuItem::separator(app)?,
            &appearance,
            &settings,
            &check_updates,
            &open_data_dir,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    Ok(TrayMenuSkeleton {
        menu,
        status,
        show,
        new_chat,
        pin,
        recent,
        workspaces,
        runs,
        cron,
        gateway,
        appearance,
        theme_light,
        theme_dark,
        theme_system,
        settings,
        check_updates,
        open_data_dir,
        quit,
    })
}

impl TrayMenuHandles {
    pub fn new(skeleton: TrayMenuSkeleton, tray_icon: TrayIcon, app_version: &'static str) -> Self {
        Self {
            apply_lock: Mutex::new(()),
            app_version,
            status: skeleton.status,
            show: skeleton.show,
            new_chat: skeleton.new_chat,
            pin: skeleton.pin,
            recent: skeleton.recent,
            workspaces: skeleton.workspaces,
            runs: skeleton.runs,
            cron: skeleton.cron,
            gateway: skeleton.gateway,
            appearance: skeleton.appearance,
            theme_light: skeleton.theme_light,
            theme_dark: skeleton.theme_dark,
            theme_system: skeleton.theme_system,
            settings: skeleton.settings,
            check_updates: skeleton.check_updates,
            open_data_dir: skeleton.open_data_dir,
            quit: skeleton.quit,
            tray_icon,
        }
    }

    /// 置顶勾选同步（真源在 Rust `WindowPinState`，不经 apply 模型）。
    pub fn set_pin_checked(&self, checked: bool) {
        if let Err(error) = self.pin.set_checked(checked) {
            eprintln!("failed to sync tray pin checkmark: {error}");
        }
    }
}

/// 唯一的托盘菜单写入路径：全部内容更新与子菜单重建都在这里完成。
/// 从 IPC 命令线程调用（菜单操作内部代理到主线程；主线程调用也安全——
/// tauri 的 `send_user_message` 在主线程上内联执行）。
pub fn apply_tray_menu(
    app: &AppHandle,
    handles: &TrayMenuHandles,
    model: TrayMenuModel,
) -> Result<(), String> {
    let _guard = handles
        .apply_lock
        .lock()
        .map_err(|_| "tray menu apply lock poisoned".to_string())?;

    let err = |error: tauri::Error| format!("tray menu update failed: {error}");

    // 状态行：Rust 拥有版本号，前端喂本地化状态后缀。
    handles
        .status
        .set_text(compose_status_line(
            handles.app_version,
            model.status_suffix.as_deref(),
        ))
        .map_err(err)?;

    // 静态文案（空字符串 = 保持现值）。
    set_text_if_present(&handles.show, &model.labels.show).map_err(err)?;
    set_text_if_present(&handles.new_chat, &model.labels.new_chat).map_err(err)?;
    set_check_text_if_present(&handles.pin, &model.labels.pin).map_err(err)?;
    set_submenu_text_if_present(&handles.recent, &model.labels.recent).map_err(err)?;
    set_submenu_text_if_present(&handles.workspaces, &model.labels.workspaces).map_err(err)?;
    set_submenu_text_if_present(&handles.runs, &model.labels.runs).map_err(err)?;
    set_submenu_text_if_present(&handles.cron, &model.labels.cron).map_err(err)?;
    set_text_if_present(&handles.gateway, &model.labels.gateway).map_err(err)?;
    set_submenu_text_if_present(&handles.appearance, &model.labels.appearance).map_err(err)?;
    set_check_text_if_present(&handles.theme_light, &model.labels.theme_light).map_err(err)?;
    set_check_text_if_present(&handles.theme_dark, &model.labels.theme_dark).map_err(err)?;
    set_check_text_if_present(&handles.theme_system, &model.labels.theme_system).map_err(err)?;
    set_text_if_present(&handles.settings, &model.labels.settings).map_err(err)?;
    set_text_if_present(&handles.check_updates, &model.labels.check_updates).map_err(err)?;
    set_text_if_present(&handles.open_data_dir, &model.labels.open_data_dir).map_err(err)?;
    set_text_if_present(&handles.quit, &model.labels.quit).map_err(err)?;

    // 快捷键回显（仅显示；实际注册在 global-shortcut 插件）。
    handles
        .show
        .set_accelerator(model.show_accelerator.as_deref())
        .map_err(err)?;
    handles
        .new_chat
        .set_accelerator(model.new_chat_accelerator.as_deref())
        .map_err(err)?;

    // 主题勾选（未知值不更新，避免把三个勾都清掉）。
    match model.theme.as_str() {
        "light" | "dark" | "system" => {
            handles
                .theme_light
                .set_checked(model.theme == "light")
                .map_err(err)?;
            handles
                .theme_dark
                .set_checked(model.theme == "dark")
                .map_err(err)?;
            handles
                .theme_system
                .set_checked(model.theme == "system")
                .map_err(err)?;
        }
        _ => {}
    }

    // 远程网关行。
    handles
        .gateway
        .set_enabled(model.gateway_enabled)
        .map_err(err)?;

    // 动态子菜单重建。
    let recent_trailing = if model.recent_truncated {
        Some((
            TRAY_RECENT_VIEW_ALL_ID,
            non_empty_or(&model.labels.recent_view_all, "查看全部…"),
        ))
    } else {
        None
    };
    rebuild_submenu(
        app,
        &handles.recent,
        &model.recent,
        TRAY_RECENT_PREFIX,
        false,
        recent_trailing,
    )
    .map_err(err)?;
    handles
        .recent
        .set_enabled(!model.recent.is_empty())
        .map_err(err)?;

    rebuild_submenu(
        app,
        &handles.workspaces,
        &model.workspaces,
        TRAY_WORKSPACE_PREFIX,
        true,
        None,
    )
    .map_err(err)?;
    handles
        .workspaces
        .set_enabled(!model.workspaces.is_empty())
        .map_err(err)?;

    let runs_trailing = if model.runs.is_empty() {
        None
    } else {
        Some((
            TRAY_RUN_STOP_ALL_ID,
            non_empty_or(&model.labels.stop_all, "全部停止"),
        ))
    };
    rebuild_submenu(
        app,
        &handles.runs,
        &model.runs,
        TRAY_RUN_PREFIX,
        false,
        runs_trailing,
    )
    .map_err(err)?;
    handles
        .runs
        .set_enabled(!model.runs.is_empty())
        .map_err(err)?;

    // 定时任务是启用开关：可勾选子项（✓ = enabled），点击翻转状态。
    rebuild_submenu(
        app,
        &handles.cron,
        &model.cron,
        TRAY_CRON_PREFIX,
        true,
        None,
    )
    .map_err(err)?;
    handles
        .cron
        .set_enabled(!model.cron.is_empty())
        .map_err(err)?;

    // 托盘图标附属状态。
    let tooltip = model.tooltip.as_deref().unwrap_or("LiveAgent");
    if let Err(error) = handles.tray_icon.set_tooltip(Some(tooltip)) {
        // Linux 不支持 tooltip；仅记录不失败。
        eprintln!("failed to set tray tooltip: {error}");
    }
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = handles.tray_icon.set_title(model.badge_text.as_deref()) {
            eprintln!("failed to set tray title badge: {error}");
        }
    }

    Ok(())
}

fn compose_status_line(app_version: &str, status_suffix: Option<&str>) -> String {
    let base = format!("LiveAgent {app_version}");
    match status_suffix {
        Some(suffix) if !suffix.trim().is_empty() => format!("{base} · {}", suffix.trim()),
        _ => base,
    }
}

fn non_empty_or<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}

fn set_text_if_present(item: &MenuItem<tauri::Wry>, text: &str) -> tauri::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    item.set_text(text)
}

fn set_check_text_if_present(item: &CheckMenuItem<tauri::Wry>, text: &str) -> tauri::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    item.set_text(text)
}

fn set_submenu_text_if_present(item: &Submenu<tauri::Wry>, text: &str) -> tauri::Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    item.set_text(text)
}

/// 清空并按模型重建子菜单。只能在能安全阻塞的线程调用（IPC 命令线程或主线程）。
fn rebuild_submenu(
    app: &AppHandle,
    submenu: &Submenu<tauri::Wry>,
    entries: &[TrayMenuEntry],
    prefix: &str,
    checkable: bool,
    trailing: Option<(&str, &str)>,
) -> tauri::Result<()> {
    while submenu.remove_at(0)?.is_some() {}

    for entry in entries.iter().take(TRAY_SUBMENU_MAX_ENTRIES) {
        let id = format!("{prefix}{}", entry.id);
        let label = sanitize_menu_label(&entry.label, TRAY_LABEL_MAX_WIDTH);
        if checkable {
            let item = CheckMenuItem::with_id(app, id, label, true, entry.checked, None::<&str>)?;
            submenu.append(&item)?;
        } else {
            let item = MenuItem::with_id(app, id, label, true, None::<&str>)?;
            submenu.append(&item)?;
        }
    }

    if let Some((trailing_id, trailing_label)) = trailing {
        if !entries.is_empty() {
            submenu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        let item = MenuItem::with_id(
            app,
            trailing_id,
            sanitize_menu_label(trailing_label, TRAY_LABEL_MAX_WIDTH),
            true,
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }

    Ok(())
}

/// 用户数据进菜单前的统一消毒：控制字符/零宽字符转空格并折叠、
/// 按显示宽度截断（CJK 记 2 个半角）、`&`→`&&`（Windows 助记符；
/// macOS 由 muda strip_mnemonic 剥裸 `&`，转义后可原样显示）。
pub(crate) fn sanitize_menu_label(text: &str, max_width: usize) -> String {
    let mut cleaned = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        let is_space = c.is_whitespace() || c.is_control() || c == '\u{200B}';
        if is_space {
            if !cleaned.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            cleaned.push(' ');
            pending_space = false;
        }
        cleaned.push(c);
    }

    let mut out = String::new();
    let mut width = 0usize;
    let mut truncated = false;
    for c in cleaned.chars() {
        let w = char_display_width(c);
        if width + w > max_width {
            truncated = true;
            break;
        }
        width += w;
        out.push(c);
    }
    if truncated {
        while out.ends_with(' ') {
            out.pop();
        }
        out.push('…');
    }
    if out.is_empty() {
        out.push('—');
    }

    out.replace('&', "&&")
}

/// 常见宽字符范围（CJK/全角/谚文/假名）记 2，其余记 1。
/// 够托盘截断用，不追求 UAX#11 全覆盖。
fn char_display_width(c: char) -> usize {
    let cp = c as u32;
    match cp {
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1FAFF
        | 0x20000..=0x3FFFD => 2,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_escapes_windows_mnemonic_ampersand() {
        assert_eq!(sanitize_menu_label("Fix & ship", 40), "Fix && ship");
        assert_eq!(sanitize_menu_label("a && b", 40), "a &&&& b");
    }

    #[test]
    fn sanitize_strips_control_chars_and_collapses_whitespace() {
        assert_eq!(
            sanitize_menu_label("第一行\n第二行\t结尾  ", 40),
            "第一行 第二行 结尾"
        );
        assert_eq!(sanitize_menu_label("\u{200B}a\u{0007}b", 40), "a b");
    }

    #[test]
    fn sanitize_truncates_by_display_width_with_cjk_as_double() {
        // 10 个 CJK = 宽度 20；上限 10 → 5 个字 + 省略号。
        assert_eq!(
            sanitize_menu_label("一二三四五六七八九十", 10),
            "一二三四五…"
        );
        // ASCII 按 1 计。
        assert_eq!(sanitize_menu_label("abcdefghij", 5), "abcde…");
        // 不超限不截断。
        assert_eq!(sanitize_menu_label("abc", 5), "abc");
    }

    #[test]
    fn sanitize_empty_input_falls_back_to_dash() {
        assert_eq!(sanitize_menu_label("", 10), "—");
        assert_eq!(sanitize_menu_label("  \n\t ", 10), "—");
    }

    #[test]
    fn sanitize_truncation_before_escape_keeps_width_semantics() {
        // & 在截断阶段按 1 个半角计，转义发生在截断之后。
        assert_eq!(sanitize_menu_label("a&bcdef", 3), "a&&b…");
    }

    #[test]
    fn tray_menu_model_deserializes_from_camel_case_json() {
        let model: TrayMenuModel = serde_json::from_value(serde_json::json!({
            "labels": { "newChat": "New Chat", "openDataDir": "Open Data Folder" },
            "statusSuffix": "Remote connected",
            "recent": [{ "id": "c1", "label": "对话 A" }],
            "recentTruncated": true,
            "workspaces": [{ "id": "w1", "label": "默认项目", "checked": true }],
            "runs": [],
            "cron": [{ "id": "t1", "label": "夜间构建" }],
            "theme": "dark",
            "gatewayEnabled": true,
            "newChatAccelerator": "Ctrl+Shift+KeyN",
            "tooltip": "LiveAgent · 空闲",
            "badgeText": null
        }))
        .expect("model should deserialize");

        assert_eq!(model.labels.new_chat, "New Chat");
        assert_eq!(model.labels.open_data_dir, "Open Data Folder");
        assert_eq!(model.status_suffix.as_deref(), Some("Remote connected"));
        assert_eq!(model.recent.len(), 1);
        assert!(model.recent_truncated);
        assert!(model.workspaces[0].checked);
        assert_eq!(model.theme, "dark");
        assert!(model.gateway_enabled);
        assert_eq!(
            model.new_chat_accelerator.as_deref(),
            Some("Ctrl+Shift+KeyN")
        );
        assert!(model.badge_text.is_none());
        // 缺省字段回退默认。
        assert!(model.labels.show.is_empty());
        assert!(model.show_accelerator.is_none());
    }

    #[test]
    fn compose_status_line_appends_suffix_only_when_non_empty() {
        assert_eq!(compose_status_line("1.3.0", None), "LiveAgent 1.3.0");
        assert_eq!(compose_status_line("1.3.0", Some("  ")), "LiveAgent 1.3.0");
        assert_eq!(
            compose_status_line("1.3.0", Some("远程已连接")),
            "LiveAgent 1.3.0 · 远程已连接"
        );
    }
}
