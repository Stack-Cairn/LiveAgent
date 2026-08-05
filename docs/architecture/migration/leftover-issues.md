# 迁移遗留问题清单(阶段 1–6)

**状态:🟡 持续维护**。汇总六个阶段执行记录中所有未解决的遗留问题。
已随后续阶段自然消解的(如阶段 4 记录的 gateway 侧死代码,随阶段 5/6 整体删除)不再收录。
每条给出:来源 / 影响 / 建议处置。

## 一、阻塞验收

这些直接与 [phase-6-cutover.md](phase-6-cutover.md) 的验收标准冲突,不解决无法收尾。

### 1. 桌面壳无法连接远程后端

- **来源**:阶段 6 文档重写时发现。`crates/agent-gui/src-tauri/src/commands/app/backend.rs`
  的 `get_backend_endpoint` 只返回内嵌后端端点(host 恒为 `127.0.0.1`);前端
  `lib/backend/endpoint.ts` 在壳内只走 `askShellForEndpoint()`,没有填写远程地址的入口。
- **影响**:验收标准「Docker 跑 headless 后端,笔记本上的桌面端连过去」当前实现不支持,
  远程访问只有浏览器一条路。
- **处置**:要么在壳内补远程地址入口(登录页在壳内也可达),要么改验收标准明确
  「桌面壳 = 本地内嵌后端,远程一律走浏览器」。需要人拍板。

### 2. 容器数据落点未验证,重建可能丢数据 —— 已解决

- **来源**:阶段 6。`crates/agent-core/src/storage.rs` 用 `dirs::home_dir()` 解析
  `~/.liveagent`,而 `Dockerfile` 把 runtime 用户建成 `--home-dir /nonexistent`,
  镜像也没有为数据目录预留卷。
- **影响**:CI smoke 绿只说明进程能起,数据可能落在未挂卷路径,容器重建丢
  设置库/历史库/记忆文件。
- **处置(已完成)**:`storage.rs` 支持 `LIVEAGENT_DATA_DIR` 环境变量,后端加
  `--data-dir` 参数;Dockerfile 预设 `LIVEAGENT_DATA_DIR=/var/lib/liveagent`、
  建目录并 `VOLUME`;deployment.md 已写明挂卷路径。

### 3. 端到端验收整体未跑

- **来源**:阶段 4(「验收标准一条都没实跑」)、阶段 5(「手工冒烟未跑;`make dev` 未跑」)、
  阶段 6(桌面端+浏览器连 headless 后端全功能验证、旧桌面端连旧 gateway 镜像的兼容验证均未做)。
- **影响**:README「已知风险」明确记录过「757 测试全绿但 `make dev` abort」的先例,
  只在真实启动路径上跑的代码测试套件看不到。
- **处置**:按 phase-6-cutover.md 的端到端清单逐项过:history / settings / terminal /
  上传 / git review / skills / memory / cron / chat(冷启动 / 长挂起 / 断网重连),
  桌面与浏览器各一遍;`make dev` 必须真跑。

### 4. 镜像体积与启动时间对比未记录

- **来源**:阶段 6 验收标准(决策 3 的已知代价要「记下来而不是假装没有」);
  Docker 镜像本身也从未真实构建过(CI 未跑)。
- **处置**:真 build 一次,记录与 Go 版镜像的体积/启动时间对比。

## 二、功能缺口

### 5. Docker 镜像只发 amd64,arm64 退化

- **来源**:阶段 6 CI 切换。旧 Go 版靠 GOARCH 白送交叉编译;Rust 依赖链有
  `aws-lc-sys`,交叉编译需 cmake + aarch64 工具链。Dockerfile builder 阶段
  `--platform=$BUILDPLATFORM` 且 `cargo build` 未传 `--target`,照原样推 multi-arch
  会复现 v0.1.0–v1.1.8「标着 arm64、装着 x86-64 二进制」的事故,故只发 amd64
  并保留架构校验。
- **处置**:Dockerfile 接交叉编译工具链后恢复 arm64。

### 6. `openChatFileLink` 在浏览器里是「报错」不是「隐藏」

- **来源**:阶段 5。聊天消息里的文件链接是内联渲染元素,没有可门控的菜单入口,
  浏览器里点击弹一句中文错误。真隐藏要在渲染层把链接降级成纯文本。
- **处置**:改动大收益小,维持现状;若做,归入前端渲染层。

### 7. `docs/operations/multi-agent.md` 只加了废弃横幅

- **来源**:阶段 6 文档重写。整篇基于已删除的 Gateway 每-Agent 凭证模型,
  未按新架构重写。
- **处置**:新架构下多前端连同一后端的模型定稿后重写,或直接删除。

## 三、技术债

### 8. 后端不读环境变量,靠 entrypoint 薄壳翻译 —— 已解决

- **来源**:阶段 6。`agent-backend` 只认 argv(main.rs 无一处 `env::var`),
  容器场景靠新增的 `scripts/docker-entrypoint.sh` 把
  `PORT` / `LIVEAGENT_BACKEND_PASSWORD` / `LIVEAGENT_TLS_CERT+KEY` 翻成 argv。
