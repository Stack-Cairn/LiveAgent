# 会话同步自动化与资源测量记录

## 隔离环境

- 合成数据根：`%TEMP%/liveagent-session-sync-benchmark-v1`。
- 数据集：248 个会话、263,192,576 字节 transcript（251 MiB），12 个工作目录。
- 数据集摘要：`276c0b02104069573b3e43127ab62c93d08ed2ee3b89df4efc48cb8cbdc88c52`。
- K-brain 基线：`0dad9fdec4adbb2a6324974edc1d610c69b2a79b`。
- 基线 `kn.exe` SHA-256：`295B6C5B4D0FFCCA0E89FD1874ED4E9B450461BDD9DE6F1F2532FADD4799C922`。
- 基线 `k-brain-computer.exe` SHA-256：`A38DBD1441BE127B9F89E3E7336CAED361063A16D9068DA63E18D87A8A107D93`。

数据均在任务专用临时目录中生成，不读取或改写用户会话。每次运行记录源码 SHA、二进制路径和哈希、数据集摘要、PID、端口、采样时长及请求负载。改动前后使用同一份只读合成数据集。

## 工具

| 路径 | 用途 |
|---|---|
| `scripts/testing/session-sync-generate-dataset.mjs` | 生成确定性的 K-brain `session.jsonl` 数据集及摘要 |
| `scripts/testing/session-sync-sample.ps1` | 采集 Windows 进程累计 CPU、I/O、Working Set、Private Bytes、句柄和线程 |
| `scripts/testing/session-sync-benchmark.mjs` | 按固定节奏请求会话列表并记录延迟、状态和响应大小 |
| `scripts/testing/session-sync-run-backend-benchmark.ps1` | 启动指定 K-brain 二进制并编排采样、请求与汇总 |
| `scripts/testing/session-sync-summarize.mjs` | 汇总平均 CPU、I/O 增量、内存峰值/斜率、句柄/线程变化和请求延迟 |
| `scripts/testing/session-sync-mock-model.mjs` | 提供不使用密钥的确定性 OpenAI Chat Completions fixture |
| `scripts/testing/session-sync-run-tui-fixture.mjs` | 用真实 `kn run` 调用 fixture 并确认会话落盘 |
| `scripts/testing/session-sync-tauri.mjs` | 通过 debug MCP Bridge 的 WebSocket 驱动真实 Tauri WebView、截图及 DOM 断言 |

脚本单元测试：

```text
node --test scripts/testing/session-sync-tools.test.mjs scripts/testing/session-sync-harness.test.mjs
```

当前结果：7/7 通过。测试覆盖数据集确定性与合法 JSONL、汇总计算、MCP Bridge 请求、CLI manifest、Windows 原始计数器、请求负载及本地模型 fixture。

## 真实自动化入口

Debug 版 Tauri 注册 `tauri-plugin-mcp-bridge`，默认监听 `9223`。自动化使用真实桌面进程的 `list_windows`、`get_backend_state`、`execute_js` 和 `capture_native_screenshot`，不使用伪造 DOM。桥接不可用时，场景记为未验证，不能用 Vite HTTP 200 或进程存活代替。

Gateway WebUI 使用真实浏览器和 WebSocket。原生 TUI 使用 PTY；`kn run` 和 ACP 使用本地模型 fixture。模型 fixture 的响应固定为 `session sync fixture response`，不访问外部模型服务。

## 基线结果

基线后端启动参数：

```text
kn.exe backend -listen 127.0.0.1:47331 -data-dir %TEMP%/liveagent-session-sync-benchmark-v1 -memory-organizer-interval 24h
```

5 分钟场景每分钟连续请求旧 `/v1/sessions?page=1&page_size=200` 三次，共 15 次，模拟桌面和两个 WebUI 的重复列表读取。结果保存在 `%TEMP%/liveagent-session-sync-baseline-run`：

| 指标 | 基线 |
|---|---:|
| 请求平均延迟 | 2,936.03 ms |
| 请求最小 / 最大延迟 | 2,724.58 / 3,704.84 ms |
| 进程读取字节增量 | 3,684,696,064 bytes |
| CPU 累计增量 | 48.5 s |
| 24 逻辑核总容量平均 CPU | 0.67% |
| Working Set 峰值 | 41,123,840 bytes |
| Private Bytes 峰值 | 74,973,184 bytes |
| 句柄峰值 / 增量 | 272 / +21 |
| 线程峰值 / 增量 | 20 / 0 |

