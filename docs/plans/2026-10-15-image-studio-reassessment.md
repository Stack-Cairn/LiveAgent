# 生图功能恢复与开发方案复审（2026-10-15）

## 本次结论

继续采用 K-Brain 执行图像任务、agent-ui 共享工作台、桌面和 Gateway 提供宿主 I/O 的架构。恢复与变基不代表五个平台均已验收，也不代表具备发布条件。本次仅恢复既有开发、同步上游和评审方案，不新增付费调用或发布。

原实施文档入口为 [2026-10-11 图像工作台](2026-10-11-image-studio/README.md)。本文补充恢复后的实际状态及后续顺序，不改写历史验证记录。

## 恢复与基线

| 仓库 | 最新上游基线 | 变基后开发提交 | 未提交代码 |
| --- | --- | --- | --- |
| LiveAgent | upstream/v2-kbrian，7d431fea49e088a42e3fad2c22639162f2112950 | 39f8f0b0、22daf31c | 从生图暂存 5908aa3b43d4ace34ff680c91dc936062afc4739 恢复 |
| K-Brain（工作区内子仓） | upstream/main，ac3cbe6 | b1fe9f0、ea258ef | 变基前另存暂存，变基后连同原暂存区状态恢复 |

LA 当前分支 feat-image-studio-v2；K-Brain 当前分支 feat-image-studio。两仓均建立 backup/image-studio-before-sync-20261015 或 backup/image-studio-before-restore-20261015 备份分支，保留旧 stash。LA 的上下文压缩任务 stash 没有应用；当前已有未跟踪文档保持保留。恢复后 LA 与原生图 stash 的源码差异仅来自上游新增的 relay/client/测试和发行 pin。

## 对旧方案的修订意见

1. **保留图像引擎与聊天隔离。** 配置、秘密、任务、事件和资产继续由 K-Brain 管理；前端不执行平台签名，不自行轮询供应商，也不将秘密放进草稿。当前恢复不需要重做架构。
2. **以最新设置入口为准。** 图像连接放在供应商设置的图像服务子页；模型或工作流目标放在创作输入区的目标设置。06 中早期“独立图像设置页”应按其 2026-10-14 修订理解，后续文档不再以独立导航作为交付要求。
3. **平台接入按生产路径判断。** 当前 cmd/kn/backend_images.go 的 resolveImageAdapter 已有直接平台与即梦分支，但未注册 RunningHub Adapter。存在 runninghub_model.go 与单测不等于生产工作流可用。下一步先明确模型接口和工作流接口各自的配置、验证和调度路径；工作流仍需要 API-format graph、输出映射及实际可用条件，缺材料时保持禁用。
4. **区分图片预览与导出。** ImageDetailPane 使用默认 AssetImage，显示缩略图；ImageCompareView 显式请求 original。原图下载 API 和原生导出测试已有历史证据，不能据此声称系统保存对话框已人工通过。应分别验证详情、比较、原图导出与取消保存。
5. **明确 Gateway 支持边界。** 当前单用户 loopback 范围不能当作多用户隔离完成；远程导出也不能因类型中存在目的地就宣称可用。原 07 的跨用户 A15 与远程导出场景继续保留为目标，发布前必须明确实现并验收，或取得明确范围调整。
6. **更新检查入口。** 当前没有 scripts/check-mirror.mjs，共享 UI 约束由 scripts/check-ui-boundaries.mjs 检查。双端类型检查、构建和专项测试仍必须分别运行；边界检查不替代构建。旧文档命令不应直接当作本轮通过收据。
7. **保留历史证据的时间边界。** RollDek 的历史成功资产、RunningHub 的 unknown、既有账本均不因恢复清零。本次没有真实平台调用，旧截图不能代替本次新基线的原生验收，也不能将旧回归全部记成本次通过。

## 后续实施顺序

