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
| 2 | 桌面新对话发送"用一句话介绍你自己"（DeepSeek `deepseek-flash`） | 通过：首次因调试数据根 DeepSeek key 无效返回 401 并正确回写；用户更新 key 后同一会话得到正常回答 |
| 3 | 自动审查模式发送 | 待 key 更新 |
| 4 | 重启客户端后历史保留 | 通过：会话仍在侧栏；`instanceId` 由 `dd9041f6` 变为 `39aa9322`；父进程退出后 K0 子进程经 parent-stdio EOF 自行退出 |
| 5 | WebUI 发起会话 | 待 key 更新与 WebUI 登录 |
| 6 | WebUI 排队项追加与删除 | 待 key 更新与 WebUI 登录 |
| 7 | 定时任务新建 / 停用 / 删除 | 通过：Shell 任务 `k0-acceptance`（`0 0 3 1 1 *`）三步成功，后端存储中已无该任务 |

## 第二轮：用户验收反馈的界面问题（2026-10-29）

| # | 现象 | 根因 | 修改 | 回归 |
|---|---|---|---|---|
| 3 | 发出指令后切到其他对话，新会话不在列表里 | K-brain 新会话在首条消息落盘前 `listed:false`（`internal/session/summary.go` summaryListed 要求 count>0）；桌面 `sidebarSync.onChanges` 与 Gateway `history_sync.go` 把它当权威删除，移除了本地 pending 行；停留在该会话时 ChatPage 会重插，切走后无人重插 | 只有此前已 listed 的会话收到 `listed:false` 才删除；`kind:"delete"` 不变 | `kbrain-sidebar-unlisted-new-session.test.mjs`、`history_sync_unlisted_test.go`，修复前均失败。调试版实测：修复前切走约 370ms 行消失、落盘后才回来；修复后 pending 行全程保留，落盘后转为正式行 |
| 4 | 中文界面出现英文提示 | `turn.ts` 的 toast 标题写死 `AI review · {tool}`，正文是 K-brain 固定英文原因；本地 Gateway 监管器的 11 条固定英文错误在 Remote 设置原样显示 | AI 审查标题与固定原因按界面语言显示（前缀可叠加，模型自由文本原样）；本地 Gateway 错误在 `RemoteSection` 显示时翻译 | `kbrain-turn.test.mjs` 新增一例、`local-gateway-error.test.mjs` |
| 2 | 设置页多出一个返回按钮 | Windows 设置顶栏 `WindowsSettingsHeader`（上游 `ede24425`）在侧栏"返回对话"之外又放了返回箭头 | 移除顶栏返回箭头，保留标题、拖拽区和窗口按钮；返回仍走侧栏"返回对话"与 Esc | `windows-header.test.mjs` 改为断言顶栏无返回按钮 |
| 5 | 权限模式图标重复；自动审查未配置审查模型时所有工具输出被拦截、用户不知原因 | 选择器只为"变更前确认""完全访问"配了图标，其余默认盾牌；未配置审查模型时 K-brain 评审结果一律 unknown，自动审查模式扣留工具输出（`internal/approval/run.go`） | 六种模式各用独立图标（灯泡、手掌、铅笔、带勾盾牌、闪电、带叹号盾牌）；读取到审查配置且未选模型时，自动审查项改为琥珀色提示并在其下提供"去设置审查模型"（跳到 设置 → 系统工具）；读不到配置时视为未知、不提示 | `command-safety-mode-selector.test.mjs`。桌面调试版：已配置审查模型时无提示；WebUI 1280/390：六个图标不同、无横向溢出、文字未截断 |

WebUI 经桌面托管的 Gateway 时，桌面桥只转发 `kbrainMemory`，不转发 `aiApproval`，WebUI 无法得知是否已配置审查模型；首版提示因此在 WebUI 误报，已改为"读不到即未知"并补回归。WebUI 的"AI 智能审批"设置同样读不到该字段，属既有缺口，已在第三轮补齐。

第二轮自动验证：LA 全量 7 批次总计 4141，通过 4137，失败 3（与第一轮相同的已知环境失败），跳过 1；Gateway `go test ./...` 全部通过，`internal/kbrain` `-race` 通过；WebUI 275/275；typecheck ×3、biome（LF）、check-mirror、`git diff --check` 通过。对抗复审两轮：第一轮提出 2 条 P2（工具输出阶段的附件前缀未翻译；本地 Gateway 18 条固定错误只覆盖 11 条），均修复并保留其先失败回归 `kbrain-review-notice-tool-output.test.mjs`、`local-gateway-error-coverage.test.mjs`；第二轮结论"未发现阻止合并的问题"。复审后另补 `connection.rs` 的 3 条固定错误翻译（单测覆盖）。