结果表明 15 次列表请求读取约 3.68 GB，与每次完整读取约 251 MiB 相符。该结果只描述基线，不代表改动后的目标已满足。

同一基线二进制已通过真实 `kn run` + 本地模型 fixture：输出 `text` 与 `done` 事件，调用模型一次，并在隔离数据根写入一份会话。结果保存在 `%TEMP%/liveagent-session-sync-tui-baseline-2`。

30 分钟基线结果保存在 `%TEMP%/liveagent-session-sync-baseline-30min`。90 次请求平均 2,804.37 ms；K-brain 累计 CPU 268.734 s、读取 21,318,598,656 bytes，Working Set 峰值 41,967,616 bytes、Private Bytes 峰值 75,403,264 bytes，句柄峰值 288、起止增加 56，线程峰值 21、增加 2。采样末段同机执行过构建/测试，进程自身 CPU 和 I/O 计数仍有效，延迟可能受磁盘竞争影响；实现版按同一脚本、数据集及负载在安静时段重跑，并单独标记这个限制。

### LiveAgent 桌面基线

为避免将当前实现源码与旧二进制混用，使用 `git archive b2049905` 创建只读临时源码样本 `%TEMP%/liveagent-v2-baseline-b204-source`，仅运行同版本 Vite dev server；Tauri/Rust 使用此前从同一 b204 工作区构建并保存的 `%TEMP%/liveagent-v2-baseline-b204-artifacts/liveagent.exe`，SHA-256 为 `3914B92B550D8FB84DED43E9937D89B2AAD507C6B8CE5D6F4200D29AE798B8AA`。Gateway SHA-256 为 `948EC7E3A077FB89AAB3D16BF07311C0D2A870F76343123E755AE3305C2E09E9`，K-brain 使用上表 0dad9fd 基线二进制。

数据根 `%TEMP%/liveagent-v2-baseline-b204-home` 与用户数据隔离，并复制同一份 248 会话数据。MCP Bridge 截图确认真实桌面 WebView 已显示会话和置顶列表；截图为 `baseline-seeded.png`。本场景仅有桌面客户端，没有额外连接两个 WebUI，不能作为“桌面 + 两 WebUI”基线。

5 分钟空闲结果保存在 `resource-5min`：

| 角色 | CPU 累计 | 24 核平均 CPU | 读取增量 | Working Set 峰值 | Private Bytes 峰值 | 句柄峰值/增量 |
|---|---:|---:|---:|---:|---:|---:|
| LiveAgent | 1.375 s | 0.02% | 450,584 | 85,360,640 | 27,074,560 | 654 / -11 |
| WebView2 总和 | 7.391 s | 0.10% | 228,063,690 | 633,155,584 | 555,032,576 | 3,186 / -75 |
| K-brain | 58.5 s | 0.82% | 4,474,273,792 | 42,426,368 | 76,713,984 | 264 / +10 |
| Gateway | 0.094 s | 0.00% | 0 | 20,877,312 | 22,515,712 | 187 / +2 |

WebView2 指标包含该 LiveAgent 实例的浏览器、GPU、network、storage 和 renderer 子进程总和。该结果说明旧桌面轮询使 K-brain 在 5 分钟内读取约 4.47 GB；实现版须按同样的真实桌面进程树重新采样。临时 Git archive 不是开发工作树，不在其中实施或保存任务修改，也不用于新协议验收。

### K-brain r4 初步结果

当前最终候选二进制为 `%TEMP%/kbrain-session-sync-implementation-0dad9fd-r4/kn.exe`，SHA-256 `4EF31FCDAC3DC71D7967003E326E8F904D00D49542B00B10B6FE81105E2CCB5D`，源码差异 manifest `32721995801B39B70D6A30231ADDC7A974367FBBB0F3892AD6BD1FDBC58C260D`。早期 r1–r3 均因独立复核发现忙循环、深拷贝或路径扫描问题而废弃，不计入最终对照。

