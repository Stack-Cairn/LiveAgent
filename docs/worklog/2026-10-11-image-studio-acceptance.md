# ImageStudio 验收矩阵（2026-10-11）

**Goal 未完成。没有实际用户验收记录；本文所有人工项在桌面与 WebUI 均为待验。** 自动化通过只表示所记录范围，不表示真实平台、浏览器交互或用户验收通过。本次仅本地读取设计、07 计划、两仓源码及已有专项记录，新增本文；没有运行测试、启动服务、读取个人配置或日志、调用平台。

依据：[统一设计](../plans/2026-10-11-image-studio/design.md)、[07 集成与发布](../plans/2026-10-11-image-studio/07-integration-release.md)。K-Brain 当前实现位于 `.liveagent/subprojects/K-brain`；本文中的 `KB/` 均指该目录。实施期间源码仍可能变化，执行验收时应另记两仓实际 SHA 和未提交修改范围。

## 当前证据与阻塞

| 范围 | 已有证据（不是本次重跑） | 尚未完成 / 判定边界 |
| --- | --- | --- |
| 引擎、配置、存储、HTTP/SSE、直接 Adapter | [实施记录](2026-10-11-image-studio-implementation.md)记载 imaging、backend Image 专项及 direct 离线测试通过 | 部分后续修改待复测；不能推导全仓检查或当前最终源码全绿 |
| 即梦 / RunningHub Adapter | [离线收据](../../.liveagent/subprojects/K-brain/internal/imaging/adapters/async/VALIDATION.md)：`go test ./internal/imaging/adapters/async -count=1 -timeout 45s` PASS，16 个顶层测试；vet 无诊断 | httptest 与自建签名向量；不是官方 CV 固定向量或真实调用 |
| 共享 UI / 客户端 | 实施记录记载联合 Node 55/55、设置专项15/15及局部 typecheck/Biome 通过 | 是当时专项结果；后续新增用例与最终整合结果需补收据；不等于浏览器操作 |
| 浏览器 harness | 本轮任务交接记录：打包通过；[harness 说明](../../crates/agent-gui/test/image-studio/browser/README.md)保留权限拒绝证据 | `browser_exec` 访问 `127.0.0.1` 被 private URL 权限阻挡；全部交互、窄屏、输入法、截图均未验；未改权限或绕过 |
| Rust 原图导出 | 任务交接及实施记录：8 tests PASS，`cargo check --tests` PASS | Tauri 原生 dialog、真实文件落盘与双端联调未人工验收；`remote_workspace` unsupported |
| URL 输出下载 | 无可交付下载实现 | 此前 auto-review 拒绝该实现动作，仅返回“possible cybersecurity risk”；仍未实现。返回 URL 的适配器不能视为完成下载→保存→展示闭环 |
| Gateway 多租户 | 可信委派、scope、代理转发模块和专项测试已有实现 | 真实 principal resolver 与 per-owner settings 未装配，默认503；不能把注入 principal 的测试当作真实多用户可用 |
| 全局交付 | 尚无本次完整检查、真实调用、双端人工或 required CI 的完整收据 | 不得宣称 Goal 完成、五平台可用或发行可交付 |

五平台均 `liveVerified=false`，没有真实调用收据。账号凭据、权限、额度与预算未核实；不能自行假定具备或缺失。普通工作台目标必须遵守验证门禁，不能为验收强行启用。

| 平台 / 所选产品 | 官方证据边界 | 真实验证状态 / 具体阻塞 |
| --- | --- | --- |
| OpenAI Images / GPT Image 2 | 研究记录的收窄契约完整；direct fixture 已有 | 未 live；模型权限、真实生成/编辑/遮罩效果和 usage 待验 |
| Google Gemini Developer API | `contractComplete=false` | 禁用；输出格式、模型级 MIME/候选数、地区与模型证据不足；未 live |
| 火山 Ark Images / Seedream 5.0 pro | 研究记录的收窄契约完整；direct fixture 已有 | 未 live；账号权限、真实生成/编辑待验；URL 输出另受下载阻塞 |
| 即梦图片生成4.0 / Visual OpenAPI | 收窄契约记录与 async fixture 已有 | 未 live；CV 官方固定签名向量、submit→poll 实测及 URL 下载闭环待完成 |
| RunningHub 国内站 ComfyUI Workflow API | `contractComplete=false` | 禁用；具体工作流 ID、revision、输入输出节点映射、新查询接口适用证据不足；未 live |

