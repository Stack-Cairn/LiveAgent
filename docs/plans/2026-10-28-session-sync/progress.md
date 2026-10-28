# 会话摘要缓存、增量同步与资源优化进展

## 当前任务

完成 K-brain 独立 TUI/CLI/ACP、LiveAgent 桌面、Rust、Gateway 及 WebUI 的会话摘要缓存与端到端增量同步，同时证明 CPU、内存和磁盘读取改善。范围包括评审 R01–R16、设计 A01–A22 及由 Agent 执行的 M01–M12，最终需要两仓 PR 与 required CI 收敛。

本次明确由自动化代替人工验收。不要求用户点击、截图或回复“通过”。不得提前宣告完整目标完成，也不发布正式 K-brain 产物、不改正式锁文件、不自动合并。

## 工作区与保护范围

- LiveAgent：当前工作区 `D:/Documents/Projects/Web/LiveAgent`，分支 `feat-session-sync-resources`，基线 `upstream/v2-kbrian@b2049905a89462e766b4aa7d6aa76b3a4cbef144`。
- K-brain：隔离工作树 `D:/Documents/Projects/Go/K-brain-worktrees/session-sync-resources`，分支 `feat/session-sync-resources`，基线 `origin/main@0dad9fdec4adbb2a6324974edc1d610c69b2a79b`。
- K-brain 主检出的用户未提交开发保持原样；LiveAgent 原有两份未跟踪设计文档作为输入保留。
- `start-tauri-dev.bat` 由 `.git/info/exclude:8` 忽略，`git ls-files` 无输出。不得将它、开发二进制、测试数据、token 或 profile 纳入提交。

## 最新整体状态（2026-10-28 10:27，Asia/Shanghai）

| 阶段 | 状态 | 已有结果与剩余工作 |
|---|---|---|
| 基线与计划 | 已完成 | 两仓基线、用户改动保护、设计与实施顺序已记录；最新 fetch 后基线未变化 |
| K-brain 摘要与同步 | final4 冻结候选 | Server.Close 迟到快照、创建期 admission、嵌套 usage 深拷贝及空快照 `sessions:null` 均已复现并修复；build/vet、相关 count20/race30 通过，final4 SHA `16A864EB...40E174`，待最终真实组合和 CI |
| GUI/Rust/Gateway/WebUI | 最终组合短测通过，长测中 | 桌面协调器、稳定映射、乐观覆盖、权威恢复、队列缺口锁存、token/ack、freshness 与旧版降级已有回归；直连最终 final4 真实14/14通过，legacy/cap1各3/3，Go全量通过 |
| 增量投影正确性 | 回归通过 | 新增 16 项独立回归全部通过；加 publication/offline-alias 共 21/21；GUI 聚焦组合与 WebUI 43 项均通过；typecheck、任务文件 Biome、Mirror 和 diff 检查通过 |
| 自动化完整检查 | 最终build/check/lint已收敛，CI待开始 | GUI/WebUI最终build与typecheck通过、cargo check --tests通过、Gateway全包和最终lint通过、harness13/13；WebUI275/275，GUI全部3,534项3,528通过/5基线失败/1跳过。Rust23、K-brain8失败有基线复现，changed-file Biome/Mirror/diff通过。全目录Biome格式诊断单独记录，CI尚未开始 |
| 真实客户端 | 新旧完整UI组合通过，短基线对照中 | 106/106正式循环、实际菜单/定时任务/外部kn/PTY取消恢复、M06分页/M07受控并发均通过；Windows最小化/Gateway断连恢复、新LA旧KB及旧LA新KB真实菜单改名通过。旧三端静态和TUI/HTTP短对照仍在处理中 |
| 资源目标 | 正式长测与短对照完成，有明确取舍 | 106/106通过、桌面renderer平台、KB/GW/Rust稳定；WebUI+132.8MB及GC高水位保留。旧三端静态无法ready、没有可比结果；HTTP各10轮小库无订阅均过；独立TUI各40秒CPU接近但final4内存峰+34.5MB/end+11.9MB，不能宣称全面改善。正式大库持续创建内核CPU仍待1–3轮分项定位 |
| 提交、PR 与 CI | 两仓PR已创建，CI修复中 | K-brain PR#60（main），LiveAgent Draft PR#1071（v2-kbrian）已附任务；KB macOS首轮过、Windows CRLF/Linux sandbox环境修复已追加b4f5508；LA Gateway/WebUI/Docker/Diff过，UI门禁mise缺失已修准备追加。仍监测全部required CI至终态，无合并/tag/release/正式lock变更 |