r4 在相同数据和请求负载下的首轮 5 分钟结果：15 次旧列表请求平均 101.62 ms，累计读取 151,760,180 bytes、CPU 1.141 s、Working Set 峰值 38,293,504 bytes、Private Bytes 峰值 72,495,104 bytes。相对基线分别为：平均延迟降低 96.5%，读取降低 95.9%，CPU 累计降低 97.6%。同机曾有短时测试活动，因此正式报告仍需在安静时段复测 5/30 分钟；本组只作初步证据。

r4 的 30 分钟热列表结果：90 次请求平均 49.38 ms（首个冷请求 1,560.12 ms；其余 89 次平均 32.40 ms、最大 46.36 ms），CPU 累计 4.281 s，读取 169,084,158 bytes，Working Set 峰值 41,926,656 bytes、Private Bytes 峰值 72,429,568 bytes，句柄峰值 252、起止增加 13，线程峰值 20、起止减少 3。基线其余 89 次仍平均 2,800.65 ms；相同 30 分钟下累计 CPU 268.734 s、读取 21,318,598,656 bytes。热请求平均延迟降低 98.8%，累计 CPU 降低 98.4%，读取降低 99.2%。结果目录为 `%TEMP%/liveagent-session-sync-implementation-r4-30min`。r4 与最终 r5 的订阅热缓存路径相同；r5 另修复租约外不留 journal 和 dirty cache 修复，最终集成仍使用 r5。

内部测试 `TestSummaryCacheAvoidsTranscriptReadsWhenFilesAreUnchanged` 通过，断言冷读取 8 次、热读取 0 次。`TestTUIStoreDoesNotStartSummaryBackgroundTasks -count=20` 通过，覆盖独立 Store 的 Create/Save/List/SetTitle，并断言没有 scanner、publish timer 或 waiter。r4 的真实 `kn run`、会话落盘和 ACP `session/list` 也已通过本地 fixture。

真实 r4 PTY 还执行了：从空数据根启动、信任提示、创建并保存对话、`/rename automated-renamed`、`/fork automated-fork`、`/archive`、`/forks`、`/resume`、`/quit`、重新启动并恢复原会话，以及 `kn sessions delete` 删除 fork。整个流程使用本地延迟 fixture，不需要用户密钥。取消语义按现有设计需要 busy 时连续两次 Ctrl+C；早期单次 Ctrl+C/输入非空时 Esc 没有取消属于调用步骤不符，最终双击序列和保留的单元测试需在最终 r5 上再记录。

ACP 自动客户端通过 stdio 发送 `initialize` 和 `session/list`，r4 返回真实能力、版本 `0dad9fd-session-sync-32721995801B`，并列出刚由 `kn run` 落盘的会话。

## 后续矩阵

1. K-brain 实现二进制：5 分钟和 30 分钟相同负载；第二次及后续热列表完整读取/解析次数为零。
2. 独立 TUI：启动、picker、继续会话、创建/保存、改名、fork、删除、取消和退出；关闭 HTTP 订阅后无后台扫描。
3. `kn run` / ACP：新建、列表、加载、取消、恢复，以及与 HTTP 后端共用数据目录时的写入发现。
4. Tauri + 两个 WebUI：创建、改名、置顶、移动、归档、删除、分页、外部写入、断线、reset、重复 focus、旧后端降级。
5. 故障注入：500+ 变化、快照过期、tombstone floor、429/5xx、队列溢出、旧 generation ack、Gateway 与 K-brain 重启。
6. 资源回收：反复订阅/取消、快照过期、等待取消、窗口隐藏/恢复和 30 分钟循环后，内存、句柄、线程和任务不随轮数持续增长。

只有真实场景完成并产生证据后，才在本记录中标为通过。

## 自动化运行说明