产品与证据来源见[平台矩阵](../research/image-studio-2026-10-11/matrix.md)。该研究矩阵早于部分实现，其“静态测试未运行”等历史措辞不能覆盖后续离线收据；后续离线通过也不能改变未 live 的结论。

## 执行入口与记录方式

1. 使用最新两仓源码对应的桌面 host / Gateway WebUI，打开独立“图像工作台”（workbench），创建项目，再选择执行目标、操作、数量和参数。**不在聊天框发送提示词来替代图像任务入口，也不把聊天返回的图片当作验收结果。** 图像设置从工作台“图像设置”进入。
2. 下文 P01—P09 都是可复制到 workbench“提示词”框的生成输入；取消、断网、切 backend、冲突等由 UI 操作或隔离注入触发，提示词本身不会制造这些状态。无需执行的场景可只填草稿。
3. 真实生成仅在明确目标、次数和预算授权后进行。故障、重复收费、中断和伪造身份用例使用隔离 fixture / fake Adapter；不得诱导真实平台重复扣费。当前真实目标未通过验证门禁，相关真实生成项保持阻塞待验。
4. 每次记录：用例 ID、桌面或 WebUI、真实/fixture、两仓版本、时间、backend、脱敏测试身份、target revision、操作、job/asset ID、实际结果、证据与验收人。usage 未知填 `null` /“未知”，不能填0。凭据、下载签名 URL、内部句柄不进入收据。
5. 下表“待验 / 待验”依次表示桌面 / WebUI。必须分别获得实际用户结果才能改状态；自动化状态单列。07 的 A05/A06/A08/A09/A15 中确定性注入与调用计数移至 T 矩阵。

## 可复制中文生成输入

**P01：基础成功、失败恢复、取消、超时、重复、恢复、导出共用。** 这些测试使用同一普通生成输入，故障由测试环境控制。

```text
生成一张蓝色几何风格海报，使用深蓝、浅蓝和白色的矩形与圆形，中央保留大片留白，画面简洁，边缘清晰，不含文字、标志或水印。
```

**P02：从选中的第二张结果继续修改 / version lineage。** 先在详情点“继续修改”，使用支持 edit 的目标。

```text
保留当前图片的几何构图、形状位置和中央留白，将背景改成暖黄色，主体改成深蓝色，保持边缘清晰，不添加文字、标志或水印。
```

**P03：参考图上传。** 先选“参考图生成”，导入测试 PNG/JPEG/WebP 并指定参考图片角色。

```text
参考已上传图片的主要构图和色彩比例，生成一张简洁的几何海报，将主体改成圆形与矩形组合，保留中央留白，不复制图片中的文字或标志。
```

**P04：遮罩上传。** 仅对有明确 mask 能力的目标，分别导入原图和符合该目标约定的遮罩。

```text
只修改遮罩指定区域，将该区域替换为柔和的浅黄色背景，保留其余区域的主体、构图和细节，不添加文字。
```

**P05：中文输入边界 / 输入法 / 多行。** 数量、参数边界另在表单设置；空白提示词直接清空输入，不复制“空白”二字。

```text
生成一张极简海报：蓝色圆形、白色矩形。
中央留白约三分之一；保持清晰边缘。
画面只包含图形，不添加文字。主题意象：春天 🌱。
```

**P06：backend A / scope A 草稿。** 填写后不提交，切换作用域。

```text
生成一张以蓝色圆形为主体的极简海报，背景为白色，中央留白，不含文字。
```

**P07：backend B / scope B 草稿。** 在另一后端或项目填写，用于肉眼区分草稿。

```text
生成一张以橙色三角形为主体的极简海报，背景为米色，中央留白，不含文字。
```

**P08：settings revision conflict 前后的新任务输入。** 冲突操作发生在两个设置视图，不能靠提示词触发。

```text
生成一张绿色与白色相间的几何海报，使用规则网格排列矩形，中心留白，不含文字或标志。
```

**P09：版本链第二次派生。** 在 P02 的输出上再次“继续修改”。

```text
保留当前图片的暖黄色背景和深蓝色主体，将最外侧图形边缘改成圆角，保持中央留白和主体位置不变，不添加文字。
```

## 人工验收矩阵