1. 固定本次双仓基线，完成恢复后专项测试、双端类型检查与构建、Rust 检查、共享边界检查、差异卫生检查。任何失败单独列出，不用历史通过覆盖本次失败。
2. 收敛 RunningHub 模型和工作流生产注册、验证入口与配置契约；使用 fake 平台验证提交、轮询、取消、超时、结果未知和重启恢复。需要平台材料的工作流项明确阻塞，不能填成已完成。
3. 用最新 K-Brain 源码重新编译启动隔离 Tauri，验证供应商图像服务、目标弹窗未保存保护、项目恢复、生成与编辑、原图比较、系统保存和取消保存。保留现有客户端和个人数据，端口冲突时使用独立端口。真实平台调用仍需按授权和剩余预算执行。
4. 完成双端人工矩阵，包括重复提交、部分成功、失败、取消、失联恢复、后端切换、窄屏与中文输入法；用自动化注入扣费风险和身份伪造场景，不要求用户真实重复扣费。
5. 补齐五平台证据和当前生产支持矩阵，再决定发行版本依赖；用户人工验收通过后，按双仓规则提交、PR 并追踪 required CI。

## 验证记录

| 检查 | 本次结果 |
| --- | --- |
| 生图专项 Node 测试 | 118/118 通过，无跳过；覆盖桌面工作台、WebUI 图像宿主、共享 client 和桌面传输 |
| GUI / WebUI | 两端标准 build 均退出 0，包含各自两套 tsconfig 类型检查及 Vite 生产构建 |
| Gateway | internal/handler、internal/kbrain、internal/server 全部通过 |
| K-Brain 图像引擎 | internal/imaging 及 direct、async Adapter 包通过 |
| K-Brain 生产图像接入 | cmd/kn 的 Image/Imaging 定向测试通过，0.398s |
| K-Brain backend | 补齐 Windows 子进程 PATH 后完整包通过，28.281s；首轮 Hook/自动终端失败及定向复测保留在日志中 |
| Rust | cargo check --tests 通过；显式使用本机既有 PROTOC，保留编译警告 |
| UI 边界及 Git 卫生 | check-ui-boundaries 通过；双仓已暂存/未暂存 diff --check 均通过 |
| 差异 lint | 未通过：ui 32 个格式错误、gui 11 个格式错误、webui 8 个格式错误；ui 另有 useIndexOf info。未运行格式自动修复 |
| 上游祖先与恢复完整性 | 两仓最新上游均为当前 HEAD 祖先；与恢复用 stash 比较，图像源码无丢失，差异均为新增上游文件 |

复现命令：

```bash
node --test crates/agent-gui/test/image-studio/*.test.mjs crates/agent-gui/test/providers/kbrain-image-transport.test.mjs crates/agent-gateway/web/test/image*.test.mjs crates/agent-ui/src/lib/imaging/*.test.mjs
pnpm --dir crates/agent-gui build
pnpm --dir crates/agent-gateway/web build
go -C crates/agent-gateway test ./internal/handler ./internal/kbrain ./internal/server
go -C .liveagent/subprojects/K-brain test ./internal/imaging/...
go -C .liveagent/subprojects/K-brain test ./cmd/kn -run 'Image|Imaging' -count=1 -timeout=90s
go -C .liveagent/subprojects/K-brain test ./internal/backend -count=1 -timeout=120s
cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests
node scripts/check-ui-boundaries.mjs
LIVEAGENT_CHECK_BASE_REF=upstream/v2-kbrian node scripts/check-biome-changed.mjs ui
LIVEAGENT_CHECK_BASE_REF=upstream/v2-kbrian node scripts/check-biome-changed.mjs gui
LIVEAGENT_CHECK_BASE_REF=upstream/v2-kbrian node scripts/check-biome-changed.mjs webui
```

工具启动环境的 PATH 被裁剪，首次标准构建找不到嵌套 pnpm/node，首次 Rust 检查找不到 protoc；本轮仅在命令进程内补齐本机已安装工具路径，未修改项目依赖或全局配置。带完整 cmd/kn 包的首次较大范围检查长时间未返回，已主动终止，不计为通过；生产图像路径另行定向执行通过。没有运行两仓全仓测试，也没有重跑全部人工矩阵。