- 第一次 30 分钟循环（`cycle-final-30min-v4`）完成 25 轮后终止：第二个 WebUI 进入 BFCache，WebSocket 断开，因此脚本在等待该隐藏页面继续实时更新时超时。没有刷新页面；`Page.bringToFront` 后 3 秒内恢复并显示遗漏会话，证明重连/权威重同步有效。该段是恢复证据，不是完整 30 分钟通过。
- 第二次尝试（v5）只完成 4 轮，随后同类目标生命周期问题终止；资源 PID 映射又指向已经退出的桌面进程，因此相应采样已明确移动为 `samples-stale-pid-discarded.jsonl`，不得使用。
- 真实 WebUI 上下文菜单改名曾出现“标题已在桌面和两 WebUI 生效，但触发页同时提示修改失败”。回归定位为无 generation 的旧 history event 提前结束 v2 mutation waiter。修复后再次通过真实菜单改名，触发页错误提示为 0，另一 WebUI 和桌面标题一致。
- 最终 v6 循环使用 Gateway `2545A108…`、K-brain r5 `DB0CE3A4…` 和当前工作区 Tauri。每次 WebUI 断言前先 `Page.bringToFront`，把隐藏/恢复作为测试步骤，而不是要求 BFCache 页面维持实时连接。循环脚本、完整 1,805 秒采样和 CDP 错误监听分别使用独立进程；源文件 manifest 包含未跟踪的生产实现，避免仅用 `git diff` 漏记新文件。

原始性能、进程、截图和 CDP 记录均在 `%TEMP%` 下，不提交绝对用户路径、token、进程命令行或用户数据。提交的文档只保留脱敏汇总。

## 最终增量路径的资源诊断

冻结后的实时变化改为逐条 upsert/delete，并将工作目录统计单独发布。250 条基线的模块回归确认只转换变化条目、其余对象引用稳定；这修复了重复完整 reset 的热点，但不能单独证明原生内存已稳定。

2026-10-28 的 B722 探索组合从当前工作区 `start-tauri-dev.bat` 重新构建启动。真实桌面与两个认证 WebUI 完成 37 轮 create/pin/rename/delete，同步健康、单订阅、最终数量回到 251/13，Gateway 没有待补完整快照。循环在约 279 秒停止，因为 renderer Private Bytes 从约 254 MB 增到约 615 MB；不能把这一段写成 100 轮或最终 30 分钟通过。原始数据位于 `%TEMP%/liveagent-session-sync-validation-20261028/incremental-b722-exploration/`。

进一步分组探针排除了单纯 DOM/监听器泄漏：强制 GC 后 JS heap 约 56 MB、DOM 约 1,261、监听器约 1,001，均接近起始值，但原生私有内存仍增长。50 次 focus/visibility、100 次纯 HTTP health fetch、1,000 次纯 `gateway_status` invoke 均没有同等增长。真实 10 轮元数据变化在 Gateway 断开时增长约 4.4 MB，在线时约 25 MB，因此继续采集了 renderer heap snapshot，而没有据此猜测具体产品代码。

heap snapshot 给出了可复核的保留来源：375,772 个原生 `PerformanceMeasure` 对象占约 45.5 MB，Performance timeline 中累计 378,777 条 measure，名称为 React 组件，详情带 React DevTools track。React 19.2.4 development renderer 会在每次组件渲染写入这些条目；浏览器原生 timeline 长期保留它们，普通 JS/DOM GC 不会清除。诊断干预 `performance.clearMeasures()` 后配合 critical memory pressure/GC，renderer Private Bytes 从 831.1 MB 降到 319.5 MB，embedder heap 从 61.2 MB 降到 8.6 MB。这证明此前大幅原生增长的主要来源是开发模式的无界性能轨迹。

该清理仅为一次诊断，不是正式采样中的隐藏操作。后续正式组合必须使用共享 DEV-only React timeline 预算实现，验证 React 条目有界、应用自身的 timing 保留，并在最终 K-brain/Gateway 构建上重新运行 5/30 分钟。生产构建不启用 React development 轨迹，仍须分别标记构建模式，不能混用性能结果。

同一探索组合还实际操作了 WebUI 菜单：改名通过输入框和保存按钮执行，两个 WebUI 分别约 94/659 ms 显示新标题，桌面同步；移动到隔离 Default Project、取消置顶、重新置顶及带内联确认的删除均完成。改名/移动/删除没有 `role=alert` 错误，删除后两 WebUI 与桌面移除且后端返回 404。它们是产品操作证据，和 HTTP 压测负载分开记录；最终构建仍需短 smoke。

## 最终构建的短场景