用户反馈的"供应商数据读不到"与"Gateway 端口被占用"：调试期间安装版 LiveAgent 一直在运行并占用 50052；调试版 `/v1/settings` 返回 11 个供应商且页面全部显示，用量接口正常（RightCode 的厂商用量端点 10 秒超时后显示错误）。由用户重新验证，本轮未改代码。

调试版实测"自动审查"时出现 `Reviewer unavailable`：调试数据根的 `config.json` 没有 `aiApproval` 审查模型配置，属配置状态，需在设置中选择审查模型后复验。

## 第三轮：权限菜单调整与 AI 审批跨端读写（2026-10-29，用户决定）

K-brain 权限分两层：每次运行的 `permission_mode`（normal / plan / auto_edit / auto_review / full_access / always，`internal/permissions/mode.go`、`internal/backend/run_options.go`）与全局 `aiApproval.mode`（off / risk_only / auto，需审查供应商与模型）。always 不建审查器；auto_review 本次运行强制按 auto 审查；其余模式按全局设置。

| 改动 | 说明 | 回归 |
|---|---|---|
| 菜单精简 | "变更前确认"改名"始终询问"，说明改为"每个需要授权的操作都先请求审批"（原"只读操作无需确认"在 K-brain 中未找到对应放行逻辑）；去掉"完全访问"；"自动审查"占其位置，仍发 `auto_review`；计划模式从权限菜单移除，只保留加号菜单开关，选择权限不再关闭计划模式 | `command-safety-mode-selector.test.mjs` |
| 旧值迁移 | 已保存的 `auto` 与缺失值归一为 `always`（TS 与 Rust 两处 normalize，Rust 随下次保存写回）；旧客户端发来的 `auto` 在桌面 `resolveKBrainPermissionMode` 与 Gateway `kbrainOptions` 均按 `always` 执行 | `permission-modes.test.mjs`、`sandbox-policy.test.mjs`、Rust `command_safety_mode_unrecognized_value_fails_closed_to_ask` 及 4 个默认值断言、Gateway `permission_modes_test.go` |
| AI 审批跨端 | 桌面桥 `kbrain_ai_approval.rs`：settings.get 从同一次 K-brain 设置读取注入 `aiApproval`；WebUI 更新中的 `aiApproval` 取出后写入 K-brain `/v1/settings`，不进 LiveAgent 设置；K-brain 拒绝时回传其错误原因，不含 token/URL | 模块内 4 个 Rust 测试（含本地 HTTP 替身） |

实机：桌面调试版菜单四项、图标各异，原"完全访问"已显示为"始终允许"；WebUI 1280/390 四项、无横向溢出。WebUI 设置 → 系统工具 → AI 智能审批能读到"自动审批 / deepseek-flash"；改为"仅风险提示"保存后 K-brain `config.json` 为 `risk_only`、LiveAgent `system_settings` 不含该字段；再改回"自动审批"恢复原配置。

## 第四轮：WebUI 设置层偏移与供应商模型自动获取（2026-10-29，用户决定）

| # | 现象 | 根因 | 修改 | 回归 / 实测 |
|---|---|---|---|---|
| 6 | WebUI 设置页右上角露出半截对话页顶栏 | 设置层以 `translate-y-24px` 入场，打开态用 `transform-none!` 收尾；Tailwind v4 的 `translate-y-*` 写的是独立的 `translate` 属性，`transform-none` 清不掉，设置层停在下移 24px 处（上游 `f67cdd7a` 起） | 打开态改 `translate-none!`，过渡属性改为 `opacity,translate` | `settings-overlay-settled-position.test.mjs`（修复前 2 项失败）；WebUI 1280 实测设置层 top=0、`translate: none`、右上角被覆盖，Esc 关闭正常 |
| 7 | 修改供应商任意字段不再自动获取模型列表 | v2 起编辑器只拿到已保存 Key 的占位（`providerCredentialsRedacted`），自动获取要求本地有 Key 才发请求，于是静默跳过；手动刷新走的是"复用已保存 Key"分支所以仍可用 | 地址/代理未变时用已保存 Key 自动获取（K-brain 按 providerId 取 Key）；地址或代理改动后 K-brain 不允许把已保存 Key 发往新地址，改为提示"地址已修改，需要重新填写 API Key 才能自动获取模型列表"，填入新 Key 后恢复自动获取 | `provider-modal-stored-key-autofetch.test.mjs`（修复前 3 项均为 0 次请求）；桌面实测打开 DeepSeek 编辑 912ms 后自动 `POST /v1/settings/providers/<id>/models`，改 Base URL 后无请求并显示提示，取消未保存、配置不变 |

