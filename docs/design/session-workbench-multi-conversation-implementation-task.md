# Task：多会话可拖拽 Workbench 实施

| 元数据 | 内容 |
|---|---|
| 状态 | Ready for implementation / 待实施 |
| 日期 | 2026-08-16 |
| 设计基线 | [会话工作台可贴靠 Pane 架构设计 v0.5](./session-workbench-pane-architecture.md) |
| 研究依据 | [OTTY Pane 架构拆解](../reverse-engineering/otty/1.3.1/pane-architecture.md) · [OTTY 当前实现](../reverse-engineering/otty/1.3.1/current-state.md) |
| 代码基线 | `35787e16 refactor(ui): split conversation workbench layout` |
| 首期范围 | 多 Conversation Pane；固定 App Chrome；固定 Right Dock |

## 1. 任务目标

将当前单会话首页升级为始终可拼接的窗口级 Workbench：

1. 当前会话首页就是 Workbench 的第一个 Root Conversation Pane，不新增“进入布局模式”按钮。
2. 用户从左侧拖动一个历史会话到当前 Pane 的上、下、左、右或画布边缘时，直接扩展 PaneTree。
3. 新 Pane 复用历史会话的稳定 `conversationId`，展示与当前主会话相同的 Transcript、Composer、任务进度、审批、队列和模型控制。
4. 同一会话在同一窗口中最多存在一个可编辑 Pane；再次拖入时移动或聚焦现有 Pane，不复制 DOM、Composer 或 Runtime。
5. Pane 移动、交换和调整比例时保持 DOM、草稿、滚动、流式输出和运行状态稳定。
6. 右上角应用按钮继续属于中央工作台列的 App Chrome，不属于任何 Pane，也不随 PaneTree 移动。
7. Right Dock 继续是工作台外的第三列，并根据当前聚焦 Pane 的显式项目上下文显示 File、Git、Connection 和 Task。

首期完成后的核心体验：

```text
初始状态

Sidebar | App Chrome + Conversation A | Right Dock

拖动历史会话 B 到 A 右侧

Sidebar | App Chrome                           | Right Dock
        | Conversation A | Conversation B     |

继续把会话 C 拖到 B 下方

Sidebar | App Chrome                           | Right Dock
        | Conversation A | Conversation B     |
        |                | Conversation C     |
```

## 2. 明确的产品交互合同

### 2.1 不提供布局配置模式

- 不新增“开启分屏”“编辑布局”“工作台模式”之类的用户按钮。
- Workbench 始终可接收拖拽；单 Pane 时视觉上应与当前会话首页基本一致。
- Drop Zone 只在拖拽进入 Armed/Dragging 状态后出现，平时不占视觉空间。
- Feature Flag 仅用于开发、灰度和回退，不作为用户理解布局的前置步骤。

### 2.2 历史会话行为

| 用户操作 | 结果 |
|---|---|
| 单击未打开会话 | 沿用现有导航语义，在当前聚焦 Pane 打开或创建 Root Pane |
| 单击已打开会话 | 聚焦已有 Pane，不切换其他 Pane 的内容 |
| 拖未打开会话到 Pane 边缘 | 在对应方向创建新 Conversation Pane |
| 拖未打开会话到画布外沿 | 对整棵 PaneTree 做根级分割 |
| 拖已打开会话到新位置 | 移动已有 Pane，不创建第二份会话视图 |
| 拖已有 Pane 到另一个 Pane 中心 | 交换两个 Pane 的位置 |
| 关闭 Conversation Pane | 只关闭视图，不删除、归档或停止历史会话 |
| 再次拖入已关闭会话 | 重新挂载同一 `conversationId` |

侧栏的新内容投到 Pane 中心时不得静默覆盖目标。首期采用确定性自动贴靠：优先右侧，空间不足时尝试下方，再查找最近可分割祖先；没有合法空间时明确拒绝。

### 2.3 拖拽状态机

```text
Idle
  → Pointer Down
Armed
  → 移动超过 6px
Dragging
  → 冻结 Geometry Snapshot + Layout Revision
  → Pointer Move 只更新 Drop Preview
  → Pointer Up
Committing
  → 提交一次 Workbench Transaction
  → Success / Reject / Stale Revision
Idle
```

- `Esc`、Pointer Cancel、窗口失焦均取消拖拽，不改变布局。
- 拖动期间不持续修改 PaneTree，避免目标矩形抖动和 Transcript 反复重排。
- Pointer Up 时使用最终坐标重新命中；若 Revision 已变化，取消当前事务，不用旧几何自动重放。

### 2.4 Pane 视觉与焦点

每个 Conversation Pane 使用同一套结构：