当前正式候选组合来自同一工作区 BAT：K-brain final4 `16A864EB2ADF697AC114763BB38DFF62E5E1309818B85CF0F2A518D76640E174`，computer `1A792849F7F29CB7B5EEFC4D4D04BAF94052F4E877741A473F1F95458D93E628`，当前 Gateway `BC24C9002AD2A7CF61AA13A452595C1001D6CF5B70987CA71E848C25300AB549`，Tauri `ABD1EB0487F09B4EED6A7B5FF631BE13F989EE8C3CC5AFBC93BFD59B2B63A8B5`。K-brain 生产差异 manifest 为 `27143745D5D2BC7F60BFF8E60901B5FB6D4D4A198BC293223768BAF0B13F3CED`。它们均是可追溯开发构建，不是正式发布或锁文件更新。

| 场景 | 触发与真实断言 | 结果 |
|---|---|---|
| DEV timeline 10/50 轮 | 当前 Tauri 与两认证 WebUI 执行 create/pin/rename/delete；检查产品内 React 条目预算及自建 application timing | 10/10、50/50 通过。50 轮资源样本约 248 秒，renderer Private Bytes 峰 332,050,432 bytes、末约 316 MB，起止减少 16,293,888 bytes。没有人工 clearMeasures；React 条目观察值低于 2,000，自建 timing 始终保留一条。短负载仅证明预算与回收，正式 5/30 分钟另录 |
| M04 定时后台写入 | 在真实桌面新增 Http 请求任务，六段 Cron `*/10 * * * * *`，执行限额一轮；POST 本地隔离后端创建有消息的普通会话；等待时钟触发，再点击生成会话 | 09:00:50 真实任务日志成功、耗时 1.5 秒，达到限额后已停用。桌面和两 WebUI 显示同一标题，桌面打开后显示预期 fixture 消息，两个 WebUI 无 alert。Auto Prompt 产品本身会注明不进入最近会话，因此本场景使用普通会话写入，未改变任务过滤契约 |
| M05 外部进程写入 | final4 `kn run` 与 HTTP 后端共享隔离 home，在真实工作目录发送本地 fixture 模型请求；不 dispatch focus/rescan，持续观察现有三个客户端 | CLI exit 0，输出 text/done 和 fixture 回复。周期扫描后桌面与两个 WebUI 均显示新标题，首次观测距 CLI 启动不超过 33.3 秒（含模型与落盘约 2.3 秒）；这是外部扫描发现延迟，不写成同进程 2 秒指标 |
| final4 TUI 取消/恢复 | 真实 PTY 启动独立 final4；本地模型延迟 10 秒，busy 时连续两次 Ctrl+C；改名、退出、按 ID 重启恢复，再退出 | 显示 interrupted，输入仍可用；改名成功，两次 quit 均 exit 0。重启恢复原用户消息及保存标题，transcript 三行且无 assistant 回复。二进制、会话内容哈希及步骤保存在任务临时结果中；不依赖 LiveAgent/Gateway |

短场景完成后只删除本任务明确命名的五个合成残留，恢复正式数据为 248 会话/251 MiB/12 工作目录。删除白名单和前后 coordinator 计数已保存；用户数据不在此隔离 home 中。

正式采样使用动态进程树，以覆盖 BFCache/重连后替换的 renderer PID。首次短采样发现 Windows PID 复用把早于当前 runtime 创建的孤儿 support 进程归入树；该段已标为 discarded。修正为按 runtime 创建时间排除旧孤儿后，从 09:06:14 重新开始完整 305 秒静态采样，不沿用有误的进程计数。

## final4 正式静态采样

09:06:15–09:11:19 的有效采样跨度 303.817 秒，248 会话/251 MiB/12 个工作目录，当前 Tauri DEV 与两个生产 WebUI 静置，无额外交互或编译。原始数据与产物、源码清单均在 `%TEMP%/liveagent-session-sync-validation-20261028/formal-final4/`。

