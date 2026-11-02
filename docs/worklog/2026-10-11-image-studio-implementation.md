# 图像工作台实施记录

日期：2026-10-11。对应目标：按 `docs/plans/2026-10-11-image-studio/` 完成 K-Brain 独立图像任务引擎与 LiveAgent 桌面/Gateway WebUI 共享工作台，完成官方协议核对、真实平台验证、自动检查及人工验收；用户通过后提交、创建 PR 并跟踪 required CI。

## 当前状态

Goal 未完成，已恢复实施。用户撤销等待 main 的决定后，LiveAgent 已在基于最新 `v2-kbrian` 的 `feat-image-studio-v2`。用户于2026-10-11 10:22:54 UTC 授权在当前工作区克隆 K-Brain 子项目；现已克隆到 `.liveagent/subprojects/K-brain`，结构化文件工具与命令工具均可访问。子仓库从最新上游 `main` 的 `df192b6a8f6d85f27e3497bcadb95995d74d4a00` 创建 `feat-image-studio`，目录权限阻塞已解除。当前推进公共类型、配置校验和平台证据补齐；未将静态研究或待验证的实现描述为生产功能支持。

## 基线与已有改动

- 原 LiveAgent 分支：`fix-kbrain-provider-add-save`。
- 首轮任务分支：`feat-image-studio`，直接在当前工作区检出，未创建 worktree。用户授权更换基线后当前任务分支为 `feat-image-studio-v2`，基于 `upstream/v2-kbrian` 的 `e347122a476f69ca33d5a03aa44c0b51fa59dab6`。
- 已执行 `git fetch upstream main`；`git rev-parse upstream/main` 与 `git ls-remote upstream refs/heads/main` 一致，均为 `85029b5611be595a67adca47ea2e6fd00e08eff8`。任务 HEAD 为同一 SHA。
- 初次切分支被 Git 拒绝：`.gitignore` 的本地修改可能被覆盖。
- 用户明确选择“备份并恢复该修改”。先将原 `.gitignore` 原文保存到已忽略的 `.liveagent/image-studio-local-backup/2026-10-11.gitignore.original`，临时移除新增的 `.alma-snapshots` 行；切分支成功后恢复该行。
- 当前 `.gitignore` 相对任务基线仍只有新增 `.alma-snapshots` 的用户修改，不纳入任务提交。
- 保留了用户对三份旧 `docs/superpowers/` 文档的删除，以及已有未跟踪设计、计划、研究、工作记录。
- 切到上游基线后，已有 `crates/agent-gui/src-tauri/binaries/` 因该基线没有原分支的忽略规则而出现在未跟踪列表。没有创建、删除或暂存这些构建产物，后续提交仍必须排除它们。
- 暂存区为空。没有 commit、push、PR 或发布操作。

## 阻塞证据

本地启动脚本 `.liveagent/dev-run.sh` 第15行指定 K-Brain 路径为 `D:\Documents\Projects\Go\K-brain`。尝试读取该目录下的 `AGENTS.md`，文件工具返回：

```text
Read.path is outside the authorized workspace roots
```

用户已选择“开放 K-Brain 目录”。随后再次读取相同路径，仍收到相同拒绝；对话中的许可没有让工具实际新增该目录授权。未通过 shell、其他目录或 worktree 绕过限制。

继续双仓实现需要在应用中将该目录加入本会话可读写项目范围，并由文件工具成功读取其规则和源码。当前源码的授权入口为 LiveAgent 工作空间“配置 → 目录与权限 → 添加目录”，访问权限选择“读写”，目录状态应为“正常”；相关文字可在 `crates/agent-ui/src/i18n/translations/zhCNCommon.ts` 第194—235行核对。拖入文件夹默认只读。用户已授权基于 `v2-kbrian` 继续，现无需等待 main 合入。2026-10-11 本轮重试读取 K-Brain 的 `AGENTS.md` 仍被文件工具拒绝；授权实际生效后先读取其规则、检查源码和 Git 状态，再继续同一个 Goal。

## 接入状态的表述规则

官方文档核对、静态 Adapter 契约测试、真实调用分别登记。只有对应目标环境的真实调用收据才能支持 `liveVerified=true`；静态测试通过不能替代真实验证。`contractComplete`、静态测试结果与 `liveVerified` 分别记录。目标启用同时受官方契约完整性、静态测试和真实验证门禁约束。

未开展五个平台的账号凭据、模型权限、额度、RunningHub 工作流 ID 和节点映射的接入核查，不能断言它们已具备或缺失。首次基线测试意外读取个人配置并在失败日志暴露敏感值，处理状态见下文；这不构成真实接入验证。真实调用前仍须列明所选模型/工作流、次数、输入和预算，按计划获得相应授权。当前没有调用收费 API。

