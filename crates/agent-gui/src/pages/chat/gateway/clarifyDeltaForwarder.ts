// crates/agent-gui/src/pages/chat/gateway/clarifyDeltaForwarder.ts
//
// 澄清流式增量的串行合帧转发：每个 token 直接 fire-and-forget invoke 会并发
// 落到 Tauri 异步运行时，突发时可能乱序（预览短暂错乱），且每 token 一条
// IPC + 网关 WS 消息。这里保证任一时刻至多一个 invoke 在途，在途期间到达的
// 增量并入缓冲，下一次冲刷合为一条——既保序又天然限频。

/** 包一层串行冲刷循环；send 失败只告警不中断（Rust 侧对非 pending 请求静默丢弃）。 */
export function createClarifyDeltaForwarder(
  send: (text: string) => Promise<unknown>,
  onError: (error: unknown) => void = () => {},
): (delta: string) => void {
  let buffer = "";
  let flushing = false;

  const flush = async () => {
    flushing = true;
    try {
      while (buffer) {
        const text = buffer;
        buffer = "";
        try {
          await send(text);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      flushing = false;
    }
  };

  return (delta) => {
    if (!delta) return;
    buffer += delta;
    if (!flushing) {
      void flush();
    }
  };
}
