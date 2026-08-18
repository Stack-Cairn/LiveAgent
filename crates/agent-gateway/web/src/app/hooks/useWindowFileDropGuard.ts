import { useEffect } from "react";

function dragEventHasFiles(event: globalThis.DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * 浏览器对未处理的文件拖放的默认行为是在当前标签页直接打开该文件，等于
 * 丢掉整个应用状态。已声明的拖放区（聊天面板、侧栏工作空间区）会先于
 * window 处理并 preventDefault，这里只兜底其余所有落点。
 */
export function useWindowFileDropGuard() {
  useEffect(() => {
    const handleDragOver = (event: globalThis.DragEvent) => {
      if (!dragEventHasFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "none";
      }
    };
    const handleDrop = (event: globalThis.DragEvent) => {
      if (!dragEventHasFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);
}
