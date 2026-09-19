# 长 TSX 渐进拆分

2026-09-11。以开始本轮时的工作区为基线；行数仅用于发现候选，按独立职责、状态归属与依赖决定是否拆分。
本轮保留已有外观和交互。业务专属组件就近放置，出现真实复用需求后再提升共享层级。

## 最长的十个 TSX

| 文件（相对仓库根目录） | 基线行数 | 判断 |
| --- | ---: | --- |
| crates/agent-gui/src/pages/ChatPage.tsx | 4237 | 跨模块状态与副作用编排，先理清状态归属，避免大量参数透传 |
| crates/agent-ui/src/components/chat/MentionComposerInternals.tsx | 2306 | 包含序列化和 DOM 辅助逻辑，应按逻辑模块评估，并非都适合组件化 |
| crates/agent-gateway/web/src/app/GatewayApp.tsx | 2250 | 已有 controller/view 分层，进一步拆分要按领域状态处理 |
| crates/agent-ui/src/components/chat/MentionComposer.tsx | 2172 | 编辑器事件、选区与 ref 紧密关联，暂缓机械拆分 |
| crates/agent-ui/src/components/chat/ChatHistorySidebar.tsx | 2121 | 列表、菜单与会话动作需进一步确认状态边界 |
| crates/agent-gateway/web/src/app/GatewayAppView.tsx | 2088 | 可以评估业务区域，但要避免向新组件传递整个控制器 |
| crates/agent-ui/src/pages/settings/ProviderModalView.tsx | 2076 | 后续优先评估用量查询等独立表单区，只传对应字段与动作 |
| crates/agent-ui/src/pages/skills-hub/SkillsHubPage.tsx | 2006 | 后续评估商店搜索/结果区；明确请求、筛选、安装动作归属后实施 |
| crates/agent-ui/src/components/workspace-editor/WorkspaceSftpPanel.tsx | 1990 | 路径导航已有完整内部状态与明确输入输出，本轮先拆 |
| crates/agent-ui/src/pages/chat/ChatComposerBar.tsx | 1986 | 组合器有较多交互关联，需先区分独立弹层与共享状态 |

## 第一批：SFTP 路径导航（已完成）

- `WorkspaceSftpPanel.tsx`：1990 → 1536 行，保留目录、文件操作、传输和面板编排。
- 同目录 `SftpPathNavigator.tsx`：427 行，容纳面包屑、路径编辑、异步目录建议及键盘交互。
  保留原导航组件的 props、内部状态、请求失效处理、180ms 防抖与 8 条建议上限。
- 同目录 `workspaceSftpPaths.ts`：36 行，共用路径规范化、父路径和拼接函数；面板与导航都引用这一来源。

这是将已有职责独立的内部组件移动到文件，不新增状态层、上下文或通用框架。
总行数因模块导入略增，收益是阅读和修改路径导航时不再穿过整个文件传输面板。

验证：

- 与修改前工作区 AST 对比：7 个搬移函数的参数和函数体一致，面板剩余声明及 JSX 在组件改名后也一致。
- `crates/agent-gui/test/workspace-editor/sftp-path-navigator.test.mjs`：真实 React DOM 渲染，验证本地/远端面包屑、编辑聚焦、目录过滤和排序、方向键/Enter、Escape、关闭后旧请求不能覆盖新结果。
- 共享 UI 类型检查、GUI/Gateway 生产构建、UI 边界检查、3 个源码文件 Biome、差异空白检查通过。
- 按 React 组件检查项复核：组件保持模块级定义、hooks 依赖与清理不变、没有新增 props 透传层，原 ARIA 关系与 ref 保留。

本轮未执行真实 SFTP 服务、原生 WebView 或浏览器像素对照；没有修改样式表达式。
未暂存或提交本轮改动。下一批候选为 ProviderModalView 的独立表单区，再到 SkillsHubPage 的商店区域；具体边界需实施前进一步检查。