```text
PaneFrame
├── PaneChrome
│   ├── 工作区名 / 会话标题 / 状态
│   └── 拖柄 / 更多 / 关闭视图
└── ConversationSurface
    ├── ChatTranscript
    ├── Progress / Approval / Queue
    └── ChatComposerBar
```

- App Chrome 与 PaneChrome 是两个层级，不能合并。
- 聚焦边框应克制但可辨识，不能用“正在运行”状态点代替焦点。
- 点击 Right Dock 内部控件不改变 `focusedPaneId`，也不抢回 Composer 或 Terminal 的业务焦点。
- 键盘必须提供与拖拽等价的聚焦、移动、关闭和均分命令。

## 3. 当前代码基础与真实缺口

### 3.1 已经具备

- [`ChatPage.tsx`](../../crates/agent-gui/src/pages/ChatPage.tsx) 已形成 Sidebar、Main、Right Dock 三列框架。
- [`AppWorkbenchChrome.tsx`](../../crates/agent-ui/src/application/AppWorkbenchChrome.tsx) 已固定在 Main 列顶部。
- [`ApplicationView.tsx`](../../crates/agent-ui/src/application/ApplicationView.tsx) 的 chat 分支已不再强制组装 ChatHeader。
- [`ConversationSurface.tsx`](../../crates/agent-gui/src/pages/chat/surfaces/ConversationSurface.tsx) 已建立 Transcript、Composer、Overlay 的稳定 DOM 边界。
- [`ChatComposerBar.tsx`](../../crates/agent-ui/src/pages/chat/ChatComposerBar.tsx) 已承载模型和执行模式入口。
- Conversation Runtime Cache、Live Transcript、Queue、Pending Upload、Approval 已有按 `conversationId` 分桶的基础。

### 3.2 当前不能直接复制 ConversationSurface 的原因

当前 `ConversationSurface` 仍接收由 `ChatPage` 组装的 `ReactNode`。真实可变状态仍主要来自页面级唯一槽位：

- `currentConversationId`
- `conversationState`
- `isSending`
- `conversationOpenState`
- `composerRef`
- `scrollFollowRef`
- `composerOverlayHeight`
- `pendingUploadedFiles`
- `selectedValue`
- `errorMessage` / `hookWarning`

虽然后台 Map 已能保存多个会话条目，但 `useChatPageRuntimeStore` 仍会把选中会话同步回唯一一套可见 React State。直接同时渲染两个 Surface 会造成以下问题：

- 两个 Pane 读取同一份可见 Transcript。
- 两个 Composer 竞争同一个 `composerRef`。
- 草稿恢复可能覆盖另一个 Pane 的输入。
- Hydration、发送、停止、Compaction 和错误 Overlay 仍围绕“当前会话”工作。
- Right Dock 与文件动作仍读取全局激活项目，而不是聚焦 Pane 的 ProjectRef。

### 3.3 尚未实现的工作台能力

- ~~PaneTree、Layout Reducer、Revision 和 Invariant~~（已落地：`agent-ui/src/lib/workbench/reducer.ts`）。
- ~~整数像素 Geometry、Divider、最小尺寸与命中测试~~（已落地：`geometry.ts`、`hitTesting.ts`、`adjacency.ts`）。
- ~~Stable PaneSurfaceLayer 和以 `paneId` 为 Key 的稳定挂载~~（已落地：`agent-ui/src/components/workbench/`，Flag 开启时 ChatPage 单 Root Pane 走 `WorkbenchCanvas`）。
- ~~Sidebar Conversation Pointer Drag Payload~~（已落地：`useWorkbenchDragSession.ts` + 侧栏行拖拽入口）。
- ~~Pane 自身拖柄的拖拽联调~~（已落地：PaneChrome 拖柄 → 拖拽会话 → MOVE 提交全链路）。
- ~~`focusedPaneId` 与 `FocusedSurfaceContext`~~（已落地：聚焦 Pane 驱动页面当前会话与 Right Dock 激活项目）。
- ~~Layout 本机持久化与 Feature Flag 回退~~（已落地：SQLite `workbench_layout` 表 + localStorage 迁移/回退 + 损坏修复）。
- 终端 Pane 剩余项（stale 恢复占位、newTerminal/SSH 拖入入口、cwd 范围校验等）：见 `session-workbench-remaining-work.md`。

## 4. 目标状态所有权

### 4.1 页面级共享对象

以下对象保留在 `ChatWorkbenchPage`，所有会话复用，不按 Pane 创建：

- Gateway Bridge 与桌面事件监听。
- History Client / Sidebar Store。
- Provider、Model、Skills 和 MCP Catalog。
- Git、Workspace、Terminal、Tunnel 等 Tauri Client。
- Window Workbench Controller。
- App Chrome、Global Overlay、Right Dock。

### 4.2 Conversation Runtime Registry

