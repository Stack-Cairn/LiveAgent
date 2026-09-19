# MCP、Skills、记忆、Cron 与 Hook 独立开关

日期：2026-09-14。状态：需求已记录，完成代码静态分析，待实现；本文中的目标行为和接口均为设计建议，不代表已经提供。

## 需求与结论

为 MCP、Skills、记忆、定时任务（Cron）、Hook 各提供一个独立的系统级开关，用户可以分别开启、关闭，并保留原有配置与数据。关闭后应阻止对应能力参与新的 Agent 执行或后台任务；重新开启时恢复原有单项选择。

**可行。现有模块已经分离，适合增加统一的能力策略和生命周期控制，无需拆成五个进程。当前只有部分开关，尚未形成五项一致的系统级启停能力。**

这里的“系统级”指 LiveAgent 桌面执行核心统一执行策略，覆盖 GUI、WebUI、后台任务和子代理；不是操作系统禁用某种协议，也不能关闭外部 MCP 服务本身。开关控制应用托管的能力，不等同于 OS 沙箱或任意 Shell/网络访问权限。

本次只记录需求与设计，不修改运行行为。

## 当前实现核对

源码路径均相对仓库根目录；下表描述本次 checkout 的实现。

| 能力 | 已有控制 | 尚缺的系统能力 | 主要证据 |
|---|---|---|---|
| MCP | 单 server `enabled`、工作区资源过滤；支持 stop/test/restart | 无 MCP 总开关；停连接和禁用配置是不同动作；执行入口没有统一的总策略检查 | `crates/agent-ui/src/lib/settings/types.ts`；`crates/agent-gui/src/lib/settings/mcpOps.ts`；`crates/agent-gui/src-tauri/src/commands/integration/mcp.rs` |
| Skills | `settings.skills.enabled`；单项 selected；工作区过滤；工具注册与 skills 文件根受启用项控制 | 主要属于前端运行策略，尚无统一后端总闸门；安装和批量启用会重新打开总开关 | `crates/agent-ui/src/pages/settings/SkillsSettingsForm.tsx`；`crates/agent-ui/src/pages/skills-hub/SkillsHubPage.tsx`；`crates/agent-gui/src/lib/tools/builtinRegistry.ts` |
| 记忆 | `organizerEnabled` 与整理频率；MemoryManager 支持 ro/rw | 没有记忆总开关，ro 也不是关闭；召回注入、回合后提取、工具读写、整理需统一控制 | `crates/agent-ui/src/lib/settings/types.ts`；`crates/agent-gui/src/pages/chat/runtime/useSendChatTurn.ts`；`crates/agent-gui/src/lib/chat/memory/extractionController.ts` |
| Cron | 每个任务 `enabled`；调度 reload；定时触发前重新检查任务状态 | 无 Cron 总暂停；手动运行、Prompt 队列认领、运行中任务缺统一总策略 | `crates/agent-gui/src-tauri/src/services/automation/{scheduler,store}.rs`；`crates/agent-gui/src/components/cron/CronPromptRunner.tsx` |
| Hook | 每个 hook `enabled`；按会话 scope 排队/取消；脚本支持取消 | 无 Hook 总开关；scope 创建时捕获启用项，后续排队执行不读取最新全局配置 | `crates/agent-gui/src/lib/automation/hookRunner.ts`；`crates/agent-gui/src-tauri/src/commands/automation/hook.rs` |

补充核对结果：

- MCP 的 `selectEnabledMcpServers()` 当前按 `server.enabled` 和 id 过滤，工作区范围由其他层收窄；不能把清空 `settings.mcp.selected` 当作总关闭。现有 `docs/features/skills-and-mcp.md` 的“enabled 且 selected”描述不足以精确表达当前路径，实施时应一起校正。
- `buildBaseBuiltinToolBundles()` 当前直接创建 Cron、McpManager、MemoryManager；只有 SkillsManager 受 `skillsEnabled` 条件控制。最终是否暴露还可能受运行模式等过滤，但这些能力本身没有总开关。
- `mcp_call_tool` 从连接池取 client 执行，没有重新读取 server 启用配置；`mcp_test_server`/`mcp_restart_server` 接收传入配置，可创建连接。因此只隐藏动态工具表不够。
- Skills 的启用状态目前在桌面 `lib/settings/storage.ts` 的本地 UI 设置路径中保存；内置 skills 在选择归一化中自动合并，应用启动也会 seed 内置文件。安装完成和批量启用会设置 `skills.enabled = true`。
- `useSendChatTurn.ts` 每轮读取记忆 overview，既维护 system 基线，也维护后续用户消息附加的记忆增量；Agent 和纯文本两个 turn runner 均有回合后提取路径。不设置提取专用模型会回退到当前模型，不是禁用提取。
- 整理器关闭定时只是不自动唤醒，手动 `poke()` 仍会尝试认领；`dispose()` 清理唤醒定时器，不能据此认定已经运行的整理也会中止。
- Cron 的手动执行路径独立于定时触发状态复核；Hook 的 HTTP 取消检查发生在请求之间，不能保证立刻取消已经发出的请求。MCP 的等待取消也不意味着远端执行已回滚。

