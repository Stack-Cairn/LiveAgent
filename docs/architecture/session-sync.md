# 会话摘要同步

本文描述 K-brain 会话摘要到桌面、Gateway 和 WebUI 的同步契约。Protobuf 单一事实源为 `crates/agent-gateway/proto/v2/gateway.proto` 与 `gateway_ws.proto`；K-brain HTTP 契约由其 `docs/liveagent-backend.md` 维护。同步只处理列表摘要，不把完整 transcript 存入同步缓存。

## 协商与旧版兼容

K-brain `/v1/health` 的 `capabilities.session_changes` 必须为数字且至少为 2。客户端还须成功取得固定快照、全部分页和有效 changes 批次，才能报告同步健康。仅有 capability 1、缺字段、缺路由、鉴权或传输失败，都不能据此关闭原有轮询。

桌面同一后端身份只运行一个协调器，消费者使用引用计数。最后一个消费者退出时，取消长轮询、清理退避/心跳/焦点计时器与监听器。后端身份或 epoch 改变，旧 generation 的结果不能提交到新集合。focus/visible 合并 rescan，取消当前等待后按同一游标继续，不反复创建完整快照。

健康桌面关闭周期会话列表 reconcile，workdirs 保留 300 秒校准。健康 WebUI 保留 300 秒列表校准，故障时恢复 60 秒。生产者状态超过 45 秒未刷新时，WebSocket 仍连接也不能视为健康。

## K-brain 快照与变化

| 请求 | 关键行为 |
|---|---|
| `POST /v1/sessions/snapshots` | 创建固定 epoch/revision 的不可变摘要集合，返回 token、total_count、workdirs |
| `GET /v1/sessions/snapshots/{id}?offset=N&limit=500` | 返回同一切点分页；空页仍返回 `sessions: []`；`next_offset: null` 表示结束 |
| `DELETE /v1/sessions/snapshots/{id}` | 幂等释放 token；客户端释放失败仍受服务端 TTL 约束 |
| `GET /v1/sessions/changes?epoch=E&since=R&wait=30&rescan=0` | 返回有序变化、`head_revision`、`next_since`、`more` 或明确 reset |
| `GET /v1/sessions/workdirs` | 返回同一摘要投影的工作目录统计 |

revision 使用十进制 uint64 字符串，不经 JavaScript Number 比较。`head_revision` 是服务端当时的 head，`next_since` 才是这批实际交付水位。客户端只按 `next_since` 前进，空批保持原游标，`more=true` 用 `wait=0` 立即追赶。完整初始化先取得所有固定 R 页，再追到首次变化响应的固定 H；失败丢弃临时集合，不能发布半份基线。

元数据写入和删除响应增加 `sync_epoch`、`sync_revision`。桌面在同步达到水位后解除本地操作覆盖；丢失或无效水位触发恢复，不能自动重放结果不确定的写请求。其他消费者仍可忽略这些新增字段，继续旧列表操作。

K-brain 保持严格解析、文件锁、排序和过滤契约。热缓存允许目录枚举和 stat，文件未变时不完整读取 transcript。外部进程变化依靠按需共享扫描发现；它与同进程写入的同步延迟分别测量。没有 HTTP 订阅的独立 TUI、`kn run`、ACP 不因本功能启动常驻同步轮询。

## 桌面投影与身份

初始化、epoch 切换和恢复发送完整 `reset`；正常变化只投影改变的条目，发送 `upsert`、`delete` 和独立 workdirs 更新。所有 row 事件在发布前已经过 schema、身份、顺序和 revision 校验。

LA conversation ID 与后端 ID 映射在内存与持久化中保持幂等，按实际数据根隔离。不可写的持久存储不会导致同进程反复生成新 UUID。未知 delete 不创建别名；`listed=false` 只移除可见投影，保留身份供恢复；真实删除释放映射。Gateway 断线后用完整 LA-ID 集合替换移除旧行，不依赖无限保留删除别名。

共享 sidebar store 同时保存完整远端摘要缓存和当前已加载前缀。有序增量采用完整行语义，所以取消置顶和清空可选字段不会保留旧值。完整缓存负责全局/当前 scope 数量、分页边界、删除补位和展开工作区统计。旧列表与分页请求在新权威事件之后返回时不能覆盖新值。

本地乐观操作与最新远端事实分开：在途改名、移动、置顶和删除不被旧事件覆盖；失败恢复最近远端值。位置锁只保护排序时间，不保留过期标题、置顶或 cwd。source 切换后，旧操作响应不能把原会话带回新 store。

## 桌面到 Gateway

受信 main window 调用 `gateway_publish_history_sync_v2`，输入采用 camelCase：

```json
{
  "input": {
    "kind": "status",
    "sourceId": "kbrain:fixture-store",
    "generation": "fixture-generation",
    "deliverySeq": 12,
    "available": true
  }
}
```

`kind` 另可为 `snapshot` 或 `event`。snapshot 携带完整 conversations/workdirs 和当前 deliverySeq；event 携带 upsert/delete。所有摘要显式提供 Rust 必需的 `messageCount`、`isPinned` 和 `isShared`。源在一个发布循环取得同一切点的会话集合与 workdirs，等待 Gateway 状态不能把两者拆成不同切点。