每个 `conversationId` 拥有一个独立 Controller：

```ts
type ConversationSurfaceSnapshot = {
  conversationId: string;
  project: ProjectRef;
  transcript: ConversationTranscriptSlice;
  execution: ConversationExecutionSlice;
  model: ConversationModelSlice;
  uploads: ConversationUploadSlice;
  queue: ConversationQueueSlice;
  approvals: ConversationApprovalSlice;
  lifecycle: ConversationLifecycleSlice;
};

type ConversationSurfaceController = {
  conversationId: string;
  getSnapshot(): ConversationSurfaceSnapshot;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  send(draft: MentionComposerDraft): Promise<void>;
  stop(): void;
  compact(): Promise<void>;
  retry(): Promise<void>;
};

type ConversationRuntimeRegistry = {
  get(conversationId: string): ConversationSurfaceController | null;
  ensure(input: {
    conversationId: string;
    project: ProjectRef;
  }): Promise<ConversationSurfaceController>;
  createDraft(project: ProjectRef): Promise<ConversationSurfaceController>;
  releaseView(conversationId: string): void;
};
```

实现要求：

- 使用 `useSyncExternalStore` 或等价的细粒度订阅，让一个会话更新时只刷新对应 Surface。
- 迁移现有 Cache，而不是重新创建第二套运行系统。
- Gateway/History/Provider 等依赖通过 Controller Factory 注入，不能由每个 Surface 重复监听 Tauri。
- 运行中的会话即使关闭 Pane，Runtime 仍可继续；Registry 根据运行、队列和缓存策略决定何时回收。

### 4.3 Pane 本地视图状态

以下状态属于 `paneId`，不属于全局当前会话：

- Composer DOM Ref。
- Scroll Follow Ref 与滚动位置。
- Composer Overlay 高度。
- Pane compact 状态。
- Pane 内 Popover 的焦点返回目标。
- Hydrating/Error 的当前视图呈现。

同一 `conversationId` 首期最多绑定一个可编辑 Pane，因此 Conversation 状态和 Pane 视图状态可以稳定一对一，但代码仍应保留清晰边界。

### 4.4 Layout 与 Runtime 分离

```ts
type ProjectRef = {
  projectId: string;
  projectPathKey: string;
};

type WorkbenchSurfaceSpec = {
  kind: "conversation";
  conversationId: string;
  project: ProjectRef;
};

type PaneRecord = {
  paneId: string;
  surface: WorkbenchSurfaceSpec;
  view: {
    compactChrome?: boolean;
  };
};

type PaneNode =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      splitId: string;
      axis: "horizontal" | "vertical";
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };

type WorkbenchLayout = {
  schemaVersion: number;
  revision: number;
  root: PaneNode | null;
  panes: Record<string, PaneRecord>;
  focusedPaneId: string | null;
};
```

Layout 只能保存稳定身份和空间信息。禁止保存消息、Prompt、附件、审批、输出、Secret、Session ID、临时错误和 ReactNode。

## 5. 工作包与实施顺序

### Task 0：契约、Feature Flag 与回归基线

#### 目标

在改变 UI 前冻结多会话隔离要求和布局不变量。

#### 工作项

- [x] 新增内部 `sessionWorkbench.enabled` Feature Flag，默认保持旧单 Pane 路径（`featureFlags.ts`、`sessionWorkbench.ts`）。
- [x] 定义 `ProjectRef`、`PaneRecord`、`PaneNode`、`WorkbenchLayout`、Command 和错误结果（`types.ts`、`commands.ts`；Surface 已扩展为 conversation/localTerminal/sshTerminal/unsupported 四元联合）。
- [x] 定义同一 `conversationId` 最多一个可编辑 Pane 的不变量（`invariants.ts`、reducer 层双重拦截，含测试）。
- [x] 为草稿、上传、Queue、Approval、Model、Streaming、Compaction 增加双会话隔离回归测试（`session-workbench-contracts.test.mjs`、`workbench-streaming-isolation` 交错时序测试）。
- [ ] 记录当前单会话首屏、发送、停止、切换、文件上传和 Native Drop 基线（推迟，见 `session-workbench-remaining-work.md`）。

#### 验收

- 不改变用户界面。
- 所有核心合同有类型和测试。
- 关闭 Flag 后完全沿用当前单会话路径。

### Task 1：Conversation Runtime Registry

#### 目标

把页面级唯一可见会话状态升级为按 `conversationId` 订阅的 Controller。

#### 推荐代码位置

```text
crates/agent-gui/src/pages/chat/conversations/
├── conversationControllerTypes.ts
├── createConversationRuntimeRegistry.ts
├── useConversationRuntimeRegistry.ts
├── useConversationSurfaceController.ts
├── conversationDraftStore.ts
└── conversationModelStore.ts
```