## 开关层级与独立性

统一入口建议设在“系统设置 → 能力管理”，展示五个开关；各功能页显示同一个总状态，并保留原有单项管理。

```text
有效能力 = 系统总开关 ∧ 当前执行上下文允许
有效资源 = 有效能力 ∧ 单项启用/选择 ∧ 已有工作区限制
```

工作区、会话、Cron、子代理只能收窄权限，不能覆盖系统关闭。当前工作区资源 off 同时影响 MCP/Skills，可保留兼容；第一阶段不必为五项新增完整的项目级开关矩阵。

总开关只控制最终生效状态，不批量重写 `server.enabled`、Skill selected、任务 enabled、Hook enabled 或 organizerEnabled。关闭期间仍允许用户在管理页面查看和编辑配置、导出及删除数据；所有会启动执行的操作须遵守总开关，包括 MCP 测试/重启、Cron“立即运行”和记忆“立即整理”。

用户管理入口与 Agent 执行入口需要分开授权：沿用并检查现有桌面/远程设置权限，不依赖调用方自行声称 `source=user`；模型工具不得直接启用系统能力。能编辑单项配置也不意味着可以重新打开总开关。

| 组合 | 预期行为 |
|---|---|
| MCP 关，Skills 开 | Skills 正常注入与读取；Skill 中要求调用 MCP 的步骤报告依赖不可用，不自动重启 MCP |
| Skills 关，MCP 开 | MCP 工具正常可用，不扫描/注入 Agent Skill 内容，不注册 SkillsManager |
| 记忆关，其他开 | 正常聊天、MCP、Skills、Cron 与 Hook 继续工作，停止内置记忆读取、学习与整理 |
| Cron 关，Hook 开 | 不再触发 Cron；聊天生命周期 Hook 仍可执行 |
| Hook 关，Cron 开 | 聊天事件不再执行用户 Hook；Cron Bash/HTTP/Prompt 保持可用 |
| 记忆开，Cron 关 | 记忆整理器按自己的配置调度；它目前不是 Cron 调度器的一部分 |
| Cron Prompt 开，MCP/Skills/记忆之一关 | Prompt 仍可运行，只获得允许的能力；依赖不可用时返回明确结果，不替用户改开关 |

“Cron 开关”应命名为“定时任务（Cron）”，避免用户误以为它会停掉所有应用计时器。若后续需要“一键暂停所有自动化”，应另做组合操作，覆盖 Cron、记忆自动整理和其他明确列出的后台自动任务；网络保活、超时回收、租约清理不属于这个功能开关。

## 五项关闭语义

| 能力 | 关闭时阻止 | 保留与重新开启 |
|---|---|---|
| MCP | 新连接、工具发现/调用、自动重连、执行性诊断、自动授权与刷新；移除相关 ToolSearch catalog/activation，不暴露 McpManager | 保留 server 配置及授权凭据；本地托管进程和连接在在途请求收尾后释放；重新开启后按需连接原已启用项，不强制连接全部 server |
| Skills | Agent discovery、prompt/显式提及注入、SkillsManager、skills 专用文件与脚本访问；不启动新的自动 seed/后台扫描 | 保留安装文件和 selected；内置 skills 也服从总开关；用户主动安装/扫描仅用于管理，不自动改变总开关；重新开启恢复原选择 |
| 记忆 | 新 overview/增量注入、MemoryManager 召回和写入、回合后提取、daily 自动追加、自动/手动 AI 整理 | 保留 Markdown、索引、整理记录；管理页面仍可查看/导出/删除；重新开启只处理后续内容，不自动回溯关闭期间的会话 |
| Cron | 新定时触发、手动立即运行、Prompt 入队及认领、模型 Cron 工具 | 保留任务、单项 enabled、剩余次数与历史；重新开启按下一次未来触发点执行，不补跑关闭期间漏掉的执行 |
| Hook | 新事件派发、未开始的队列、后端新脚本/HTTP 执行 | 保留 hook 定义和单项 enabled；重新开启只接收新事件，不重放关闭期间事件 |

记忆可在总开关之外提供三个进阶项：

