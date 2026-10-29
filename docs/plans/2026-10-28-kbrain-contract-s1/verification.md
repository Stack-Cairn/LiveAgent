---
date: 2026-10-28
tags: [kbrain, compatibility, s1, verification]
---

# K0 / L0（S1 契约基础）验证记录

依据：LiveAgent `upstream/v2-kbrian@336a6e75` 的 `docs/design/2026-10-26-kbrain-decoupled-updates.md`，K-brain `origin/main@894612f` 的 `docs/compatibility.md`。两文对 L0 的定义不同（设计 §3.3"首个启用更新器的 LiveAgent"，契约 §9.1"支持该契约的 L0，更新器保持关闭"）；设计 §14 要求签名密钥和维护预算落实前更新器保持关闭，本次按契约 §9.1 交付 S1，更新器未启用。

## 范围

| 仓库 / 分支 | 交付 |
|---|---|
| K-brain `feat-compat-contract-k0`（基线 894612f） | `/v1/health` 增加 `protocol`、`build`、`startupContract`、`instanceId`、`capabilityRevision`；旧 `version` 与历史能力值不变；不声明未实现的 `instance_precondition`、`backend_drain`、`storage`、`build.releaseSequence`；能力登记表 `internal/protocol/capabilities.json`（首次发布 tag 用 `git tag --contains` 核对）；`NewBuild` 只把 `vX.Y.Z[-pre]` 视为发布，其余为 dev；构建注入 `main.revision` |
| LiveAgent `feat-kbrain-contract-l0`（基线 336a6e75） | TS / Rust / Go 三宿主 health 解析器，共用 `crates/agent-ui/src/lib/kbrain/health-contract-vectors.json`；消费点改走解析器；Gateway 握手缓存与闸门（`StartRun`、后端队列提交与推进类动作、cron `run_now` / 推进类 `cron_apply`、loop create）；桌面"关于"页 K-brain 后端只读行；源码构建脚本注入 revision |

规则摘要：只有完全缺失 `protocol` 才走 v1 旧路径；`protocol` 为 null、非对象、名称或主版本矛盾、已出现字段类型错误都拒绝；整数按数值判断，范围 [0, 2^53−1]；拒绝 BOM、非法 UTF-8、尾随数据。停止类操作（取消运行、删除/暂停排队项、停用/删除定时任务、loop cancel、权限回复）在契约损坏时仍放行。Gateway 遇到 404 health 视为未声明契约，只放行无需能力的普通模式。

## 自动验证（2026-10-28，Windows 11）

| 项 | 命令 | 结果 |
|---|---|---|
| LA 全量 | `node ~/.agents/skills/la-kb-preflight/scripts/la-full-tests.mjs` | 7 批次全部运行，总计 4135，通过 4131，失败 3，跳过 1；3 项均为已知环境失败（cargo 套件 180 秒超时、两项按 CWD 读源码，在 `crates/agent-gui` 下重跑通过） |
| Gateway | `go -C crates/agent-gateway test ./...` | 全部包通过；健康/队列/对抗相关 `-race -count=3~5` 无 DATA RACE |
| WebUI | `pnpm --dir crates/agent-gateway/web test` | 275/275 |
| Rust | `cargo test --lib kbrain_`；`--test kbrain_health_adversarial --test kbrain_health_adversarial_r2` | 19/19；3/3、3/3；`cargo check --tests` 无新增警告 |
| 类型 / 格式 | `typecheck:ui/gui/webui`；改动文件 LF 后 `biome check --line-ending=lf`；`check-mirror`；`git diff --check`；gofmt / rustfmt（LF 副本） | 全部通过 |
| K-brain 全量 | `kb-full-tests.sh` | 44 个包通过；5 项已知 Windows 基线失败；`cmd/kn`、`internal/backend` `-race -count=10` 无 DATA RACE；`internal/protocol` `-race -count=10` 通过 |
| 偶发 | `internal/memoryruntime TestCompletedCoalescesWithinThrottle` | 首次全量失败一次，单独 `-count=50` 通过；该包不依赖 `internal/protocol` / `internal/backend`，复跑全量未复现 |
| 对抗复审 | 独立子代理，五轮 | 共提出 11 条 P2，全部修复并保留其先失败回归；第五轮结论"未发现阻止合并的问题" |

## 调试版实机（start-tauri-dev.bat，当前工作区 HEAD）

- 本地 K0 构建 `k-brain k0-local`（revision 894612f…，工作区未提交改动），以 `LIVEAGENT_KBRAIN_BINARY` 注入；运行中的调试版 `target\debug\liveagent.exe` 子进程即该二进制（SHA-256 一致），启动握手通过。
- 设置 → 关于：显示 `K-brain k0-local (dev)`、`协议 kbrain.agent 1.1 · 894612f1eaa5 · 能力修订 1 · 实例 <8 位>`。1280 / 480 宽度无横向溢出、无截断；窗口 `minWidth` 为 480，390 只能经 bridge 强制，此时整页设置内容列被侧栏挤压，现有"应用"行同样受影响，属既有布局问题。
- WebUI 不渲染该行（关于页仅桌面宿主），经 Gateway 下发后端快照属 S6。

## 人工验收（经 MCP bridge 驱动调试版真实界面；Computer use 在应用设置中未开启）

| # | 场景 | 结果 |
|---|---|---|
| 1 | 设置 → 关于显示 K0 后端信息 | 通过：`K-brain k0-local (dev)`，协议 1.1、revision、能力修订 1、实例短号 |
| 2 | 桌面新对话发送"用一句话介绍你自己"（DeepSeek `deepseek-flash`） | 链路通过、模型未答：运行被 K0 受理并路由到 DeepSeek，供应商返回 `401 Authentication Fails`（调试数据根中 DeepSeek API key 无效），错误正确回写会话。需更新 key 后复验 |
| 3 | 自动审查模式发送 | 待 key 更新 |
| 4 | 重启客户端后历史保留 | 通过：会话仍在侧栏；`instanceId` 由 `dd9041f6` 变为 `39aa9322`；父进程退出后 K0 子进程经 parent-stdio EOF 自行退出 |
| 5 | WebUI 发起会话 | 待 key 更新与 WebUI 登录 |
| 6 | WebUI 排队项追加与删除 | 待 key 更新与 WebUI 登录 |
| 7 | 定时任务新建 / 停用 / 删除 | 通过：Shell 任务 `k0-acceptance`（`0 0 3 1 1 *`）三步成功，后端存储中已无该任务 |

## 未运行 / 未覆盖

- 人工验收 2、3、5、6 需要可用的模型 key，未运行；已随 PR 请维护者协助验证。
- macOS / Linux；签名、存储门禁、迁移、更新器（S2–S6）。
- 生图实例握手（S6），`/v1/terminal`、`/v1/fs` 未加闸门（S1 未要求）。
- K0 尚未发布真实 tag，`kbrain.lock.json` 未改；`capabilities.json` 中 K0 新字段的首次发布 tag 待发布后补登记。