“预期”是验收标准，不是已经实现或通过的声明。当前不具备前置条件的项明确保留阻塞；测试模式中的显示效果也须实际操作后才能记为 fixture 人工结果。

| ID / 关联07 | 触发 / 前置 | workbench 操作步骤（提示词） | 预期可观察结果 | 桌面 / WebUI 状态 |
| --- | --- | --- | --- | --- |
| M01 / A01 | 旧后端、无 capability 或模块关闭 | 打开独立工作台；查看不可用提示；返回原聊天页 | 明确升级/不可用原因；不反复调用不存在的 image 路由；聊天历史和使用正常 | 待验 / 待验 |
| M02 / A02 | 图像设置；隔离测试连接 | 分别配置 provider_ref 与 independent；保存、重开；秘密只用合成测试值；编辑未保存后离开 | 配置回读正确；仅显示已配置/opaque ref；秘密输入清空且不在公开草稿/错误中出现；离开保护有效 | 待验 / 待验；远程 per-owner settings 阻塞 |
| M03 / A03 | 已验证目标；或明确标识的 fixture | 新建项目；选“文字生成”、count=1；粘贴 P01，生成；打开缩略图及详情原图；刷新 | 资产真实可读；任务与历史一致，实际目标/提示词/参数可见；未知费用显示未知。真实调用须另留收据 | 待验 / 待验；真实平台全部阻塞 |
| M04 / A04、A13 | 支持多图与 edit，至少2个结果 | count=2 用 P01；明确选第二张，点“继续修改”填 P02；再选新图填 P09；查看父图、左右比较、刷新 | 第二张才是首个父资产；形成 A2→B→C；原图不覆盖；request.parentAssetId 与资产 parentAssetIds 一致，刷新保留。不能只看画面相似 | 待验 / 待验；浏览器 fixture 无真实 lineage |
| M05 / A05 | 隔离慢响应/丢回执 fixture | P01；连续点击生成；丢回执后点“核对原请求”；明确再生成另做一次 | 提交中不可重复触发；核对沿用原 key/原请求；明确新生成才用新 key。后台提交次数由 T02 核实 | 待验 / 待验；仅 fixture，不做真实重复扣费 |
| M06 / A06、A17 | 部分失败、401/429、空输出 fixture | P01，触发预置失败；查看错误、保留结果；明确输入拒绝后修改草稿，再用成功模式提交 | 错误可理解；明确拒绝后草稿可编辑；空输出不成功；部分成功保留可查看/导出图片；无虚假0元 | 待验 / 待验；注入见 T03 |
| M07 / A07 | 已有任务与持久化测试 backend | P01 提交后断开客户端网络再恢复；刷新/关闭重开工作台 | 服务端任务不因页面断线取消；从快照和缺失事件恢复；结果不重复，终态不倒退 | 待验 / 待验；harness 刷新重置，不能证明持久化 |
| M08 / A09 | 丢回执/超时 fixture | P01；触发响应不确定；查看“核对原请求”和“明确重新生成（可能再次计费）” | 保留未知状态与原请求；不自动再次计费、不自动切平台；核对与新任务含义清楚。实际超时分类见 T04 | 待验 / 待验；禁止真实故障注入 |
| M09 / A10 | queued、running、已成功三种 fixture | P01；在排队和执行中分别取消；成功后尝试迟到取消 | 排队取消、执行取消效果区分；不支持上游取消时明确 local_only/可能计费；成功不变回取消；迟到图保留且有解释 | 待验 / 待验；调用次数与竞态见 T05 |
| M10 / A11 | 已有可读原图；host 提供导出目的地 | 选 P01 输出，选“下载图片”或“保存到本地工作区”，点“导出当前图片”；检查真实文件；第二次在原生选择器取消 | 原图字节/格式正确；成功仅在实际保存后报告；取消不报成功。Web 下载与本地工作区能力分别记录 | 待验 / 待验；原生 dialog 未验，remote_workspace unsupported |
| M11 / A12 | 两个 schema 不兼容目标/工作流 | 填 P01 和目标参数；切目标；查看并确认“需要调整”的字段；再生成 | 不兼容字段明确列出，不能静默丢弃后直接提交；workflow revision 冻结；禁用目标说明原因且不能执行 | 待验 / 待验；RunningHub 不可强行启用 |
| M12 / A14 | 同一工作区两个受支持 backend | A 中填 P06 并选图/上传；切 B 填 P07；切回 A；观察迟到事件和设置 | 后端、草稿、资产、事件和设置不串；不自动复制秘密；跨后端资产须显式导入复制；导出目的地主机准确 | 待验 / 待验；真实 Gateway/远程导出阻塞 |
| M13 / A13、A15 | 两项目、两工作区；真实两用户须先装配身份 | 分别填 P06/P07；来回切项目/工作区；两测试用户各自打开工作台 | 各自草稿/历史隔离，已移除资产不复活；换 scope 中止旧上传/订阅；不能将“不同草稿”当作后端鉴权证明 | 待验 / 待验；真实多用户阻塞，伪造请求见 T07 |
| M14 / A16 | 真实桌面和窄屏 viewport | 填 P05；中文输入法选词、Enter、Tab；切项目/画廊/详情；拖入测试图；键盘操作生成 | 输入法确认不误生成；焦点与按钮可用；窄屏面板可达；拖入图片角色正确。以实际 viewport 记录尺寸 | 待验 / 待验；全浏览器交互未验 |
| M15 / 输入边界 | 禁用目标、空输入、非法数量/参数 | 空/全空白提示词；再填 P05；数量依次0、负数、小数、目标上限+1；必填缺失、枚举/类型不合法 | 字段错误明确且不提交；数量遵守1—min(16,目标上限)；未知参数不静默忽略。超大输入仅隔离测试 | 待验 / 待验；API 强制校验见 T08 |
| M16 / 上传 | 支持 reference/edit/mask 的目标 | P03：分别导入 PNG/JPEG/WebP；移除再导入；慢上传点“取消上传”；P04 上传原图/遮罩 | 真实图片解码、角色与素材一致；取消或切 scope 后迟到结果不污染新草稿；不支持操作不显示为可用 | 待验 / 待验；超限/伪 MIME 见 T09 |
| M17 / settings revision conflict | 两个设置视图读取同 revision | A 改连接名保存；B 改同连接后保存，处理冲突；重新审阅保存；回工作台填 P08；查看旧任务快照 | B 收到409并保留草稿；显示冲突、允许明确选择，不盲覆写；新保存使用最新 revision；旧任务快照不变 | 待验 / 待验；远程 settings 阻塞；harness 用单页冲突开关注入 |
| M18 / 五平台 live | 指定目标、revision、次数、预算授权及验证入口可用 | 每平台至少一次 P01；有能力的平台追加 P03/P02/P04；异步记录submit→poll→保存 | 真图、可读资产、脱敏收据与真实状态；不支持能力附证据并关闭；验证通过前普通目标继续禁用 | 待验 / 待验；五平台均未 live，URL 闭环阻塞 |