| 进程角色 | CPU 累计 | 平均/采样峰值 CPU（24 核总容量） | 读取字节增量 | Private Bytes 起止增量 | 句柄/线程起止增量 |
|---|---:|---:|---:|---:|---:|
| K-brain | 0.719 s | 0.01% / 0.14% | 0 | +311,296 | 0 / 0 |
| LiveAgent/Rust | 2.453 s | 0.03% / 0.22% | 795,976 | +12,288 | +5 / +1 |
| Gateway | 0.516 s | 0.01% / 0.09% | 0 | -131,072 | 0 / 0 |
| WebView2 合计 | 10.656 s | 0.15% / 1.32% | 12,085,700 | +7,811,072 | -27 / -3 |
| 两个 WebUI 的 Edge 合计 | 41.109 s | 0.56% / 1.99% | 822,656 | +417,792 | -2 / -1 |

采样峰值按相邻实际样本的累计 CPU 差计算，间隔约 1.4 秒，不代表瞬时极值。WebView2 合计按每个样本相加后计算，未把不同时间的各进程峰值相加。Private Bytes 起止：K-brain 70,393,856→70,705,152 bytes，Rust 33,468,416→33,480,704，Gateway 26,877,952→26,746,880，WebView2 434,466,816→442,277,888，两个 WebUI 497,905,664→498,323,456。

K-brain 的进程读取计数为零不代表没有目录枚举/stat；完整 transcript 读取/解析为零仍由专门 read observer 回归证明。此前旧桌面基线没有两个 WebUI，因此不能直接用浏览器总 CPU 计算前后百分比；相同三端基线将在最终 30 分钟后补测。

正式循环于 09:11:20 开始，时长固定 1,800,000 ms、每轮结束后间隔 10,000 ms。每轮动作仍为创建含消息会话、置顶、三端断言、改名、三端断言、删除、三端移除；每四轮触发合并 focus/visibility。满 30 分钟即停，不延长凑轮数。前一版 93 轮样本未记录 interval 参数，所以两轮可比较动作和资源收敛，不能声称节奏完全相同。

CDP 监听启动时重放六条旧网络日志，均早于正式循环：08:50:50 的 `/v1/prompts` 400 两条、08:50:52 的 `/v1/skills` 422 两条来自合成工作目录不存在；09:02:59 的已删除 fixture 会话 events 404 和 09:03:01 的 trajectory 404，来自正式恢复数据前删除当时打开的 M04 会话。保留原条目及时间戳，不把它们归为 BFCache 或静默忽略；正式期间新增错误另按实际时间统计。

## final4 正式 30 分钟循环

09:11:20.888–09:41:20.891，固定 30 分钟完成 **106/106 轮**，没有延长凑数；资源采样跨度 1,803.892 秒。循环与 sampler 均 exit 0，三端每轮创建、置顶、改名、删除断言通过，最终 248 会话/12 工作目录、单订阅、`needsGatewaySnapshot=false`。正式区间新增 CDP error 为 0；六条开始时重放的旧日志保留。

| 角色 | CPU 累计 | 平均/采样峰值（24 核总容量） | 读取增量 | Private Bytes 起→止 / 峰值 | 句柄/线程增量 |
|---|---:|---:|---:|---:|---:|
| K-brain | 538.594 s | 1.24% / 4.52% | 193,447,625 | 70.51→71.18 / 75.58 MB | 0 / 0 |
| LiveAgent/Rust | 29.344 s | 0.07% / 0.59% | 17,223,552 | 33.51→35.55 / 36.09 MB | +2 / -2 |
| Gateway | 3.438 s | 0.01% / 0.14% | 0 | 26.75→27.89 / 28.71 MB | 0 / 0 |
| WebView renderer | 237.500 s | 0.55% / 2.72% | 54,989,367 | 246.35→324.00 / 327.51 MB | -1 / 0 |
| WebView 其他子进程 | 51.953 s | 0.12% / 0.87% | 121,148,889 | 196.66→220.21 / 284.74 MB | -18 / 0 |
| 两 WebUI 的 Edge 合计 | 476.203 s | 1.10% / 5.50% | 83,961,735 | 488.96→621.72 / 675.11 MB | -3 / +3 |

表内 MB 为十进制。动态进程树覆盖全部 9 个隔离 Edge 子进程，没有以遗漏新 PID 的方式降低总量。持续写入时 K-brain CPU 明显高于静态；中段分解约 86% 为内核时间，不能将它描述为零开销或直接认作 Go 忙循环。后续以同构建模式的基线/实现各 10 轮 HTTP mutations 分项比较，区分既有 runtime 创建与 metadata/锁成本。

