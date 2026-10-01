# 右侧工具栏在左侧边栏展开时被裁切

日期：2026-09-20
分支：`fix/right-sidebar-overlap-develop`（基于 `upstream/develop` @ 9aadbc5f）
工作树：`target/right-sidebar-overlap-worktree`

## 现象

右侧 Right Dock 打开时展开左侧边栏，主面板向右位移，Right Dock 左侧一截内容看不见了（标签栏"文件树"只剩"树"，文件名前几个字母被截掉）。看起来像被主面板盖住。

## 根因

`crates/agent-ui/src/components/project-tools/WorkspacePanels.tsx` 里 `WorkspaceToolsPanel` 的内容层是一个 `absolute right-0` 的 div，宽度固定写成 `savedWidth`（用户保存的像素宽度），只有拖拽 resize 期间才切到 `100%`。

左侧边栏展开后，`ResizablePanelGroup` 总宽度变小，react-resizable-panels 按百分比保持两个 panel 的份额，所以 tools panel 的实际像素宽度跟着缩小；但内容层还是 `savedWidth` 像素、右对齐，于是向左溢出 panel。panel 自带 `overflow: hidden`，溢出部分被裁掉，视觉上就像被主面板遮住。

不是层叠问题，是内容层宽度没有跟随 panel 实际宽度。

## 修复

内容层固定像素宽度只在开关动画期间需要（让内容随 flex-grow 过渡"滑入"而不是重排）。加一个 `settled` 状态：
- 打开后等过渡结束（`TOOLS_PANEL_TRANSITION_MS = 240`，对应 `duration-200`）切到 `100%`；
- `immediate` 模式直接 `100%`；
- 关闭 / 移动端复位。

之后左侧边栏展开，主面板位移，Right Dock 同步缩窄，内容跟着 panel 宽度重排，不再溢出。

`WorkspacePanelGroup` 同时被桌面端 `ChatPage.tsx` 和 gateway web `GatewayAppView.tsx` 使用，一处修复覆盖两端。

## 验证

- 新增测试 `crates/agent-gui/test/chat/sidebar-shells.test.mjs`："tools panel content follows the panel width once the open animation settles"。
- `node --test test/chat/sidebar-shells.test.mjs`：7/7 通过。
- `node ../../scripts/run-node-tests.mjs test/chat`：1441 pass / 7 fail；同样的 7 个失败在未改动的 develop 基线上也存在（源码扫描类测试受 CRLF 影响），与本次改动无关。
- `tsc --noEmit -p crates/agent-ui/tsconfig.json`：通过。
- biome 对该文件只报 CRLF 格式差异（checkout autocrlf 导致，全文件都是），`git diff --ignore-cr-at-eol` 确认改动只有新增逻辑。

## 备注

- `pnpm run test:frontend` 在这个工作树里直接跑会 `spawn ENAMETOOLONG`（374 个文件路径拼成一条命令超 Windows 上限），按目录跑 `test/chat` 绕过。
