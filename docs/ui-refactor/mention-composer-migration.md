# MentionComposer 编辑器迁移设计

状态：实验实现保存在 `refactor/mention-composer-lexical` 独立工作树，未提交、未进入当前 `refactor/ui`；真实 Tauri WebView、视觉与 VoiceOver 待确认

本文中的“完成”和“执行结果”均描述独立实验工作树，不描述当前 `refactor/ui`。当前分支继续使用原有 MentionComposer，以免把高风险编辑器换核混入阶段 1—4 的确定性 DOM 治理。

## 为什么必须单独治理

当前 `refactor/ui` 中，`MentionComposer.tsx`、`MentionComposerInternals.tsx` 和 `MentionComposerOverlays.tsx` 合计约 4,800 行，共同承担编辑器文档、DOM 渲染、Selection/Range、IME、剪贴板、语音输入、历史记录、异步 mention 查询、弹层定位和业务校验。独立实验工作树把公开 `MentionComposer.tsx` 降为 28 行出口并删除了旧 `MentionComposerInternals.tsx`。

这里的问题不是调用了 DOM API。浏览器编辑器必然需要 Selection、Range 和 contenteditable。真正的问题是业务组件同时拥有以下三层状态：

1. DOM 是实时编辑文档。
2. `largePastesRef`、selection ref 和 transient STT ref 是旁路状态。
3. `MentionComposerDraftSegment[]` 只在读取、发送、复制或恢复时临时生成。

任何新 mention 类型都必须修改建节点、读属性、序列化、粘贴、草稿恢复、删除、光标跨越和发送聚合等多条路径。少改一条就可能出现“看得见但发不出去”“复制后丢身份”或“恢复后无法删除”的断层。

## 当前已经固定的协议边界

本轮新增 `MentionComposerDocument.ts`，将下列纯逻辑移出 DOM helper：

- caret artifact 清理和文本规范化；
- 相邻文本 segment 合并与 chip 边界空格恢复；
- segment 到发送文本的序列化；
- segment 到 `MentionComposerDraft` 的聚合；
- skill、commit 和 git-file token 格式化。

`MentionComposerDraftSegment[]` 是迁移期间的权威交换格式。现有 contenteditable 和未来编辑器都必须通过适配器读写它，宿主的 `MentionComposerHandle`、草稿缓存和发送管线不感知编辑器框架。

当前 segment 类型：

| 类型 | 编辑器表现 | 发送表现 | 额外约束 |
| --- | --- | --- | --- |
| `text` | 普通可编辑文本与换行 | 原文本 | 统一 LF，清理 caret artifact 与 NBSP |
| `fileMention` | 文件或目录 chip | Markdown 文件链接 | path/kind 必须能重新校验 |
| `largePaste` | 折叠的长文本 chip | 完整粘贴文本 | `textWithoutLargePastes` 必须排除正文 |
| `skillMention` | skill chip | `/skill-name` | 反序列化时必须仍在 enabled skills 中 |
| `appMention` | 应用 chip | 名称与 bundle id/path | 同一应用只能出现一次 |
| `commitMention` | commit chip 和 tooltip | commit token 或 GitHub 链接 | 保留 sha、stat、remote 元数据 |
| `gitFileMention` | commit 文件 chip | git-file token 或 GitHub 链接 | 保留 ref、旧路径和状态 |
| `conversationMention` | 会话 chip | conversation URI token | 去重、排除自身、最多 3 个、可整体禁用 |
| `codeMention` | 文件行范围 chip | 带 `#Lx-Ly` 的 Markdown 链接 | 行号规范化 |

## 行为矩阵

框架原型必须逐项给出自动化证据，不能只验证“能打字”。

