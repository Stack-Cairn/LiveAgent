# 会话列表同步验证矩阵

> 状态：最终真实客户端与5/30分钟采样已完成，跨仓PR已创建、CI跟进中。用户明确免除人工验收，实际场景由Agent自动执行。部分平台/旧三端基线限制保留，下表只把有可复核证据的检查列为通过。

## 变更对象

LiveAgent 基线为 `upstream/v2-kbrian` 的 `b2049905a89462e766b4aa7d6aa76b3a4cbef144`，K-brain 基线为 `origin/main` 的 `0dad9fdec4adbb2a6324974edc1d610c69b2a79b`。开发 sidecar 来自 K-brain 任务工作树，不是正式发布；本次没有伪造下载版本、替换发布锁或运行发布流程。

两份此前未跟踪的设计/评审文档作为输入保留。K-brain 主检出的用户改动保持原样；任务修改在单独的 K-brain 工作树完成。LiveAgent 实施始终在当前工作区，性能基线另从 Git 对象导出只读样本，未在样本中实施任务修改。

## 设计自动化场景

| ID | 实际测试或证据 | 当前结果 |
|---|---|---|
| A01 热缓存 | K-brain `TestSummaryCacheAvoidsTranscriptReadsWhenFilesAreUnchanged`：cold=8、warm=0；248会话/251MiB的5/30分钟对照 | 计数回归通过；性能原始数据见 automation.md |
| A02 写入入口 | K-brain write统一更新、delete移除、元数据/任务/导入/检查点既有测试及消费者地图 | K-brain报告；最终按测试名核对，不以代码入口推测代替结果 |
| A03 返回值隔离 | 非空Tags/SubUsage/ModelUsage；深拷贝丢usage曾先失败，修后通过 | 通过 |
| A04 外部写入与扫描失败 | 外部Store改名/删除，失败扫描不发布半份状态，不稳定读取重试；scanner失败唤醒 | K-brain新增回归通过；真实跨进程场景由 automation.md记录 |
| A05 冷启动 | changes-first不造历史事件，摘要初始化完整 | K-brain新增回归通过 |
| A06 跨页快照 | K-brain真实HTTP快照；GUI真实HTTP fixture分批1,201条，从R追到H，不从head跳过条目 | 通过 |
| A07 快照失效 | K-brain epoch/floor/TTL及410；Gateway恢复token60秒与旧ack拒绝 | 后端/WS回归通过；容量与TTL详见两仓报告 |
| A08 快照资源 | K-brain每身份4份/64MiB；Gateway单页500/8MiB、权威集合100000条/64MiB，增量累计预算 | 回归通过；大规模压测结果另列 |
| A09 增量分批 | `kbrain-session-sync.test.mjs`真实HTTP 1,201条（500/500/201）；K-brain新增1,201条三批并在翻批期间修改已交付/未交付ID、创建/删除；Relay校验 | 通过 |
| A10 游标边界 | 字符串uint64、大于2^53/越界拒绝、MaxUint64重建epoch；Gateway安全序号 | 回归通过 |
| A11 合并/超时 | K-brain固定窗口50次写入最多3次waiter循环；GUI卡住more批20ms超时；空批不推进 | 通过 |
| A12 等待竞态 | K-brain取消、waiter上限、rescan限频、追平后不忙循环；GUI重复focus与429保持基线 | 新增回归通过 |
| A13 删除回收 | K-brain floor、即时tombstone修剪；桌面离线delete别名回收，listed=false保身份 | 新增回归通过 |
| A14 投影等价 | 后端pinned/workdirs；shared store reset校准workspace计数，Gateway完整集重建workdirs | 相关回归通过；真实多工作区行为另记 |
| A15 ID幂等 | `kbrain-managed-mapping.test.mjs`：存储写失败身份稳定、数据根隔离、旧scope迁移、248条只写一次、删除不能从旧scope复活 | 4个回归通过 |
| A16 乐观冲突 | sidebar-store在途事件保护、失败用最新remote、source代际变化和stop/start迟到响应；GUI确认水位；WebUI订阅事件确认、一次合并恢复 | 新增回归通过；真实界面交互仍单独记录 |
| A17 代际/迟到 | 多owner唯一循环、dispose旧snapshot不发布、focus不重快照、source/epoch和Gateway session切换 | 新增回归通过 |
| A18 断线/旧版本 | capability1不调用v2路由；Relay首次health503后自动恢复；WebUI旧协议不强行resync；rescan429遵守Retry-After | 新增回归通过；完整版本组合见真实场景 |
| A19 广播缺口 | manager128队列drop锁存、控制发送失败恢复、真实WS错误token/旧代/正确ack；WebUI缓冲溢出与回放缺口不提交部分集 | 新增Go/WS/WebUI回归通过 |
| A20 心跳/计数 | WebUI新鲜度超时300秒→60秒、取消重试、完整集/工作目录校准 | WebUI模块回归通过；真机隐藏窗口见 automation.md |
| A21 Relay | 真实HTTP snapshot/changes/取消、R→H、畸形批拒绝、首次能力探测失败重试 | Gateway新增回归通过 |
| A22 权限 | K-brain Bearer/非法参数；Tauri main+local origin限制及payload预算；Gateway WS认证与ack身份 | 相关回归通过；未设计多用户ACL，不宣称跨租户能力 |