## 已运行检查

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `git fetch upstream main` | exit 0 | 获取本任务 LA 上游基线 |
| `git rev-parse upstream/main` 与 `git ls-remote upstream refs/heads/main` | 相同 SHA | 基线一致性 |
| `git switch -c feat-image-studio upstream/main` | 首次因用户 `.gitignore` 修改失败；用户授权后成功 | 分支门禁 |
| `git diff -- .gitignore` | 只有 `.alma-snapshots` 新增行 | 用户修改恢复 |
| `git diff --cached --name-only` | 无输出 | 暂存区为空 |
| `git check-ignore -v -- start-tauri-dev.bat` | `.git/info/exclude:8:/start-tauri-dev.bat` | 本地启动脚本保持忽略 |
| `git ls-files -- start-tauri-dev.bat` | 无输出 | 本地启动脚本未被跟踪 |
| `git diff --check` | exit 0 | 已跟踪文件差异；不包含新研究文档 |

引擎测试、Adapter fixture 测试、TypeScript build/lint/test、Rust check、Gateway test、Mirror Check、浏览器端到端验证、Tauri 启动、真实平台验证和用户人工验收尚未运行。没有实现对应功能，不能用现有客户端或旧 K-Brain 二进制伪装验证。

## 用户决定的实施暂停条件

切到最新 `upstream/main` 后重新检查实际入口，发现该基线中以下路径不存在：

- `crates/agent-gui/src/lib/kbrain/`
- `crates/agent-gateway/internal/kbrain/`
- `scripts/release/kbrain.lock.json`

`git ls-tree --name-only upstream/main` 对这些路径无输出；同样检查原分支 `fix-kbrain-provider-add-save` 时三项均存在。原分支包含 `v2-kbrian` 开发线上的 K-Brain 接入、传输和发行基础，不能把实施计划调查时看到的这些路径当成 `main` 已有功能。

远端只读检查：`refs/heads/v2-kbrian` 当前为 `e347122a476f69ca33d5a03aa44c0b51fa59dab6`。本地缓存的 `upstream/v2-kbrian` 为 `e63992a366fb09b3068e964b1e4ef7dcf93c0aef`，缓存不是最新远端；没有切到该分支或合入其提交。当前 `upstream/main` 不是该本地缓存 head 的祖先。

已向用户列明三种处理方式：授权改用 v2 基线；在 main 上补齐前置接入基础；等待基础进入 main。用户最初选择“等待基础进入 main”；随后于2026-10-11 10:06:20 UTC 明确改为“也不用等合入，直接在 v2-brain分支基础上实施”。后续决定覆盖先前暂停条件。

## 改用 v2 基线的执行结果

- `git ls-remote --heads upstream v2-brain v2-kbrian v2-kbrain` 仅返回 `v2-kbrian`；按上下文选用这一实际分支。
- `git fetch upstream v2-kbrian` 成功；本地 `upstream/v2-kbrian` 与远端 head 一致，均为 `e347122a476f69ca33d5a03aa44c0b51fa59dab6`。
- `git ls-tree` 确认该基线具备桌面 `src/lib/kbrain/`、Gateway `internal/kbrain/` 与 `scripts/release/kbrain.lock.json`。
- 第一次 `git switch -c feat-image-studio-v2 upstream/v2-kbrian` 因 `.gitignore` 用户改动被拒绝。沿用用户已授权的备份与恢复操作，保存 `.liveagent/image-studio-local-backup/2026-10-11-v2-switch.gitignore.original`，临时移除 `.alma-snapshots` 行；创建并切换分支成功后将此行追加到 v2 的 `.gitignore`，保留 v2 自有忽略规则。
- 切换后 HEAD 为同一 v2 基线 SHA；`.gitignore` 相对新基线仍只有用户的 `.alma-snapshots` 新增行；三份旧文档删除及已有未跟踪文件保持原样，暂存区为空。已有 binaries 在 v2 下重新被正常忽略，没有删除或替换构建产物。
- 本轮 `git diff --check` 无报错；`git check-ignore -v -- start-tauri-dev.bat` 返回 `.git/info/exclude:8:/start-tauri-dev.bat`；`git ls-files -- start-tauri-dev.bat` 无输出。
- 补齐 `docs/research/image-studio-2026-10-11/matrix.md` 和 `index.json`。运行 `node .liveagent/image-studio-local-backup/check-evidence.mjs` 返回五份记录全部 PASS，33个来源 URL 的格式/域名、矩阵链接和索引一致性通过。这只是文档结构检查，不验证链接可用、协议正确性、fixture、运行功能或真实接入。Google 和 RunningHub 的契约证据缺口仍保留。
- 再读 K-Brain 规则仍被目录授权拒绝；没有通过 shell 绕过。全局 `C:\Users\AlphaCat\.liveagent\AGENTS.md` 的读取也被文件工具拒绝，未声称已读取该文件。当前采用已提供的全局指令和已读取的本项目规则。
- 本轮没有实现运行时代码、调用收费 API、提交、推送或创建 PR。