## 自动化专用矩阵

以下关注上游调用次数、持久化边界、HTTP 鉴权和故障注入。测试文件存在不等于当前运行通过；除前述已有专项收据外，**逐项最终复跑状态统一待核验，本次未执行**。所有故障使用 fake Adapter / httptest / fake clock /临时 store，不以真实收费平台试错。

| ID | 触发 / 步骤（生成输入） | 必须断言的可观察预期 | 已有测试入口 / 当前状态 |
| --- | --- | --- | --- |
| T01 成功与 wire | bytes fixture 用 P01 创建任务，读取原图/缩略图，重开 store；比较两端 fixture | `saving` 完成后才成功；资产存在且可读；version/camelCase 一致；未知 usage=null | KB `scheduler_test.go`、`assets_test.go`、`config_test.go`；专项曾通过，最终复跑待核验 |
| T02 幂等 / 重复 | 并发同 scope+key+P01；同 key 改成 P08；不同 scope 使用相同 key | 原请求返回同一 job；冲突409；不会重复 Submit；客户端核对沿用 key，明确新生成才新 key | KB `service_test.go`、backend `image_jobs_test.go`；LA `workbench-ui.test.mjs`；最终复跑待核验 |
| T03 失败 / 部分成功 | P01 count=2；一项成功一项失败；另注入认证、429、空结果 | `partial_succeeded` 保留1张；零输出不能成功；rejected 不自动重提；错误脱敏、usage 不冒充0 | KB `scheduler_test.go`、direct `adapter_test.go`；LA `studio-model.test.mjs`；最终复跑待核验 |
| T04 超时 / uncertain | P01；注入 not_sent/rejected/uncertain、截止时钟、连续查询失败 | uncertain 后 Submit 仍1次；仅核对；保留 handle；超出查询预算为未知；重试受截止限制 | KB `scheduler_test.go`、async `adapter_test.go`/`boundary_test.go`；async 离线收据通过，整合待核验 |
| T05 取消 / 竞态 | P01；queued 取消、运行中取消、取消超时、local_only 与迟到成功交错 | queued Submit=0；如实区分上游取消效果；不把未知当停止；成功不倒退；迟到资产不丢 | KB `TestCancelQueuedDoesNotSubmit`、`TestCancelTerminalRace`、`TestCancelPendingConfirmationAndTimeout`；专项曾通过，最终复跑待核验 |
| T06 崩溃 / 恢复 | P01；在 submitting、handle 落盘、资产提交边界注入退出；重开；制造事件缺口 | 不重提 uncertain；已落盘 handle 继续 poll；WAL 原子；EVENT_GAP 取快照后以快照 seq 续接，不死循环 | KB `recovery_test.go`、`store_recovery_test.go`、backend `image_events_test.go`；LA `workbench-ui.test.mjs`；待最终复跑，浏览器 harness 不覆盖真实崩溃/EVENT_GAP |
| T07 owner/backend scope | P06/P07；注入可信测试 principal；另用户读项目/任务/分页/asset/HEAD/SSE；伪造 owner header、重放委派 | 跨 scope 404/拒绝，不泄漏；委派校验且不能退回 local；缺真实 resolver 默认503；无 per-owner settings 时拒绝配置 | KB backend `image_delegation_test.go`、`image_routes_test.go`；Gateway auth/handler/server image tests；专项通过不代表生产身份装配，真实多用户阻塞 |
| T08 输入边界 / 目标门禁 | P05 与空白；count 0/17/小数；未知字段、非法 schema、禁用目标、越权父资产 | 返回可定位422/相应错误，不 Submit；目标上限进一步收紧；Google/RunningHub 不因 fixture 通过而启用 | KB `request_test.go`、`config_test.go`、direct `limits_test.go`；LA `parameter-model.test.mjs`；最终复跑待核验 |
| T09 上传 / 取消 | P03/P04；临时图构造20 MiB/40 MP边界及超限、伪 MIME、损坏数据；中途取消与换 scope | PNG/JPEG/WebP 实际解码；超限拒绝，无半成品资产；正确原图 hash/512px缩略图；旧上传不污染新 scope | KB `image_content_test.go`、backend `image_assets_test.go`；LA `workbench-ui.test.mjs`；最终复跑待核验 |
| T10 设置冲突 / 秘密 | 两更新同 expectedRevision；合成 secret 写入后冲突/取消/换 scope；旧任务用 P08 | 一个更新成功另一个409；草稿保留并显式解决；秘密不进入公开对象；晚返回不绑定新 scope；快照不变 | KB backend `image_settings_test.go`；LA `image-settings.test.mjs`；已有设置专项通过，新增/最终整合待核验 |
| T11 backend / 草稿 | A=P06、B=P07；替换客户端、切工作区/项目；让旧事件/上传稍后完成 | key 隔离，旧请求 abort；迟到响应不能写新 scope；资产引用不跨 backend 偷渡 | LA `desktop-host.test.mjs`、`drafts.test.mjs`、`navigation.test.mjs`、`workbench-ui.test.mjs`；最终复跑待核验 |
| T12 导出 | P01 原图 fixture；测试落盘、取消、失败、路径边界、远程目的地请求 | 只写授权目标；取消 saved=false；失败不报成功；`remote_workspace` 明确 unsupported | Rust `commands/image_export.rs`：已有8 tests/cargo check通过；LA `desktop-host.test.mjs`；原生 dialog 仍待验 |
| T13 version lineage | P01 count=2→第二张 P02→P09；非法父关系、跨scope、循环；重开 store | 精确 parentAssetId/parentAssetIds；原资产不覆盖；关系恢复；越权/循环拒绝 | KB `TestProjectParentAssetScopeAndCycles`、`TestSchedulerRealOutputAncestryAndUnsupportedURL`；最终复跑待核验，浏览器 fixture 不提供 lineage 证据 |
| T14 URL 输出 | 上游仅返回 URL（P01）；检查保存结果 | 当前明确 unsupported/失败，不假成功、不创建可用假资产；不能宣称下载重试/DNS/跳转策略已实现 | direct `TestContractURLNeverDownloaded`、scheduler URL 用例；下载实现阻塞；fake 下载重试测试不代表真实 downloader |
| T15 GC / 取消删除 / 关闭 | 临时store中构造共享hash、过期上传、unknown、取消后阻塞worker；注入目录/WAL失败；重启并关闭 | 活worker非空lease保护落盘到引用提交，删除busy；worker退出后删除成功且其他项目继续；unknown仅保留自身引用；故障不误删；Close释放writer；二次宽限后才清理 | KB `asset_gc_concurrency_test.go`、GC/取消删除/runtime shutdown相关测试；imaging整包/vet、GC重复10次、runtime/maintenance专项通过；race/cgo与真实断电仍未验证，测试仅临时目录 |