## 先失败、修复与独立复核

以下缺陷均留有回归，不以“代码看起来正确”代替证明：

- store：在途改名被旧事件覆盖、reset残留旧别名、健康推送仍定时HTTP读列表，基线3/3失败，修后通过。
- 映射：localStorage写失败时ensure每次生成UUID；迁移managed映射删除后旧namespace将其复活，均先失败后修复。
- 轮询：焦点恢复全量重建、429重建快照、more=false掩盖head缺口、more批卡住，独立审查新增回归先失败，修后通过。
- 生命周期：source替换及stop/start后旧mutation仍写入当前store；跨epoch仍用旧Gateway发布generation，先失败后修复。
- 离线资源：未配置Gateway时删除别名无限保留；修后以明确delete回收，archive/空会话移除仍保身份，Gateway恢复用完整集合清旧行。
- 后端：cloneMeta清空usage map、追平后longpoll零延时忙循环、通知未真正合并、纯TUI创建HTTP任务，均已在K-brain侧补回归并修复。
- Gateway：重复序号不应误判缺口；跳号后不应提供不完整权威集；累计增量必须遵守预算；旧ack不能清新drop。Go/WS/WebUI模块用实际fixture覆盖。
- 真机发布边界：K-brain省略false的pinned字段，桌面未发送Rust必填isPinned使完整快照被拒绝。真实invoke返回缺字段错误；发布边界显式补齐isPinned/isShared/messageCount，新增回归先失败后通过，真机needsGatewaySnapshot变为false。
- 新旧广播共存：WebUI元数据动作仍发送旧即时历史广播，不能将已激活的完整v2权威集切成legacy generation。manager回归先复现污染，再忽略这类重复legacy事件，等待v2流确认；旧模式保留原广播行为。最终真实操作及后续同步由自动化重新验证。

## 本地已运行命令

| 检查 | 结果与限制 |
|---|---|
| GUI build | 通过；Vite已有大chunk警告，不等于运行内存结论 |
| GUI/共享UI typecheck | 最终通过；CI Shared UI Boundaries亦通过 |
| GUI lint | Windows全目录最终219个行尾/格式诊断（首轮222），固定b204的App.tsx原始LF也复现格式问题；最终所有任务生产TS/TSX按LF/error-on-warnings严格检查通过，未全仓重排格式；Linux CI GUI lint通过 |
| Node全量预检 | 565个文件、7批全部运行：4045项，4036通过、8失败、1跳过。失败已分为 task backend cargo smoke、native file-drop routing、permission modes、planning lazy migration、trajectory HTTP 两项及其余环境 fixture；没有把这些结果写成全量通过。GUI 单目录复跑的 656 项为 653通过、3失败（permission-modes 的 full-access/always 及父测试），失败来自默认锁定旧 K-brain 能力；使用最终开发构建且修正能力门槛后，新协议相关 focused 20/20 通过。 |
| Node工作目录复跑 | native-file-drop-routing、planning-lazy-migration在GUI目录复跑13/13通过；说明原根目录runner不适用于其相对路径读取 |
| Node Bash相关基线对照 | 未修改K-brain二进制执行permission/trajectory：17项，12通过、5失败；full-access、always及两条trajectory路径复现，与任务首轮一致 |
| Rust check --tests | 通过，已有unused警告保留 |
| Rust完整lib tests | 当前任务源码：1134 tests，1107通过、23失败、4忽略；失败均为环境相关的 hook/bash、Windows worktree 路径、sandbox/terminal 与 MSYS 隔离。固定 b204 只读 archive 已逐字节核对 2,674 个文件，并在独立临时 target 编译运行：1131 tests，1104通过、23失败、4忽略；失败名称集合与任务源码完全相同。基线日志 `%TEMP%/liveagent-session-sync-rust-baseline-closure/full-lib-test.log`，源码核对 `%TEMP%/liveagent-session-sync-rust-baseline-closure/baseline-source-verification.json`。因此 23 项不能归因于本次改动；本次新增 Rust 测试通过。 |
| Gateway Go全量 | 最终全包通过，固定Go1.25/golangci-lint2.12.2+干净cache为0issues，PBWS测试copylocks已修后复测；Linux CI Gateway通过 |
| WebUI全量 | 最终119文件275/275通过；Linux CI build/lint/tests通过 |
| 自动化harness | 最终13/13通过；只证明harness基础行为，不替代真实客户端场景 |
| Mirror/shared boundaries | `node scripts/check-mirror.mjs`通过：复用全仓UI边界检查、检查两端共享alias及sidebar单一实现，无空脚本 |
| Diff卫生 | `git diff --check`通过；未跟踪文件在暂存前另做实际内容检查 |