## 阶段历史

### 阶段一：基线与原问题量化

- 构造 248 个会话、251 MiB 的确定性隔离数据集；数据和模型请求不使用用户会话或密钥。
- K-brain 基线 30 分钟 90 次列表请求：平均约 2,804 ms，累计 CPU 268.73 s，读取 21.32 GB。
- 相同负载的缓存实现候选 r4：平均 49.38 ms，累计 CPU 4.28 s，读取约 169 MB，Private Bytes 峰值从约 75.40 MB 降为 72.43 MB。
- 热缓存读取计数测试明确断言 transcript 完整读取为 0；进程 I/O 仍包含有界目录枚举与 stat，不能称零读盘。

证据：`automation.md`、K-brain 验证文档与 `%TEMP%/liveagent-session-sync-baseline-30min/summary.json`、`%TEMP%/liveagent-session-sync-implementation-r4-30min/summary.json`。不同候选和最终构建差异在报告中分别标记。

### 阶段二：跨端协议与恢复

- 完成固定快照 R → 首批固定 H 的追赶、字符串 uint64 游标、`next_since` 续传、reset/floor 与取消。
- 完成单协调器与 Abort/generation、稳定 LA-ID、元数据确认水位、本地覆盖与远端事实分离。
- Gateway 增加 source/generation/seq、缺口锁存、控制恢复、分页权威集合、token/ack 和生产者 freshness；旧组合保留轮询。
- 修复真实 Tauri 发布缺少布尔字段，以及 legacy history event 提前结算 v2 mutation waiter、污染已激活 v2 authority 的问题。
- 修复前真实长循环 93 次操作全部同步成功，但资源采样发现 WebView renderer 私有内存增长约 775 MB；该轮不能作为完整验收通过。

证据：`gateway-verification.md`、`verification.md`、`requirements.md`、原始 `%TEMP%/liveagent-session-sync-cycle-final-30min-v6`。

### 阶段三：实时增量与边界回归

- 把实时变化与初始化/恢复快照分开，实时变化不再每批发送完整 reset；250 条基线修改一条只转换一条，其余对象引用保持。
- 独立首败回归发现并修复：取消置顶、清空 cwd、尾页更新计数、尾页删除、首页删除补位、迟到列表回滚、页外本地操作和发布快照 workdirs 切点不一致。
- 共享 store 增加完整摘要行语义，完整缓存负责分页和工作区计数；本地覆盖与位置锁仍受保护。
- 权威事件回收已确认 local-upsert ID、删除锁和状态；legacy 删除记录达到 1,024 条后使旧请求失效再回收，2,048 次删除回归通过。
- 新增 16 项独立测试、相关 publication/offline-alias 共 21/21 通过；WebUI 43 项聚焦测试通过。GUI/WebUI typecheck、任务文件 Biome、Mirror、diff 卫生通过。

证据：`kbrain-sidebar-incremental.test.mjs`、`kbrain-session-sync.test.mjs`；首败 `%TEMP%/liveagent-session-sync-incremental-review-first.log`，修后 `%TEMP%/liveagent-session-sync-incremental-review-final.log`。

### 阶段四：基线失败对照与最终真实复核（当前）