第三轮对抗复审另提出 3 条 P2（设置页保存审查模型后输入框提示不消失；关闭菜单也重读设置；已删除/停用的审查模型仍判为已配置），均已修复并保留回归 `review5-auto-review-readiness.test.mjs`、`review6-auto-review-readiness-refresh.test.mjs`；复审结论"未发现阻止合并的问题"。

## 第五轮：已保存 Key 获取模型列表（2026-10-29，用户决定）

用户反馈：URL 变化而 Key 不变时，不应要求重填 Key。核对 K-brain：保存路径（`settings.go` → `updateProvider`）只改地址、Key 留空时保留已存 Key；模型发现（`settings_provider.go`）却在草稿地址与存储不同时清空 Key 与自定义头，两条规则矛盾。第四轮复审另指出两处缺陷：WebUI 经桌面代理时桌面桥从旧版 SQLite `provider_settings` 取 Key；K-brain 拿存储原始地址比较界面回传的脱敏地址，误判"已改"。

| 位置 | 修改 | 回归 |
|---|---|---|
| K-brain `handleProviderModels` | 去掉"地址不同即清空已存 Key/头"；草稿地址等于脱敏后的存储地址时视为未改并沿用原始地址 | `settings_provider_stored_key_test.go`（修复前 3 项失败） |
| 桌面桥 `handle_provider_models` | 不再读旧版 SQLite；空 Key 时按 providerId 转给 K-brain，未提供的 isFullUrl/自定义头不写入请求 | Rust `stored_key_discovery_forwards_the_draft_for_kbrain_to_resolve_by_id`、`discovery_without_a_key_needs_a_provider_to_resolve_it`；复审回归 `provider-models-stored-key-webui-desktop.test.mjs` |
| Gateway `settingsRequest` | 失败时保留 K-brain 的错误说明 | `settings_error_test.go`（修复前失败） |
| 供应商编辑器 | 有已存 Key 即可自动获取（地址变化也一样）；去掉预先提示；仅旧版 K-brain 拒绝复用（错误含 credentials or endpoint are not configured）时提示重填 Key | `provider-modal-stored-key-autofetch.test.mjs` 6 项 |

实机：旧 K0 下改 DeepSeek 地址后自动向新地址请求，被拒后显示重填提示（回退生效）；用新代码重建 K0 后同一步骤请求成功、无提示，取消不写配置（配置文件修改时间不变）。WebUI 经桌面桥打开编辑并改地址，无报错。测试期间配置两次被保存为 `/v1`，代码中没有自动保存路径，且同样步骤在受控复现中不写配置，判断为窗口内手动点了"保存"；第一次已恢复为 `https://api.deepseek.com`，第二次保留现状待用户确认；保存后已存 Key 保留（35 字符）。

第五轮复审另提出 2 条 K-brain P2：已存地址带 userinfo 时输入新 Key 仍失败；"脱敏地址视为未改"只在模型发现生效、保存时仍用脱敏地址覆盖（丢 secret query / api-version）。改为在 `updateProvider` 内统一用 `resolveEditedURL` 解析（仅当存储地址仍是合法端点时沿用），保存与发现一致；保留复审回归 `settings_provider_stored_key_review_test.go`。K-brain `internal/backend`、`internal/config` 在隔离 HOME 下全部通过；`TestBackendQueueFIFOInterruptAndShutdown` 在本机真实 HOME 下读到 `~/.liveagent` 记忆注入而失败，隔离后 5/5 通过，属环境问题。

## 第六轮：模型选择框定位当前模型（2026-10-29）

| 现象 | 修改 | 回归 / 实测 |
|---|---|---|
| 展开模型列表后不会定位到当前模型 | 进入模型列表时，若当前模型所在供应商被折叠则先展开，再把当前模型滚到列表中部（只滚列表容器；已筛选其他供应商时不干预；搜索时不滚动） | `composer-model-picker-scroll-to-active.test.mjs`（修复前未滚动）；桌面实测当前模型 `gpt-6.1-sol` 位于列表下部，打开即 `scrollTop=1068` 居中显示 |

## 未运行 / 未覆盖

- 人工验收 1–7 已由用户在调试版与 WebUI 全部验证通过（2026-10-29），验收中发现的问题均已在第二至第六轮修复。
- macOS / Linux；签名、存储门禁、迁移、更新器（S2–S6）。
- 生图实例握手（S6），`/v1/terminal`、`/v1/fs` 未加闸门（S1 未要求）。
- K0 尚未发布真实 tag，`kbrain.lock.json` 未改；`capabilities.json` 中 K0 新字段的首次发布 tag 待发布后补登记。
