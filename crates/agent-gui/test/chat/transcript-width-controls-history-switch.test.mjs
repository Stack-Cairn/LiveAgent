import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// #749：打开历史会话后宽度手柄不可用，收起侧栏才恢复。源码里有两条分支能造成
// 同一表象：(1) 历史加载遮罩（z-30、不透传指针）在挂载期间压住 z-10 的手柄；
// (2) 宿主 ≤ 624px 时组件整体不渲染，只有 ResizeObserver 再次送达才恢复。
// 本测试用 jsdom + 真实 react-dom 验证修复后的不变量：
// - 遮罩挂载期间手柄挂起；遮罩离开的同一次 commit 里手柄回来，且宿主被同步重测；
// - 宿主跨过 624/625px 阈值时手柄由观察器自动隐藏/恢复；
// - 无关的父级重渲染不改变手柄状态；
// - 根节点常驻并带 data-transcript-width-state，运行时能直接读出手柄被哪道闸关掉。

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const doc = env.dom.window.document;

// jsdom 没有 ResizeObserver：桩记录被观察的宿主，测试按需"送达一次尺寸变化"。
const observers = [];
class ResizeObserverStub {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    observers.push(this);
  }
  observe(target) {
    this.targets.add(target);
  }
  unobserve(target) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}
globalThis.ResizeObserver = ResizeObserverStub;

const { TranscriptWidthControls, CHAT_TRANSCRIPT_WIDTH_CSS_VAR } = env.loadModule(
  "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls.tsx",
);
const widthModel = env.loadModule("@liveagent/ui/lib/transcript-width/transcriptWidthModel.ts");

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// 与 ChatTranscript 同构：宽度 owner → 转录根（hostRef）→ 控件是根的子节点。
function Stage(props) {
  const hostRef = React.useRef(null);
  return React.createElement(
    "div",
    { "data-chat-width-owner": "", "data-testid": "owner" },
    React.createElement(
      "div",
      { ref: hostRef, "data-testid": "host" },
      React.createElement(TranscriptWidthControls, {
        hostRef,
        width: props.width,
        onWidthChange: props.onWidthChange,
        resizeLabel: "Resize",
        resetLabel: "Reset",
        suspended: props.suspended,
      }),
    ),
  );
}