- Rust 未修改 b204 基线 2,674 个文件逐字节一致；独立临时 target 全量 1,131 tests = 1,104 通过、23 失败、4 忽略。
- 任务源码 1,134 tests = 1,107 通过、23 失败、4 忽略，失败名称集合完全相同；新增 3 项通过。证据 `%TEMP%/liveagent-session-sync-rust-baseline-closure/full-lib-test.log`。
- 最新独立 K-brain 回归复现：请求已进入快照创建后 Server.Close 完成，迟到请求仍创建 1 份快照和 60 秒 timer，并返回 HTTP 200。正在实现创建预约、预算与关闭复核；首败 `%TEMP%/kbrain-session-sync-review-close-first.log`。
- 真实 Gateway 直连 WS 复现：`history.set_cwd` 返回 agent offline；删除 unary 成功后，新连接恢复快照仍保留 1 条已删除会话，直到 K-brain epoch 重建才清除。证据 `%TEMP%/liveagent-session-sync-relay-first-20261028-082540/results.json`。正在补齐直连实现。
- 当前增量 GUI + B722 的探索约 220 秒、约 30 轮：三端同步正确，但 WebView renderer 私有内存约 253.6 MB → 614.9 MB，峰值约 628.4 MB，约 98 MB/min。GC 后 JS heap、DOM、listener 返回基线，native private 仍增长；因此增量路径修复没有证明解决整体内存问题。停止扩大正式长测，保留现场并继续定位。
- 同轮 Rust private 约 +0.34 MB、Gateway +1.0 MB、K-brain +2.6 MB；不能把 WebView 开销移出统计后宣称优化完成。证据 `%TEMP%/liveagent-session-sync-validation-20261028/incremental-b722-exploration/samples.jsonl` 和 `partial-summary.json`。
- 资源隔离 A/B：Gateway 断开、Node HTTP 写入 10 轮、仅桌面 DOM 断言约 +4.4 MB；Gateway 在线同负载约 +25 MB。两组 JS heap/DOM/listeners 基本稳定，说明增长集中在 WebView/native 或在线 IPC/恢复路径，但尚不足以归因到具体代码。当前只保留诊断探针，不把任一假设写成根因。
- 直连真实回归：修复候选 Gateway 在独立进程中 rename/pin/unpin/move/delete 三端约 523–568 ms 收敛，K-brain 重启后约 1.05 s 新 epoch 恢复，`max active changes=1`；修前 8 场景 6/8，set_cwd 为 agent offline、delete 恢复仍有残留。红/绿证据 `%TEMP%/liveagent-session-sync-relay-regression-red-20261028-083412` 与 `...-green-20261028-083428`。
- K-brain final2：`%TEMP%/kbrain-session-sync-implementation-0dad9fd-final2/kn.exe` SHA-256 `AAB751F5D9C830A7599BD50EF4267F8593350C559E15FB4ACD423F437250027B`，computer `1A792849F7F29CB7B5EEFC4D4D04BAF94052F4E877741A473F1F95458D93E628`，source manifest `C1D8F38165A963363DCF3D2537E8CED14E899695AAFCAEF9878B32DF8D945E18`。它只作为关闭 admission 修复候选；嵌套 usage alias 修复前不得联调最终组合。

### 阶段五：内存根因与最终候选修复