| 区域 | 必须保持的行为 | 主要风险 | 现有证据/新增测试 |
| --- | --- | --- | --- |
| 普通输入 | 中英文、emoji、多行、首尾换行、空白草稿 | DOM 块结构改变文本换行 | `paste-newline-pipeline.test.mjs` |
| IME | composing 时 Enter 不发送；compositionend 尾部 Enter 不重复发送 | 中文输入被截断或误发送 | `send-shortcut.test.mjs`、`MentionComposerInputUtils` 测试 |
| 发送快捷键 | Enter/Shift+Enter 和用户设置保持一致 | 框架 command 优先级改变 | `send-shortcut.test.mjs` |
| 文件 mention | `@` 搜索、键盘选择、拖放插入、复制恢复 | path 丢失或 chip 变普通文本 | `workspace-path-drag.test.mjs`、`paste-newline-pipeline.test.mjs` |
| skill mention | `/` 搜索、只恢复仍启用的 skill | 旧草稿恢复未经授权 skill | `paste-newline-pipeline.test.mjs` |
| app mention | CUA 门控、去重、真实图标、复制恢复 | 图标 data URL 进入文档或剪贴板 | `mention-app-suggestions.test.mjs`、`app-mention-dedup.test.mjs` |
| 会话 mention | 自引用拒绝、去重、上限 3、禁用时降级文本 | 结构化引用越权或静默丢内容 | `conversation-reference-paste.test.mjs`、`conversation-reference-drag.test.mjs` |
| commit/git file | tooltip、复制、草稿、发送 token | 大量属性漏序列化 | `paste-newline-pipeline.test.mjs` 和新增 node round-trip 测试 |
| code mention | 行范围显示、复制和发送 | range 归一化不一致 | `paste-newline-pipeline.test.mjs` |
| 大段粘贴 | 超阈值折叠、删除同步、发送时恢复全文 | side map 与文档分离 | `paste-newline-pipeline.test.mjs` |
| 剪贴板 | 自定义 MIME 优先、HTML/plain text 降级、外部粘贴 | chip 身份丢失、恶意属性进入模型 | clipboard 与 paste 系列测试 |
| 删除与光标 | Backspace/Delete 整体删除 chip，箭头跨过原子节点 | 光标卡死或删除相邻文字 | `mention-composer-lexical-prototype.test.mjs`、`mention-composer-lexical-view.test.mjs` |
| 选区菜单 | copy/cut/paste/select all、右键选区恢复 | 菜单打开后 selection 丢失 | 新增真实浏览器用例 |
| 历史提示 | 空输入时上下键读取，编辑后退出 recall session | undo/history 与提示历史互相污染 | prompt history 相关测试 |
| 语音临时文本 | begin/update/commit/cancel，取消可选择保留尾部文本 | 流式更新污染 undo 或移动光标 | `composer-stt-lifecycle.test.mjs` |
| 草稿切换 | 多会话、Workbench Pane、主 composer 接管时不串稿 | editor instance 生命周期错配 | `workbench-page-composer-draft-restore.test.mjs` 等 |
| 可访问性 | textbox role、multiline、placeholder、禁用态和弹层键盘导航 | 自定义 node 被重复朗读 | 新增 axe/键盘检查与肉眼 VoiceOver 检查 |

## 候选方案

### Lexical：首选原型

官方将 Lexical 定位为由 editor state 驱动、挂载到单个 contenteditable 的模块化框架，并直接展示 compact chat input 场景。它的 React plugin 结构适合把 mention、clipboard、history、STT 和宿主 bridge 分开。自定义 node 可以承载原子 chip，React 只负责 node view，selection 和 mutation 由编辑器内核管理。

原型必须先验证：

- 当前仓库 React 19.2 和构建链能否只加载一份 Lexical runtime；
- plain-text 根节点能否稳定保持当前 LF 语义；
- 自定义 inline node 相邻、行首、行尾和连续出现时无需现有 caret anchor hack；
- update listener 不会导致整棵 ChatComposerBar 高频重渲染；
- 自定义 clipboard MIME、IME 与 STT command 可以进入同一 history 事务模型。