async function mountStage({ stageWidth, width = 768, suspended = false, onWidthChange }) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  const stage = { width: stageWidth };
  const handleWidthChange = onWidthChange ?? (() => {});
  const render = async (overrides = {}) => {
    await act(async () => {
      root.render(
        React.createElement(Stage, {
          width,
          onWidthChange: handleWidthChange,
          suspended,
          ...overrides,
        }),
      );
    });
  };
  await render();
  const host = container.querySelector('[data-testid="host"]');
  // 宿主实测宽度由测试控制；挂载 RAF 此刻还没跑，第一次测量就读到它。
  host.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: stage.width,
    height: 600,
    right: stage.width,
    bottom: 600,
    toJSON() {
      return {};
    },
  });
  await act(async () => {
    await nextFrame();
  });
  return {
    container,
    host,
    stage,
    owner: container.querySelector('[data-testid="owner"]'),
    controls: () => container.querySelector(".transcript-width-controls"),
    separator: () => container.querySelector('[role="separator"]'),
    render,
    deliverResize: async () => {
      await act(async () => {
        for (const observer of observers) {
          for (const target of observer.targets) {
            observer.callback([{ target }], observer);
          }
        }
        await nextFrame();
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("the controls state names the first gate that hides the handles", () => {
  const { resolveTranscriptWidthControlsState: state, MIN_CHAT_TRANSCRIPT_WIDTH } = widthModel;
  assert.equal(state({ suspended: false, mediaHidden: false, maxWidth: 936 }), "ready");
  assert.equal(state({ suspended: true, mediaHidden: true, maxWidth: 560 }), "suspended");
  assert.equal(state({ suspended: false, mediaHidden: true, maxWidth: 936 }), "media-hidden");
  assert.equal(
    state({ suspended: false, mediaHidden: false, maxWidth: MIN_CHAT_TRANSCRIPT_WIDTH }),
    "stage-narrow",
  );
});

test("a stage below the hide threshold keeps the root mounted with a readable reason", async () => {
  const stage = await mountStage({ stageWidth: 600 });
  assert.equal(stage.separator(), null, "no handle can widen a 560px-max stage");
  const controls = stage.controls();
  assert.ok(controls, "controls root stays mounted while the handles are hidden");
  assert.equal(controls.dataset.transcriptWidthState, "stage-narrow");
  assert.equal(controls.dataset.transcriptWidthMax, String(widthModel.MIN_CHAT_TRANSCRIPT_WIDTH));
  assert.equal(controls.hidden, true);
  // 变量仍被钳到舞台上限：宿主 600 → 上限 560。
  assert.equal(stage.owner.style.getPropertyValue(CHAT_TRANSCRIPT_WIDTH_CSS_VAR), "560px");
  await stage.unmount();
});

test("crossing the threshold restores the handles through the stage observer alone", async () => {
  const stage = await mountStage({ stageWidth: 600 });
  assert.equal(stage.separator(), null);

  stage.stage.width = 900;
  await stage.deliverResize();

  const separator = stage.separator();
  assert.ok(separator, "separator returns once the stage can host more than the minimum");
  assert.equal(separator.getAttribute("aria-valuemax"), "836");
  assert.equal(stage.controls().dataset.transcriptWidthState, "ready");
  assert.equal(stage.controls().hidden, false);
  assert.equal(stage.owner.style.getPropertyValue(CHAT_TRANSCRIPT_WIDTH_CSS_VAR), "768px");
  await stage.unmount();
});

test("handles suspend behind a loading overlay and return, re-measured, when it lifts", async () => {
  const stage = await mountStage({ stageWidth: 1000 });
  assert.equal(stage.separator().getAttribute("aria-valuemax"), "936");

  await stage.render({ suspended: true });
  assert.equal(stage.separator(), null, "nothing is grabbable under an opaque overlay");
  assert.equal(stage.controls().dataset.transcriptWidthState, "suspended");
  assert.equal(stage.controls().hidden, true);

  // 遮罩期间 Pane 变宽，但观察器没有送达（模拟被吞掉/尚未派发的通知）。
  stage.stage.width = 1100;
  await stage.render({ suspended: false });

  const separator = stage.separator();
  assert.ok(separator, "separator is back in the commit that removed the overlay");
  assert.equal(
    separator.getAttribute("aria-valuemax"),
    "1036",
    "reveal re-measures the stage synchronously instead of trusting the pre-overlay ceiling",
  );
  assert.equal(stage.controls().dataset.transcriptWidthState, "ready");
  await stage.unmount();
});

test("an overlay arriving mid-drag commits the dragged width and drops the listeners", async () => {
  const committed = [];
  const stage = await mountStage({ stageWidth: 1000, onWidthChange: (w) => committed.push(w) });
  const handle = stage.separator();

  await act(async () => {
    handle.dispatchEvent(
      new env.dom.window.MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 500,
      }),
    );
  });
  assert.equal(doc.body.style.cursor, "col-resize");
  await act(async () => {
    env.dom.window.dispatchEvent(
      new env.dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 540 }),
    );
  });

  await stage.render({ suspended: true });

  // 右侧手柄拖 40px → 宽度 +80 → 848，落在 936 的舞台上限之内。
  assert.deepEqual(committed, [848]);
  assert.equal(doc.body.style.cursor, "", "drag cleanup restored the body cursor");
  assert.equal(stage.separator(), null);
  await stage.unmount();
});

test("an unrelated parent re-render leaves the handle state alone", async () => {
  const stage = await mountStage({ stageWidth: 1000 });
  const before = stage.separator();
  assert.ok(before);

  await stage.render();

  assert.ok(Object.is(stage.separator(), before), "same separator node survives the re-render");
  assert.equal(stage.separator().getAttribute("aria-valuemax"), "936");
  assert.equal(stage.controls().dataset.transcriptWidthState, "ready");
  await stage.unmount();
});

test("desktop pairs the history overlay with the suspended handles in one condition", () => {
  const transcriptSource = readFileSync(
    new URL("../../src/pages/chat/transcript/ChatTranscript.tsx", import.meta.url),
    "utf8",
  );
  const overlaySource = readFileSync(
    new URL("../../src/pages/chat/transcript/TranscriptLoadingStates.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    transcriptSource,
    /const isTranscriptBusy = isHistorySwitching \|\| isTranscriptSettling;/,
  );
  assert.match(
    transcriptSource,
    /<TranscriptWidthControls[\s\S]*?suspended=\{isTranscriptBusy\}[\s\S]*?\/>/,
  );
  assert.match(transcriptSource, /\{isTranscriptBusy \? <HistorySwitchLoadingOverlay \/> : null\}/);
  // 遮罩仍在手柄之上且拦截指针：选择"挂起手柄"而非"提升 z-index"，两端一致。
  assert.match(overlaySource, /className="absolute inset-0 z-30"/);
  assert.doesNotMatch(overlaySource, /pointer-events-none/);
});

test.after(() => {
  env.cleanup();
});