返回 `{accepted, needsResync}` 只说明交给当前桌面出站传输的结果，不代表 Gateway manager 或浏览器确认。桌面比较 Gateway agentId 与连接身份；重连、发送失败或序号缺口触发完整快照。待发数据按最终状态合并，保留受容量限制的完整集合，不无限积累发送任务。

Rust 限定 main window 和本地 Tauri/asset/loopback origin，拒绝共享窗口与远程页。发布者验证 ID、重复项、JavaScript 安全序号、条目和编码大小。Gateway 不把重复 legacy 元数据广播切换成新 generation，也不能用旧即时通知提前确认 v2 mutation。

## Gateway 到浏览器

| 消息 | 语义 |
|---|---|
| `HistorySyncEvent` | `source_id`、`generation`、`delivery_seq` 及完整 upsert/delete |
| `HistorySyncStatus` | 当前源、generation、latest_delivery_seq、available、needs_resync 与可选 resync_token |
| `HistorySyncSnapshot` | 固定 source/generation/cut_delivery_seq 的分页权威集合、workdirs 和连接内 token |
| `HistoryResyncRequest` | 使用 token 取得固定快照的下一页 |
| `HistoryResyncAck` | 浏览器声明已应用同 token 的 source/generation/applied_delivery_seq |

Gateway manager 在同一临界区更新完整 authority 和广播序号。重复序号幂等；跳号使 authority 无效，不提供半份集合。浏览器队列满的 drop 分支在事件队列外锁存恢复义务，控制通道通知不能静默丢弃；控制发送也失败时关闭连接，新连接必须恢复。

浏览器先暂存全部快照页，再按序回放切点后的缓冲事件，最后原子替换并 ack。期间有新缺口、溢出、旧 generation 或无效 token 时放弃临时状态重新恢复。只有匹配当前连接、token、generation 和缺口水位的 ack 才解除恢复义务，旧 ack 不能确认新的 drop。

WebUI 操作优先等待同 generation 的订阅投影确认。超时后至多进行一次与并发操作共享的完整恢复；字段不一致不能仅因时间戳相同就假报成功。旧 Gateway 未协商同步时仍用原 unary 行为。

## Gateway 直连 K-brain

Relay 共用一个上游变化循环，不按浏览器数量增加 K-brain 长轮询。初始化同样遵循固定快照和有限追赶，重启/鉴权/路由故障使用退避、失效状态和恢复。

直连 history list/get/rename/pin/set_cwd/delete 都通过 K-brain。cwd 的合法性继续遵循后端契约；拒绝的移动不能改变权威集合。健康订阅下，删除 unary 不提前丢掉广播所需的原 alias；有序 delete 交接后回收。订阅失败或删除别名达到预算时，先使 authority 不可用，再释放并重建快照。没有同步能力的旧后端不长期保存待确认删除别名。

## 容量与回收

| 资源 | 当前限制与回收 |
|---|---|
| K-brain HTTP 快照 | TTL 60 秒；在途与已保存共 4 份、保存摘要编码总量 64 MiB；同时 1 个 builder，构建前预约，失败/取消释放；关闭取消 builder 并拒绝迟到登记 |
| K-brain tombstone | 10,000 条或 24 小时；裁剪推进 min_since，低于 floor 必须 reset |
| K-brain 外部扫描 | 按 HTTP 同步租约运行，正常 30 秒扫描，租约约 90 秒；结束后释放任务与 journal |
| Gateway authority | 最多 100,000 条、64 MiB；超限显式失效，不能静默裁剪 |
| 浏览器恢复页 | 最多 500 条，编码后单帧最多 8 MiB；token 60 秒 TTL |
| 浏览器事件缓冲 | 最多 10,000 条；超限丢弃临时恢复状态重建 |
| manager 普通事件队列 | 128 项；满时独立锁存恢复，控制失败断开连接 |
| Relay 待删除 alias | 最多 10,000；超限先失效 authority 再清理与恢复 |
| sidebar legacy 删除记录 | 1,024 条后使旧 workspace 请求失效并清理；权威增量直接回收已确认 ID |

这些是不同层的限制，不能用扩大另一层缓存替代正确恢复。详细测试、真实客户端结果、基线失败与性能取舍见 `docs/plans/2026-10-28-session-sync/`。

## 开发模式性能轨迹

React 19 DEV 会把组件 props diff 与调度记录留在 User Timing 中；高频侧栏变化可让 native PerformanceMeasure 持续增加，即使 JS heap、DOM 与 listener 已回收。两宿主只在 DEV 安装共享预算 observer：超过 2,000 条 React 记录后清理 React 独占名称，保留应用 measure/mark 和同名应用记录，HMR 时释放 observer。生产模式不安装这项开发诊断管理。资源报告分别记录 DEV 与生产构建，不能把模式差异当作同负载优化数字。

## 发布与权限边界

新协议仅适用于现有认证后的同 Store 全量投影，不是多用户 ACL。受限共享链接与未认证调用不能取得全量摘要、cwd 或同步发布能力。

开发联调可以显式覆盖本地 K-brain artifact，并记录源码 manifest 和二进制哈希。正式 `kbrain.lock.json` 只能引用真实可用的发布产物。跨仓 PR 必须说明 K-brain 提交/发布依赖，不能把开发 override 当作已发布组合。