- **影响**:能用,但属架构欠账;所有容器平台的配置都多绕一层 shell。
- **处置(已完成)**:main.rs 读 `PORT` / `LIVEAGENT_BACKEND_PASSWORD` /
  `LIVEAGENT_TLS_CERT+KEY` / `LIVEAGENT_ENGINE_BUNDLE` / `LIVEAGENT_DATA_DIR`
  (argv 优先),`scripts/docker-entrypoint.sh` 已删,ENTRYPOINT 直指二进制。

### 9. Makefile 既有 bug 两处

- **来源**:阶段 6 CI 切换时发现,与迁移无关故未动。
  - `MODEL_CATALOG_GENERATED_FILES` 未定义(用于 `github-release-main`):展开为空后
    `git diff --quiet --` 比对整个工作树、`git add` 无 pathspec,发版流程可能在
    不该提交的时候提交。
  - `clean` 目标为空,但 `help` 声称清理构建产物。
- **处置**:改它等于改发版行为,需要人拍板后修。

### 10. `backend_server.rs` 的 4 个阶段 5 遗留 warning

- **来源**:阶段 6 `cargo check` 记录。3 个 unused import(`SocketAddr` / `PathBuf` /
  `Arc`,行 9–11)+ 1 个 never-read 字段(`BackendServer::engine`,行 22)。
- **处置**:顺手清;`engine` 字段先确认是否为将来接线预留。

### 11. 前端残留的 gateway 旧称与旧文件

- **来源**:阶段 5/6。
  - `crates/agent-gui/src/pages/chat/gateway/` 仍有 7 个文件
    (chatRuntimeSnapshot / gatewayBridge* / useGateway* 等),命名与部分逻辑
    沿用 gateway 时代。
  - `src/lib/managed-process/backend.ts:4` 与 `src/lib/automation/backend.ts:4`
    注释仍写 "the gateway process.* / cron.manage protocol"(仅措辞旧,无悬空引用)。
- **处置**:重命名/收编进 `lib/backend`,注释顺手改;不影响构建,低优先。

### 12. `protobufjs` 仍在依赖树里

- **来源**:阶段 6 删除清单核查。它不是直接依赖,链路是
  `@earendil-works/pi-ai` → `@google/genai` → `protobufjs`;
  `pnpm-workspace.yaml` 的 `allowBuilds: protobufjs` 是给这个传递依赖的
  安装脚本放行的,删掉会让 pnpm 报「构建脚本被忽略」。
- **处置**:无法本仓库解决,等上游 `pi-ai` 依赖变化;保留放行配置。

### 13. `settings_save_remote` 的「部分删除」分类缺陷

- **来源**:阶段 1「遗留缺陷」。`RemoteSettingsPayload` 混了两类字段,
  gateway 相关字段随 Gateway 删除,web 权限开关仍需要;计划阶段 4 拆成两半,
  已记入 `backend-boundary.md`「已知分类缺陷」。
- **处置**:✅ 已核对完成(阶段 4 P4-08)。`RemoteSettingsPayload`
  (`agent-core/src/commands/config/settings/types.rs`)与前端 `RemoteSettings`
  (`agent-gui/src/lib/settings/index.ts`)都只剩 `enabled` + `enableWeb*` 权限开关,
  gateway 连接字段已删,旧库遗留键由 serde 默认行为忽略。
  backend-boundary.md 的「已知分类缺陷」一节已销记。

### 14. 根 `.gitignore` 的 `bin` 条目来历不明

- **来源**:阶段 6 删除时发现,疑为 gateway 二进制遗留,但条目太通用怕误伤未删。
- **处置**:确认无人依赖后删除。

## 四、待验证

### 15. 浏览器端门控从未实测

- **来源**:阶段 5(「门控全部是静态推导 + tsc 保证,未在真浏览器里点过」,归入 P5-08)。
  探测在模块顶层求值的 `FILE_TREE_HAS_OS_INTEGRATION` 理论上不受加载时序影响,
  但没有实测背书。
- **处置**:并入第 3 条的端到端验收,浏览器逐项点一遍壳能力降级点。

### 16. 20 个脆测试的改写效果

- **来源**:README 已知风险(P5-05)。阶段 5 报告已改写或删除且 1371/1371 绿,
  但改写后的测试是否真验行为(而非换一种方式断言源码文本)未复核。
- **处置**:抽查改写后的测试,确认删掉被测行为时测试会红(变异验证)。

### 17. 新 CI 与 Docker 构建本身未真跑

- **来源**:阶段 6。ci.yml / backend-docker.yml 只过了 YAML 解析与 `bash -n`,
  Docker 三阶段构建、entrypoint 五种参数组合只在 stub 上验过。
- **处置**:推分支看 CI 首跑;本地 `make backend-docker-build && make backend-docker-smoke`。