测试路径缩写：KB 未注明 backend/adapter 的文件均在 `internal/imaging/`；LA 测试文件均在 `crates/agent-gui/test/image-studio/`，传输另见 `test/providers/kbrain-image-transport.test.mjs`。源码定位：[工作台](../../crates/agent-ui/src/features/image-studio/ImageStudioPage.tsx)、[输入控件](../../crates/agent-ui/src/features/image-studio/ImageComposer.tsx)、[版本/导出详情](../../crates/agent-ui/src/features/image-studio/ImageDetailPane.tsx)、[Gateway 身份门禁](../../crates/agent-gateway/internal/handler/image.go)、[桌面 host](../../crates/agent-gui/src/agent-ui-adapters/imageStudio.ts)。

## 复跑与收据要求

本节为待执行清单，不是命令通过记录。Go 测试前必须清空继承的 `LIVEAGENT_HOME`、`K_BRAIN_HOME`，将 HOME/USERPROFILE 设为工作区隔离测试目录，使用已安装 Git Bash；离线运行设 `GOPROXY=off`，不得回退到个人配置或外网补依赖。测试自身继续用临时目录，不能用固定 LIVEAGENT_HOME 覆盖测试隔离。

- K-Brain：按07运行 `go test ./internal/imaging/... ./internal/backend ./internal/config ./internal/ai`、`go test ./...`，并复核 `cmd/kn` runtime 集成。每条另记时间、exit code、隔离环境、范围。race 当前有 cgo 工具链阻塞，不能标本地通过。
- LA：按07执行 GUI typecheck/lint/test:frontend/build、Gateway Web lint/test/build、Gateway Go全套、Rust `cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests` 及导出测试。已有局部通过不能代替完整检查。
- 当前基线缺少07列出的 `scripts/check-mirror.mjs`；记录不可用，使用实际存在的 UI 边界检查，不创建空脚本充数。两仓 `git diff --check` 与 required CI 均须最终另附结果。
- 浏览器 harness 只可证明显式 TEST FIXTURE 行为：图片为同一测试画布，成功固定发两张图、不遵守 count；父资产关系为空；刷新/路由导航重置状态；不模拟项目 revision、EVENT_GAP 或导出。不可用它验收真实数量、lineage、持久化或导出，也不能把 fixture 限制写成产品缺陷。
- 真实平台收据补齐调用授权、预算、target/模型/工作流 revision、操作、时间、job/asset ID、结果和已知用量；五平台逐一登记，不从一次真实成功推广其他平台或操作。

收据模板（每一端、每一模式独立填写）：

```text
用例ID：
端：桌面 / WebUI；模式：真实平台 / 隔离fixture / 自动化
LA版本与修改范围：
K-Brain版本与修改范围：
时间与验收人：
backend / 脱敏测试身份 / target revision：
触发与实际步骤：
job / asset ID（如适用）：
实际结果与证据（或命令、exit code）：
usage：未知则null
状态：待验 / 通过 / 失败 / 阻塞待验
阻塞与后续动作：
```

完成门禁仍缺：五平台真实验证及必要官方证据、URL 下载实现与闭环、真实 Gateway principal/per-owner settings、所需远程导出能力、最终自动检查、桌面/WebUI 全交互和用户明确验收、双仓版本匹配及 required CI。本文不触发 stage、commit、worktree、PR 或发布，也不把文档完成视为 Goal 完成。