参考：[Lexical 官网](https://lexical.dev/)、[官方仓库](https://github.com/facebook/lexical)。

### Tiptap/ProseMirror：备选

ProseMirror 的 schema、transaction、history、command 和 node view 都很成熟。Tiptap 提供 React node view 与 suggestion utility，inline atom 很适合 mention chip。它的代价是 schema/extension 层更厚，React 包还需要 Tiptap/ProseMirror 依赖组；对于只需要单个聊天输入框的场景，需要确认 bundle 与实例开销是否值得。

当 Lexical 原型在 IME、clipboard 或原子节点边界上失败时，再做同一矩阵的 Tiptap 对照，不同时维护两个完整实现。

参考：[ProseMirror Guide](https://prosemirror.net/docs/guide/)、[Tiptap React 安装](https://tiptap.dev/docs/editor/getting-started/install/react)、[Tiptap Suggestion](https://tiptap.dev/docs/editor/api/utilities/suggestion)、[Tiptap React Node Views](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views/react)。

### Slate：不进入第一轮原型

Slate 支持自定义 inline void，但官方约束要求 void node 始终包含空 text child，并且 inline node 在块首尾或彼此相邻时需要额外空 text 节点。这个结构与当前 caret anchor 问题相似，无法优先证明会减少边界修补代码。

参考：[Slate Nodes](https://docs.slatejs.org/concepts/02-nodes)、[Slate Element/Voids](https://docs.slatejs.org/api/nodes/element)。

## 目标架构

```text
ChatComposerBar / hosts
        │ MentionComposerHandle
        ▼
MentionComposer shell ───── overlay React components
        │
        ▼
Editor adapter (Lexical candidate)
        │ editor commands / editor state
        ├── Mention nodes and validation plugin
        ├── Clipboard plugin
        ├── IME + send shortcut plugin
        ├── STT transient text plugin
        ├── Prompt history plugin
        └── Selection/context-menu bridge
        │
        ▼
MentionComposerDraftSegment[]
        │
        ▼
MentionComposerDocument.ts
        │
        ├── MentionComposerDraft
        └── outbound text
```

业务模块只能操作 segment、命令和 `MentionComposerHandle`。只有 editor adapter/plugin 可以读取编辑器 selection 或创建框架 node。弹层继续由 React/Portal 渲染，位置来源是 editor selection rect 的只读快照。

## Node 设计

原型应使用独立 node type，而不是一个携带任意 JSON 的万能 chip：

- `FileMentionNode`
- `LargePasteNode`
- `SkillMentionNode`
- `AppMentionNode`
- `CommitMentionNode`
- `GitFileMentionNode`
- `ConversationMentionNode`
- `CodeMentionNode`

每个 node 必须实现：

1. 构造时规范化和裁剪输入。
2. JSON import/export 映射到对应 segment。
3. DOM import 只接受现有受信 data attribute，并重新校验。
4. DOM export 提供可复制的 HTML fallback。
5. 文本导出委托给 `MentionComposerDocument.ts`。
6. React view 只接收经过规范化的数据，不把 icon data URL 写入 editor state。

## 分片迁移顺序

### 5A：稳定文档协议

- 完成纯 document adapter 和全 segment 聚合测试。
- 将业务约束从“扫描现有 DOM chip”改成接收 segment/node identity 集合。
- 把 DOM attribute 解析限制在 legacy adapter 内。

完成条件：发送和草稿聚合不读取 DOM，业务规则可在无 document 环境测试。

执行结果：完成。`MentionComposerDocument.ts` 已承接 segment 序列化、草稿聚合、私有剪贴板 JSON 校验、plain-text token 恢复、large-paste 重建、app 去重和 conversation 自引用/去重/上限约束。Node 测试在不存在 `document` 的环境直接加载并验证这些入口。迁移期间的 legacy DOM adapter 已随 5D 删除；现有 clipboard plugin 只在 `DataTransfer` 和 HTML fallback 边界接触 DOM。

### 5B：Lexical 原型

- 添加最小依赖，只包含 core、React、plain-text/history 所需包。
- 实现 text、file mention、large paste 和 conversation mention 四类节点。
- 实现 `getDraft/setDraft/getText/setText/clear/focus`。
- 用独立测试 harness 验证换行、IME、selection、copy/paste 和 undo。

完成条件：四类节点通过对应行为矩阵；原型不接入生产入口。

执行结果：完成。已固定 `lexical`、`@lexical/react`、`@lexical/plain-text`、`@lexical/history` 0.50.0，并新增隔离的 headless adapter 与 React view。四类基线节点通过 segment/draft/text 与 JSON round-trip；React harness 通过实际 copy/cut/paste、composition 和键盘 DOM 事件验证私有 MIME、可读 HTML/plain-text fallback、版本化 DOM 导入导出、外部超大文本折叠、连续 atom 左右移动、整体删除与 undo。测试环境只补浏览器原生而 jsdom 缺失的 Range 布局桩。原型 harness 仍只由测试加载，生产入口使用独立的 `MentionComposerLexicalEditor.tsx`。

### 5C：补齐命令和节点

- 增加 skill、app、commit、git-file 和 code node。
- 迁移 mention suggestion、异步搜索、上下键导航。
- 迁移 STT transient command、prompt history 和 context menu selection bridge。

完成条件：`MentionComposerHandle` 全部方法在 adapter 上实现；所有 focused tests 通过。

当前证据：node 层已完成并独立放在 `MentionComposerLexicalNodes.ts`。`SkillMentionNode`、`AppMentionNode`、`CommitMentionNode`、`GitFileMentionNode` 和 `CodeMentionNode` 已加入，与 5B 的三类 atom 一起通过 JSON、DOM、clipboard 和 draft 聚合测试。skill 粘贴仍必须通过宿主提供的 enabled skill 列表；app state 不携带图标 data URL。

STT 使用一个带 Lexical `NodeKey` 的临时 TextNode；partial 更新合并到同一节点，commit 只产生一个可撤销步骤，cancel 可选择丢弃或保留最后一次 partial。Prompt history 复用现有纯状态机，通过 ArrowUp/ArrowDown command 判断逻辑首末行；进入 recall 时暂存 `MentionComposerDraft`，越过最新记录时恢复全部 atom，不再保存 `innerHTML`。Legacy 生产实现也已先改成同一结构化 stash，消除了这条 HTML 状态协议。

Headless adapter 已覆盖 `MentionComposerHandle` 的读取、写入、清空、焦点、STT 以及 file、skill、commit、git-file、conversation、code 插入命令；conversation 命令保留 disabled、invalid、self、duplicate 和 limit 结果。Selection bridge 通过框架 selection clone 完成 context-menu 的读取、恢复、删除和全选，不再保存 DOM `Range`。Suggestion bridge 从 Lexical text selection 识别 `@`、`/` 及 query，替换触发文本时校验 node key 和字符范围；插件在 session 活跃时接管上下键、Enter 和 Escape。异步文件/会话搜索继续留在 React shell，根据 bridge 输出的 query 更新普通 state，不进入 editor adapter。

### 5D：切换生产入口

- 在同一工作区完成公开入口替换，不引入长期 feature switch。
- GUI 与 WebUI 分别完成真实浏览器矩阵。
- 新实现稳定后删除 legacy chip factory、caret anchor、DOM serializer 和 `innerHTML` stash。

完成条件：业务组件不再创建 chip、保存整段 innerHTML 或用 `execCommand` 编辑；旧实现和开关一起删除。

执行结果：公开 `MentionComposer` 已指向 `MentionComposerLexical`。生产 shell 负责 Popup、文件/会话异步搜索、候选过滤和高亮；正文、selection、替换、history、clipboard、IME 发送和 STT 全部走 Lexical editor state 与插件。Desktop 自定义右键菜单使用 Lexical selection snapshot，WebUI 继续保留浏览器原生菜单。

八类 atom 均由 `MentionComposerLexicalAtomView.tsx` 的 React JSX 渲染，保留文件类型图标、应用图标、简短标签、title 和原有 chip palette；结构化数据只存在 node state/clipboard payload，不再塞进 DOM attribute。应用粘贴会按稳定身份去重；会话粘贴统一执行 disabled、自引用、重复和最多三个的约束，拒绝的结构化段降级为可读文本，避免静默丢内容。

旧 `MentionComposerInternals.tsx`、旧 contenteditable writer、chip factory、DOM serializer、caret anchor 和 `execCommand` 编辑路径已经删除。生产模块不再依赖带 `Prototype` 命名的测试 harness；原型文件仅由 headless 测试加载。

双端浏览器 fixture 也已删除旧的裸 contenteditable/`execCommand` 编辑器，直接挂载公开 `MentionComposer`。GUI 与 WebUI 的真实 Chromium 运行均覆盖 18 组换行和长文本、结构化 MIME/HTML、纯文本 token fallback、键盘手工换行及 undo/redo。该运行发现并修复了纯文本粘贴未调用 `parseSerializedComposerText` 的迁移缺口；file、skill、commit、git-file 与 code token 再次能恢复为 atom。

## 不可接受的“半迁移”

- JSX 渲染 chip，同时允许浏览器直接修改同一 contenteditable 子树。
- 将现有 DOM helper 原样包进名为 editor 的 hook。
- 框架 state 与 `largePastesRef` 长期双写。
- 每次 keystroke 把完整 editor JSON 提升到 ChatComposerBar。
- 用 `innerHTML` 作为历史记录、草稿或回退协议。
- 为了通过测试永久保留 legacy 和新实现两套发送序列化。

## 验证与退出条件

自动验证除仓库现有 lint、typecheck、GUI/WebUI 测试和构建外，必须加入真实浏览器用例，覆盖 Chrome WebUI 与 Tauri 使用的 WebView：

1. 中文拼音 composing 后按 Enter。
2. 连续两个 chip 的左右移动、Backspace 和 Delete。
3. chip 位于首行、行尾和两行之间。
4. 内部复制粘贴保留结构；粘贴到外部只得到可读文本/HTML。
5. 外部 HTML 和超大纯文本粘贴。
6. undo/redo 跨越输入、插入 chip、删除 chip 和 STT 临时更新。
7. 多 Workbench Pane 切换与草稿恢复。
8. VoiceOver 朗读、Tab/Arrow/Escape 导航。

只有行为矩阵全部有证据、生产入口已切换、legacy DOM writer 已删除，阶段 5 才算完成。