- `recallEnabled`：控制自动注入及模型主动 list/read/search。
- `learningEnabled`：控制回合后提取、daily 以及模型主动写入；关闭时若允许召回则 MemoryManager 仅只读。
- 复用 `organizerEnabled`：控制自动整理；手动 AI 整理受记忆总开关约束，但不必要求自动整理开启。

三个进阶项控制不同路径：整理器可以为整理而读取/修改记忆，即使模型召回或聊天学习关闭；UI 应明确说明。“只读记忆”预设需同时关闭学习和整理，并禁止手动 AI 应用。第一阶段可以只做总开关，避免把子选项混入首批交付。

## 运行中切换与关闭完成

建议区分持久化意图与运行状态：`enabled` 是配置；运行态展示“已启用 / 正在停用 / 已停用 / 停用异常”。配置关闭一旦提交，立即拒绝新的执行，不等待旧任务结束才生效。

默认采用“禁止新执行，已进入不可中断步骤的任务收尾”，避免中途杀死用户脚本造成部分写入。具体处理：

1. 清除 Hook 待执行批次、记忆提取 coalesce 队列；旧 Cron pending Prompt 标记为因能力关闭而取消，不能在重新开启后复活，也不消耗定时次数。
2. 记忆提取/整理在模型轮和批次之间协作取消；写入提交边界再次校验策略，防止关闭后旧 LLM 结果继续写记忆。已提交的数据不回滚。
3. Cron Prompt 可在模型请求/工具步骤之间停止；其已经启动的 Shell、HTTP 或外部工具按实际取消能力收尾，不假定“取消等待”就停止了远端工作。
4. MCP 不接收新调用，在途调用完成或超时后断开托管连接；Hook 不再启动下一条脚本/HTTP 请求。正在执行的步骤如允许用户另行停止，应准确展示取消结果。
5. 运行中聊天保持可用，但后续每次工具 dispatch 都读取最新策略。下一次模型请求刷新工具 schema、ToolSearch 激活项以及合成的 Skill/Memory 上下文。并行调用队列也须逐项检查，不能只在整轮开始检查。
6. 重新开启也产生新的策略版本。关闭前创建的任务不得因开关快速 off→on 而恢复提交权限；旧 run 保持失效，只允许新建执行。

停用超时或清理失败时保留“关闭”配置并显示异常与剩余执行，不回滚成开启。可继续运行的租约回收、历史落盘、取消记录等清理必须保留，否则关能力会破坏运行记录。

**上下文限制：**关闭后可以清除应用可识别的注入基线、增量和显式 Skill 提及块，停止继续把这些合成内容发送给模型；无法让模型撤回已处理的上下文，也不能承诺从自然语言回复或已有压缩摘要中自动剥离所有相关知识。关闭不删除聊天历史；需要完全隔离旧上下文时使用新会话。

**权限限制：**功能开关不是任意 Bash、通用文件工具或网络请求的隔离墙。专用 Skill 路径及模型工具别名需接受策略校验；如产品要求“任何途径都不能读记忆目录或访问 MCP 地址”，须额外扩展文件/网络沙箱与托管进程策略，不能用隐藏工具表来宣称已实现。

## 建议架构与持久化

建议采用一个后端持久化的权威策略，前端只消费快照。字段位置示意：

```json
{
  "system": {
    "capabilities": {
      "mcp": true,
      "skills": true,
      "memory": true,
      "cron": true,
      "hooks": true
    }
  }
}
```

五个字段是五个独立开关。集中存储便于一致检查，不代表相互绑定。现有 `skills.enabled` 迁移到该权威字段后停止双写；兼容期若保留旧字段，只允许单向派生，避免两份开关冲突。单项配置仍留在各自模块。

后端新增能力策略服务，负责加载、验证、保存、版本递增、执行准入及停用通知。状态查询返回配置和实际运行状态；错误使用稳定的 `CAPABILITY_DISABLED` 等机器码，UI 本地化说明，不把主动关闭渲染成网络故障。

需要覆盖四层：

| 层 | 实施要求 |
|---|---|
| 设置与 UI | 共享 `agent-ui` 提供五项管理；保存成功以桌面后端确认为准，远程断线时不可显示已生效；页面、安装回调、批量选择不得暗中重启总能力 |
| 模型上下文与工具表 | Chat 两种 runner、Cron Prompt、子代理统一解析策略；过滤动态 MCP、ToolSearch、SkillsManager、MemoryManager、Cron，并清理可识别的合成注入缓存 |
| 实际执行 | Tauri command 与直接 service 调用都检查；Cron 在 fire/run_now/enqueue/claim 处、Hook 在队列与执行处、记忆在认领与写入提交处检查；前端传入的 enabled 不作为权威依据 |
| 生命周期 | 为每项接入 disable/enable 协调；复用 scheduler reload、Hook scope 取消、提取 AbortController、MCP stop 等机制，并补齐全局枚举与状态反馈 |

