# K-brain 客户端传输与恢复边界

## 状态所有者

参考 ZCode 的 UI → 服务代理 → Host → CLI 分层，但保留本项目 HTTP/SSE 协议。K-brain 持有已接受的 run、历史、工具与业务状态；Tauri 持有本地子进程；前端持有连接与显示投影，不构造供应商请求。

所有 GUI K-brain HTTP 适配器通过 `fetchKBrain` 发送请求。bootstrap 的健康探测是独立连接初始化边界。显式 endpoint 客户端与默认桌面托管连接必须隔离，不能将本地凭据发到另一个后端。

## 本轮行为

1. prompt、trajectory、hooks、usage 适配器复用传输层；默认聊天客户端不捕获启动时的地址和 token。
2. 连接恢复为单次共享操作；每个等待者可独立取消，不取消其他等待者的恢复。已取消请求不得继续重试或执行写入。
3. 传输错误携带稳定 code、cause；HTTP 状态、协议校验、业务冲突不是网络恢复信号。重连后第二次失败不无限重试。
4. SSE 重新订阅使用已经应用的 after_seq，恢复期间不创建新 run。主动取消或消费端错误时取消 reader，避免旧订阅泄漏。
5. `startRun` 响应丢失时，按原 client_request_id 查询后端持久化的接收记录；找到即恢复相同 run，未找到则报告原错误。禁止生成新请求 ID 自动重放写入。查询接口不初始化模型、不启动执行。
6. 本地会话映射与迁移缓存使用稳定的托管 scope；端口轮换不是新的数据存储。显式远程 endpoint 保持按地址隔离。

```text
UI → typed client → transport → K-brain POST runs
                                  │ 执行前保存接收记录
       接收响应丢失                 │
UI ← typed client → transport → GET runs?client_request_id=原ID
       同一个 run_id/accepted_seq  ←┘
UI → SSE events?after_seq=已应用序号 → 同一会话事件日志
```

## 验收

- 后端换端口后，既有 client 的读取及订阅使用新地址和凭据。
- 两个并发读取共享重连；其中一个取消不影响另一个，取消者不会重发。
- 普通 POST/PUT 失败不自动重放；丢失 run ACK 仅查询原 ID，一次模型执行。
- 相同请求 ID 不同内容仍由后端返回冲突。
- 健康探测、明确 endpoint、浏览器连接不隐式切到桌面本地实例。
- 日程、Cron、Memory、MCP、Skills、设置、聊天/历史相关页面进行真实桌面回归。

## 非目标

本轮不改成 stdio/MessagePort，不实现通用命令队列、跨设备 owner/lease、全量 V4 snapshot/delta 协议，不保证进程被杀后继续原模型调用；现有 run 日志与中断恢复仍由 K-brain 决定。

## 2026-10-06 验证

- K-brain `go test -p 1 ./...`、backend race 和 vet 通过；接收记录可跨服务重启查询，查询不初始化模型，隔离持久化故障的运行时。
- LiveAgent 前端全量 2960 项：2959 通过、1 跳过、0 失败；GUI TypeScript 通过。恢复测试 11 项覆盖并发、取消、显式地址隔离、写入不重放、ACK 丢失和 SSE 游标续订。
- 真实 runKBrainTurn → 新编译 K-brain → 本地 Anthropic fixture → Read 工具，故意丢弃 POST runs 响应后通过 GET 找回同一 run；断言一个 POST、一个查询、无重复工具执行。不是外部供应商验收。脚本 `/private/tmp/desk/transport-live.mjs`，日志 `/tmp/la-transport-live.log`。
- 真实 WKWebView 终止 sidecar 并观察新端口恢复：日程与 Cron/Memory/MCP/Skills 正常，1440/480 视口通过；日程 26 项、历史命令 22/22。日志 `/tmp/la-transport-{browser,planning,history}.log`。
- 前端全量日志 `/tmp/la-transport-full-frontend-final.log`；Go 全量 `/tmp/kbrain-transport-full.log`；race `/tmp/kbrain-transport-tests-final.log`。