#### 工作项

- [x] 将 `ConversationRuntimeEntry` 扩展或拆分为可订阅 Store（`createConversationRuntimeRegistry.ts` per-id 精确通知 + `useSyncExternalStore`）。
- [x] 将 Hydration、分页和错误状态按 ID 分桶（分页/错误已分桶；Hydration 已分桶：`ConversationHydrationStore` 挂 registry.hydration，Controller 快照暴露 `lifecycle.hydrating|hydrationFailed`，见 remaining-work R-3 落地记录）。
- [x] 保留并接入现有 Live Transcript per-conversation Store（两条渲染路径均按 id 取）。
- [ ] 将 Composer Draft 从“单 Ref + 切换时缓存”改为 Controller 持有 Draft，Composer 实例只编辑所属 Draft（草稿数据已在 `conversationDraftStore` 分桶且 Controller 有 `setDraft/clearDraft`；仅编辑器 DOM 实例仍单例，牵涉 IME/焦点，保留，见 remaining-work R-2 裁决）。
- [ ] 将 Pending Upload、Queue、Approval、Compaction、Model、Runtime Controls 暴露为 Controller Slice（Model 已收敛为 registry-owned + 快照 slice；Runtime Controls 仍全局派生，见 remaining-work R-2）。
- [x] 将 Send/Stop/Retry/Compact API 改为显式接收 `conversationId`，不得依赖全局 current ref（`conversationControllerActions` 全部显式 id 路由，send 管线优先 `conversationIdOverride`；防回潮断言见 `runtime-slot-convergence.test.mjs`）。
- [x] 删除或限制 `syncVisibleConversationRuntime` 的唯一槽位职责（已收窄：sessionId/createdAt/selectedModel 三镜像删除、改经 `useConversationRuntimeEntrySnapshot` 从 registry 派生；仅余 5 个瞬态字段镜像，保留理由见 remaining-work R-2）。
- [x] 保留运行会话在 Pane 关闭后的后台生命周期（关闭仅 closePane + 转焦点，不 abort；LRU 保护有测试）。

#### 验收

- 两个 Controller 同时 Hydrate，不相互覆盖。
- A 流式输出时操作 B 的 Composer，不刷新或清空 A。
- A/B 的 Draft、Upload、Queue、Approval、Model、Compaction 完全隔离。
- 删除会话能原子清理其 Controller、缓存、审批、队列和上传。

### Task 2：双 Conversation Surface 测试 Harness

#### 目标

在引入 PaneTree 前证明一个页面能稳定挂载两个完整 Conversation Surface。

#### 工作项

- [x] 新增 `ConversationPaneHost`，只接收 `paneId`、`conversationId` 和 `project`。
- [x] `ConversationPaneHost` 内部创建独立 Composer Ref、Scroll Ref 和 Overlay Height。
- [x] 把 Transcript、Composer、Progress、Approval、Queue 的组装从 `ChatPage` 移入 Host。
- [x] `ConversationSurface` 改为由 Controller Snapshot 和 Actions 驱动，不再接收页面拼好的大块 ReactNode。
- [x] 增加开发测试 Harness，固定左右挂载两个不同会话。
- [x] 验证关闭 Harness 后当前正式单会话路径不回归。

当前进度说明：双 Pane Harness、Environment/Factory 和唯一性合同已落地，正式单 Pane 路径通过全量回归。真实多 Runtime 联调已通过“聚焦 Pane 的会话 = 页面当前会话”架构完成：聚焦 Pane 走完整页面管线（Hydration、模型、上传、发送、Native Drop、用量环）；非聚焦 Pane 由独立 Background Controller 驱动，从按 `conversationId` 分桶的 Runtime Cache 与 Live Transcript Store 渲染（后台流式可见），每个 Pane 持有独立 Composer DOM 与草稿，模型标签按各自 Runtime Entry 解析。跨 Pane 的当前会话级操作（发送、改模型、编辑队列）经 focusGuard 先聚焦再执行，聚焦切换复用既有 `handleSelectConversation` 管线，保证草稿缓存/恢复与 Hydration 语义与单 Pane 时代一致。

#### 验收

- 两个完整会话同时可见、可输入、可发送、可停止。
- 两边可以同时流式输出。
- 模型 Popover、IME、粘贴、上传和审批不会串 Pane。
- 一个 Surface 卸载不会中止另一个会话。

此 Task 是进入拖拽布局前的硬门槛。未通过时不得直接制作 PaneTree UI。

### Task 3：PaneTree、Command Engine 与 Geometry

#### 推荐代码位置

```text
crates/agent-ui/src/lib/workbench/
├── types.ts
├── commands.ts
├── reducer.ts
├── invariants.ts
├── geometry.ts
├── hitTesting.ts
├── adjacency.ts
└── codec.ts
```

