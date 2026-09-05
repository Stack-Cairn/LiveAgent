# 历史会话打开后宽度手柄失效（#749）

## 现象

Issue #749：桌面端左侧会话栏展开时，从最近会话打开一个历史会话，正文左右边界 hover 与拖拽都没有反应；收起左侧栏后手柄恢复。报告缺两项运行时数据：失效时会话 Pane 的实际宽度、历史加载遮罩是否还在 DOM 里。

## 分支

分支：`fix/transcript-width-controls-after-history-switch`，基线 `main@be86449f`（v1.3.1）。改动集中在共享宽度手柄组件及其两端接入点，未触碰打开会话的状态机。

## 源码结论

两条分支都能产生同一表象，源码层面都已确认：

1. 遮罩分支。`HistorySwitchLoadingOverlay` 是 `absolute inset-0 z-30`、不透传指针，在 DOM 里排在 `z-10` 的 `TranscriptWidthControls` 之后。遮罩挂载期间手柄不可能被命中。WebUI 的 `.gateway-history-switch-overlay`（`--layer-panel` = 20）与手柄（10）是同一结构。遮罩本身是 `bg-background` 不透明骨架屏，如果它一直挂着，用户看到的是骨架而非正文，所以它解释"遮罩可见时点不到"，解释不了遮罩消失后的持续失效。
2. 阈值分支。`resolveStageMaxWidth` 先减 64px 安全间距、下限 560，`areWidthControlsUsable` 只在上限大于 560 时为真，于是宿主 ≤ 624px 时组件返回 `null`，DOM 里没有任何痕迹。"2560 × 1528 最大化"很可能是物理尺寸：2560×1600 面板在 Windows 150% / 200% 缩放下，CSS 视口只有 1707 / 1280px，再扣掉 272px 侧栏和右侧 dock（320–720px）或分屏，会话 Pane 正好落在 624 这道坎附近。收起侧栏加回 272px 就跨过阈值，与"收起后恢复"吻合。

没有找到 `maxWidth` 卡在旧值的路径：ResizeObserver 挂在稳定的转录根上；切换历史会话不会重挂 `ChatTranscript`（只有 `TranscriptList` 按会话 key 重挂）；CSS 变量只有一个 owner；`controlsHidden` 每次渲染都重读 `matchMedia`。

## 决策

Issue 的开放问题：遮罩可见时是否允许调宽度。答案是不允许。不透明骨架下没有可抓的边界，可聚焦的 `role="separator"` 也不应藏在拦截层下面。因此不提升手柄的 z-index，而是在遮罩挂载期间挂起手柄，并要求遮罩离开的同一次 commit 里手柄回来。

## 改动

- `crates/agent-ui/src/lib/transcript-width/transcriptWidthModel.ts`：新增 `resolveTranscriptWidthControlsState`，按 suspended → media-hidden → stage-narrow → ready 的顺序给出当前关掉手柄的那道闸。
- `crates/agent-ui/src/pages/chat/transcript/TranscriptWidthControls.tsx`：
  - 新增 `suspended` 属性。挂起时不渲染手柄，进行中的拖拽以当前宽度结束提交；观察器继续运行，CSS 变量持续钳位。
  - 挂载与每次揭示都在 layout effect 里同步重测宿主，遮罩期间 Pane 尺寸变了也能在恢复的那一帧拿到正确上限，不再依赖后续无关的布局变化唤醒观察器。
  - 根节点在所有状态下常驻，带 `data-transcript-width-state` 与 `data-transcript-width-max`，隐藏态用 `hidden` 移出布局、命中与无障碍树。
- `crates/agent-gui/src/pages/chat/transcript/ChatTranscript.tsx`：`isTranscriptBusy = isHistorySwitching || isTranscriptSettling`，同时驱动遮罩与 `suspended`。
- `crates/agent-gateway/web/src/app/GatewayAppView.tsx`：两处 `TranscriptWidthControls` 传 `suspended={conversationOpenState.showOverlay}`；`base-chat.css` 补注释。
- 测试：`crates/agent-gui/test/chat/transcript-width-controls-history-switch.test.mjs`（jsdom + 真实 react-dom）、`crates/agent-gateway/web/test/transcript-width-history-overlay.test.mjs`（源码与 CSS 静态断言）。

## 调试客户端验证

1. 保持左侧栏展开，从最近会话打开一个历史会话，等骨架屏消失。
2. 打开 DevTools，在 Console 执行：

```js
const controls = document.querySelector(".transcript-width-controls");
({
  state: controls?.dataset.transcriptWidthState,
  stageMax: controls?.dataset.transcriptWidthMax,
  hostWidth: controls?.parentElement.getBoundingClientRect().width,
  overlayMounted: !!document.querySelector("[data-pane-loading-skeleton]"),
  separatorMax: document.querySelector('[role="separator"]')?.getAttribute("aria-valuemax"),
  dpr: window.devicePixelRatio,
  viewport: window.innerWidth,
});
```

3. 读法：
   - `state === "ready"`：手柄在 DOM 里。把鼠标移到正文列左右边界任意高度（命中区全高、17px 宽），应出现 col-resize 光标与指示条，可拖动。
   - `state === "stage-narrow"`：宿主 CSS 宽度 ≤ 624px，手柄按设计隐藏。对照 `hostWidth`、`dpr`、右侧 dock 与分屏；收起侧栏后应变为 `ready`。
   - `state === "suspended"` 而 `overlayMounted` 为 false：遮罩状态与手柄状态脱节，属于新问题，请连同 `hostWidth` 一起反馈。
   - `state === "media-hidden"`：`(max-width: 820px), (pointer: coarse)` 命中，检查 `viewport` 与主指针类型。
4. 再收起、展开一次左侧栏，`state` 与 `separatorMax` 应只随 `hostWidth` 变化。

## 未做

- 没有下调 624px 阈值或 64px 安全间距。若验证结果是 `stage-narrow`，那是窄 Pane 下的既定行为，是否调整阈值另议。
- 没有改动 `openController` 与首屏 settle 逻辑，静态分析未发现遮罩卡住的路径。

## 后续调整：扩大手柄触发区（2026-09-05）

调试客户端验证通过后的反馈：手柄 96px 高、12px 宽的命中区太小，难触发。按要求把透明命中区改为全高，宽度 12px → 17px（`inset-y-0` + `w-[17px]`，与 `DetailsResizeHandle`、`RightDockPanel` 两个全高 col-resize 手柄同构）。可见的小竖条外观与悬停/拖拽加亮规格不变，只有命中区变大。

代价：正文列左右边缘各约 8.5px 的全高条带被手柄接管指针，从最边缘像素起始的文本选取会被挡住——这是全高命中区的固有取舍。`measurements-lru.test.mjs` 中原本锁定"命中区局部化"的测试反转为锁定全高 + 17px。