renderer 在前五分钟扩容后稳定：中间十分钟私有内存线性回归斜率约 +0.024 MB/min，最后十分钟约 -0.345 MB/min，最后十分钟范围 309.47–327.51 MB。正式后自然状态再 GC，renderer 私有内存约 263.95→238.11 MB，React 条目仍有界且 application timing 保留；没有在有效采样中人工清理 timeline。

WebUI 总私有内存确实增加 132.76 MB，不能隐藏。主要来自一个 renderer（125.52→250.34 MB），另一页仅增加 5.51 MB；最后五分钟总量约 623→622 MB。两页生产 bundle 没有 React DEV 性能轨迹，`performance.measure` 数为 0，样式表 2 张、CSS rules 765 未增长。正式后 GC，两页 JS heap 均约 28 MB、DOM 均 835、监听器均 1,083；增长较大页面私有内存从自然观测的 285.43 MB 回收至 216.20 MB，另一页从 216.20 MB 至 212.27 MB。关闭本任务隔离 Edge profile 后旧 browser/renderer 全部退出，释放对应资源。

以新隔离 profile 重连后再执行 10 轮（非正式长测扩展），两页自然私有内存约 177.51/123.14 MB，GC 后 119.68/112.37 MB；JS heap 27.72/28.66 MB、监听器 1,085/1,106，样式和 measure 数不变。这支持 GC 时机和 allocator 预热高水位的解释，但不把整轮真实增加写成“零增长”，也不从一次结束 delta 宣称任意长时间无泄漏。后续版本对照使用新的相同 profile 起点，并在报告中保留这一资源取舍。

正式后产品场景：桌面和 WebUI 展开两个工作目录并点击真实“继续加载会话”，`workdir-10` 从 10→18 条、`workdir-9` 从 10→19 条，`hasMore` 对应消失，无 alert。真实桌面改名请求用可撤销 fetch 故障注入挂起，期间另一真实 HTTP 改名事件到达，UI 保持本地输入；拒绝挂起请求后恢复最新远端标题并显示失败，重新执行成功分支后按确认水位显示本地新标题且 alert 清除，原 fetch 均已恢复。

Windows 窗口最小化期间后端改名继续被桌面消费；现有 capability 允许 minimize，但 hide/unminimize IPC 被拒绝。测试没有扩大权限，而是用 Win32 `ShowWindowAsync(SW_RESTORE)` 只恢复本任务窗口。Gateway 断开期间继续修改，连接恢复后两个 WebUI 标题一致且权威快照义务清除。终止本任务 K-brain 后由真实桌面重新连接，约 1.86 秒内新 epoch 健康，revision 重置、publication generation 替换；随后转入版本兼容测试，未把旧 epoch 数据当成新代完整快照。macOS 隐藏/休眠仍未真机验证。

## 版本组合、独立 TUI 与补充测量

- 新 LiveAgent + clean `0dad9fd` K-brain：从当前工作区 BAT 使用旧构建 override。旧端没有 `session_changes`，新协调器保持 unhealthy/空同步缓存，真实 legacy 列表仍显示已有会话；桌面菜单改名完成，随后后端 canonical list 确认同 ID 新标题，无 alert。没有把旧轮询数据冒充完整新协议缓存。
- 旧 LiveAgent + final4：使用可追溯 b204 只读 archive 的 Vite 与保存的 b204 app `3914B92B…`、旧 Gateway `948EC7E3…`，独立旧 home/profile。首次选择原始 Benchmark 会话改名失败，真实 PATCH 500 先为未配置模型、配置后为合成 cwd 不存在；这些首败保留。改用存在的临时 cwd、新建普通 fixture，并由旧 LA 自己生成映射后，同一真实菜单改名成功，后端标题匹配、无 alert；随后删除测试 fixture。未修改旧源码或伪造旧 artifact。
- 旧 LiveAgent +旧 K-brain +两个 WebUI 的可比静态基线没有取得：真实登录后两页显示 online，但没有建立相同的有内容列表，曾出现 composer action timed out，重试后空列表；桌面与 K-brain 仍显示 248 条。直接 K-brain 列表两次 HTTP 200、2,553/2,479 ms。问题未在限定诊断内定根因，既未修改基线使其通过，也未把“online”当作视图健康；因此本次没有声称新旧三端浏览器 CPU/内存的严格百分比改善。既有仅桌面与后端相同 90 请求对照保留。
- final4 空库：当前工作区 BAT 使用全新隔离 home/profile，真实 coordinator healthy=true、0 会话/0 工作目录、revision=0、单订阅、无待恢复 Gateway 快照；native storageId 与原数据根不同，空页面正常。此项验证了 `sessions:[]` 修复，未复用已填充缓存。