#### Command

```ts
type WorkbenchCommand =
  | { type: "OPEN_PANE"; pane: PaneRecord; target: OpenTarget }
  | { type: "MOVE_PANE"; paneId: string; target: MoveTarget }
  | { type: "SWAP_PANES"; firstPaneId: string; secondPaneId: string }
  | { type: "CLOSE_PANE"; paneId: string }
  | { type: "RESIZE_SPLIT"; splitId: string; ratio: number }
  | { type: "EQUALIZE_SPLIT"; splitId: string }
  | { type: "FOCUS_PANE"; paneId: string };
```

#### 不变量

- [x] 每个 Leaf 恰好对应一个 PaneRecord。
- [x] 每个 PaneRecord 恰好被 Tree 引用一次。
- [x] Split 始终有两个非空 child。
- [x] `focusedPaneId` 为 null 当且仅当 root 为 null。
- [x] 同一 `conversationId` 最多出现一次。
- [x] Move 不改变 `paneId`、Surface 身份和 React Key。
- [x] Ratio 受 Conversation 硬最小尺寸钳制（Reducer 钳制 0.05–0.95；`clampRatioToMinSize` 在 Divider 交互层按硬最小像素钳制）。
- [x] 所有结构修改校验 `expectedRevision`。

#### 必测纯函数

均已在 `agent-gui/test/chat/workbench-pane-tree.test.mjs` 覆盖：

- [x] Root Open。
- [x] Left/Right/Top/Bottom Split。
- [x] Root Edge Split。
- [x] Close 后父 Split 折叠。
- [x] Edge Move 先 Remove 再 Graft。
- [x] Center Swap。
- [x] Divider Insert。
- [x] Ratio Clamp 和 Equalize。
- [x] Duplicate Conversation Reject。
- [x] Stale Revision Reject。
- [x] Keyboard Adjacent Pane。
- [x] Codec Round Trip 与损坏恢复。

当前进度说明：Task 3 纯模型已完成——`reducer.ts`（七个 Command 全量）、`geometry.ts`（整数像素平铺，无缝隙/无重叠）、`hitTesting.ts`（canvas-edge > divider > pane-edge > pane-center 优先级与 Drop Preview Rect）、`adjacency.ts`（键盘四向邻接）、`codec.ts`（编解码、损坏修复、未知版本拒绝）。Move 语义与 OTTY 逆向一致：先 Remove（父 Split 折叠）再 Graft；分离后消失的 Divider 目标安全拒绝而非重放。

### Task 4：WorkbenchCanvas 与稳定 Surface Layer

#### 推荐代码位置

```text
crates/agent-ui/src/components/workbench/
├── WorkbenchCanvas.tsx
├── PaneSurfaceLayer.tsx
├── PaneFrame.tsx
├── PaneChrome.tsx
├── DividerLayer.tsx
├── DockIntentOverlay.tsx
└── WorkbenchEmptyState.tsx
```

#### 工作项

- [x] Main 列改为 `AppWorkbenchChrome + WorkbenchCanvas`（Flag 开启时生效；Flag 关闭走原直挂路径）。
- [x] 初始当前会话转换为 Root `PaneRecord`，单 Pane 视觉保持当前样式（单 Pane 不渲染 PaneChrome/Divider）。
- [x] Surface Layer 按 `paneId` 平铺渲染，移动只更新 Rect（渲染顺序按 paneId 排序，与树结构解耦）。
- [x] 使用整数 CSS Pixel 的 `left/top/width/height`，稳定态不使用 transform 布局。
- [x] Divider 使用 Pointer Capture；移动时 rAF 节流每帧最多一次预览，Pointer Up 提交一次事务。
- [x] Conversation 宽度变化只触发布局响应，不重建 Controller（render prop 注入稳定 Host）。
- [x] PaneChrome 提供拖柄、标题、状态、trailingActions 插槽和关闭视图（拖柄 DOM 就绪，拖拽联调属 Task 5）。
- [x] 极窄 Pane 进入 compact，保证模型、输入和发送入口始终可达（由 Composer 容器查询达成：`@container` + `@max-[480px]:` 使分屏窄 Pane 下模型选择器塌成图标、发送按钮恒定 32px、输入框 `min-w-0 flex-1`；布局层 `MIN_CONVERSATION_PANE_WIDTH=320` 兜底。注：转录区/空态尚未接容器查询，见 `session-workbench-remaining-work.md` §四）。

当前进度说明：组件层（`WorkbenchCanvas`/`PaneSurfaceLayer`/`PaneFrame`/`PaneChrome`/`DividerLayer`/`DockIntentOverlay`/`WorkbenchEmptyState`）已落地于 `agent-ui/src/components/workbench/`，合同测试见 `agent-gui/test/chat/workbench-canvas-contracts.test.mjs`。多 Pane 同屏仍受 Task 2 硬门槛限制（真实双 Runtime 联调未完成），因此 Flag 开启路径当前只挂单 Root Pane。

