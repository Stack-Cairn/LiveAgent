/**
 * 桌面端 webview 导航守卫（GUI 专属，勿镜像到 WebUI —— 浏览器里 F5 刷新是用户预期）。
 *
 * WebView2（Windows）等宿主 webview 自带一批"浏览器加速键"：F5/Ctrl+R/Ctrl+F5 刷新、
 * Ctrl+F/F3 原生查找条、Ctrl+P 打印、Ctrl+S 保存页面、Ctrl+O 打开文件、Ctrl+U 查看源码、
 * F7 光标浏览、Alt+←/→/Home 历史导航；鼠标侧键（button 3/4）与页内拖放同样会触发
 * 历史导航或页面跳转。这些默认行为会把整个应用当网页刷新/导航走，表现为"软件整体刷新"。
 *
 * Chromium 系加速键在页面对 keydown preventDefault 后不再执行，所以统一在 window
 * 捕获阶段取消默认行为。只 preventDefault、绝不 stopPropagation：xterm/Monaco/
 * 应用内快捷键处理器仍照常收到事件。
 */

export interface GuardKeyInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface GuardKeyOptions {
  /** macOS 上 Option+方向键是分词移动光标的编辑默认行为，历史导航拦截仅限非 mac。 */
  isMac: boolean;
  /** dev 下放行刷新组合键（F5/Ctrl+R/Cmd+R），方便本地整页重载调试。 */
  allowReloadChords: boolean;
}

/** 键盘媒体导航键（UI Events 标准 key 值），一律取消默认行为。 */
const BROWSER_NAV_KEYS = new Set([
  "BrowserBack",
  "BrowserForward",
  "BrowserHome",
  "BrowserSearch",
  "BrowserFavorites",
  "BrowserStop",
]);

// 主修饰键（Ctrl/Cmd）组合下要拦的物理键：打印/查找/保存页面/打开文件/查看源码。
// 同时按 code 与 key 匹配 —— 非拉丁布局（如西里尔）下 key 是本地字符，
// 而 webview 加速键按物理键位（code）生效。
const PRIMARY_BLOCKED_CODES = new Set(["KeyP", "KeyF", "KeyS", "KeyO", "KeyU"]);
const PRIMARY_BLOCKED_KEYS = new Set(["p", "f", "s", "o", "u"]);

/**
 * 判断一次 keydown 是否应取消 webview 的浏览器默认行为。
 * 纯函数，便于穷举测试；不判定应用内快捷键（那些走各自组件的处理器）。
 */
export function shouldBlockBrowserKeyDefault(
  event: GuardKeyInput,
  options: GuardKeyOptions,
): boolean {
  const primary = event.ctrlKey || event.metaKey;

  // 刷新全家桶：F5 / Ctrl+F5 / Shift+F5 / 键盘 BrowserRefresh 媒体键。
  if (event.key === "F5" || event.key === "BrowserRefresh") {
    return !options.allowReloadChords;
  }
  // F3 查找下一个、F7 光标浏览确认框（均为 WebView2 加速键）。
  if (event.key === "F3" || event.key === "F7") return true;
  if (BROWSER_NAV_KEYS.has(event.key)) return true;

  // AltGr 在 Windows 上报告为 ctrl+alt，放行以免吞掉特殊字符输入。
  if (primary && !event.altKey) {
    if (event.code === "KeyR" || event.key.toLowerCase() === "r") {
      return !options.allowReloadChords;
    }
    if (
      PRIMARY_BLOCKED_CODES.has(event.code) ||
      PRIMARY_BLOCKED_KEYS.has(event.key.toLowerCase())
    ) {
      return true;
    }
  }

  // Alt+←/→ 历史导航、Alt+Home 回主页（Windows/Linux webview）。
  if (!options.isMac && event.altKey && !primary) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home") {
      return true;
    }
  }

  return false;
}

/** 往输入框/富文本拖文本是合法编辑操作，拖放守卫对可编辑目标放行。 */
function isEditableDragTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  return el.isContentEditable === true;
}

export interface WebviewNavigationGuardOptions {
  isMac: boolean;
  allowReloadChords?: boolean;
}

/** 结构化的最小事件源类型：生产传 window，测试传录制用的假实现。 */
export interface GuardEventSource {
  addEventListener(
    type: string,
    listener: (event: never) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: never) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

let uninstallCurrent: (() => void) | null = null;

/**
 * 安装 webview 导航守卫，返回卸载函数。重复安装会先卸载上一份（幂等，兼容 HMR）。
 * 在 React 挂载前调用，保证 UI 崩溃兜底页之外的一切阶段都有防护。
 */
export function installWebviewNavigationGuard(
  options: WebviewNavigationGuardOptions,
  target?: GuardEventSource,
): () => void {
  const win = target ?? (typeof window === "undefined" ? null : window);
  if (!win) return () => {};
  uninstallCurrent?.();

  const keyOptions: GuardKeyOptions = {
    isMac: options.isMac,
    allowReloadChords: options.allowReloadChords ?? false,
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (shouldBlockBrowserKeyDefault(event, keyOptions)) event.preventDefault();
  };

  // 鼠标侧键（button 3/4）在 Chromium/WebView2 上触发历史前进/后退；
  // mousedown+mouseup 都取消，覆盖不同引擎的触发时机。
  const onNavMouseButton = (event: MouseEvent) => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  };

  // 页内拖放（链接/图片/选中文本拖到非可编辑区域）默认会让 webview 导航到拖体。
  // 组件自己处理过的（defaultPrevented）与可编辑目标放行；冒泡阶段注册，
  // 保证晚于 React 根容器的委托处理器。外部文件拖入由 Tauri 原生 dragDrop 接管，
  // 不产生 HTML5 拖放事件，不受此守卫影响。
  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || isEditableDragTarget(event.target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented || isEditableDragTarget(event.target)) return;
    event.preventDefault();
  };

  // 漏写 onSubmit preventDefault 的表单默认会整页导航（等效刷新）——兜底取消。
  const onSubmit = (event: Event) => {
    if (!event.defaultPrevented) event.preventDefault();
  };

  win.addEventListener("keydown", onKeyDown, { capture: true });
  win.addEventListener("mousedown", onNavMouseButton, { capture: true });
  win.addEventListener("mouseup", onNavMouseButton, { capture: true });
  win.addEventListener("dragover", onDragOver);
  win.addEventListener("drop", onDrop);
  win.addEventListener("submit", onSubmit);

  const uninstall = () => {
    win.removeEventListener("keydown", onKeyDown, { capture: true });
    win.removeEventListener("mousedown", onNavMouseButton, { capture: true });
    win.removeEventListener("mouseup", onNavMouseButton, { capture: true });
    win.removeEventListener("dragover", onDragOver);
    win.removeEventListener("drop", onDrop);
    win.removeEventListener("submit", onSubmit);
    if (uninstallCurrent === uninstall) uninstallCurrent = null;
  };
  uninstallCurrent = uninstall;
  return uninstall;
}
