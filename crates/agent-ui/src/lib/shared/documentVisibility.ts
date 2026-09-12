import { useEffect, useState } from "react";

/**
 * 文档是否隐藏。
 *
 * 两个信号都当作隐藏：`document.hidden` 与 `document.visibilityState` 本该同步，
 * 但 Tauri/WKWebView 的后台启动状态下出现过 `hidden=true` 而 `visibilityState`
 * 仍是 `"visible"` 的组合（原实现见设置页的 section-enter 兜底）。
 *
 * 退出后台时 `visibilitychange` 只会触发一次，因此以隐藏期间的定时器一律用
 * 「重新订阅 + 重算」而不是「暂停后继续累加」的方式恢复。
 */
export function isDocumentHidden(): boolean {
  if (typeof document === "undefined") return false;
  return document.hidden || document.visibilityState === "hidden";
}

/**
 * 订阅文档可见性。渲染进程在窗口不可见时不该继续跑每秒心跳、重建账本或重绘
 * 长列表——这些工作产生的帧用户看不到，却照样烧 CPU（长会话下表现为渲染进程
 * 持续 80%+ 与整机热限流）。
 */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(isDocumentHidden);

  useEffect(() => {
    const sync = () => setHidden(isDocumentHidden());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return hidden;
}
