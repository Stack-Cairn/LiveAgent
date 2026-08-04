# 阶段 5 · 前端合并

**状态:⬜ 未开始**(依赖阶段 4)

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
