# 07：双仓集成、验收与发布实施计划

> 执行者逐任务勾选，优先使用 subagent-driven-development 或 executing-plans；不可用时按本文执行。提交、推送、PR只在项目门禁和用户验收满足后执行。

**Goal：**让K-Brain和LA的图像能力在同一版本契约下通过自动化、真实平台与桌面/WebUI人工验收。

**Architecture：**先集成fake上下游，再做五平台真实调用。dev用最新源码，发行用已验证版本pin；保留旧后端和聊天回归。

**Tech Stack：**Go测试、TypeScript/React构建、Rust check、Tauri dev、Gateway WebUI、现有CI与发布脚本。

**Spec：**[统一规格](design.md)，前置00—06及README覆盖矩阵。

## 全局约束

授权文档≠授权收费调用或发布。真实调用次数/预算明确，缺条件单独报告，不缩小总目标。不得用发行锁定旧二进制验收已合入的K-Brain修复。已有用户修改不得入提交。所有提交与PR描述中文。

## 文件地图

LA修改 `scripts/release/kbrain.lock.json`（仅发行集成）、按需修改 `scripts/release/prepare-kbrain.mjs` 和已有packaging测试；新增 `docs/testing/image-studio-acceptance-2026-10-11.md`，记录实际结果不是预填通过。

K-Brain新增 `internal/backend/image_integration_test.go`；LA新增 `crates/agent-gui/test/providers/kbrain-image-contract.test.mjs`、Gateway `test/websocket/v2_image_scope_test.go`（只有实际使用WS envelope时；否则采用HTTP集成测试路径，不能硬造WS协议）。日志、截图仅按验收需要且脱敏，不存平台原始秘密响应。

## Task 1：实施前与版本契约

- [ ] 各仓读实际AGENTS/全局规则，确认目标和源码状态。LA `/goal`建议目标：实现独立K-Brain图像任务引擎与LA共享设计工作台，覆盖五个平台已选官方产品、同步/异步/工作流、持久化恢复、取消幂等、权限和双端验收，完成自动检查、人工验收及required CI。
- [ ] 检查旧活动Goal是否同目标；不一致不替换。按各仓上游约定建立新任务分支，用户已有修改原样保留。
- [ ] 记录实现基线SHA、协议version、Adapter证据日期。LA客户端capability先判断再使用image端点，旧后端退化提示升级而不是应用崩溃。
- [ ] 首先跑fake直接/异步全链路，确认至少一条结果成功保存并在桌面和WebUI读取。

## Task 2：自动检查

在K-Brain根运行：

```powershell
go test ./internal/imaging/... ./internal/backend ./internal/config ./internal/ai
go test ./...
git diff --check
```

支持race的工具链追加 `go test -race ./internal/imaging/... ./internal/backend`。不支持时记录环境限制，在CI执行，不冒充本地通过。

在LA根运行：

```powershell
pnpm --dir crates/agent-gui typecheck
pnpm --dir crates/agent-gui lint
pnpm --dir crates/agent-gui test:frontend
pnpm --dir crates/agent-gui build
pnpm --dir crates/agent-gateway/web lint
pnpm --dir crates/agent-gateway/web test
pnpm --dir crates/agent-gateway/web build
go -C crates/agent-gateway test ./...
cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests
node scripts/check-mirror.mjs
git diff --check
```

- [ ] 保存每条命令的exit code、时间与失败原因，未运行列明。
- [ ] 契约fixture两端一致，确保POST重复不加上游提交次数，GET恢复不漏event，权限检查包含全部分页和asset读取。
- [ ] 新增错误测试必须测可观察结果，例如unknown后Submit仍1次、跨owner读取404、部分成功asset数为1；不能仅测内部flag。

## Task 3：真实平台验证

- [ ] 列出五平台所选产品、目标ID、连接身份、模型/工作流revision、次数和预算；获得真实调用授权。
- [ ] 每平台至少生成1次；支持参考/编辑的平台追加1次对应操作。不支持的能力显示关闭并附官方证据，不能为了矩阵好看伪造支持。
- [ ] 异步平台验证submit→poll→下载，保存durable handle后重启再poll；是否支持上游cancel按真实证据显示。
- [ ] 记录仅含目标/时间/本地job/asset/操作/结果/已知用量的收据；usage未知为null。截图不包含凭据和签名下载URL。
- [ ] 任一平台没有官方接口、凭据、额度或工作流材料时记录具体阻塞与可继续任务；五平台全部交付不能标完成。

## Task 4：桌面/WebUI人工验收

