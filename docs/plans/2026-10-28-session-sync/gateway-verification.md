# Gateway 会话同步实现与验证

## 范围与契约

本记录覆盖桌面 WebView → Tauri/Rust → Gateway → WebUI，以及 Gateway 直连 K-brain 的会话列表同步。生产代码基于 LiveAgent `upstream/v2-kbrian` 的 `b2049905a89462e766b4aa7d6aa76b3a4cbef144` 实施。

新增线协议只做加法：

- `HistorySyncEvent` 增加 `source_id`、`generation`、`delivery_seq`。
- 桌面发送 `HistorySyncStatus`、`HistorySyncSnapshot` 和增量事件。Gateway 在同一把锁内维护每个 Agent 的当前权威集合；增量必须连续，重复序号幂等，跳号使权威集合失效，等待完整快照。
- 浏览器收到 `needs_resync` 后，使用一次性 `resync_token` 分页读取固定切点快照；每页最多 500 条、单帧不超过 8 MiB。完整集合在 Gateway 中最多 100,000 条、序列化摘要总量最多 64 MiB。
- 浏览器完成快照和切点后事件回放后发送 `HistoryResyncAck`。token、source、generation、切点或 60 秒 TTL 任一不匹配都不能清除恢复义务；新 drop 不能被旧 ack 清除。
- WebUI 增量缓冲最多 10,000 条。缓冲溢出、序号缺口、状态超过 45 秒未刷新或恢复失败时，不提交部分集合，并退回 60 秒轮询。健康时保留 300 秒权威校准。
- Gateway 直连模式先完成 K-brain 快照 R 和有限追赶 H，再发布初始集合；`more=true` 用 `wait=0` 立即续传。每批严格校验 epoch、字符串 revision、顺序、head/next、kind 和摘要身份。

Tauri 命令 `gateway_publish_history_sync_v2` 使用 camelCase 输入：`kind`、`sourceId`、`generation`、`deliverySeq`，以及相应的 `available`、`conversations`、`workdirs` 或 `event`。命令只接受 `main` window 和 Tauri/asset/loopback origin，拒绝共享窗口和远程页面；ID、序号、快照数量和编码大小也在入队前校验。

返回值 `{accepted, needsResync}` 只表示当前桌面传输已接收或需要恢复，**不是 Gateway manager 或任一浏览器已确认**。GUI 每次发布前比较 Gateway `agentId + sessionId/connectedSince`，连接代际变化时强制发送完整快照；WebUI 的 manager 接管与浏览器确认由 resync token/ack 独立完成。

## 恢复与资源边界

| 边界 | 行为 |
|---|---|
| manager 事件订阅 128 条缓冲满 | 不静默丢失：独立锁存 `(subscriber, agent)` 恢复义务，并通过控制通道发送 `needs_resync` |
| 控制通道也无法发送 | 关闭浏览器连接；新连接默认需要权威快照 |
| 单个浏览器恢复 token | 60 秒 TTL；固定 source/generation/cut；分页期间使用连接内不可变快照 |
| WebUI 增量缓冲 | 10,000 条；超限清空临时数据并重新恢复，不提交部分 reset |
| manager 权威集合 | 100,000 会话、64 MiB 摘要；snapshot 与每次 upsert 都按累计大小检查，超限使 authority 不可用并触发恢复，不静默裁剪 |
| WebSocket 快照页 | 最多 500 条；根据 protobuf 编码大小继续折半，单条仍超 8 MiB 时明确失败 |
| Agent/Relay 生命周期 | Agent 断线/删除、Relay 关闭时释放 manager authority；`available=false` 清除旧集合，不能用旧数据恢复后假报健康 |
| Gateway Relay 协商 | transport 失败按 1–30 秒退避；旧能力每 5 分钟重探；首次 health 失败不要求重建 Server |
| mutation 确认 | 协商 v2 后先等正常增量事件；超时只发一次与并发操作共享的完整 resync。字段不匹配不能用相同 `updatedAt` 冒充确认；旧 Gateway 没有同步状态时直接保留原 unary 行为 |

