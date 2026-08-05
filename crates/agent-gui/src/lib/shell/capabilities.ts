/**
 * 壳能力探测（阶段 5 · 决策 16）。
 *
 * 一份代码跑在两种宿主里：Tauri 桌面壳和纯浏览器。差异不靠构建分叉，
 * 靠这里的运行时探测——浏览器里没有的能力，入口隐藏或用 Web API 降级。
 *
 * 判定源头只有一个：`isDesktopShell()`（真 Tauri internals 在场且不是我们
 * 自己装的网络 shim）。托盘/更新/窗口控制/全局快捷键/原生对话框都是
 * 「壳在不在」的同义词，分开命名只是为了让调用点说清自己在问什么，
 * 将来某个能力的判定条件分化时（比如 Linux 无托盘）也只改这里。
 */

import { isDesktopShell } from "../backend/endpoint";

/** 跑在 Tauri 桌面壳里？浏览器里为 false。 */
export function hasShell(): boolean {
  return isDesktopShell();
}

/** 系统托盘（托盘菜单、托盘图标状态同步）。 */
export function hasTray(): boolean {
  return hasShell();
}

/** 应用自更新（检查更新、下载安装、重启）。浏览器版本随后端走，无此概念。 */
export function hasUpdater(): boolean {
  return hasShell();
}

/** 窗口控制：置顶、关闭行为、macOS 红绿灯留白。浏览器窗口归浏览器管。 */
export function hasWindowControls(): boolean {
  return hasShell();
}

/** 系统级全局快捷键。浏览器里只有页面内快捷键。 */
export function hasGlobalShortcuts(): boolean {
  return hasShell();
}

/**
 * 原生文件/文件夹对话框（system_pick_file / system_pick_folder）。
 *
 * 注意语义：这些对话框选的是**后端所在机器**上的路径。桌面壳里前端和后端
 * 同机，弹原生对话框是对的；浏览器连远程后端时，弹浏览器对话框选到的是
 * 用户本机路径，对后端毫无意义——所以浏览器里是「隐藏浏览按钮、手输路径」，
 * 不是降级成 <input type=file>。
 */
export function hasNativeFileDialogs(): boolean {
  return hasShell();
}

/**
 * 用系统程序打开本机文件/目录（open_chat_file_link、fs_open_workspace_path、
 * git_open_system_file_location）。同上，浏览器连远程后端时无对应物。
 */
export function hasSystemFileOpener(): boolean {
  return hasShell();
}
