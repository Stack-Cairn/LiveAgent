# 阶段 5 · 前端合并

**状态:🟨 基本完成**(代码合并与删除已落地,全套 GUI 测试绿;手工冒烟与 `make dev` 未跑)

## 目标

两套前端合并成一套。以 **GUI 为基线**(决策 16),`crates/agent-gateway/web` 删除。

## 为什么可行

| 前端 | 现在 | 阶段 3 抽走引擎后 |
|---|---|---|
| `crates/agent-gui/src` | 151,713 行 | 约 116,500 行 |
| `crates/agent-gateway/web/src` | 126,934 行 | 126,934 行(本来就不含引擎) |

**抽走引擎后两边体量几乎一样。** 而且 `scripts/mirror-manifest.json` 已经在用 CI
强制大量文件**字节相同** —— 它本身就是「这两套代码应该是一套」的证据。

阶段 4 做完后,GUI 侧真正的 Tauri 专属只剩约 10 个文件,合并阻力很小。

## 要求

| # | 要求 | 为什么 |
|---|---|---|
| 1 | 以 GUI 为基线 | 决策 16。功能更全、演进更快、历史包裹少 |
| 2 | 壳能力用**运行时探测**降级 | 不要两份代码。浏览器里没有托盘/更新,探测到就隐藏入口 |
| 3 | 删除 `mirror-manifest.json` 及其 CI job | 合并后镜像机制失去意义 |
| 4 | 登录页从 WebUI 并入 | 阶段 4 建的登录页在 WebUI 侧 |
| 5 | 处理 20 个脆测试 | 见下 |

## 运行时探测,不要两份代码

```ts
// 好：一份代码，能力探测
if (hasShell()) { renderTrayMenu() }

// 坏：两份代码，靠构建分叉
// gui/TrayMenu.tsx  vs  web/NoTrayMenu.tsx
```

需要探测的能力:系统托盘、自动更新、窗口控制(置顶/关闭行为/macOS 红绿灯)、
全局快捷键、系统剪贴板、原生文件对话框、外部程序打开。

对应 18 个前端专属 command;浏览器侧要么隐藏入口,要么用 Web API 降级
(剪贴板 → `navigator.clipboard`,文件选择 → `<input type=file>`,
打开外链 → `window.open`)。

## 20 个脆测试

`crates/agent-gui/test/` 里有 20 个文件用 `readFileSync` + 正则断言**源码文本**:

```js
assert.match(composer, /lastEditorSelectionRef = useRef<Range \| null>\(null\)/)
```

它们**不验证行为**,只锁死源码长相。阶段 4/5 的大规模改动会让它们成片红,
且红了也不代表真有问题。

另外 128 个测试是行为型的(走 `helpers/load-ts-module.mjs` 用 `vm` 真实执行 TS),
那些要保留。

处置:逐个判断 —— 能改写成行为断言的改写,纯粹锁死实现细节的删掉。
**不要为了让它们绿而回避重构。**

## 验收标准

- 只有一个前端源码树
- 同一份代码在 Tauri 壳里和浏览器里都能跑,壳能力按探测结果降级
- `mirror-manifest.json` 与 `GUI/WebUI Mirror Check` CI job 删除
- 全部测试绿(脆测试已改写或删除,不是被跳过)
- 手工冒烟:桌面端和浏览器端逐项过 history / settings / terminal / 上传 /
  git review / skills / memory / cron / chat

---

## 实施记录

### P5-01 差异盘点:合并成本远低于预期

- `mirror-manifest.json` 的 119 个文件实测**全部字节相同**,零成本。
- WebUI 独有 107 个文件,几乎全是 gateway 时代产物(`GatewayApp.tsx`、
  `gatewaySocket*`、`proto/gen`、19 个 gateway*Client)——它们的功能在 GUI 侧
  已有网络化对应物(阶段 4 的 `lib/backend/*`),无一需要迁移。
- 唯一从 WebUI 吸收的概念是登录页——但阶段 4 已经在 GUI 侧建好了
  `pages/login/`(AuthGate + LoginPage),P5-03 实际早已完成,无需搬代码。

### P5-02 壳能力探测:`lib/shell/capabilities.ts`

hasShell/hasTray/hasUpdater/hasWindowControls/hasGlobalShortcuts/
hasNativeFileDialogs/hasSystemFileOpener,全部收敛到 `isDesktopShell()`
(真 Tauri internals 在场且非网络 shim)。分开命名是给调用点说清语义、
给将来判定分化留位置,不是七个不同实现。

