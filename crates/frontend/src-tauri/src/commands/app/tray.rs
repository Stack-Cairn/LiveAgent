use std::sync::Arc;

use crate::services::tray::{apply_tray_menu, TrayMenuHandles, TrayMenuModel};

/// 前端推送托盘菜单模型（已本地化文案 + 动态列表 + 状态）。
/// 唯一的托盘内容写入口；apply 内部经菜单句柄代理到主线程执行。
#[tauri::command(rename_all = "snake_case")]
pub async fn app_tray_menu_sync(
    app: tauri::AppHandle,
    model: TrayMenuModel,
    handles: tauri::State<'_, Arc<TrayMenuHandles>>,
) -> Result<(), String> {
    apply_tray_menu(&app, &handles, model)
}