#### 验收

- 单 Pane 与当前首页无明显视觉回归。
- Split、Resize、Move 时 Conversation DOM 不卸载。
- 草稿、滚动、流式和 Popover 焦点在移动后保持。
- App Chrome 与 Right Dock 永远不进入 PaneTree。

### Task 5：历史会话与 Pane 拖拽

#### 推荐代码位置

```text
crates/agent-ui/src/components/workbench/SidebarSurfaceDragHandle.tsx
crates/agent-gui/src/pages/chat/workbench/useSidebarWorkbenchDrag.ts
crates/agent-gui/src/pages/chat/workbench/usePaneWorkbenchDrag.ts
```

#### Payload

```ts
type SidebarWorkbenchPayload = {
  kind: "existingConversation";
  conversationId: string;
  project: ProjectRef;
  title: string;
};
```

#### 工作项

- [x] 在 HistoryRow 增加非交互标题拖动区（Pointer Drag，6px 阈值内仍是点击），不把整行设为 HTML `draggable`。
- [x] 重命名、批量选择、菜单、删除确认、Pending 状态期间禁用拖拽；触屏走长按菜单不触发拖拽。
- [x] 拖拽激活时冻结 Layout Revision、Geometry Snapshot 和 Canvas Origin（`useWorkbenchDragSession`）。
- [x] Hit Test 优先级采用 `canvas-edge > divider > pane-edge > pane-center`；侧栏 Payload 投到 Pane 中心自动贴靠到右侧。
- [x] Drop Preview 显示最终 Rect 与会话标题；拖影跟随指针。
- [x] 未打开会话提交 `OPEN_PANE` 后经聚焦选择管线完成 Hydration。
- [x] 已打开会话提交 `MOVE_PANE` 或 `FOCUS_PANE`；PaneChrome 拖柄支持已有 Pane 的移动与中心交换。
- [x] Async Hydration 失败时保留可重试 Surface（沿用现有 hydrationFailed 呈现），不回滚到错误会话。
- [x] 键盘替代动作：Meta/Ctrl+Alt+方向键按几何邻接聚焦 Pane；触屏首期不支持复杂拖动。
- [x] Esc、Pointer Cancel、窗口失焦取消拖拽；拖拽后的合成 click 被抑制；Revision 变化时事务取消不重放。
- [x] 菜单替代动作：会话行菜单提供“在分屏中打开”（贴靠聚焦 Pane 右侧；已打开则聚焦）。
- [x] 工作区拖入：ProjectRow 标题区 Pointer 拖拽创建该项目的新草稿会话并原子贴靠到投放位置——先经目录校验的既有新建管线创建会话，新草稿的 workdir 与拖拽意图匹配后才 `OPEN_PANE`；校验失败不创建 Pane；归档/缺失项目不可拖。

#### 验收场景

1. 将历史会话 B 拖到 A 右侧，A/B 各显示完整会话。
2. 再次拖动 B 到 A 下方，只移动 B，不复制。
3. 单击侧栏 B，聚焦已有 Pane。
4. 关闭 B 后从侧栏重新拖入，历史与 Runtime 正确恢复。
5. 拖动未超过阈值仍执行普通点击。
6. 拖动过程中按 Esc，布局无变化。
7. 拖动期间 Revision 变化，事务安全取消。

### Task 6：Focused Surface Context 与 Right Dock

#### 目标

让 Right Dock 跟随工作台业务焦点，而不是全局激活项目或任意 cwd。

#### 数据结构

```ts
type FocusedSurfaceContext = {
  paneId: string;
  surfaceKind: "conversation";
  project: ProjectRef;
  conversationId: string;
  cwd: string;
};
```

#### 工作项

- [x] `focusedPaneId` 成为工作台业务焦点；聚焦 Pane 的会话即页面当前会话。
- [x] 聚焦 Pane 时若其 ProjectRef 对应已知工作区项目，激活该项目，Right Dock 数据源随之切换（近似实现：经工作区激活而非独立 Context 适配层）。
- [x] Right Dock 的 File Tree 状态按 `projectPathKey` 分桶（沿用 `useRightDockSettings` 既有实现）。
- [x] 点击 Dock 内控件不改变 `focusedPaneId`（Dock 位于 Canvas 之外，不触发 Pane 聚焦）。
- [x] 右上角文件按钮打开 Dock（既有行为保留）。
- [x] ProjectRef 归档/缺失时 Pane 顶部显示 blocked 横幅（会话内容保持可读，不改绑其他项目）；聚焦此类 Pane 不激活其项目，Dock 不回退到错误项目。
- [x] Right Dock 插入文件、Commit 或 Skill 时经桥接 Composer Ref 路由到聚焦 Pane 的 Composer。