独立 TUI 使用同一份 248 会话/251 MiB 临时副本，不启动 HTTP。两构建分别真实 PTY `--browse`，看到分页 50 条 picker，向上移动三项、Esc 取消、`/quit` exit 0；各采样约 40 秒：

| 指标 | clean 0dad 基线 | final4 | 限制 |
|---|---:|---:|---|
| 启动至末样本累计 CPU | 5.891 s | 6.281 s | 基线首轮含信任提示、final4 已信任；导航时点略有差异，不作精确百分比结论 |
| 用户/内核 CPU | 2.109 / 3.781 s | 2.531 / 3.750 s | 都保留真实 cold picker/preview |
| 累计读取 | 528.32 MB | 531.51 MB | 含首次列表严格读取和四个历史 preview，不能要求历史 preview 零正文读取 |
| Working Set 峰值 | 524.21 MB | 562.91 MB | 短时完整 preview 会分配正文，两端均有峰值 |
| Private Bytes 峰值/末值 | 558.76 / 76.07 MB | 593.26 / 87.94 MB | final4 峰值增加约 34.5 MB、末值增加约 11.9 MB，明确记录缓存取舍，不宣称独立 TUI 内存改善 |

两端真实交互、取消 picker 和退出行为一致；普通 TUI 无 HTTP scanner/timer/journal 的自动化断言另已通过。此短样本没有替代独立 TUI 功能回归，也不从峰值断言永久泄漏。

小库无订阅的 HTTP 同负载补测：两端各 10 轮 create/pin/rename/delete，均 40 请求通过；clean 0dad CPU 0.421875 s（user 0.171875/kernel 0.250），final4 0.343750 s（user 0.125/kernel 0.218750）。这只描述小库无 changes 消费者的请求成本，不能排除正式 248 会话、实际配置和订阅下的额外 CPU；正式持续写入的高内核成本继续以分阶段测量说明，不用此数字强行归为既有开销。

最终恢复 current-workspace BAT 后，保留真实 248 会话、当前配置与一个 changes 消费者，追加三轮分阶段测量（每阶段后等待 700 ms 让事件落地）：

| 动作 | 三次请求耗时 | 三次用户/内核 CPU | 读取增量/次 | changes GET/阶段 |
|---|---|---|---:|---:|
| create | 1,440 / 1,442 / 1,492 ms | 0.297/1.203、0.188/1.266、0.172/1.453 s | 909,818 | 1 |
| pin | 16 / 16 / 17 ms | 0/0.016、0/0.016、0/0.016 s | 2,642 | 1 |
| rename | 21 / 18 / 16 ms | 0.016/0.016、0/0.016、0.016/0 s | 2,640 | 1 |
| delete | 8 / 8 / 9 ms | 0/0.016、0/0、0/0 s | 745 | 1 |

随后三秒空闲用户/内核 CPU 均为 0。高成本集中在实际配置下的会话创建阶段，changes 没有出现持续短请求或空闲忙循环；没有函数栈 profile，所以仍不将原因精确归为某个 skills/factory/锁函数，也不据此进行无关重构。原始分项保存在 `cpu-stage-248-final4.json`。

测试结束时已从当前任务工作区 BAT 恢复 final4 原隔离 home，真实 coordinator healthy=true、248 会话/12 工作目录、单订阅、`needsGatewaySnapshot=false`，新 epoch/generation 正常。没有留下用于采样的旧基线客户端代替当前实现；旧版本/空库组合均单独记明。