本机调试入口现有 `start-tauri-dev.bat` 与 `.liveagent/dev-run.sh` 应在执行前核对。用户当前偏好通过以下命令启动最新源码K-Brain；如果脚本不满足AGENTS指定入口，先修复本地入口衔接，不使用旧binary绕过：

```powershell
& "C:\Program Files\Git\bin\bash.exe" "D:/Documents/Projects/Web/LiveAgent/.liveagent/dev-run.sh"
```

该脚本先构建最新源码K-Brain，启动失败查看 `.liveagent/dev.log`。本地脚本保持忽略，不跟踪提交；服务启动按用户规则不设运行寿命上限，观察使用blocking output读取而非长sleep。

同一验收矩阵桌面和WebUI分别记录结果：

| ID | 操作 | 预期 |
| --- | --- | --- |
| A01 | 旧后端打开设计入口 | 明确升级提示，聊天正常 |
| A02 | 配置引用Provider与独立连接，保存后重开 | 网络配置正确，secret只显示已配置 |
| A03 | 创建项目，输入“生成一张蓝色几何风格海报，中央留白” | 真实图片保存、缩略图及原图可读 |
| A04 | 从多图结果选第二张，输入“保留构图，将背景改成暖黄色” | 新资产父关系准确，原图不覆盖 |
| A05 | 双击生成或同key重发 | 一个job，收费提交不重复 |
| A06 | batch其中一项失败 | 成功图片保留，部分成功可操作 |
| A07 | 提交后断网络再恢复 | 历史快照与缺失event恢复，任务不因页面断开取消 |
| A08 | 异步handle保存后重启后端 | 继续查询，Submit次数不增加 |
| A09 | 注入提交后响应超时 | 结果未知，明确核对/重新生成选项 |
| A10 | 排队和执行中分别取消 | 排队不调用；执行按上游能力显示真实效果 |
| A11 | 导出原图后用户取消第二次导出 | 第一次真实保存，取消不报成功 |
| A12 | 切换模型或工作流，参数不兼容 | 具体字段调整提示，不静默丢失 |
| A13 | 建立两个版本并比较，刷新页面 | 图片与版本关系恢复，草稿按项目隔离 |
| A14 | 同一工作区切本地和远程后端 | 图片和draft不串，导出发生在所选主机 |
| A15 | WebUI第二用户读取第一用户asset ID | 无权限404，不泄漏图片 |
| A16 | 中文输入法、键盘操作、窄屏、拖入图片 | 操作可用，生成按钮无误触 |
| A17 | 认证失效/限流/无图片响应 | 可操作错误，没有虚假完成或0元费用 |

A05计费次数、A06故障、A08/A09中断和A15伪造身份应通过测试模式或自动化注入，不诱导用户真实反复扣费。人工无法触发的项在结果文档注明自动化专用，附实际命令与结果；其余给实际UI步骤。真实调用和fake用例分开记录。

## Task 5：兼容、发行与回滚

- [ ] 图像配置缺省不改变聊天路由与旧历史；新增字段旧客户端忽略。
- [ ] 新客户端遇到旧K-Brain隐藏功能；新K-Brain遇到旧LA仍正常聊天；protocol major不匹配禁止图像执行。
- [ ] 已验证K-Brain版本发布后再更新LA发行lock及packaging检查。开发模式仍最新源码，不用lock代替本地验收。
- [ ] 模块可关闭：停止新任务接受、保留历史和资产、已有任务按既定恢复策略保存。不能通过删除目录实现回滚。
- [ ] store格式version未知时只读诊断，不由旧binary覆盖；回滚到不支持图像的版本前保留数据目录和备份，恢复原版本可读取。

## Task 6：用户验收后提交与CI

- [ ] 将自动检查、平台矩阵和人工步骤交给用户，等待明确验收通过。
- [ ] 按AGENTS逐项确认忽略本地启动脚本，staged diff仅本任务内容；不添加已有未跟踪历史设计或研究。
- [ ] 建议K-Brain提交标题：`新增独立图像任务引擎与多平台协议适配`；LA标题：`新增双端共享图像设计工作台与引擎接入`。PR列版本依赖、验证、未运行项、真实平台范围和风险。
- [ ] 按实际stack规则建立提交依赖；跨仓依赖用发布版本/commit引用表达，不假造Git祖先关系。
- [ ] 创建PR后追踪required CI至终态；本次改动失败修复、复测、追加提交；外部阻塞给证据，不擅自修改无关代码。

**最终完成条件：**00证据/04接入真实验收、全部自动检查、双端人工验收、双仓版本匹配与required CI齐全。未完成项明确列出，不以“已搭建框架”代表全部支持。
