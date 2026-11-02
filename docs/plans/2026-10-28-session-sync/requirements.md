# 会话摘要同步需求与验证对应关系

状态：实现与模块回归已覆盖下列问题；最终构建的真实客户端、资源采样、跨仓 PR 与 CI 仍在进行。表中的“回归通过”只描述对应自动化断言，不表示完整 Goal 已完成。

## 评审问题

| 问题 | 实现位置与行为 | 直接验证 |
|---|---|---|
| R01 增量续传 | K-brain `internal/session/summary.go`、GUI `sessionSync.ts`、Gateway `internal/kbrain/history_sync.go` 分离 `head_revision` 与 `next_since` | `TestSummaryChangesBatchCursorNeverJumpsToHead`；GUI `kbrain-session-sync.test.mjs` 的真实 HTTP 1,201 条变化、500/500/201 三批追赶 |
| R02 跨页切点 | K-brain `internal/backend/session_sync.go` 保存不可变快照；GUI 先取得所有固定 R 页，再追赶首批固定 H | `TestSessionSnapshotIsImmutableAndChangesResumeFromItsRevision`；GUI 同一快照与有限追赶回归；Gateway 发布者等待期间切点一致性回归 |
| R03 合并唤醒 | K-brain Store 首次变化启动固定窗口，后续写入不延长；显式 `wait=0` 可立即续传 | `TestSummaryChangesCoalescesWaiterWakeups`；合并、deadline、空批不推进及 caught-up 不忙循环测试 |
| R04 外部变化 | K-brain HTTP 同步租约按需拥有共享 scanner；GUI focus 合并并取消当前 poll 发起 rescan | 外部 Store 写入/删除、scanner 失败、rescan 429/Retry-After 与 focus 不重建快照测试；真实外部进程场景另见自动化记录 |
| R05 稳定身份 | GUI `mapping.ts` 以内存状态串行 ensure/set，批处理持久化，按实际数据根隔离 | `kbrain-managed-mapping.test.mjs`：存储写失败仍稳定、数据根隔离、批量只写一次、删除别名不从旧 namespace 复活 |
| R06 乐观覆盖 | 共享 `sidebar/store.ts` 分离最新远端事件与本地覆盖；GUI 元数据操作等待后端确认水位 | store 在途改名、失败恢复最新值；`kbrain-sidebar-incremental.test.mjs` 的并发覆盖与页外本地操作成功/失败 |
| R07 广播丢失 | Rust 发布者返回交接结果；Gateway 在事件队列之外锁存恢复义务；浏览器按 token/ack 恢复 | Rust 发布权限及返回值测试；manager 缓冲满、控制发送失败；真实 PBWS 错 token、旧 generation 与新 drop 后旧 ack 测试 |
| R08 删除别名 | GUI 真实删除回收映射，隐藏投影保留映射；离线恢复依靠完整 LA-ID 集合替换 | `kbrain-sidebar-offline-alias.test.mjs`；增量隐藏/删除与发送拒绝后最新完整集合回归 |
| R09 tombstone 无界 | K-brain 10,000 条/24h 清理推进 floor；共享 store 的 legacy 删除记录达 1,024 条时使旧 workspace 请求失效后回收 | `TestSummaryTombstonePruningRaisesFloor`；2,048 次 legacy 删除后旧请求不能恢复 ghost 的行为回归 |
| R10 冷启动顺序 | Store 惰性初始化完整摘要基线，changes-first 不伪造历史事件 | `TestSummaryChangesFirstInitializesWithoutSyntheticChanges`；初始化、并发写入与严格读取回归 |
| R11 生命周期与迟到 | GUI 单协调器引用计数、Abort、generation；共享 store 拒绝旧列表和旧 mutation；退出释放任务 | 多 owner、dispose、stop/start、source/epoch 切换、迟到 first-page 和分页回归 |
| R12 不完整能力 | GUI/Gateway 仅在完整 v2 路由和 schema 初始化成功后保持健康；故障保留旧轮询并退避重探 | capability 1 不调用 v2；Relay 首次 503 自动恢复；旧端与缺字段测试。真实版本组合另记 |
| R13 多视图投影 | 完整摘要基线存入共享 store；有序增量替换完整行并从缓存校准分页、工作区、置顶与 workdirs | unpin、清空 cwd、250 条基线尾页改名/删除、首页删除补位、展开工作区 move/pin/delete 及位置锁回归 |
| R14 扫描错误 | K-brain 先暂存整轮扫描，全部成功后发布；文件稳定性校验失败有限重试 | `TestSummaryScanFailureDoesNotPublishPartialState`、`TestSummaryColdReadRetriesAnUnstableExternalFile`、外部变更和损坏文件回归 |
| R15 授权投影 | v2 只对现有 Bearer 认证后的同 Store 完整投影开放；不向受限共享链接暴露全量同步 | `TestSessionChangesRejectUnauthorizedAndInvalidInputs`；Gateway 认证和 token 身份校验；不宣称未设计的多用户 ACL |
| R16 精度、权限与预算 | 字符串 uint64；快照/等待者/队列/authority/帧大小有界；Tauri 发布限定 main window 与本地 origin | 大于 2^53、非法值、overflow re-epoch、快照/等待者预算；Rust caller 和 payload 测试；Gateway 100,000 条/64 MiB 与单帧 8 MiB 回归 |