**修掉的坑:三处直接探 `window.__TAURI_INTERNALS__` 的代码在浏览器里会被
我们自己装的网络 shim 骗到**(MacOsTitleBarSpacer、WindowsTitleBar、
file-tree/model.ts),已改用 capabilities。

### P5-04 降级实况

- 外链:`@tauri-apps/plugin-opener` 经 vite alias + tsconfig paths 顶替为
  `lib/backend/tauriOpener.ts`——壳里转发真插件,浏览器 `window.open`。
  7 个 import 点零改动。
- 上传:`usePendingUploads` 浏览器走 `<input type=file multiple>`,产出与
  壳侧 `system_pick_readable_files` 等价的数据结构。
- 剪贴板:`clipboardText.ts` 本就有 `navigator.clipboard` 兜底,未动。
- 原生"浏览…"按钮(5 处 system_pick_file/folder):**隐藏,保留手输路径**。
  这些对话框选的是**后端机器**的路径,浏览器对话框选的是用户本机路径,
  降级成 `<input type=file>` 是语义错误,不做。
- 打开系统文件位置(3 个 command、4 处调用):入口按 `hasSystemFileOpener()` 隐藏。
- 更新/托盘/全局快捷键/窗口置顶:UI 入口隐藏 + 调用点早退。

### P5-05 脆测试处置(20 个)

删 8、重写 2、裁剪 7、保留 3,无一 skip。要点:

- **保留的 3 个 `backend/release-*` 其实不脆**:readFileSync 读的是脚本
  **产物**(真跑 release 脚本后校验 latest.json / GitHub env),是黑盒行为
  测试,列入 20 个名单是当初按 grep readFileSync 误伤。
- 重写:mention-refetch 改为直接加载真实模块断言输入输出;
  builtin-code-review 改为校验 `prompt/skills/` 数据资产契约
  (frontmatter 可解析、name 与目录一致、description 含调度线索)。
- 删除的 8 个全是锁 JSX/CSS/变量名字面量(`transformOrigin: "top right"`、
  `useRef<Range | null>(null)` 出现次数之类),零行为价值。
- 顺带清掉了所有"双跑 GUI+WebUI 两份实现"的加载(git-graph、
  skill-card-presentation、installed-skill-sort 等)——web 树没了,
  parity 断言失去比较对象。

### P5-06/07 删除实况

- `crates/agent-gateway/web`(126,934 行)、`scripts/mirror-manifest.json`、
  `scripts/check-mirror.mjs`、`crates/agent-gateway/test/webui/`(22 个测试)
  全部删除。全 diff 净减约 15.7 万行。
- Go gateway 阶段 6 才退役,本阶段保持可编译:`embed.go` 改嵌
  `webui-retired/index.html` 占位页(说明 WebUI 已并入 v2 统一前端,
  指引 README 迁移指南),`http.go` 的 `fs.Sub` 同步改。
  `go build ./... && go vet ./...` 绿。
- CI:删 `mirror`(GUI/WebUI Mirror Check)、`webui`(Gateway WebUI)两个
  job,删 gateway job 里的 WebUI 构建 step;`pr-governance.yml` 删
  web 路径条目;`generate-model-catalog.mjs` 只产出 GUI 侧。

### 验收状态

- ✅ 只有一个前端源码树
- ✅ mirror-manifest 与 Mirror Check job 删除
- ✅ `node --test 'crates/agent-gui/test/**/*.test.mjs'` 1371/1371 绿
  (脆测试已改写或删除,无 skip)
- ⬜ 「同一份代码在 Tauri 壳与浏览器里都能跑」——降级代码已就位,
  但未实际起浏览器验证
- ⬜ 手工冒烟(桌面 + 浏览器逐项)未跑;`make dev` 未跑

### 遗留事项

- **`openChatFileLink` 浏览器里是「报错」不是「隐藏」**:聊天消息里的文件
  链接是内联渲染元素,没有可门控的菜单入口,点击弹一句中文错误。真隐藏
  要在渲染层把链接降级成纯文本,改动大收益小,未做。
- **门控全部是静态推导 + tsc 保证,未在真浏览器里点过。** 探测在模块顶层
  求值的只有 `FILE_TREE_HAS_OS_INTEGRATION` 一处(沿用原写法),理论上
  不受加载时序影响,但没有实测背书——归入 P5-08。
- **隐藏入口的连带损伤已排查一轮**:WorkspaceCloneModal 的父目录输入框
  原本 readOnly、只能靠原生对话框填,藏按钮时已改条件式 readOnly。其余
  四处隐藏点(Cherry 数据目录、Cron workdir、MCP 导入、侧栏浏览)均为
  纯可选按钮或有手输兜底。