宏观的 K-brain HTTP 快照预算与 Gateway 浏览器帧预算是两层不同限制：K-brain 快照按其 60 秒 TTL/64 MiB 规则建立；Gateway manager 保存转换后的 LA-ID 摘要集合；WebSocket 再按 500 条和 8 MiB 逐页发送。不能用扩大浏览器队列代替分页，也不能反复 clone 64 MiB 全集合来生成每一页。

## 验收映射

| 设计场景 | 自动化证据 |
|---|---|
| A17 代际与迟到 | manager 拒绝旧 generation 和迟到 snapshot；重复 delivery seq 幂等；GUI 同 URL 后端 epoch 改变时重建 publication generation；WebUI mutation waiter 绑定 generation |
| A19 广播缺口 | 128 缓冲 drop → 独立控制恢复；真实 PBWS 连接验证错误 token、旧 generation、正确 ack 和 ack 后解除锁存；旧 ack 不能清新 drop；控制队列失败关闭连接 |
| A20 心跳与计数 | 45 秒新鲜度测试、60/300 秒 reconcile 切换、完整 reset 重算 workdirs；WebUI buffer gap/overflow 不提交部分集合 |
| A21 Relay | 真实 HTTP fixture 验证快照、changes、取消；首次 health 503 后无需重建 Server 自动恢复；严格 R→H、more 和 cursor 校验；unknown delete 不创建别名，真正 delete 回收别名 |
| A22 权限与容量 | Rust main-window/local-origin 测试；source/generation 长度、JS safe integer、conversation identity、重复 snapshot ID、64 MiB/100k authority 和 8 MiB frame 预算测试 |

WebUI 另有真实共享 backend fixture覆盖：

- 快照成功后原子 `reset` 和 ack；切点后的 buffered tail 在同一临时 Map 回放，ack 使用已应用序号。
- buffered gap、overflow 和持续恢复失败不会提交部分基线，也不会忙循环请求。
- 45 秒 freshness 失效，旧端/未协商端保留 60 秒轮询。
- 普通 metadata mutation 等待订阅投影；并发 mutation 共用一次权威快照；同时间戳的旧标题不能确认新标题；legacy 模式 resync 调用数为 0。
- 取消订阅会清计时器和恢复重试。

## 已执行检查

| 检查 | 结果与日志 |
|---|---|
| Gateway 全量 Go 测试 | 全包通过；`%TEMP%/liveagent-session-sync-gateway-go-test-frozen.log`。最终预算增量之后的 history focused 测试也通过 |
| Gateway WebUI 全量测试 | 最终119文件、275/275，通过；`%TEMP%/liveagent-session-sync-web-final4.log`。早期冻结记录为274项，不能混用计数 |
| WebUI history focused | 17 tests 通过，另有 mutation projection/coalescing 测试；覆盖上表的 buffer、freshness、legacy 和 mutation 场景 |
| Rust 编译 | `cargo check --tests` 通过；`%TEMP%/liveagent-session-sync-cargo-check-final.log`。当前源码全量 lib 为 1107通过、23失败、4忽略；固定 b204 只读 archive（2,674 个文件逐字节一致）在独立临时 target 完整运行 1104通过、23失败、4忽略，失败名称集合完全相同，故 23 项为 Windows/环境基线失败而非本次同步改动引入。基线原始日志 `%TEMP%/liveagent-session-sync-rust-baseline-closure/full-lib-test.log`，构建产物 SHA-256 `F1D4EF7D3257C7F5B8748B35A7FBA5C7DFCD2B1B0EB565FE8CA5CB5AE74CFB9C`。 |
| Rust caller 权限 | 精确测试通过；`%TEMP%/liveagent-session-sync-rust-auth-test.log` |
| Proto | `buf lint` 与相对 `upstream/v2-kbrian` 的 `buf breaking` 通过；生成物由 `buf generate` 产生，没有手写。Windows 下 `buf.gen.yaml` 使用 `[pnpm, --dir, web, exec, protoc-gen-es]`，规避 `.bin` shell 入口不可执行；CI/Linux 仍调用同一 pnpm 包 |
| Gateway WebUI build | `gateway:prepare` 完成 typecheck 和生产构建；只有既有 dynamic/static import 警告 |
| WebUI lint | 最终Windows全目录`pnpm lint`有53个格式诊断（早期52）；`lineEnding:auto`在本机要求CRLF而提交规范为LF。最终22个改动生产TS/TSX文件以`biome check --line-ending=lf --error-on-warnings`检查通过，未重排无关文件。全目录命令仍记录失败，Linux/CI结果是最终依据；日志`%TEMP%/liveagent-session-sync-final-web-lint.log` |
| Gateway lint | 最终固定Go1.25.12、golangci-lint2.12.2及独立干净lint cache，`golangci-lint run ./...`为0issues。此前系统Go1.27与mise1.25混用、跨版本cache诊断保留；修复任务测试两处protobuf锁复制后PBWS history聚焦通过，生产源码未改；日志`%TEMP%/liveagent-session-sync-final-go-lint-fresh-cache.log` |
| CI 边界基线 | `ui-boundaries` job 使用完整 Git 历史，并把 `LIVEAGENT_CHECK_BASE_REF` 指向当前 PR 的实际 base SHA（push 时使用 `before`）；v2 PR 不再回退到 `origin/main` 后把整条 v2 差异误报为本次新增 warning。脚本的默认行为未改，其他 workflow 不受影响 |

