# 会话列表同步与资源优化实施记录

## 基线与范围

- LiveAgent：`upstream/v2-kbrian`，`b2049905a89462e766b4aa7d6aa76b3a4cbef144`，当前工作区任务分支 `feat-session-sync-resources`。
- K-brain：`origin/main`，`0dad9fdec4adbb2a6324974edc1d610c69b2a79b`，独立工作树 `D:/Documents/Projects/Go/K-brain-worktrees/session-sync-resources`，分支 `feat/session-sync-resources`。主检出已有用户改动保持原样。
- 设计输入：`docs/design/2026-10-27-session-change-sync.md`；问题与证据：`docs/design/2026-10-28-session-change-sync-review.md`。
- 用户本次明确免除人工验收；GUI/WebUI/TUI 场景由 Agent 自动执行并保存证据，不把“已启动”当作行为验证。
- 对应问题：[Stack-Cairn/LiveAgent#1070](https://github.com/Stack-Cairn/LiveAgent/issues/1070)。实现PR：[LiveAgent#1071](https://github.com/Stack-Cairn/LiveAgent/pull/1071)。跨仓依赖：[K-brain#60](https://github.com/Stack-Cairn/K-brain/pull/60)，生产提交`482fd2d71fd9a85777e8f7e650379c39b6712684`、CI/文档head`a0cbc8f6f4276597efce4cabd95b8bdc02ddce63`；PR #60 已合入为 `51c827d3d56533550e67bc4f78ff7673fa7bd9a3`，用户授权发布的 `v0.107.6-beta.23` 构建已全部成功；当前 lock 更新到该 release 的真实下载地址与 SHA-256，下载和 LA CI 结果见 progress.md。

## 实施顺序

1. K-brain 惰性摘要缓存、原子扫描、一致快照和 changes v2；HTTP 任务按订阅生命周期创建，不使独立 TUI 增加后台轮询。
2. 桌面同步协调器和稳定映射；共享 sidebar 的权威 reset、本地操作覆盖、动态 reconcile。
3. Gateway 直连与桌面转发、广播缺口锁存、浏览器完整集合恢复和旧版本降级。
4. 两仓完整测试、真实客户端自动化、同负载 CPU/内存/I/O 对照与持续资源回收观察。
5. 独立对抗性复核、契约消费者检查、任务提交及 required CI 收敛；不自动合并或正式发布。

## 风险与验证责任

| 风险 | 验证 |
|---|---|
| 跨页或分批丢失 | 不可变快照、R→H 追赶、next_since、分页中写入、reset/floor 回归 |
| 本地操作被旧事件覆盖 | store 真实模块测试与界面延迟/失败场景 |
| 多端广播丢失 | 真实 WS、队列满、断线、代际和错误 ack 回归 |
| 优化影响独立 TUI | 无 HTTP 订阅的 TUI/kn/ACP 启动、操作、退出及同目录并发测试 |
| 用内存换 CPU 或资源泄漏 | 缓存/快照/队列容量、5 分钟空闲、30 分钟循环、关闭后回收 |
| 构建对象错误 | 两仓 SHA、开发 sidecar 来源与哈希、同工作区 Tauri 构建记录 |

## 先失败回归

实施前执行：

```text
node --test --test-name-pattern='remote events preserve|authoritative sync reset|healthy event sync' crates/agent-gateway/web/test/sidebar-store.test.mjs
```

基线结果：3 个用例全部失败。远端 upsert 把在途标题 `my title` 覆盖为 `remote title`；reset 未删除旧别名；健康推送状态下仍重复发列表请求（45ms 观察中列表调用从 1 增为 3）。修复后，共享 store 的23个场景全部通过；随后新增source切换时拒绝迟到mutation的回归也通过。

映射先失败回归：存储写入失败时，同一后端 ID 连续 ensure 得到不同 UUID。修复后同进程身份稳定、按 native storageId 隔离数据根、旧 managed scope 仅迁移到一个已识别根，248条批处理只持久化一次，重复列表不再重写。

## 契约地图

消费者扫描涵盖 `session_changes`、`next_since`、`sync_revision`、`sourceIdentity`、`gateway_publish_history_sync_v2`、`HistorySyncStatus` 与 `HistoryResyncAck` 的生产者、调用者和测试。完整结果保存在本机临时日志目录，不包含凭据；下表记录需要共同遵守的契约，不依赖本机技能脚本才能阅读或复核。

| 生产者 | 消费者 | 实施与验证 |
|---|---|---|
| K-brain snapshots/changes v2 | 桌面client/sessionSync、Gateway Relay | 字符串uint64校验、固定R/H追赶、分页、reset；真实HTTP 601条分批和backend mutation联调已通过，更多后端回归由K-brain记录 |
| K-brain sync_epoch/sync_revision | 桌面history确认、本地mutation覆盖 | 等待同步达到确认水位；字段缺失进入恢复，不重放不确定写请求；流中已移除会话不能回退到操作响应旧摘要 |
| 桌面完整远端集合 | GUI sidebar adapter、共享store | reset保草稿/在途覆盖，清理旧别名和陈旧分页请求；getReconcileIntervalMs随健康动态配置 |
| 桌面gateway_publish_history_sync_v2 | Rust发布者、Gateway manager | 独立结果、source/generation/seq、完整权威集和事件；Native caller限制与Go恢复测试见各测试日志 |
| Gateway HistorySyncStatus/Snapshot/ResyncAck | PBWS、WebUI socket/adapter、shared store | 丢弃锁存、token/seq确认、分页恢复与有界buffer；旧端保旧轮询。完整真实WS与UI结果待后续记录 |
| Store摘要缓存 | HTTP、TUI、ACP、kn run | 存储格式不变；无HTTP订阅时不启用扫描/通知任务；独立TUI和ACP实际验证由自动化记录 |

## 优先级与并发约束

| 叠加规则 | 处理顺序与证据 |
|---|---|
| 后端身份切换、generation与迟到响应 | source变化使旧mutation失效；同源reset保留在途覆盖。旧list/poll响应须通过代际检查 |
| 本地待完成改名/置顶/移动/删除 vs 远端事件 | 远端事实单独记录，本地覆盖先显示；操作失败恢复最新远端，而非操作前副本 |
| 已确认写入 vs 网络失败/重试 | 只重试安全读；不确定写结果用快照恢复；元数据确认水位后才解除覆盖 |
| 独立TUI vs HTTP同步 | 文件锁仍是共享存储串行边界，HTTP等待不能持锁；无订阅不启动HTTP扫描任务 |
| 鉴权与新能力 | 先鉴权再探测和调用；401/403不得通过旧模式绕过；新API不完整保留旧轮询和错误提示 |
| 运行/模型权限/路由策略 | 本任务不改变模型授权与routing优先级；通过现有跨消费者回归检查，不能将权限基线失败静默归为通过 |

## 当前验证状态

整个任务的最新状态、阶段历史、证据和下一步统一记录在 [进展留痕](progress.md)，每次阶段性结果后更新。

正在实施。A01–A22、自动执行的 M01–M12、TUI 兼容、性能与全量测试结果将分别记录；本文未列结果的项目不代表通过。性能与实际工具路径见 [自动化记录](automation.md)。

Gateway、Rust 桥接和 WebUI 恢复协议的实现边界、自动化断言及已知限制见 [Gateway 验证记录](gateway-verification.md)。

实现后的运行契约见 [会话摘要同步](../../architecture/session-sync.md)；评审问题和真实场景的对应关系见 [需求映射](requirements.md)。