#### 验收

- 聚焦不同工作区的 Conversation Pane 时，Right Dock 立即显示正确项目。
- Dock 内搜索、滚动、菜单不抢走工作台业务焦点。
- 不允许通过 Terminal cwd 或上一个激活项目隐式扩大权限。

### Task 7：持久化、Native Drop 与恢复

#### 首期持久化内容

- `schemaVersion`
- `revision`
- `root`
- `panes`
- `focusedPaneId`
- Split Ratio
- Pane compact 视图偏好

#### 禁止持久化

- 消息正文与流式输出。
- Composer Draft 和附件内容。
- Approval、Queue 临时状态。
- Secret、Prompt、Token。
- Tauri Session ID、AbortController、React Ref。
- Hydration/Network 临时错误。

#### 工作项

- [x] 本机保存窗口级 Layout：SQLite `workbench_layout` 表（`scope_id='main-window'`，250ms 防抖，Payload 上限 96 KiB，不参与 Gateway Settings Sync），自动迁移早期 localStorage Payload；非 Tauri 开发环境回退 localStorage。跨会话 revision 保持单调递增。
- [x] 恢复时先经 Codec 校验/修复 Tree/Pane/ProjectRef，再对照未过滤会话表丢弃已不存在的 Conversation，然后才挂载 Surface。
- [x] 无 Runtime 状态的恢复 Pane 按 conversationId 后台自动 Hydrate,不抢占全局焦点;加载失败保留标题与重试入口,成功后直接渲染原对话。
- [x] 损坏 JSON 保存 `.corrupted` 诊断副本后回退到单 Root Conversation。
- [x] Native File Drop 按坐标命中路由到任意 Pane：文件悬停在某 Pane 上时该 Pane 自动聚焦（其会话成为投放目标），Drop Overlay 与附件都落在悬停 Pane 的 `conversationId`。
- [x] 文件 Drop 只准备附件，不自动发送（沿用既有行为）。
- [x] 拖入路径不自动执行 Shell，也不扩大 Workspace Root Grant（沿用既有行为）。

### Task 8：清理、灰度与发布门槛

#### 工作项

- [x] 保留旧单会话路径（Flag 关闭为默认，两条路径共存）。
- [x] Feature Flag（`VITE_LIVEAGENT_SESSION_WORKBENCH`）打开时运行 Workbench；关闭时进入旧单 Pane 路径。
- [x] 新布局数据在关闭 Flag 时保留但不执行（禁用状态不读不写不删存储）。
- [ ] 完成 macOS Retina、Windows 混合 DPI、Linux X11/Wayland 实机验证（未做，需实机矩阵）。
- [ ] 验证 IME、Keyboard、Reduced Motion、Forced Colors 和屏幕阅读器标签（Divider/Pane 已带 ARIA 与 IME 组合键守卫，完整验证未做）。
- [ ] 监测双流式 Conversation 的渲染频率、内存和 Long Task（未做）。
- [ ] 稳定后删除 `ChatPage` 中已被 Controller 取代的 current-visible 镜像状态（部分完成：sessionId/createdAt/selectedModel 三镜像已删、registry 派生；余 5 个瞬态镜像的保留理由见 remaining-work R-2）。

## 6. 推荐 PR 拆分

为降低一次性重构风险，建议按以下 PR 顺序交付：

1. `test(workbench): define multi-conversation isolation contracts`
2. `refactor(chat): introduce conversation runtime registry`
3. `refactor(chat): mount conversation panes from controllers`
4. `feat(workbench): add pane tree command engine`
5. `feat(workbench): render stable conversation pane canvas`
6. `feat(workbench): drag history conversations into pane tree`
7. `feat(workbench): route right dock through focused pane context`
8. `feat(workbench): persist and restore window pane layout`

每个 PR 必须能独立回退，不能把 Runtime Registry、PaneTree、拖拽和 Right Dock 一次性混在一个不可审查提交中。

## 7. 测试矩阵

### 7.1 Controller 隔离

- [x] A/B 同时 Hydrate（`hydration-bucketing.test.mjs` 9 例：并发互不覆盖、失败按 ID 隔离、重试只清本会话）。
- [x] A/B 同时 Streaming（交错时序隔离测试）。
- [x] A Sending 时 B 发送或编辑 Draft。
- [x] A/B 独立 Queue、Approval、Upload、Model、Compaction（`session-workbench-contracts.test.mjs`）。
- [x] 删除 A 不清理 B。
- [x] 关闭 A Pane 不停止 A 后台 Runtime。

### 7.2 Layout 纯模型