不能只在 Tauri command 上拦截：Gateway 转发或 Rust 后台可能直接调用 service。也不能只在启动时读取一次布尔值；准入检查与执行注册应具备明确的原子边界，用策略版本或执行许可避免“检查通过→关闭→才执行”的竞态。不可中断的外部步骤若已获准进入，纳入“正在停用”的在途计数。

持久化与同步要求：

- 已有安装迁移时，Skills 保留原 `skills.enabled`；其余四项缺省按现有行为为开启，单项和 organizer 的原状态不变。新安装沿用这一兼容默认，是否改成默认关闭可另做产品决策。
- 启动先读权威策略，再启动 scheduler/自动 seed 等功能行为；读库失败不能当作“没有字段”而默认全开，应保持能力不可执行并显示错误。
- Skills 当前的旧值在桌面 local UI storage：首次升级需在后台能力启动前完成握手迁移。已有后端策略优先，WebUI 缓存不参与首次权威迁移。
- 复用现有 SQLite 设置、导入导出、备份以及 Gateway 同步链路，检查所有 normalize、局部保存、快照合并和脱敏白名单，避免新字段在旧 reducer 或整对象覆盖中丢失。
- `gateway.proto` 的 settings get/update/sync 已使用 `settings_json`，仅添加 JSON 配置未必需要增加 protobuf 字段；若增加独立状态事件再扩展协议。远程更新仍由桌面保存和执行。
- 以 capability key 做局部更新并进行版本冲突检测；旧客户端提交缺少新字段的快照不得把已关闭能力重新默认成开启。普通配置导入保留本机总开关；明确的完整恢复可以恢复开关，但必须走同一策略更新与生命周期协调过程。

## 实施分期与验收

整体属于跨模块的中等规模改造；核心难度是热切换、持久化一致性和后台执行边界，五个 UI 控件本身很小。建议依次交付：

1. **权威策略**：后端保存与加载、Skills 迁移、共享类型、五项 UI、版本化更新、双端同步。此阶段只能称“配置能力”，不能宣称完整关闭。
2. **执行覆盖**：上下文/工具过滤、后端 service 准入、Cron/Hook/Memory 的全部后台路径、单项不得反向启用总开关。
3. **热切换闭环**：在途任务与队列、缓存失效、状态反馈、重启/导入/并发/远程一致性，形成可交付的系统级关闭。

每项的基础验收：

- [ ] 单独关闭一项，其他四项配置不变，独立执行路径仍可用。
- [ ] 关闭后专用工具和新 prompt 注入不可见，旧工具表、ToolSearch 激活项及别名不能执行已关闭能力。
- [ ] 直接调用后端执行接口、Gateway 转发、子代理、Cron Prompt 均遵守同一策略；用户管理页仍可管理数据。
- [ ] 五项全关时正常聊天可用；不会自动提取记忆、执行 Hook 或产生 Cron 业务执行。
- [ ] 关闭→重启仍关闭；重新开启恢复原有单项选择，保留数据，不补跑暂停期间任务、不回溯学习暂停期间聊天。
- [ ] Skill 安装/批量启用和模型管理操作不会重新开启总开关；内置 Skill 也受总开关控制。
- [ ] MCP test/restart、Cron run_now、记忆 Run Now 在对应总开关关闭时不能启动工作。
- [ ] Cron pending/leased、Hook 排队/在途、记忆生成后尚未提交、MCP 加载/调用中切换都有明确终态；无新执行越过关闭边界。
- [ ] 快速 off→on 不复活旧任务；清理失败显示“停用异常”，不会错误显示“已停用”或自动恢复开启。
- [ ] GUI/WebUI 并发更新、断线、旧快照、备份导入不丢失或擅自开启开关。

实施时优先在已有 MCP registry/manager、Hook lifecycle、Memory extraction/organizer、Automation scheduler/store 和 settings sync 测试中补行为用例；覆盖五项单独关闭、全关、上文依赖组合及关键竞态，无需枚举没有额外意义的全部 32 种组合。

## 本次记录的验证范围

结论来自本地代码和现有架构文档的静态核对，没有启动真实 MCP、执行 Cron/Hook 或调用记忆模型。本文不承诺尚未实现的中止能力；后续交付须按上述验收实测。本次修改只涉及文档，检查文档差异、源码引用与相对链接。