## 在当前工作区克隆 K-Brain 子项目

- 用户明确授权从 `AlphaCatMeow/K-brain` 拉取到当前项目下作为子项目。选用 `.liveagent/subprojects/K-brain`，作为独立 Git clone，而非 worktree、submodule 或复制旧目录；原外部仓库未修改。
- `git check-ignore -v -- .liveagent/subprojects/K-brain` 返回 `.gitignore:14:.liveagent`；子仓库不会混入 LiveAgent staged diff。
- 首次 HTTPS clone 失败：`Failed to connect to github.com:443 after 21102 ms`。SSH clone 成功，origin 为 `git@github.com:AlphaCatMeow/K-brain.git`，fork main 为 `df192b6a8f6d85f27e3497bcadb95995d74d4a00`。
- 已添加 `upstream=git@github.com:Stack-Cairn/K-brain.git` 并 `git fetch upstream main`。本地上游与远端 SHA 相同，均为该提交。
- `git switch -c feat-image-studio upstream/main` 成功；切换后子仓库工作区干净，暂存为空。本机 `go version` 为 `go1.27.1 windows/amd64`，满足 `go.mod` 的1.27.0。
- 结构化 `List` 与 `Read go.mod` 均成功。子仓库未发现 `AGENTS.md`、`CLAUDE.md` 或项目 `brain.md`，适用已读取的父工作区规则与用户针对双仓的授权。
- 外部 `D:\Documents\Projects\Go\K-brain` 不再是当前实现目录。目录权限问题视为在用户授权的新 clone 范围内解除；不声称修复了旧目录的授权配置。
- 已启动只读入口核对和01公共类型/配置校验工作；Go代码验收结果待执行者返回并由主代理复核。Google/RunningHub证据补齐独立进行，不虚构用户工作流映射或真实调用收据。

## 测试环境事故与处理

首次执行 `go test ./internal/config ./internal/backend` 未清空继承的 `LIVEAGENT_HOME`。该变量指向个人配置目录；现有测试仅设置 HOME/USERPROFILE 或 K_BRAIN_HOME，因 LIVEAGENT_HOME 优先级更高而未隔离。`TestLoadSaveDefaults` 在默认值断言中输出整个配置，日志出现真实秘密。该进程已结束，exit 1；本记录不复制敏感值。

源码审查确认不止读取风险：配置包含直接写入 config.json/config.json.bak/models.json 的故障测试、保存配置的测试及信任目录写入测试；backend.New 的默认 memoryRoot 也可能落在继承目录。不能只依据首个用例的 Fatal 推断整套测试没产生写入。Save 覆盖单一 .bak，部分测试会删除 .bak，因此不能把当前备份当成事故前恢复点。

用户已授权只读核查，未授权恢复或覆盖。2026-10-11 10:50之后再次用结构化List检查个人config.json仍被工作区权限拒绝；没有绕过。实际文件影响、可用恢复点尚未核实。敏感测试日志位于工具管理的临时目录，调用Delete也被工作区权限拒绝，尚未清理；不读取或引用其内容继续研究，不写入仓库，不提交日志。用户已经收到事故说明。

后续命令统一清空 `LIVEAGENT_HOME`、`K_BRAIN_HOME`，将进程初始 HOME/USERPROFILE设为工作区 `.liveagent/image-studio-test-home`，由各测试自身t.TempDir继续隔离。不能把LIVEAGENT_HOME固定为同一个测试目录，否则仍会覆盖测试自身K_BRAIN_HOME。

隔离后配置包通过；backend原有Cron测试使用printf，默认pwsh失败。改用已安装Git Bash作为K_BRAIN_SHELL后，重新运行 `go test ./internal/imaging ./internal/config ./internal/backend` exit 0：imaging 0.019s，config/backend使用该隔离环境的Go缓存。原始事故日志不作为功能验证通过证据。

## 本轮实现与专项验证