日志保存在 .liveagent/image-restore-*.log：tests、gui-build、web-build、gateway-tests、kbrain-tests、kbrain-env-retest、kbrain-backend-retest、kbrain-cmd-image、rust-check 以及 ui/gui/web-lint。格式问题列入下一轮修复，不能称 lint 通过。

本次未启动原生客户端、未进行收费调用、未创建新实现提交、未推送或创建 PR。

本文按本地 shuorenhua 技能审稿，保留事实、条件、责任主体和未完成状态。

## 2026-10-15 独立客户端复审及 Draft 提交

用户新增授权：重新检查 K-Brain 独立客户端兼容性，然后提交并推送 Draft PR，保留后续验证和评审；此次不再等待人工验收才创建 Draft，不将其视为可合并状态。

K-Brain 新增无图像模块情况下的真实聊天 HTTP/SSE 回归，并从源码构建独立 CLI。实际 backend 进程验证空配置、图像存储路径损坏两种场景：health/会话 API 正常，后者仅图像 API 返回 503，两者均正常退出。更详细的范围、证据和限制见 K-Brain 仓库 docs/image-standalone-review-2026-10-15.md。

全仓 Go 测试实际结束但失败；独立 Agent、backend、config、storage 和图像模块包通过，cmd/kn、planning、tools、tools/bashrun、tui 的失败仍需区分环境和基线。没有将文件未改动作为所有失败无关的证明。独立 TUI 人工验收仍待完成。

本轮修正生图前端差异文件格式，ui/gui/webui 差异 lint、118 项生图专项和双端标准 build 全部通过，更新此前“格式错误未修复”的阶段状态。未修改用户 .gitignore 和本地启动脚本。两个 PR 均要求保持 Draft。

### Draft PR 与 CI 修订

已创建 K-Brain Draft #35 与 LA Draft #988，两个正文均以 UTF-8 从 GitHub 逐字读回核对。K-Brain 原生 Shell 的五个残余失败用例通过 Go -overlay 恢复上游 94 个 Go 文件后全部复现；该证据只覆盖这五项，并不替代 TUI 人工验收或宣称全仓测试通过。

LA 首轮 CI 暴露 WebUI 浏览器下载辅助函数引用桌面源码、Gateway errcheck 以及供应商页旧精确文案断言。已将浏览器通用下载逻辑移动到 agent-ui，桌面保留兼容导出，WebUI 不再依赖桌面源码；显式忽略响应关闭错误；供应商页回归验证原界面与新增页签共同存在，保留原 props 和无额外后端请求断言。下载/宿主 9 项、供应商设置回归、Gateway 相关包、共享边界及两端构建重新通过。CI 最终结果以 PR 检查为准。

## 2026-10-15 合并前修订

原生 manager 以 canonical data root 的 SHA-256 生成不含原始目录或凭据的 storageId。桌面图像草稿、未确认提交和验证收据使用该稳定身份；传输仍绑定当次 URL/token，端口和 token 变化不会改变持久化 namespace，不同数据根/工作区继续隔离。缺失托管身份时拒绝创建图像 host，不回退到随机端口存储。未自动合并开发版旧端口 namespace，因为无法可靠证明属于同一数据根。

macOS 验证：Rust data-root 身份测试（含目录别名和不同根），原生 manager 回归、GUI TypeScript、前端全量测试；Chrome 1440/390 视口直接使用生产 desktop host 和共享工作台模拟重启换端口，恢复草稿并以原 frozen request/key 核对未知提交。模拟 transport，不含真实供应商调用或原生保存对话框验收。

合并不等于发布：当前后端锁保持已发布 beta.11；需在配套 KB #35 发布后更新版本锁，才能在发行安装包启用图像模块。
