import { startTransition, useCallback, useRef, useState } from "react";

// Base UI 的 Dialog 在挂载瞬间 open 已为 true 时不会进入 starting-style（无入场过渡），
// 关闭时直接卸载 Root 也会丢掉 ending-style（无退场过渡）。
// 因此抽屉需常驻挂载：open 由"是否有内容"驱动；关闭后父级立刻清空内容，
// 这里保留最后一份快照渲染完退场动画（onOpenChangeComplete(false)）再释放。
// entered 在入场动画完成后才为 true，调用方先用骨架屏顶替重内容，避免动画期掉帧。
export function useDrawerPresence<T>(current: T | null): {
  open: boolean;
  snapshot: T | null;
  entered: boolean;
  handleOpenChangeComplete: (nextOpen: boolean) => void;
} {
  const open = current !== null;
  const retainedRef = useRef<T | null>(null);
  if (current !== null) {
    retainedRef.current = current;
  }
  const [entered, setEntered] = useState(false);
  const handleOpenChangeComplete = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      startTransition(() => setEntered(true));
    } else {
      retainedRef.current = null;
      setEntered(false);
    }
  }, []);
  return {
    open,
    snapshot: current ?? retainedRef.current,
    entered,
    handleOpenChangeComplete,
  };
}