- [x] Open、Move、Swap、Close、Resize、Equalize（`workbench-pane-tree.test.mjs`）。
- [x] Root Edge、Pane Edge、Divider Insert。
- [x] Duplicate Surface、Invalid Target、Insufficient Space（Insufficient Space 为 reducer 层显式拒绝语义 + 测试）。
- [x] Revision CAS 与晚到事务。
- [x] Close Focus Transfer。
- [x] Codec Repair。

### 7.3 组件与交互

- [ ] 单 Pane 视觉回归（DOM 测试基建已就绪 `test/helpers/dom-test-env.mjs`，视觉级回归仍未做）。
- [x] 历史会话拖到四个方向（模型层）。
- [x] 已打开会话移动而不复制。
- [x] Pointer Threshold、Esc、Cancel、Window Blur（拖拽状态机纯函数化 + `workbench-drag-session.test.mjs`）。
- [x] Divider Resize 与最小尺寸。
- [x] Pane 移动不重挂 DOM（DOM 级验证 `workbench-pane-dom-stability.test.mjs`：jsdom + 真实 react-dom 渲染 PaneSurfaceLayer，MOVE/RESIZE 后 `Object.is` 比对节点实例、CLOSE 只移除被关 Pane；源码断言保留为第二道防线）。
- [x] App Chrome 和 Right Dock 不被 Drop Target 覆盖（hit-test 限于画布坐标系）。

### 7.4 跨项目与 Right Dock

- [x] 两个不同 ProjectRef 的 Conversation 并列（codec round-trip 层）。
- [x] Focus A/B 时 File、Git、Connection、Task 上下文正确（「focusedPane → activeProject → dock 数据源」解析已抽成纯函数 `resolveWorkbenchPaneProject` 并做模型测试 `workbench-pane-project-context.test.mjs` 7 例：archived/missing 不激活、陈旧 key 不回退、规范化 key 匹配；实机矩阵验证仍在 §三）。
- [x] Dock 操作不改变 focusedPaneId（`workbench-dock-focus.test.mjs` 11 例：源码断言 dock 组件零布局命令 + reducer 模型断言 RESIZE/EQUALIZE/失败命令不改焦点；「聚焦工作台面板」为白名单显式跳转）。
- [ ] Missing/Archived/Permission Changed 项目进入 blocked（archived/missing 已实现并有断言；Permission Changed 数据层无信号，需后端先提供一等状态并推送事件，调研证据见 remaining-work §〇）。

### 7.5 Native Drop 与安全

- [x] 文件只进入命中的 Conversation Pane（hit-test 模型层双 pane 归属测试）。
- [x] 文件不自动发送（drop 仅产出附件准备动作,无发送字段,模型断言）。
- [x] 路径不自动执行（terminalDropCommit 产物白名单断言）。
- [x] Drop 不扩大 Workspace Root（提交链路无 grant 调用,源码断言）。
- [x] 布局文件不含 Secret、Prompt、输出和附件（encode 产物键集合白名单测试）。

## 8. Definition of Done

全部满足后，本 Task 才可关闭：

1. 当前会话首页以 Root Conversation Pane 形式渲染，单 Pane 视觉与行为无回归。
2. 用户无需开启布局模式，可直接把历史会话拖到任意合法边缘形成分屏。
3. 每个 Pane 展示完整且同构的 Transcript、Composer、模型、进度、审批和队列。
4. 同一 Conversation 不出现两个可编辑 DOM 或两个 Composer。
5. A/B 会话的草稿、上传、模型、队列、审批、流式和停止互不串线。
6. Move、Swap、Resize 不重挂 Conversation Surface。
7. 关闭 Pane 不删除历史、不默认停止后台会话；可从侧栏重新拖入。
8. Right Dock 正确跟随 focused Pane 的 ProjectRef，点击 Dock 不改变业务焦点。
9. App Chrome 始终位于中央工作台列顶部，不进入 PaneTree。
10. Layout 支持安全恢复、损坏回退和 Feature Flag 回旧路径。
11. Native Drop 精确路由到 paneId/conversationId，不自动发送或执行。
12. 全量前端测试、TypeScript、生产构建与三平台关键交互验证通过。

## 9. 首个实施里程碑

首个里程碑不是拖拽动画，而是完成以下无拖拽验证：

```text
同一页面固定左右挂载 Conversation A 和 Conversation B
→ 两边独立加载历史
→ 两边独立编辑草稿
→ 两边可以同时流式
→ 两边独立审批、队列、模型和上传
→ 卸载任一 Surface 不影响另一边
```

只有这个里程碑通过，才说明当前会话首页已经真正拆成可复用内容。之后 PaneTree 和拖拽只负责决定这些稳定 Surface 显示在哪里，而不再承担会话业务状态。