- Heap snapshot 找到约 375,772 个 native `PerformanceMeasure`，timeline 约 378,777 条；条目为 React 19.2.4 DEV 的组件/调度轨迹，`detail.devtools.track=Components ⚛` 或 `trackGroup=Scheduler ⚛`，常附 props diff。React 代码没有清理，User Timing 会长期保留这些 native 对象。
- 受控干预：`performance.clearMeasures()` 加 GC 后，renderer private 831.1→319.5 MB（释放约 511.6 MB），embedder heap 61.2→8.6 MB，JS/DOM/listener 数量仍稳定。该结果把根因从早期猜测推进为直接干预证据；全清只用于测试诊断，不能作为产品实现。
- 产品修复为共享 `reactDevTimeline.ts`：仅在 DEV 安装 observer，React 轨迹超 2,000 条后清理仅被 React 使用的 measure 名称；保留应用 measure、mark 以及与应用同名的记录。GUI 与 WebUI 入口共同使用，HMR dispose 会断开 observer，生产模式不安装。
- 真实 Node PerformanceObserver 测试验证多批增长受控、应用 timing 保留和 dispose；GUI/WebUI typecheck、任务文件 Biome、Mirror Check 通过。最终实际资源回收仍须重新采样，不能直接用清理前后一次 delta 宣告无泄漏。
- K-brain final4 修复三个独立反例：Server.Close 后快照复活、`ai.Usage.PromptTokensDetails` 嵌套指针污染返回值、空库快照返回 `sessions:null` 导致严格客户端不能初始化。新增测试保留首败；关闭/预算、深拷贝、1,201 条三批追赶、10,005 条 tombstone 和空库快照回归通过，相关 race30 无 DATA RACE。
- final4 开发产物：`%TEMP%/kbrain-session-sync-implementation-0dad9fd-final4/kn.exe` SHA-256 `16A864EB2ADF697AC114763BB38DFF62E5E1309818B85CF0F2A518D76640E174`；computer SHA-256 `1A792849F7F29CB7B5EEFC4D4D04BAF94052F4E877741A473F1F95458D93E628`；source manifest `27143745D5D2BC7F60BFF8E60901B5FB6D4D4A198BC293223768BAF0B13F3CED`，版本 `0dad9fd-session-sync-27143745D5D2`。final2/final3 保留为中间候选，未覆盖旧 artifact 或正式 lock。
- 冻结组合已从当前工作区 BAT 重新启动：LiveAgent 29928、Vite 62016、Gateway 56612、K-brain 26920。Gateway 因嵌入当前 WebUI 重新构建，SHA-256 `BC24C9002AD2A7CF61AA13A452595C1001D6CF5B70987CA71E848C25300AB549`；不能继续用旧 `2545` 或 `6BC7` 哈希描述此轮。
- 产品 timeline 预算真实短测 10/10：运行中 React measures 2/1,667，结束 875，应用 sentinel 始终 1；自然 GC 后 renderer private 约 230.3 MB、JS heap 53.6 MB、embedder heap 8.15 MB、DOM 1,199、listeners 1,003。没有由 harness 人工清除 React 记录；当前结果只支持短时改善，不替代 30 分钟观察。
- 最终前端全批结果：GUI 478 文件、6 批、3,534 tests = 3,528 pass / 5 fail / 1 skip；WebUI 119 文件 275/275。失败为 permission full-access/always 及其父测试、2 个 trajectory HTTP 用例，使用固定 0dad 基线二进制再次复现同样 5 项；其 Bash `printf` 在 Windows 的环境限制不属于本次摘要同步修改。日志 `%TEMP%/liveagent-session-sync-final4-frontend-batch-{1..6}.log`、`...-frontend-baseline-repro.log`、`...-trajectory-baseline-repro.log`、`...-web-final4.log`。标准 GUI runner 会在失败批停止，因此另按原 runner 的 6 个批次逐一执行，未漏掉后续测试。
- 最终 Relay 与 final4：真实 raw WS 10/10，含合法 cwd、非法 cwd 拒绝保 authority、鉴权、epoch 和单 poll；两真实 WebUI 已登录并选择 K-brain 显示同会话。旧 K-brain+新 Gateway legacy unary 3 项、capability1 3 项均未调用新路由。真实菜单自动化仍在收敛，不能把“已显示”当作菜单操作通过。

### 阶段六：最终短负载与产品流程

