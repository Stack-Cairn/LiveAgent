import type { TerminalStreamChunk } from "./types";

/**
 * 终端输出流句柄注册表：按 sessionId 分桶派发。
 *
 * 旧实现把所有 handle 放在一个 Set 里，每个输出事件遍历全部 handle 再按
 * sessionId 过滤（O(N)）。画板多终端 Pane 并列后同时存活的 handle 变多，
 * 高频输出下改为 Map<sessionId, Set> 桶内 O(1) 派发。
 *
 * 同一 session 理论上被 View Lease 限制为单 handle，但数据结构上仍允许
 * 多 handle 共存（防御：租约转移瞬间新旧 handle 可能短暂交叠）。
 */
export type TerminalStreamDispatchTarget = {
  accept(chunk: TerminalStreamChunk): void;
};

export function createTerminalStreamHandleRegistry<Handle extends TerminalStreamDispatchTarget>() {
  const handlesBySession = new Map<string, Set<Handle>>();

  return {
    add(sessionId: string, handle: Handle) {
      const key = sessionId.trim();
      if (!key) return;
      let bucket = handlesBySession.get(key);
      if (!bucket) {
        bucket = new Set();
        handlesBySession.set(key, bucket);
      }
      bucket.add(handle);
    },
    remove(sessionId: string, handle: Handle) {
      const key = sessionId.trim();
      const bucket = handlesBySession.get(key);
      if (!bucket) return;
      bucket.delete(handle);
      if (bucket.size === 0) {
        handlesBySession.delete(key);
      }
    },
    dispatch(chunk: TerminalStreamChunk) {
      const bucket = handlesBySession.get(chunk.sessionId);
      if (!bucket) return;
      // 快照遍历：accept 内部可能触发 dispose → remove，避免遍历中修改集合。
      for (const handle of Array.from(bucket)) {
        handle.accept(chunk);
      }
    },
    handleCount(sessionId: string) {
      return handlesBySession.get(sessionId.trim())?.size ?? 0;
    },
    sessionCount() {
      return handlesBySession.size;
    },
  };
}

export type TerminalStreamHandleRegistry<Handle extends TerminalStreamDispatchTarget> = ReturnType<
  typeof createTerminalStreamHandleRegistry<Handle>
>;
