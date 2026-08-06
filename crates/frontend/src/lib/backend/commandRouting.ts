/**
 * 命令与事件的分流表：哪些走 Tauri 壳，哪些走网络。
 *
 * 这是阶段 4「前端只通过网络和后端说话」的唯一判定处。业务代码继续写
 * `invoke("chat_history_list")` / `listen("terminal:event")`，由这里决定
 * 它落到 loopback HTTP 还是壳的 IPC。
 *
 * 分类依据是 docs/architecture/command-classes/ 下的三份清单：
 *   frontend.txt(18) 留在壳里，backend.txt(195) 走网络，deleted.txt(21) 即将消失。
 * 判定规则用**反向**写法：只列出壳专属的少数，其余一律走网络。新增后端
 * command 不需要改这个文件——这正是不用 195 行白名单的原因。
 */

/**
 * 壳专属命令（docs/architecture/command-classes/frontend.txt 的 18 个）。
 *
 * 托盘、窗口、更新、系统文件对话框、剪贴板——这些是「这台机器上的这个窗口」
 * 的能力，走网络没有意义：远程浏览器里点「选择文件夹」应该弹的是浏览器的
 * 对话框，而不是后端服务器的。
 */
export const SHELL_ONLY_COMMANDS = new Set([
  "app_confirmed_exit",
  "app_macos_traffic_light_metrics",
  "app_restart",
  "app_runtime_platform",
  "app_set_close_window_behavior",
  "app_set_global_shortcuts",
  "app_toggle_window_pin",
  "app_tray_menu_sync",
  "app_update_check",
  "app_update_install",
  "app_window_pinned",
  "fs_open_workspace_path",
  "git_open_system_file_location",
  "open_chat_file_link",
  "system_clipboard_read_text",
  "system_pick_file",
  "system_pick_folder",
  "system_pick_readable_files",
  // 壳告诉前端「内嵌后端在哪、密码是什么」。它按定义只能由壳回答。
  "get_backend_endpoint",
]);

/**
 * 已经删掉的命令（deleted.txt）里仍有前端调用点的部分。
 *
 * 20 个 gateway_* 中继命令的调用点已随运行镜像/远程队列协议一并清除，
 * 不再需要拦截。剩下 proxy_get_server_info：本地反代自举，前端 LLM 流式
 * （标题任务等）仍在调用，但 Rust 侧已随阶段 4 移除——走 IPC 会得到
 * "command not found"、走 HTTP 会得到 404。这里本地拦下并给迁移提示，
 * 直到该链路在后端重建（见迁移文档 B 组能力）。
 */
export const REMOVED_GATEWAY_COMMANDS = new Set(["proxy_get_server_info"]);

/**
 * 这条命令该走 Tauri 壳吗？
 *
 * `plugin:*` 是 Tauri 插件（窗口、托盘、opener、事件插件）的调用面，永远归壳。
 * 事件插件（plugin:event|*）由调用方在更上层拦掉，走不到这里。
 */
export function isShellCommand(cmd: string): boolean {
  if (cmd.startsWith("plugin:")) return true;
  return SHELL_ONLY_COMMANDS.has(cmd);
}

/**
 * v1 迁移提示的共用尾巴。命令拦截和登录页的地址探测各自加自己的开头，
 * 但「该怎么办」这句话只写一处。
 */
export const LEGACY_GATEWAY_MESSAGE =
  "v2 不再需要 Gateway：桌面端不再外拨连接它，改为前端直连后端（本机或远程）。" +
  "迁移步骤见 README 的 v2 迁移指南。";

/**
 * 壳自己发的事件（Tauri `AppHandle::emit`），不在后端事件总线上。
 *
 * 桌面壳内嵌的 backend 是**另一个** EventBus 实例（src-tauri
 * backend_server.rs 独立 build_state），所以「壳发的」和「后端发的」两组事件
 * 名字互不相交。按名字分流因此是确定的：一个事件只会有一个来源，不会重复投递。
 *
 * 这里列的是壳侧来源（frontend/src-tauri/src/lib.rs 的 emit 点）：
 *   - app:action / app:action-feedback  托盘菜单与全局快捷键触发的动作
 *   - terminal:exit-requested           关窗时「还有终端在跑」的确认请求
 *   - global-shortcut:*                 快捷键状态变化
 *   - tauri://*                         Tauri 内置窗口事件
 * 其余（terminal:event、terminal:stream、sftp:event、tunnel:state、
 * workspace:activity、token_delta 等）全部来自后端，走 WS。
 *
 * `gateway:*` 故意**不在**这里：壳侧的 GatewayController 已随阶段 4 删除，
 * 没有任何发送方了。让它落进默认的 WS 分支（同样收不到），至少不为一组死
 * 事件再留一条 IPC 订阅。
 */
const SHELL_EVENTS = new Set(["app:action", "app:action-feedback", "terminal:exit-requested"]);

const SHELL_EVENT_PREFIXES = ["global-shortcut:", "tauri://"];

export function isShellEvent(event: string): boolean {
  if (SHELL_EVENTS.has(event)) return true;
  return SHELL_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix));
}