- 最终 final4 + 当前 Gateway + React DEV预算组合，10轮之后继续短50轮：50/50三端创建/置顶/改名/删除通过；248秒进程采样renderer private峰约332MB、末约315MB，较采样起点下降16.3MB。timeline结束1176、应用sentinel1，由产品代码自动维护，没有harness手动clear。该结果显示此前线性增长已在短负载中收敛，正式30分钟仍是完成门槛。
- 最终 B722 之前的37轮失败样本保留；它只证明早期修复不充分，不替换或删除。最终样本仅使用 final4，构建和源码身份分别记录。
- 桌面真实定时任务UI创建每10秒HTTP fixture任务、执行上限1；09:00:50实际执行约1.5秒成功并自动停用，生成有消息会话，三端出现相同标题，桌面点击打开正确消息，alerts=0。它验证实际后台任务入口，不用存储单元测试替代。
- 外部 final4 `kn run` 使用同一隔离home/cwd落盘，保持桌面可见、不主动focus/rescan；从run开始到首次观测约不超过33.3秒。周期扫描发现后三端显示同标题；该时间包含kn运行与扫描，不混称同进程2秒延迟。
- final4真实PTY忙碌时连续两次Ctrl+C显示interrupted，随后仍能改名和退出0；重新启动带resume恢复原标题/用户prompt，再退出0。日志 `%TEMP%/kbrain-session-sync-final4-tui/pty-result.json` 与对应transcript摘要。
- 最终直连Relay 14/14真实场景全部通过，两个实际WebUI和两个raw WS：菜单改名约289ms、取消置顶/置顶约1075ms、确认删除约1126ms且alerts=0；合法移动约528ms；非法cwd拒绝不改authority；鉴权失败降级恢复约1558ms；K-brain重启新epoch恢复约1057ms；上游max active changes=1。证据 `%TEMP%/liveagent-session-sync-relay-final4-ui-20261028-090053`。legacy与capability1各3/3通过，临时进程全部退出。
- 当前进入正式5分钟静态、30分钟循环和回收采样；额外版本组合、截图、编译和完整测试安排在有效采样区间外，避免争用和负载混淆。
- 静态首段因Windows PID复用把旧孤儿support进程纳入总树而作废，保留为 `idle5-samples-orphan-support-discarded.jsonl`。采样脚本加入创建时间必须不早于任务根进程的约束后，09:06:14重新计时；核心进程原本正确，整段仍不用于最终对照。
- 最终静态有效303.817秒，同248会话/251MiB/12cwd、桌面加两WebUI：K-brain CPU0.719秒/readBytes增量0/private+0.311MB/handles增量0；Rust CPU2.453秒/read0.796MB/private+0.012MB；Gateway CPU0.516秒/read0/private-0.131MB；renderer CPU6.422秒/read1.810MB/private+8.901MB/峰255.529MB；其他WebView CPU4.234秒/read10.275MB/private-1.09MB；两WebUI合计CPU41.109秒/read0.823MB/private+0.418MB。进程读取计数为0不等于目录/stat零读盘。结果 `formal-final4/idle5-summary.json`。
- 正式30分钟09:11:20.218开始，持续1,800,000ms、每轮结束间隔10,000ms，满时停止而非凑轮数。约6分钟21轮均healthy248/12、单订阅、无需Gateway snapshot恢复；renderer private约247.5MB。6条CDP network error均由Log.enable重放正式区间前的fixture错误：早期不存在cwd的prompts/skills 400/422，以及恢复248数据时删除已打开fixture后history/trajectory 404。原日志保留，不能归为BFCache，也不算正式区间新增异常。
- 09:21:39检查点：正式区间10分19秒、37轮全部通过，deliverySeq到455，248会话/12cwd、单订阅与needsSnapshot=false保持；stderr为空，没有正式区间新CDP错误。循环满30分钟停止，不为达到特定轮数延长。
- 09:30:42检查点：19分22秒、69轮全部通过；renderer private约320.3MB（近几分钟317→319→320MB，呈平台而非早期持续线性增长），KB约71.7MB、Gateway约27.7MB、Rust约35.8MB。持续创建时K-brain累计CPU仍偏高，其中约86%为kernel；当前不能据此判定Go忙循环。已只读复核longpoll没有短timer忙循环分支，正式采样后需用旧/新后端相同10轮HTTP负载区分既有runtime创建/文件系统成本与本次改动。

### 阶段七：最终30分钟终态

