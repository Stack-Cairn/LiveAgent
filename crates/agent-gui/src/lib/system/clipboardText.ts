import { invoke } from "@tauri-apps/api/core";

/**
 * 桌面端自定义菜单"粘贴"的唯一剪贴板读取入口。
 *
 * WKWebView 里 navigator.clipboard.readText() 只有当剪贴板内容是本页面自己
 * 写入时才静默放行；内容来自其他应用时 WebKit 会弹出原生"粘贴"确认气泡
 * （DOM paste access），表现为点击自定义粘贴按钮后又冒出一个原生 Paste 按钮。
 * 因此一律先走 Rust 侧读原生剪贴板（不经过 webview 授权 UI），webview API
 * 仅作为原生读取失败（如 Windows 剪贴板被独占）时的兜底。
 *
 * 返回值契约：字符串（可为空）= 读取成功；null = 两条通道都不可用，
 * 调用方可自行决定是否退回浏览器原生粘贴行为。
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    return await invoke<string>("system_clipboard_read_text");
  } catch {
    // Fall through to the webview clipboard API.
  }
  try {
    return (await navigator.clipboard?.readText?.()) ?? "";
  } catch {
    return null;
  }
}
