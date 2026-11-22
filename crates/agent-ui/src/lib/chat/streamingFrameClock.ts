// One animation frame for everything a streaming reply redraws.
//
// The live transcript flush and the typewriter reveal both move on frames. Two
// independent requestAnimationFrame callbacks run back to back in the same
// frame, but the browser drains microtasks between them, so React commits
// once per callback: a reveal tick right after a store flush cost a second
// full commit every frame. Callbacks queued here run inside a single
// requestAnimationFrame callback, so every store emit and state update they
// make lands in one React render pass.

type FrameCallback = (now: number) => void;

type QueuedFrame = { callback: FrameCallback };

let queue: QueuedFrame[] = [];
let pendingFrame: {
  id: number;
  request: typeof requestAnimationFrame;
  cancel: typeof cancelAnimationFrame | undefined;
} | null = null;

function runFrame(now: number) {
  pendingFrame = null;
  const callbacks = queue;
  queue = [];
  for (const entry of callbacks) {
    try {
      entry.callback(now);
    } catch (error) {
      // One failing subscriber must not starve the rest of the frame.
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

/** Whether the shared frame clock can run (a browser frame loop exists). */
export function hasStreamingFrameClock(): boolean {
  return typeof globalThis.requestAnimationFrame === "function";
}

/**
 * Runs `callback` on the next shared streaming frame. Returns a cancel
 * function; cancelling the last queued callback also cancels the frame.
 */
export function requestStreamingFrame(callback: FrameCallback): () => void {
  const entry: QueuedFrame = { callback };
  queue.push(entry);
  // A frame requested through a since-replaced frame source (a test clock
  // that was torn down) will never fire: schedule on the current one.
  if (pendingFrame === null || pendingFrame.request !== globalThis.requestAnimationFrame) {
    const request = globalThis.requestAnimationFrame;
    // Host frame functions must be called on the window: WebKit rejects any
    // other receiver ("Can only call Window.cancelAnimationFrame on instances
    // of Window"), so the stored references are always invoked through call().
    pendingFrame = {
      id: request.call(globalThis, runFrame),
      request,
      cancel: globalThis.cancelAnimationFrame,
    };
  }
  return () => {
    const index = queue.indexOf(entry);
    if (index === -1) return;
    queue.splice(index, 1);
    if (queue.length === 0 && pendingFrame !== null) {
      pendingFrame.cancel?.call(globalThis, pendingFrame.id);
      pendingFrame = null;
    }
  };
}