Gateway 开发 sidecar身份：

- 路径：`crates/agent-gui/src-tauri/binaries/liveagent-gateway-x86_64-pc-windows-msvc.exe`
- 最终正式5/30分钟采样使用SHA-256 `BC24C9002AD2A7CF61AA13A452595C1001D6CF5B70987CA71E848C25300AB549`，由当前工作区BAT重新构建，包含直连cwd/delete修复和当前嵌入WebUI；搭配K-brain final4，106/106轮通过。源码manifest包含47个生产文件，已逐个核对与当前源码一致。
- `2545A10856DDC2259617E2704AF5D5D38D3F09ED813267C5B9C1B4B335FA0B49`是较早修复legacy仲裁后的候选，`431A2F22BA7545CFF77A3B94660454DD25AAA5339B891BA540786EEC6122B2FF`更早，均保留原采样但不当作最终行为构建。独立直连真实14项使用`FC398D88AD07A9B6D0AC93EF9C0ED8A84ED168115B96D19CB66E239EAF3213F0`，与最终桌面sidecar为同一Go生产修复，嵌入WebUI构建时点不同，见`relay-compat.md`。
- 这是当前任务源码的开发构建，不是正式发布产物，不能写入 K-brain/LiveAgent 正式锁文件。

## 已知限制与未完成项

- Native `{accepted:true}` 只确认交给当前出站传输。没有新增桌面→manager的 request/response ACK；连接代际检查和完整快照负责恢复，文档与测试不能把 transport handoff 写成 manager ACK。
- Gateway manager snapshot 在内存中保存一次完整权威集合；分页响应只复制请求页，避免每页重复 clone 全集合。大集合仍有一次受控的 64 MiB 常驻开销，须纳入 30 分钟资源采样。
- WebUI metadata mutation 没有 K-brain 的 `sync_revision` 直接透传。它优先等待正常订阅事件，超时后最多执行一次共享快照校准；不匹配时报告“等待同步”，不能假报成功。
- Chromium 把页面放入 Back-Forward Cache 时会主动关闭该页 WebSocket，冻结的页面不承诺实时更新。真实双 WebUI 循环中，一页出现 `Page entered Back-Forward Cache` 后暂时没有新会话；`Page.bringToFront` 恢复该页后 3 秒内重连并通过完整 resync 补齐，证明这是页面生命周期暂停，不是持久漏事件。多页断言应先恢复目标页面，再检查最终一致性。
- 本文件只记录Gateway/Rust/WebUI自动化。最终Tauri加两个WebUI、实际菜单/定时任务/外部kn/断线/最小化及106轮30分钟结果见`automation.md`；资源真实增量、GC回收、旧版本基线限制和macOS未验证项必须一并阅读，不能仅用模块测试宣称全矩阵完成。