- 01公共类型/配置校验/请求哈希和wire fixture已落盘，并通过上述imaging包测试；配置持久化与秘密管理仍在实施。
- 新增离线 `DecodeImageContent`，验证PNG/JPEG/WebP实际内容、MIME一致性、字节/像素限制、取消与512px缩略图；原始bytes/hash保留。先运行新增测试因实现缺失失败，再实现并用指定源码文件集合运行 `go test ... -run ImageContent -count=1` 通过（0.082s）。指定文件集合是为了避免并行存储工作尚未完成的编译错误；整包集成复测仍需后续执行。
- 网络下载子任务被自动安全检查拒绝，原因仅返回“possible cybersecurity risk”。未通过改写请求重试该任务。仅继续离线图片处理；远程下载仍未实现、未验证。
- 桌面fetchKBrain不再给FormData/Blob自动加JSON Content-Type，仅字符串body保留旧默认；新multipart/二进制用例先失败，再修复。与旧重连用例的联合结果待读取确认。
- 当前v2基线没有 `scripts/check-mirror.mjs`，共享UI采用agent-ui。后续仍记录该原计划检查不可用，并运行实际存在的UI边界检查、双端build/lint/test；不创建空脚本伪装Mirror Check通过。

## 集成阶段进展

以下为各专项实际命令结果，不代表完整 Goal 完成。所有后续 Go 测试使用上述隔离 HOME，并设置 Git Bash；未读取事故日志或个人配置。

| 范围 | 已验证结果 | 剩余限制 |
| --- | --- | --- |
| 公共客户端、设置 helper、工作台模型、桌面图像传输 | 联合 Node 测试 55/55 PASS | 随后新增明确拒绝提交分支须复测；浏览器另行验证 |
| 配置、秘密管理 | `go test ./internal/config ./internal/backend ./internal/imaging -run 'Image\|Secret\|Snapshot\|Config\|HashRequest' -count=1` PASS | 真实验证回调与远程多用户配置未装配 |
| WAL、快照、scope、分页 | 存储专项23个顶层测试 PASS | race 因 cgo 不可用受阻 |
| Service/Scheduler | imaging整包 PASS；取消/终态测试重复20次 PASS；vet PASS | 真实平台未运行；URL输出保存 unsupported |
| HTTP路由、SSE、上传/读取 | backend Image专项 PASS（15.365s） | 默认只有显式local；Gateway需要可信身份 |
| OpenAI/Google/Ark直接适配 | direct包测试、vet PASS，离线httptest | 全部未真实验证；Google contractComplete=false |
| Gateway委派与流转发 | kbrain/handler/auth/server包测试 PASS；KB委派测试 PASS | 现有共享token无可信用户principal，默认503；nonce缓存单进程 |
| Rust本地原图导出 | cargo check --tests PASS；导出8个测试 PASS | 原生对话框与真实桌面联调未运行；remote_workspace unsupported |
| ImageSettings共享表单 | 15/15测试、GUI typecheck、局部Biome PASS | host离开guard与两端接线仍整合中 |
| 生产启动装配 | `go test ./cmd/kn -run '^TestImageRuntime' -count=1` PASS（0.053s） | 随后新增native adapter到资产集成测试正执行 |

父代理已将图像runtime接入`cmd/kn/backend.go`，同一实例绑定settings、store、assets与scheduler，单writer、关闭顺序、重开读原图、跨owner拒绝均有测试。直接适配继承受限自定义headers，Google provider_ref的原生认证类型已补齐；异步适配接线待收尾。客户端收到明确4xx拒绝时保留可编辑草稿，网络/协议未知仍保留原幂等键，新增回归待复测。

未进行收费调用、Tauri启动、用户人工验收、暂存、提交、推送或PR。浏览器测试正在准备隔离fixture，不能替代真实双端验收。个人配置事故仍按上文未决状态保留；URL下载的自动安全审核阻塞未解除。

## 当前整合与审查（续）

- 共享侧栏、工作台 host、设置离开保护和桌面原生导出接线已落盘。相关165个Node测试、双端typecheck通过；父代理另确认GUI与WebUI build exit 0。这不代表浏览器或原生窗口验收通过。
- 当前子仓源码构建的 `k-brain.exe`、`k-brain-computer.exe` 已输出至忽略目录 `.liveagent/image-studio-build/`，构建 exit 0。审查修复完成后须重新构建，不能把此时二进制用于最终源码验收。
- 清空继承backend token并使用默认Windows shell后，`go test ./cmd/kn -count=1` 通过（16.488s）；backend/config专项使用Git Bash，二者环境不能混为一谈。
- 完整GUI前端回归首次在Windows第一批停止：549通过、2失败。独立复跑确认 `conversation-search.test.mjs` 将URL路径解析为 `D:\D:\...`，`floor-nav-scroll.test.mjs` 将其解析为 `/D:/...`；对应测试与loader、shim均无本任务diff。正在继续运行其余批次，完整结果待记录；未修改无关业务代码或将失败记为通过。
- 资产GC新增实现及隔离测试完成；未对现有数据执行清理。审查发现取消后删除导致scheduler失败、取消后晚到输出的GC窗口、目录持久化屏障缺失、Close错误后不释放writer等问题，正在补回归与修复。unknown状态阻断全局GC和缺生产maintenance也在处理。已有专项绿灯不能覆盖这些审查发现。
- [验收矩阵](2026-10-11-image-studio-acceptance.md) 已整理18项人工场景、14项自动化专用场景和9组输入提示词；实际人工状态全部待验。浏览器私有地址权限拒绝仍未解除；没有操作截图或双端交互通过记录。