最终前端重跑（K-brain final4 开发覆盖）：标准 `pnpm --dir crates/agent-gui test:frontend` 在第 2 批遇到基线失败后按 runner 设计停止；随后使用原 runner 的 discovery 和 split 函数逐一运行全部 6 批、478 文件，共 3,534 tests，3,528 通过、5 失败、1 跳过。5 项为 `permission-modes-backend` 的 full-access/always 及其父测试、`kbrain-trajectory` 的两条真实 HTTP 用例，固定 0dad 基线后端再次复现同样失败（合计 17 项中 12 通过、5 失败）。原因涉及 Windows Bash/printf 环境，不能把最终开发后端的失败归因为“默认锁旧能力”。日志为 `%TEMP%/liveagent-session-sync-final4-frontend-batch-{1..6}.log`、`...-frontend-baseline-repro.log` 和 `...-trajectory-baseline-repro.log`。WebUI 最终 `pnpm test` 为 119 文件、275/275，通过；日志 `%TEMP%/liveagent-session-sync-web-final4.log`。

原始日志保存在任务专用临时目录；正式提交中只保留可复核命令、数字与脱敏摘要，不提交用户数据、token、完整进程命令行或本机profile。

## 真实场景与完成门槛

M01–M12按设计转为Agent自动执行。真实UI使用实际Tauri WebView/CDP和两个WebUI，TUI使用PTY，模型走确定性的本地fixture。直接通过HTTP写入并观察三端DOM是同步负载证据，不能代替在WebUI输入、点击改名/置顶等产品流程；两者分别记录。

前两次长循环未完成，后续93轮虽然功能正确但发现React DEV timeline资源回归，均保留失败记录。最终final4+当前生产源码+DEV预算修复，正式5分钟静态完成，30分钟106/106轮实际三端创建/置顶/改名/删除通过。桌面renderer预热后形成平台，WebUI真实+132.8MB、GC与profile退出回收证据及TUI冷峰取舍一并记录，不声称零增长。没有result.json的早期尝试不计通过。

实际菜单、分页、受控改名延迟成功/失败、Gateway/K-brain重连、定时任务、外部kn、final4PTY取消与恢复、空库初始化及新旧桌面组合已执行，见`automation.md`和`requirements.md`逐项结果。旧三端静态未达到相同视图ready、macOS/真实系统休眠未验证，Windows严格最小化全过程的范围按最新自动化记录判断；不把这些缺口写成通过，也不要求用户代做人工验收。

已创建K-brain PR#60（main）和LiveAgent Draft PR#1071（v2-kbrian）。K-brain运行时生产提交482fd2d、CI修复b4f5508首轮三平台全绿，文档head继续跟进；LiveAgent运行时提交80f570e8、CI门禁修复fddd9372，Gateway/WebUI/Docker/Shared UI/Diff通过，其他required检查仍监测。正式锁仍指向旧发布后端，PR明确跨仓尚未发布依赖；不自动合并、不伪造发布产物。最新状态由`progress.md`持续留痕。