- 正式循环 `startedAt=2026-10-28T01:11:20.888Z`、`finishedAt=2026-10-28T01:41:20.891Z`，满30分钟即停，106/106轮通过。每轮真实创建、置顶、改名、删除，桌面和两个实际WebUI DOM断言；循环后回到248会话/12cwd，healthy、单订阅、needsSnapshot=false始终保持。进程采样覆盖1,803.892秒，包含循环末尾几秒。
- renderer private起246.35MB、末324.00MB、峰327.51MB；增长主要在预热后形成平台，不能把单轮delta或斜率直接当泄漏。Rust起33.51→35.55MB，Gateway26.75→27.89MB，K-brain70.51→71.18MB。两WebUI总private488.96→621.72MB、峰675.11MB，需继续末段趋势和停止负载后回收检查。
- K-brain累计CPU538.594秒、read193.45MB；Rust29.344秒/read17.22MB；renderer237.50秒/read54.99MB；其他WebView51.953秒/read121.15MB；Gateway3.438秒/read0；两WebUI476.203秒/read83.96MB。持续创建HTTP的KB CPU内核占比偏高，需短新旧同负载分项对照，不能将旧的90次只读列表CPU数字直接与106次创建/保存/删除循环比较。
- 24逻辑核总容量下，平均CPU：KB1.24%、Rust0.07%、renderer0.55%、其他WebView0.12%、Gateway0.01%、两WebUI1.10%；约采样间隔峰值分别4.52/0.59/2.72/0.87/0.14/5.50%。峰值是采样区间值，不是瞬时最大。
- 句柄起止变化：KB0、Gateway0、Rust+2、renderer-1、其他WebView-18、两WebUI-3；线程变化分别0/0/-2/0/0/+3。需要结合后续取消/退出回收，不单凭起止差断言所有资源无泄漏。
- 证据 `formal-final4/cycles30/result.json`、`cycles.jsonl`、`cycle30-summary.json`、`cycle30-samples.jsonl`；原始日志留TEMP，脱敏汇总纳入文档。下一步完成停止负载后回收、界面/版本组合和旧三端静态基线，随后最终提交与CI。
- WebUI分进程复核：主要增长集中同一renderer，125.5→250.3MB（约+124.8MB），另一renderer仅约+5.5MB，无新增PID。正式后两页JS heap约28.15/28.25MB、DOM835、listeners1083一致；自然回收/GC使主要renderer约285.4→216.2MB（-69.2MB），另一约216.2→212.3MB，桌面约263.9→238.1MB。最后10分钟WebUI仍有约4.3MB/min拟合斜率，因此不能仅用最后5分钟平台关闭资源疑问。将检查性能轨迹、native分配和profile退出/新profile恢复；不硬清生产应用timing，不无限追加30分钟。
- WebUI追加诊断否定React DEV轨迹：两页measures=0，React轨迹=0，样式表2份/cssRules765保持；生产bundle无React开发轨迹实现。旧profile关闭后所有对应browser/renderer进程退出、资源释放；新profile登录恢复后追加10/10循环通过。两页私有内存初始93.3/105.3MB→自然177.5/123.1MB→GC后119.7/112.4MB，JS heap27.7/28.7MB、listeners1085/1106、DOM843/923（展开状态不同）。正式末5分钟总private约623→622MB，GC后回到原profilewarm范围。证据支持临时分配及GC/allocator高水位，不把所有增量隐藏；单次短测也不能泛化为任意长期负载无泄漏。
- 两张合成会话真实CDP clip已逐一检查无token、用户数据或绝对home，按原像素复制到 `evidence/`，源/目标SHA一致。用于PR运行预览；置顶动作发生在两张截取之间，说明文字明确不把截图当同一原子切点证据。

### 阶段八：界面边界与最终检查