- Gateway WebUI host/transport/settings guard已接入，14项图像专项和5项导航测试、WebUI typecheck/build通过。父补齐 `/api/image/health` 到 `/v1/health` 的GET映射和执行权限检查，Gateway handler/kbrain/auth/server整包复测通过。真实principal仍未装配，入口明确不可用。
- 全量回归中的共享sidebar缺新增ImageIcon测试mock已补；与native drop、planning lazy migration合计14/14通过。后两项使用正确 `crates/agent-gui` cwd复跑通过；继续批次的自建runner曾用错误cwd导致额外ENOENT，不作为产品或基线缺陷。
- 全量lint仍失败：GUI 182 errors/1 warning，WebUI25 errors，包含未修改文件LF/CRLF格式冲突。尚未将全部诊断归因，不批量格式化无关文件；最终改动范围lint须另跑。
- GC资产侧新增引用事务校验、ImportAsset跨提交锁、平台目录持久化屏障、取消worker非空lease保护、无lease unknown局部保留已完成；imaging全包/vet及GC专项重复10次通过。scheduler一侧lease生命周期、删除和Close收尾仍进行中，暂未实际清理数据。
- 第二轮UI审查复现快速双击和切项目后幂等key丢失、临时错误覆盖草稿/输入、终态SSE重连、孤立parent和设置保存后target不刷新的问题，正在加回归修复。不能把修复前63个专项通过当作这些路径已通过。
- 新目标首次启用缺生产验证入口已证实；开始补持久化、幂等、配置权限保护的实际验证通道。普通任务enabled门槛不放宽，真实平台仍全部未验证；验证UI/API实现也不能替代调用授权与真实收据。

- Gateway全仓 `go test ./... -count=1` 通过。WebUI `pnpm test` 两批578+206，共784通过。当前UI boundary check通过。
- 桌面隔离启动新增阻塞：用离线小型探针、与仓库相同 `dirs=6.0.0` 验证，将进程HOME/USERPROFILE设为工作区独立目录后仍返回 `dirs_home_is_isolated=false`。Tauri `history_db_dir`、浏览器扩展同步及若干启动服务直接使用dirs::home_dir，现有LIVEAGENT_HOME/LIVEAGENT_CONFIG_DIR仅覆盖部分存储。未启动Tauri访问个人目录；需要完整开发隔离路径或用户明确决定如何处理现有个人数据后再启动。探针仅比较目录值、输出布尔值，没有读取或修改个人文件。

- 六项资产生命周期审查发现已由独立只读复核确认修复；未发现新的可确认生命周期问题，实际断电/race仍未验。终态SSE停止、同client settings保存通知、目标刷新、凭据用途camelCase统一已完成，相关34+10测试、双端typecheck、局部Biome通过。
- 其余全量检查已有归因：Windows URL.pathname及CRLF断言、prompts测试使用未规范化workspace key均为基线代码；指定Git Bash后trajectory7/7通过，planning时区测试隔离复跑通过（585ms），首次timeout未复现。全量lint的GUI181格式错误/1warning与Web25格式错误均在基线相同文件；唯一改动文件transport的换行诊断已按本地Biome修正，单文件check通过。未修改无关基线测试或产品代码。完整前端测试仍非全绿，不将定向修复后结果推广为全量通过。

## 下一阶段

在新子仓库核对配置锁、秘密持久化、路由认证与作用域，冻结双仓类型和 wire fixture 后继续实施。不重开 Goal，不使用旧外部仓库或旧二进制替代当前构建。

前置条件满足后，按 01 冻结类型与 wire fixture，再推进 02 存储、03 调度、04 平台适配、05 双端传输和 06 共享 UI。契约不完整、静态测试未通过或目标环境未真实验证的目标保持禁用。最后按 07 记录完整验收矩阵及真实结果，用户明确通过之前不提交或创建 PR。
