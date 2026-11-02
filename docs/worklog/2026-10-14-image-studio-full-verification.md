# 2026-10-14 按计划推进：完整回归与浏览器验收

继续原Goal与原任务分支，未提交/推送/PR；保留用户.gitignore和其他未跟踪内容。RollDek账本保持8/50保守占用、2张确认生成、其中1张完成资产闭环，本轮未发新的收费请求。

## 按计划编号的实际状态

| 计划 | 已有证据 | 尚未完成 |
| --- | --- | --- |
| 00 协议核对 | 五份官方证据记录；OpenAI公开OpenAPI摘录；RollDek官方与HTTPS2.5实测 | OpenAI规范内部冲突；其他平台真实账号/模型/工作流条件未验；不能填全部通过 |
| 01 配置/契约 | 独立连接/目标/秘密引用、wire、验证任务与真实RollDek证据 | RunningHub生产graph配置来源须补设计/实现，现有范围不得隐式扩展 |
| 02 存储/资产 | WAL/快照、scope、原图/缩略图、GC、URL安全保存与真实原图hash | 实际断电/race测试未做 |
| 03 引擎 | 去重、恢复、取消、部分成功、unknown和真实任务成功 | 真实异步平台恢复验收缺条件 |
| 04 适配 | direct/async静态测试、生产OpenAI/Google/方舟/即梦接入、RollDek闭环 | RunningHub Adapter未在cmd/kn production factory注册；缺API-format graph与回调配置；即梦/RunningHub验证入口未完成 |
| 05 接入 | 两端client、单人loopback Gateway、可信identity endpoint、导出 | 单人生产GUI实际交互、远程导出非首版支持；不声称多用户 |
| 06 工作台 | 共享设置/验证面板/持久化草稿、取消/失联真实浏览器fixture | 原生Tauri实际验收、移动viewport、完整矩阵仍未完成 |
| 07 验收/发布 | 相关包和构建通过，完整WebUI回归通过，Rust check通过 | 完整GUI最后轮结果待读回；K-Brain全仓失败归因与平台缺口；人工通过、提交PR/CI未完成 |

状态按类型/源码/测试/实测分别判断，不仅按计划中未勾选数量判断。原计划描述目录与检查脚本可能已变，以当前代码为准。未将所有步骤批量勾选。

## 回归修复

完整GUI逐批暴露Windows测试基础问题：URL.pathname在Windows变成/D:/...，loader再拼D盘；源码提取期待LF结束行；Tailwind/PostCSS from使用错误文件URL；Rust预设对比受CRLF影响。这些均在既有测试中复现，改测试路径为fileURLToPath，源码比对只归一化换行，不改聊天/UI业务。

涉及test/chat/conversation-search、floor-nav-scroll、standard-overlays、mention-composer-selection、mention-refetch；test/settings/popup-transition-properties、style-theme、style-token-contract、provider-usage-query-form、prompts-backend。定向分别6/6、18/18、14/14通过。

测试helper kbrain-binary新增显式LIVEAGENT_KBRAIN_BINARY绝对路径入口。本轮指定当前子仓源码编译的.liveagent/image-studio-build/k-brain.exe；发行锁定fallback保持，用于实际打包而非本地验收。prompt夹具另使用公共workspaceProjectPathKey读取持久化项目配置，修复路径键错误；真实K-Brain/上游模拟服务路径1/1通过（2.177s），不是真实收费平台。

轨迹夹具默认Windows shell运行POSIX命令导致失败；指定Git Bash并使用最新源码后7/7通过：实际Go Agent/provider/bash/SSE→认证HTTP→原始轨迹ledger/layout；实际子任务→嵌套工具布局。未把第一次完整测试失败隐藏。

## 完整检查实际结果

- WebUI pnpm test：独立完整运行exit0，两个批次563+224，共787项通过，无失败。
- GUI pnpm test:frontend：最终指定源码binary/Git Bash的shell a6bd9062-1779-490a-8f37-2a4a78de50d3完整命令exit0。可见末四批773/773、592/592、539通过+1跳过、689/689，无失败；shell超过200000字符后前面缓冲被丢弃，不能从当前归档重建全部批次总数。不为统计数字重复已成功检查；记录exit0和已可见数量，不宣称总数就是2594。一个跳过未当通过，后续验收列明。
- K-Brain go test ./...：失败。全局Git Bash适合backend/config，却破坏Windows原生命令fixtures。改为默认Windows shell后cmd/kn20.483s、bashrun13.706s通过；tools三项LiveAgent/POSIX fixtures和tui Unicode链接仍失败。它们不在当前图像diff中，但仍需记录基线证据/处理策略，不能当全仓绿。
- cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests：第一次cargo不在PATH未启动；使用已安装C:/Users/AlphaCat/.cargo/bin/cargo.exe后exit0，20.50s，12条unused/dead-code warnings保留。没有cargo fix无关文件。

## 真实浏览器fixture验收

工具访问仅授权127.0.0.1:18473，成功打开真实ImageStudioPage，不访问个人账号。临时服务有运行寿命，本轮由5d0f4001-c572-4c9a-a37a-931139c0ef98运行，验收后停止自身服务。

- 新建acceptance-project，有实际POST /projects与对应项目history GET。
- Lost receipt模式：第一次POST后提示提交响应未确认并保留草稿；点击核对后POST使用完全相同幂等键与冻结payload，恢复同一fixture job、显示已完成，两张thumbnail实际解码。不是只有工具click success，也不是生成两次新任务。
- Pending模式：明确确认新意图→运行中→点击取消，audit有POST /jobs/job-2/cancel，UI显示已取消/0结果；已有成功结果仍保留。
- 当前1024px窗口呈现窄屏页签。未取得手机viewport证据，不把窄容器当手机模拟。夹具固定两图、不实现全部版本/导出/权限，不能替代生产双端和原生人工验收。

## 原生隔离与外部条件

history_db_dir直接dirs::home_dir，其他启动服务有同类读写；HOME/USERPROFILE在Windows不能保证覆盖系统dirs解析。已读源码确认此问题，不启动到个人目录假装隔离。需要明确的完整开发数据根接入后再运行Tauri；只有Rust check不算窗口验收。

RunningHub需用户实际工作流ID、API-format图与输出映射/可用回调，不能用文档样例替代。真实收费授权目前只RollDek，其他平台不能静默调用。继续实现可独立部分，再给用户具体可审阅验收包；人工通过前不提交。
