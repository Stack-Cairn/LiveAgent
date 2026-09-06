# WebUI 验证反馈：输入框宽度不跟随、上下文用量读数被穿透

## 背景

#749 修复（`fix/transcript-width-controls-after-history-switch` 分支）在 web 端验证时发现两个新问题：

1. 拖动正文宽度手柄时只有转录列变宽，输入框停在 768px；桌面端两者是联动的。
2. 正文滚动到输入区下方时，输入卡片下缘的会话统计读数（轮·步｜上下文占用｜token 等）与底下的正文文字重叠，几乎不可读。

## 问题 1：composer 列宽

根因是 `base-chat.css` 里一个刻意的旧决策：`.gateway-chat-frame` 定义了两个独立列宽变量，composer 层网格读固定的 `--gateway-chat-column-width: 768px`，转录列才读可调的 `--chat-transcript-content-width`（原注释明说"widening the conversation never drags the input box along"）。桌面端没有这层分离——`ChatComposerBar` 桌面分支的卡片列 `max-w` 直接读转录宽度变量。

按用户要求反转该决策：

- `.gateway-composer-layer` 网格中列改读 `min(var(--chat-transcript-content-width, 768px), 100%)`，与 `.gateway-transcript-shell` 同一公式，composer 列与转录列像素级同宽。
- 删除 `--gateway-chat-column-width` 定义，注释改写为说明共享列宽。
- 不需要动 TSX：两条路径（`GatewayAppView` 传统 stage、`GatewayConversationPaneHost` workbench Pane）的 `ChatComposerBar` 都渲染在 `.gateway-transcript-stage` 内部，`TranscriptWidthControls` 写在 stage 上的内联变量（拖拽期间逐帧更新）经 CSS 继承直接到达 composer 层。

## 问题 2：统计读数毛玻璃

`ConversationStatsBar`（共享组件，桌面/web 同用）此前只是裸文字行，浮在滚动正文上没有任何背衬；桌面端仅在层底部有 1rem 的实底条，也盖不到读数行本身。

改动：非空态的读数外包一层壳——`rounded-full bg-background/90 backdrop-blur-md`（90% 不透明背景 + 12px 高斯模糊），按用户要求的"毛玻璃、不透明度 90% 左右"。空态占位分支不带这层，无数据时不会显示一个空药丸。可点击（手动压缩）分支的 hover 高亮在壳内，仍可见。两端同时受益。

## 改动清单

- `crates/agent-gateway/web/src/styles/base-chat.css`：列宽变量合一（见上）。
- `crates/agent-ui/src/components/chat/ConversationStatsBar.tsx`：毛玻璃壳。
- `crates/agent-gateway/web/test/composer-width-follows-transcript.test.mjs`（新增）：锁 composer 列读转录变量、旧变量不许回归、两条路径的 composer 都在 stage 内。
- `crates/agent-gui/test/chat/conversation-stats-bar.test.mjs`：追加毛玻璃壳断言（含空态不出空药丸）。

## 验证

- WebUI：打开会话，拖正文宽度手柄——输入卡片应与正文同步变宽/变窄（拖拽过程中逐帧跟随）；把正文滚到输入区下方，统计读数应清晰浮在毛玻璃药丸上。
- 桌面端：统计读数同样带毛玻璃底；宽度联动行为不变。

## 后续调整：药丸 → 全宽裙边（2026-09-05）

桌面端验证反馈：药丸只包住读数文字，读数两侧和输入卡片圆角外侧的弧形缺口仍会漏出正文。改为全宽毛玻璃"裙边"：与输入卡片同宽，`-top-8` 上探 2rem（等于卡片 `rounded-4xl` 的半径）藏到卡片身后，把弧形缺口一并盖住，底部用 `rounded-b-2xl` 收边；`-z-10` 保证它压在卡片之下（桌面端卡片带 `z-10`、列有 transform，web 端卡片 z-auto，两端层序都成立）、正文之上。读数行本身不再带背景，手动压缩的 hover 高亮仍在裙边上可见；空态占位分支不带裙边。`conversation-stats-bar.test.mjs` 的毛玻璃断言同步改为锁裙边（全宽、上探、-z-10，断言用 includes 避免正则转义陷阱）。

2026-09-05 追记：按验证反馈把裙边不透明度从 90% 下调至 80%（`bg-background/80`），模糊半径不变。

2026-09-05 追记：再下调至 70%（`bg-background/70`）试效果。

2026-09-05 追记：裙边自身的 `rounded-b-2xl` 又在底部两角漏字，去掉——裙边改为方角矩形，圆角只保留输入卡片自己的。

2026-09-05 追记：web 裙边下方仍漏字——composer 层底部有 16px 悬浮留白（`--gateway-chat-composer-bottom`），桌面端靠一条 desktop 独占的全宽实底条兜住，web 没有对应物。把这条实底条改为两端共用（`ChatComposerBar.tsx`），并在 `composer-width-follows-transcript.test.mjs` 加断言防回归。

2026-09-05 追记：web 端验证注意——WebUI 经 `go:embed all:web/dist` 编译进 gateway 二进制（`crates/agent-gateway/embed.go`），无磁盘回退；改前端后必须重跑 `start-gateway.bat`（它会重建 dist 并重编 gateway），只刷新浏览器拿到的永远是旧内嵌资产。本次"实底条已改但刷新无效"即此原因。