- M06实际分页：桌面与WebUI分别展开workdir-10、workdir-9，前10条分别加载到18/19条，hasMore由true变false，alerts为空；结果 `m06-pagination.json`。
- M07实际桌面改名UI：挂起PATCH、另一真实HTTP请求产生远端改名事件，pending期间本地标题仍可见而远端标题不覆盖；控制拒绝后恢复最新远端标题并显示修改失败。成功分支解除延迟后本地确认标题保留、无alert。原始fetch已恢复，证据 `m07-pending-failure.json`、`m07-pending-success.json`。
- Windows最小化期间实际远端改名仍被桌面消费；Gateway断开→改名→重连后三端标题一致且needsSnapshot=false。部分Tauri hide/unminimize命令受现有capability拒绝，测试保留错误，用Win32仅恢复本任务窗口；不把被拒命令写成通过，也不声称macOS隐藏窗口已真机验证。
- 最终GUI build、WebUI build、GUI/WebUI typecheck与Rust `cargo check --tests`通过，仅既有大chunk/dynamic import/unused警告。日志 `liveagent-session-sync-final-gui-build.log`、`...-final-web-build.log`、`...-final-cargo-check.log`。
- 测试工具13/13通过，包含动态进程采样、退出进程CPU、采样峰值与Edge单URL启动契约。日志 `...-final-harness.log`。
- Gateway lint最初遭Go1.25项目与系统Go1.27工具/缓存混用；直接指定已安装Go1.25.12和独立全新`GOLANGCI_LINT_CACHE`后得到0issues。任务测试中2处复制Protobuf MessageState锁已改为`proto.Clone`，仅测试改变；PBWS history定向回归通过。保留 `...-final-go-lint*.log` 首轮与最终结果，不把错误工具链输出写成代码基线失败。最终47个生产文件仍与正式采样manifest完全一致。
- 用户原有K-brain主检出8处tracked修改和2个untracked文件仍原样保留；未暂存/提交。原有两份LiveAgent设计输入也继续作为用户文件保留，当前任务新协议说明位于 `docs/architecture/session-sync.md`。
- 新LiveAgent当前源码+未修改0dad后端：旧能力没有session_changes，协调器保持healthy=false而legacy列表仍可见，实际菜单改名后后端同ID标题一致、无alert。旧b204桌面+final4：首轮对synthetic历史操作失败，已抓PATCH 500具体来自不存在的`C:\session-sync-benchmark`及未配置fixture模型；改用存在的任务TEMPcwd、新建兼容会话并由旧客户端自己映射后，菜单改名成功、后端标题匹配、alerts为空，再删除fixture。首败和环境修正后的结果分别留痕，不把它解释成接口回归或改动兼容门槛。
- 两个完整桌面版本组合真实UI已通过。随后启动旧b204+旧0dad+两个独立WebUI、同248会话/251MiB数据集，补同端空闲5分钟基线；正式采样期间主线停止编译/测试。
- 旧三端基线在限定时间内未能达到可比ready状态：旧桌面显示248条，真实后端列表GET200约2553/2479ms，Gateway在线、native桥pending0，但两WebUI未显示Benchmark列表、出现过composer timeout。具体根因尚未证实，不能擅称旧协议缺陷或写三端ready；保留 `old-baseline-three-client-limitation.json`，不对失败界面负载计算严格前后百分比。既有旧单桌面5分钟和K-brain相同90次列表30分钟对照仍有效，限制单列；继续HTTP/TUI短对照及恢复最终客户端。
- 已按仓库流程登记具体问题 [#1070](https://github.com/Stack-Cairn/LiveAgent/issues/1070)，内容包含248/251MiB基线及期望恢复契约。提交/PR尚未开始，不能把问题登记当作CI或实施完成。
- 相同10轮HTTP create/pin/rename/delete、同TEMPcwd/本地模型/无订阅：baseline CPU0.421875秒（user0.171875/kernel0.25），final4 CPU0.34375秒（user0.125/kernel0.21875），各10/10通过。该短对照只描述小库、无订阅路径；不能拿它排除正式248大库与订阅组合的所有CPU问题。正式每轮约5秒累计CPU还需少量分项采样定位，不无故重跑30分钟。
- 独立TUI同248会话/251MiB、无HTTP，各约40秒：实际历史picker50条、导航3项、Esc取消、quit退出0。baseline累计CPU5.891秒（user2.109/kernel3.781）、read528.323MB、private峰558.76MB/end76.07MB；final4CPU6.281秒（user2.531/kernel3.75）、read531.508MB、private峰593.26MB/end87.94MB。冷启动和preview仍严格完整解析，final4峰值约+34.5MB、末值+11.9MB为真实缓存/分配取舍，不能宣称独立TUI所有性能改善。导航触发存在数秒差异，不作精确百分比比较。无HTTP后台timer/scanner/journal回归仍通过。
- 248会话和实际单changes消费者的最后3轮分项已完成：create wall1440/1442/1492ms，CPU user约0.297/0.188/0.172秒、kernel1.203/1.266/1.453秒、每次read909,818bytes；pin16/16/17ms，rename21/18/16ms，delete8/8/9ms，每阶段仅1个changes GET。最后空闲3秒user/kernel均0。定位到创建阶段资源成本，尚无函数栈profile，不进一步强归既有或修改无关runtime；记录真实限制与后续优化方向。
- 空库actual GUI current BAT+final4健康：0会话/0cwd/revision0、单owner、needsSnapshot=false，数据根storageId与原home隔离。随后最终原home恢复：app46256/Gateway63208/KB62056(final4)/Vite59876，healthy248/12、单订阅，无待恢复快照；旧baseline进程均已结束。
- M09结论纠正：minimize命令本身成功，但恢复前IsIconic=false（可能CDP前台化），所以只证明执行最小化命令后同步正常，不能保证整个变更期间一直最小化。hide/unminimize现有capability拒绝、macOS与真实系统休眠未验证，明确部分覆盖而非全绿。
- K-brain任务16文件已提交为`482fd2d71fd9a85777e8f7e650379c39b6712684`，推fork并创建[PR#60](https://github.com/Stack-Cairn/K-brain/pull/60)。HTTPS OAuth最初因缺workflow scope拒推；使用原有已授权SSH fork远端成功，不修改账户授权。三平台session-sync检查已启动，必须跟进至终态。LiveAgent尚待任务文件提交及PR，原有用户改动不纳入。

### 阶段九：两仓提交与CI

- LiveAgent 101个任务文件提交`80f570e8c0f7b87e88d94ec3d896541909877d1e`，推fork并创建[Draft PR#1071](https://github.com/Stack-Cairn/LiveAgent/pull/1071)，base=`v2-kbrian`，关联issue#1070、跨仓依赖K-brain#60/482fd2d。PR说明全部测试、性能、运行截图和限制，保持Draft避免把未发布依赖或部分真机覆盖写成发行完成。两份原有设计输入仍未跟踪、未纳入提交，本地脚本仍忽略。
- K-brain首轮CI macOS通过；Windows13个Go文件因checkout CRLF令gofmt失败，Linux全量仅internal/browser的9个案例报No usable sandbox，其余包通过。追加`b4f5508`只改workflow/报告：Windows checkout前禁autocrlf，Linux临时runner配置允许userns并验证、提供Xvfb，保持浏览器sandbox，race30独立执行不被fullsuite失败跳过。首败日志与新run继续监测。
- LiveAgent首轮Gateway、WebUI、Docker、Diff通过；Shared UI Boundaries在严格changed-file门禁报`spawn mise ENOENT`（前面的shared typecheck/lint/44脚本测试/Mirror已过）。修脚本在CI使用已安装固定pnpm，本地仍走mise，显式LF与`.gitattributes`一致，保留`--error-on-warnings`。新增调用回归通过，ui/gui/webui三个真实changed-file门禁本地均通过；准备追加提交后监测。

## 下一步与完成门槛

1. 使用冻结的 K-brain final4 重新执行空库、真实 HTTP/TUI/ACP 与整体组合 smoke；深拷贝和空库回归不得仅停留在候选版本报告。
2. 采用独立 Gateway 修复候选完成直连 legacy/cap1/auth/浏览器恢复与 fulltest；用 final4 + 最终 Gateway 重新启动隔离桌面。
3. 验证 React DEV timeline 预算在真实客户端中生效、保留应用 timing，重新量化 native private；不能凭 JS heap 或模块测试通过关掉 P1。
4. 最终源码与产物冻结后，完成 5 分钟空闲和 30 分钟循环/回收观察，以及 M01–M12 剩余真实产品流程、外部写入、取消、故障恢复与版本组合。
5. 运行最终两仓适用检查，补齐精确需求—代码—测试—证据映射。全量基线失败与未执行项继续明示。
6. 保护用户改动，检查忽略与 staged diff，只提交任务文件，推送 fork 并创建正确 base 的 PR，持续修复/监测 required CI 至终态。不自动合并、不打 tag、不伪造未发布依赖。

## 维护规则

每次新增阶段性结果，先更新本文件的“最新整体状态”和相应证据，再追加阶段历史或补充当前阶段。记录失败、作废样本、构建身份变化和剩余门槛；保留历史，不把局部通过改写成整项完成。