精确命令和结果由 [验证矩阵](verification.md)、[Gateway 验证](gateway-verification.md) 与 K-brain 工作树内的 `docs/plans/2026-10-28-session-sync-verification.md` 记录。K-brain 主检出的用户未提交开发没有纳入这些验证对象。

## 真实客户端场景

以下场景由 Agent 执行，替代原设计的人工操作。HTTP 负载与产品点击分别登记；模块 fixture 不充当真实客户端结果。

| 场景 | 已有证据 | 最终构建剩余验证 |
|---|---|---|
| M01 空闲资源 | 最终final4/current源码5分钟303.817秒与30分钟106轮已终态；K-brain同负载前后列表5/30分钟、WebView根因干预及回收证据 | 旧桌面+两WebUI同数据静态基线、TUI与HTTP短对照汇总中；WebUI真实+132.8MB和GC高水位不能省略 |
| M02 双向元数据 | 最终真实WebUI菜单改名/取消置顶/置顶、桌面改名与三端一致，alerts=0；直连14项亦包含真实控件 | 通过；具体延迟见automation.md/relay-compat.md |
| M03 可见性 | 最终106轮创建含消息/置顶/改名/删除三端DOM一致，实际确认删除后不复活；归档/恢复模块与独立TUI证据 | 可见性变化统计/别名回归通过；完整桌面归档/恢复产品入口若未运行须单列 |
| M04 后台任务 | 实际桌面UI创建每10秒fixture任务、上限1次，实际成功并停用，三端出现结果、桌面点击打开消息正确 | 通过；不是只调用Store保存入口 |
| M05 外部写入 | final4外部kn run与HTTP共用隔离home/cwd，桌面保持可见且无主动rescan，含kn执行到首次观测≤33.3秒 | 通过；包含扫描等待，不混称同进程2秒延迟 |
| M06 多页工作区 | 桌面/WebUI实际展开两个cwd点击更多，10→18/19条、hasMore消失、alerts0；实际移动及250条缓存计数回归 | 通过；跨cwd最后一条删除与并发分页另由集成回归覆盖 |
| M07 并发输入 | 实际桌面改名UI挂起PATCH，另端真实更新到达；pending保本地，拒绝后回最新远端并提示，成功分支确认后无alert | 通过；原fetch恢复，控制故障仅用于隔离fixture |
| M08 重启重连 | 最终Gateway断开时继续改名、恢复后三端一致；实际终止KB后约1.86秒新epoch健康；关闭profile后新浏览器重连补齐 | 通过；原样保留错误token/旧ack/队列缺口集成回归 |
| M09 隐藏恢复 | 最终原生监测：minimize164点/17.972秒始终IsIconic=true，hide162点/17.942秒始终不可见；期间断开desktopCDP、独立HTTP修改、认证WebUI650/653ms更新，恢复后desktopDOM与水位正确 | Windows严格状态已通过；最初IPC权限拒绝/自动前台化样本保留但不作通过。暂停WebUI恢复后补齐，macOS/真实系统睡眠未真机验证 |
| M10 取消重复 | 引用计数/focus/Abort/StrictMode回归、最终106轮重复focus仍单订阅；final4PTY双Ctrl+C取消后继续改名/退出0/resume恢复 | 通过上述范围；自然/GC/退出profile回收分别记录，不由进程存活推断 |
| M11 超时鉴权 | 429/Retry-After、snapshot410、取消/卡住批次超时模块回归；直连真实上游401降级后新generation恢复1558ms，非法cwd拒绝 | 鉴权与恢复通过；任意真实反向代理超时部署不宣称全覆盖，受控HTTP集成覆盖超时契约 |
| M12 版本组合 | 新LA+旧KB真实legacy列表/菜单改名；旧b204LA+final4真实菜单改名；新Gateway+旧KB及cap1各3/3，完整v2直连14/14 | 通过相应场景；初轮旧UI因fixture不存在cwd/model失败，错误日志与修正后结果均保留 |

最终执行步骤、断言、原始日志位置及未覆盖项由 [自动化记录](automation.md) 与独立 Relay 记录补充。本表保留未完成项，不能因为本次免除人工验收而删去场景。

## 本轮增量回归与资源问题

修复前，桌面在每个非空增量批次重建完整摘要列表并发送 `reset`。30 分钟真实循环虽然 93 次操作全部同步成功，但 WebView renderer 私有内存从约 364 MB 增到 1,139 MB；强制 GC 后仍约 1,088 MB。随后单次 CDP 调用内直接执行 100 轮后端操作、不做逐轮 DOM 读取，仍增长约 86 MB，因此不能归因于页面断言频率，也不能宣称端到端资源目标已经满足。

当前修复把初始化/恢复快照与实时变化回调分开，只有变化的摘要重新转换，实时事件使用 `upsert`/`delete` 和独立 workdirs 更新。250 条基线只变化一条时，转换次数只增加一次，其余条目引用稳定。共享 store 接受完整行语义，清除未设置的旧字段，保留本地操作覆盖和显式位置锁，并从完整缓存校准分页与计数。发布者在等待 Gateway 状态前同时取得会话集合与 workdirs，避免跨切点快照。

独立回归共 16 项通过，连同 publication 和 offline-alias 共 21 项通过。首轮失败和最终结果分别保存在 `%TEMP%/liveagent-session-sync-incremental-review-first.log` 与 `%TEMP%/liveagent-session-sync-incremental-review-final.log`。这些证明变化处理的正确性及转换范围；内存增长是否消除必须以冻结后的真实运行测量为准。
