# 图像工作台 flare 生图修复与验收

日期：2026-11-03。验证持续至本地次日；以日志中的 UTC 时间和任务 ID 为准。

## 目标和授权

修复 Moonup-4K 的 gpt-image-2.5-flare 无图输出和重试失败，核对原提示词中的 16:9 与界面 9:16 冲突，并加入输出压缩率默认值及滑块。先完成桌面调试版、再验证真实 Gateway WebUI；用户明确通过后才提交、推送和创建 PR。

用户 `/goal` 明确授权使用独立工作树，覆盖个人 AGENTS.md 中禁止 Worktree 的条款。

- 工作树：`.worktrees/fix-image-studio-generation`，分支 `fix-image-studio-generation`。
- LiveAgent 基线：执行时最新 `upstream/main` 的 `3e0f1869b46499a3a79658310b5bacae20062f7f`。
- 原工作区分支 `fix-chat-bottom-ui-reserve` 及已有改动、进程保持原样。
- `.worktrees/`、`.image-diagnostics/` 与 `start-tauri-dev.bat` 使用 Git info/exclude 忽略，不提交。
- K-brain 修复在任务目录中的 `.image-diagnostics/kbrain-source`，基于 lock 对应的 `v0.107.11 / b143a82738a80112acd47bd001e6b5d311a13125`，使用独立同名任务分支。
- 所有 Go 命令经 mise 执行。K-brain 按其 mise.toml 使用 Go 1.27.0；LiveAgent Gateway 按项目版本使用 Go 1.25.12。未引用 Program Files 中的 Go。

## 证据与根因

1. 分享记录中的原始英文长提示词为 3902 字符，要求 horizontal / 16:9，界面选择 9:16，分辨率自动。
2. 安装版 LiveAgent 2.0.2 内置 K-brain v0.107.9，revision `8f75fe0124f9f4cff004cc1c4a09187df5307efb`。凭据仅在内存传递，不写入记录。
3. 原提示词取自已存在任务 `ij_826227ca-38a4-4998-aadd-37cbad26555b`。PackyAPI 对照 `ij_c180dc9e-cb20-4709-955a-a25c99c16c80`，仅发送 `aspectRatio:9:16`，成功生成 PNG 720×1280，1,329,462 字节。
4. Moonup 复现任务 `ij_07e1e2a4-aa94-4fe5-a6a5-8901077f806f` 返回 `IMAGE_RESULT_UNKNOWN`。直接向同模型发送原提示词与 `size:720x1280`，实际响应为 HTTP 200、`data[0].url`，URL 指向真实图片。通用 OpenAI 适配器此前仅接受 Base64，错误拒绝了 provider 的 URL 结果。这是无图结果的已证实根因。
5. URL 解析修复后的桌面任务 `ij_8a674dae-a823-4631-a4b4-d80d7dac5fc5`（自动比例）和 `ij_f22ba772-8de9-45a5-bc0e-3389798162c6`（9:16）均成功出图，但后者实际为 1280×720，比例验收失败。不能把出图恢复等同于整体通过。
6. 转换及发送序列化测试证明：GPT Image 2/2.5 的 `aspectRatio:9:16` 加自动分辨率会转换为 `size:720x1280`，不是宽高交换。供应商可能仍遵循原文的 horizontal / 16:9。
7. 真实对照保持原始正文和 `size:720x1280`，只在最终请求 prompt 末尾说明选定画布优先。Moonup 53 秒后返回 HTTP 200 / URL，下载 PNG 720×1280，2,218,096 字节。附件为 `.image-diagnostics/moonup-ratio-override-proxy.{json,png}`。这证明该兼容措施在本次真实请求中有效，不保证供应商永远遵守尺寸。
8. 上述对照首次 Node fetch 因未使用本机系统代理而在 180 秒后超时；通过系统代理后成功。首次超时不能归因于供应商，也不计作供应商超时验收。
9. Moonup primary docs 的 `/docs/moonup/endpoints.html`、`image-streaming.html`、`creative.html` 未提供足以确认 flare 专属 `aspect_ratio` / `ratio` 字段或优先级的契约。修复继续发送标准 `size`，不虚构额外字段或专用 profile。

## 实现

### K-brain

- provider-backed 通用 OpenAI 目标接受 HTTPS URL 图片结果，仍由原有安全下载流程执行公网地址检查、图片解码与原子保存。
- 官方旧目标的 URL 限制保持；Base64 分支保持。URL 结果支持已有输出 schema 中的 WebP。
- 通用第三方 OpenAI provider 明确选择画布时，发送的 prompt 附加从最终像素 size 得出的横竖方向、最简比例与宽高，并说明画布优先于原文冲突。原 job prompt 不改，正常恢复及重试不累积后缀。
- 全部画布参数省略时不附加。仅选择比例时采用原有 1K，仅读取分辨率时采用原有方形尺寸。
- Agnes、RollDek 保留各自协议。官方 OpenAI endpoint 按解析后的 hostname 精确排除 `api.openai.com`，包含大小写与 `:443`；近似域名仍视为兼容供应商。
- 32,000 Unicode 字符的请求上限包含追加说明；超出时在发送前拒绝，不截断用户正文。

### LiveAgent 共享 UI

- `TargetParameterForm` 对标准 0–100 整数 `output_compression` 使用原生滑块，默认显示 100%，步长 1，显示当前百分比，支持键盘与可见焦点。
- JPEG / WebP 可调；PNG 或未选格式时禁用，并通过统一参数归一化移除压缩参数。
- JPEG / WebP 未带压缩值时补 schema 默认值，未声明时补 100；保留已选值，包括 0。
- 默认值、格式切换、草稿恢复、历史恢复、目标迁移和最终提交使用同一规则。旧 PNG／未选格式任务中的残留压缩值自动移除，不需要切换格式绕行；合法的 JPEG / WebP 数值保持。
- 归一化返回新对象，不修改历史 request 或已冻结提交快照。
- 组件与中英文提示位于 `agent-ui`，桌面和 WebUI 直接共享，无复制实现。

## 已运行自动检查

- URL 回归测试先确认合法 provider URL 场景失败，再修复并通过。
- 比例约束回归测试先确认竖向、横向、仅分辨率和持久化 size 场景失败，再修复通过。
- 通过实际 JSON / multipart 编码核对最终字段，覆盖官方 endpoint、特殊 profile、原正文不变、重复构建和长度边界。
- 压缩参数最初3项新增测试由红到绿。独立复核发现旧 PNG／未选格式恢复缺口后，增加手工旧草稿 JSON、失败历史恢复及实际控制器提交的回归，先确认3通过／2失败，再修复为5/5通过。
- `node --test test/image-studio/output-compression.test.mjs test/image-studio/review7-regressions.test.mjs test/image-studio/framing.test.mjs test/image-studio/parameter-model.test.mjs`：27/27通过。
- 归一化修复后执行 `node --test test/image-studio/*.test.mjs`：图像工作台全套166/166通过，0失败、0跳过。
- 独立复核后续修复时执行相关5个测试文件44/44通过，并用冻结对象确认历史／提交隔离及零默认值迁移；重要缺陷已关闭，未发现新的需修复缺陷。
- 原尺寸与 GPT Image 对抗回归：8/8 通过。
- `mise exec -- go test ./internal/imaging/... -count=1`：通过。
- `mise exec -- go test ./cmd/kn ./internal/backend -run '(Image|image)' -count=1`：通过。cmd/kn 首轮因继承会话 backend token 出现 401，仅清除测试进程中的该变量后通过；不改变运行客户端认证。
- `mise exec -- go vet ./internal/imaging/... ./cmd/kn ./internal/backend`：通过。
- `pnpm --dir crates/agent-gui build` 与 `pnpm --dir crates/agent-gateway/web build`：TypeScript 和生产构建通过，存在已有 chunk / dynamic import 性能提示。
- 两端 `biome check src/ --line-ending=lf`：通过。原 lint 命令的 `lineEnding:auto` 在本机 Windows 期望 CRLF，与仓库 `.gitattributes` 的 LF 冲突，产生全文件换行噪声；未为消除该噪声修改无关文件。改动文件同样使用 LF 检查通过，仅有一项既有 findIndex 风格提示。
- `node scripts/check-mirror.mjs` 与两仓库 `git diff --check`：通过。
- 完整 backend 存在两项失败，并在原始 HEAD 的导出源码快照中连续两次复现：`TestFilesystemRootConfinementAndText` 缺少 Windows symlink 权限；`TestBackendQueueFIFOInterruptAndShutdown` 出现 one → three → two 的顺序。FIFO 属于并发时序问题，已有基线复现证据，不能据此断言与任务改动绝对无关。具体命令、UTC 时间、原 HEAD 与快照校验值见本地 `.image-diagnostics/backend-baseline.md`；不宣称整个 backend 全绿。

本地修复二进制 SHA-256：`0D9C65CE70A9D976C4B0E7883F9CCC8A52AB2223EF30427A9D59D680254C5D30`，版本 `v0.107.11-image-url-framing-dev`。本地 override 用于当前源码验收，不替代正式 K-brain 版本发布和 LiveAgent lock 固定。

## 桌面浏览器验证

从本任务工作树根执行 `start-tauri-dev.bat`，当前源码构建 Rust 与前端；Vite 1432、WebView CDP 9232，使用任务构建目录和真实 Moonup 配置。

已在真实 Tauri WebView 操作并通过 11 项压缩率检查：旧 JPEG 缺省显示 100%、PNG 禁用、未选格式禁用、WebP 默认、Home 到 0、右键步进到 1、JPEG 保留 1、End 到 100、格式切换后默认恢复、键盘调整到 80、JPEG 保留 80。截图和断言记录在 `.image-diagnostics/desktop-compression-*`。

最终构建产物、Tauri sidecar 和 debug sidecar 的 SHA-256 已核对一致；运行的 backend 是任务 artifact 中的二进制。通过 UI 提交的真实任务如下：

- `ij_62d7deae-c627-4f1e-a9e2-7c7fb433d66f`：原 3902 字提示词，9:16、4K、high、JPEG 80%。连续点击生成两次仅创建一项任务；任务成功。实际返回 PNG 2161×3840、14,603,783 字节。可确认已生成竖图且客户端保存了选择的参数，但 PNG 与 JPEG 请求不符，宽度相对精确9:16偏1像素，不能算严格尺寸或压缩执行通过，不进行隐藏转码。
- 同任务历史“恢复输入”连续点击两次后，原 prompt 仍为3902字，9:16/4K/JPEG/80保持。清空 prompt 后生成禁用，重新填入后恢复可用。
- 切换 PNG 后压缩率禁用并显示100%，真实后端请求未包含 `output_compression`；将分辨率设为自动，提交 `ij_d1c503c4-36fe-4271-8651-c54f43da7535`。任务成功返回 PNG 720×1280、2,185,803 字节，符合原始9:16/自动分辨率场景。
- 请求和结果证据在 `.image-diagnostics/desktop-final-*.json`、`desktop-auto-*.json`，对应图片与屏幕截图已展示。原始正文不包含发送时追加的画布约束。

## Gateway WebUI 验证

使用本任务源码和 mise Go 1.25.12 构建真实 Gateway，监听本机8492，直接连接同一桌面调试 backend；加载本任务已构建的生产 WebUI。使用独立私密浏览器配置，认证 token 只在进程内存与浏览器私密会话传递。

- 1440×1000 和390×844视口完成16项交互检查：默认100、JPEG初始化、0/1/100边界、JPEG/WebP保留数值、PNG/未选格式禁用、导航和刷新保留75%、断网提交不创建后端任务、恢复连接后可继续、移动端WebP保留0%、滑块与弹层无横向溢出。
- 窄屏用实际触控事件点按滑块，数值从0变39，再用键盘Home恢复0；无障碍值显示 `0%`。视口与文档宽度均390，参数面板不透明显示，截图已展示。
- 真实任务 `ij_747fc747-eb97-4883-98a2-bb871c3eaae3` 从390px移动视口提交：原3902字正文、9:16、自动分辨率、high、WebP 0%。后端完整保留数值0，任务成功；实际返回PNG720×1280、2,294,347字节，比例符合，但输出格式未遵循WebP，故同样不能证明压缩生效。原文保持，桌面显示同一任务。
- 完成后不确定提交提示已消失，图像成功解码，捕获的页面运行时错误列表为空。证据为 `.image-diagnostics/webui-final-{submission,result}.json` 和 `webui-{desktop,mobile}-*.png`。
- 另有5项实际交互通过：新结果大图为720×1280；“继续修改”带入1张参考图并保留3902字正文；恢复历史保留WebP及0%；断网提交出现“提交结果未确认”提示且保留草稿；恢复网络、核对历史并刷新后，后端任务仍为5项，没有自动新增。记录为 `.image-diagnostics/webui-interaction-checks.json`。

## 独立复核后的恢复回归

独立复核确认旧 PNG 80%／未选格式0%的参数可穿过旧恢复流程，在滑块禁用后仍被提交，属于重要缺陷。先增加回归并复现，再统一归一化规则；后续独立复核确认该缺陷关闭，冻结历史与零值均保持。

- `node .image-diagnostics/check-legacy-restore.mjs desktop` 和同脚本 `web`：各4/4通过，覆盖旧PNG 80%、未选格式0%、JPEG 0%、WebP 0%。
- 实际使用旧草稿JSON刷新进入最新UI，打开参数面板，检查禁用和值，再点击生成，核对实际客户端序列化字段。PNG／未选格式均无compression，JPEG／WebP均为0；3902字正文保持。
- 桌面视口2560px；最新生产WebUI在桌面1416px及移动390×844下验证，包含窄屏刷新后打开边栏并重新进入工作台，均无横向溢出。WebUI已按新构建重新嵌入Gateway。
- 此组属于自动构造旧状态的回归：提交时将浏览器设为离线并拦截POST返回422，仅核对真实客户端请求字段，未将请求发送到后端或供应商，不计为新的真实生图通过；完成后恢复网络、fetch和原始草稿／提交记录。
- 证据为 `.image-diagnostics/desktop-restore-checks.json` 与 `web-restore-checks.json`。最新桌面验收界面为原提示词、9:16／自动、JPEG100%，截图 `.image-diagnostics/desktop-acceptance-ready.png` 已展示。

## 验收矩阵

| 范围 | 触发与操作 | 预期 | 当前状态 |
| --- | --- | --- | --- |
| 原失败与比例冲突 | Moonup flare，恢复原3902字正文，9:16、自动分辨率，生成 | 返回真实图片；实际宽:高为9:16；原正文保持 | 桌面及WebUI均成功PNG720×1280 |
| 分辨率和压缩提交 | 同正文，9:16、4K、JPEG、80%，生成 | 请求保留选项，记录真实输出格式和宽高 | 请求正确；供应商实际PNG2161×3840，格式和严格尺寸未通过 |
| 默认与禁用 | 更多参数：未选/PNG，再切JPEG/WebP | 默认100%；PNG/未选时禁用且不发送压缩 | 两端交互通过；桌面PNG真实提交未含压缩参数 |
| 压缩边界 | 滑块Home、右方向键、End；切换JPEG/WebP | 0、1、100可达，显示与提交一致；切换格式保留值 | 两端通过；WebUI真实提交保留0；移动触控通过 |
| 恢复与重试 | 历史恢复输入、继续修改、刷新页面后提交 | 比例、格式、压缩保留；正文不累积画布后缀 | 两端恢复通过；WebUI恢复显式0、导航与刷新保留75；失败任务重试为自动化覆盖 |
| 自动比例 | 比例和分辨率都自动 | 省略画布参数，不追加约束 | 自动化已通过，旧桌面出图通过 |
| 旧压缩状态恢复 | 自动构造PNG80%／未选格式0%的旧JSON与失败历史，恢复后直接提交；对照JPEG/WebP0% | 自动移除不适用的压缩值，合法0保留，历史快照不变 | 自动化专用：控制器回归通过；最新桌面与WebUI各4/4浏览器检查通过，提交拦截核对，无供应商请求 |
| 失败输入 | 清空提示词再生成，重新填入 | 空值阻止提交；修正后可操作 | 桌面实际通过 |
| 重复操作 | 连点生成；恢复输入多次 | 当前提交不重复；恢复不叠加后缀 | 桌面双击只创建1任务，重复恢复通过 |
| 断网与恢复 | WebUI浏览器断网后点击生成，恢复连接查看待核对请求并刷新历史 | 保留草稿，解释结果不确定，不自动重复提交；恢复后可操作 | 实际通过；全程后端任务数未变 |
| 取消与供应商超时 | 自动化执行取消、超时及恢复测试 | 已提交的请求不自动重发；不支持远程取消时不虚报供应商取消 | 自动化专用，通过；未额外提交收费请求进行UI取消/超时实测，direct适配器不支持供应商取消 |
| WebUI与移动视口 | 1440×1000及390×844，参数、真实生成、查看大图、继续修改和恢复 | 数据一致，弹层与滑块可操作，无横向溢出 | 实际通过；大图720×1280，继续修改添加1张参考图；供应商仍忽略WebP |
| 官方及特殊profile | 自动化执行序列化测试 | 官方域名、Agnes/RollDek不追加通用后缀 | 自动化专用，已通过 |
| 长度与危险URL | 自动化执行provider framing / URL安全回归 | 超长在发送前拒绝，非法URL/图片不绕过校验 | 自动化专用，已通过 |

## 人工验收步骤与提示词

人工验收应使用从本任务工作树构建并启动的调试客户端。原始3902字提示词已另存为本地 `.image-diagnostics/acceptance-original-prompt.txt`，可直接复制；也可以从本次成功任务“恢复输入”。正文第一句仍包含 horizontal / 16:9，保留该冲突正是比例回归条件。

1. 选择 Moonup-4K / gpt-image-2.5-flare、9:16、分辨率自动，复制原始提示词或恢复成功任务，点击生成一次。预期任务成功且是竖图；打开大图核对。已成功的720×1280结果可直接用于查看、恢复和继续修改验收，重新生成会产生真实供应商请求。
2. 打开“画面比例与尺寸 → 更多参数”，输出格式切到JPEG。预期滑块默认100%；用Home到0、右方向键到1、End到100，再调80%。JPEG与WebP互切应保留数值；PNG和“请选择”禁用滑块，回JPEG恢复100%。
3. 为覆盖空值、重复操作和恢复：清空正文，确认生成禁用；恢复原文；连续两次“恢复输入”，确认正文不追加说明；对本次4K/JPEG任务恢复输入应为80%，对WebUI的WebP任务恢复应为0%。提交后当前按钮忙碌，连续点击不应创建重复任务。
4. 从历史“继续修改”应带入一张参考图并保留正文；再“恢复输入”应回到原文生图参数。WebUI离开图像工作台再进入、刷新页面后，未提交草稿的正文和参数应保留。窄屏查看参数面板、拖动滑块并打开大图，控件应完整可见。
5. WebUI断网后点击生成，预期显示结果未确认并保留草稿；恢复网络后先查看待核对请求、刷新历史，确认实际任务状态再决定重试。取消、供应商超时及崩溃恢复属于本次自动化专用验证，不要求为人工验收制造长时收费请求。

输出格式限制必须随验收说明：本次Moonup两次忽略JPEG/WebP选择而返回PNG，客户端已发送相应格式/压缩参数，没有静默转码或把PNG命名成JPEG/WebP。因此用户可验收滑块和参数提交；供应商的真实有损压缩效果尚未通过。4K返回2161×3840，也不宣称精确像素匹配。

## 剩余交付条件

- 两端TypeScript、生产构建和LF lint均在恢复归一化修复后重新通过；Gateway按新生产WebUI重建并重启。独立复核已收齐，所发现的旧参数恢复重要缺陷已修复并复核关闭。
- 用户于2026-11-03T23:06:40Z明确回复“确认通过”，并于2026-11-03T23:10:17Z恢复Goal。人工验收门禁已通过，进入提交前预检与PR交付；供应商格式和精确4K限制保留，不据此扩大通过范围。
- 提交预检前拉取上游，LiveAgent从初始基线无冲突快进至 `274de94f5327faae22030af5995a5adac0d74097`；K-brain最新 `origin/main` 仍为 `b143a82738a80112acd47bd001e6b5d311a13125`。未stash或操作原工作区改动。
- 已创建追踪问题：`Stack-Cairn/K-brain#85`（URL结果与画布约束）、`Stack-Cairn/LiveAgent#1150`（压缩滑块与旧参数恢复）。
- 最新基线从本任务脚本重新构建并启动Tauri；桌面GUI和真实Gateway生产WebUI均在1280×900及390×900下复核：默认100、键盘0/1、JPEG/WebP保留1、PNG禁用、原提示词保持。两宿主均无横向溢出、说明不截断，捕获页面异常为0。证据在本地 `.image-diagnostics/preflight/{desktop,web}-ui.json` 及对应截图；未额外发起供应商请求。
- K-brain修复目前为本地源码构建override。正式交付需先完成K-brain上游修复、取得可固定的版本/产物，再更新LiveAgent K-brain lock与校验值并重跑集成验证；不把本机override当成最终版本固定。
- 人工验收通过后，按两仓库各自规范完成预检、仅暂存任务文件、提交到fork和创建上游PR；持续跟踪required CI至终态。未获授权不创建tag或运行发布流程。

## 2026-11-03T23:38:31Z 交付安排更新

用户明确改为“先推送PR，同时本地跑验证，两边并行”，授权先提交并创建draft PR，覆盖此前技能要求的先完成全部预检再推送顺序。人工验收通过的结论继续有效；尚未完成的验证如实披露，发现本任务问题后追加修复提交，不重写已发布提交。

- 最新Node全量为657文件、12/12批，4473项中4461通过、11失败、1跳过。完整摘要保留在本地 `.image-diagnostics/preflight/la-full-tests.log`。失败涉及Rust cargo smoke、Edge退出耗时、两项CWD假设及实际backend联调，定向复跑和归因进行中，不宣称全绿。
- Gateway通过mise Go1.25.12执行全量Go测试，22包通过、2包无测试；UI/GUI/WebUI三个typecheck、两端生产build、两端LF lint、共享改动lint、Mirror和diff检查，共11项独立检查全部通过。
- K-brain全量Go、改动包race与最终独立对抗复核待完成。两PR先保留draft；真实人工验收和已通过的指定回归不能替代这些未完成项。
- 正式K-brain锁仍为v0.107.11；后端补丁PR与本地开发产物不代表正式依赖已经更新。

## 2026-11-04 预检收敛与独立复核

两个PR已推送：`Stack-Cairn/K-brain#86` 与 `Stack-Cairn/LiveAgent#1152`。用户于2026-11-03T23:52:16Z再次确认生图验收通过，并授权把已保存的真实截图补入PR；四张截图使用固定资产提交 `a5effc2f7c0345eea0d5608f04a2187e22ed5470`，两个PR中的图片均已确认可加载。

独立对抗复核发现一个P2：当官方OpenAI域名被配置为provider来源时，URL-only结果被错误接受。K-brain追加提交 `ce12074a00f72f45f9ede21258d32658da2a8ceb` 复用 `officialOpenAI` 判定，在通用provider URL分支排除官方域名。永久回归 `TestProviderOfficialOpenAIRemainsBase64Only` 覆盖普通域名、混合大小写和`:443`；两例均先失败后通过，原复核fixture也通过，独立复核确认P2关闭。Volcengine及专用profile保持原条件。此场景为自动化专用：fixture返回URL-only，预期无outputs，状态为`unknown / IMAGE_RESULT_UNKNOWN / DeliveryUncertain`，不需要真实供应商请求。

K-brain通过mise Go1.27.0运行图像包完整测试、vet和direct包 `-race -count=10`。追加修复后的CI run `41745361774` 四项均成功：Linux完整套件49包通过、0失败、3包无测试；含子测试事件4336通过、0失败、34跳过，顶层用例2790通过、0失败、34跳过。Windows/macOS执行现有定向测试和全仓构建，Linux另执行race，未将这两平台的定向测试称为全量。

本地Windows完整套件仍有失败，以下保留实际结果，不以CI通过替代本地失败：

| 范围 | 实际结果 | 定向核查与限制 |
| --- | --- | --- |
| K-brain，追加修复后 | 45包通过、5包失败、2包无测试；含子测试事件4349通过、10失败、58跳过 | 仅测试子进程清除继承的backend token及两项应用home配置；`go test ./... -json -p 2 -count=1 -timeout=15m`。8个持续失败的顶层场景，当前源码和原始`b143a827`基线均各复跑20次且全部失败。前一轮额外失败的Bash yield场景在两边各20次均通过，未定位该单次失败原因。 |
| LiveAgent Node全量 | 657文件、12/12批；4473项中4461通过、11失败、1跳过 | 两项CWD测试在根目录各3轮失败，在GUI目录各3轮通过；Edge退出用例复跑3轮通过，未定位其首次失败的单一原因。另四组backend定向复跑通过，没有重跑整个Node套件。 |
| backend permission与trajectory | 默认PowerShell分别7通过/3失败、5通过/2失败；显式Git Bash后10/10、7/7通过 | 当前开发产物和原始基线均得到相同结果；真实SSE记录证明默认PowerShell不识别fixture的POSIX `printf`。基线产物经mise Go1.27.3构建，当前验收产物经Go1.27.0构建，未声称工具链版本相同。permission失败计数含父级聚合。 |
| Rust完整套件 | `cargo test --manifest-path src-tauri/Cargo.toml`：1145通过、23失败、4忽略，退出101 | cargo已实际运行，不能沿用首次`spawn cargo ENOENT`作为最终结果。失败包括2项shell语法、10项Windows扩展Git路径、5项Unix路径假设、1项`/etc`预期、5项sandbox/MSYS对象或DLL初始化；未做Rust基线重放，不能声称23项都已复现于基线。相对本任务准确基线`274de94f`，Rust及Cargo文件无任务改动。 |

完整本地证据保存在忽略的 `.image-diagnostics/preflight/`：`kb-baseline-confirm-summary.json`、`kb-postreview-summary.json`、`ci-kbrain-final-summary.json`、`la-final-findings.json`和对应原始日志。任务相关图像工作台166/166、恢复与冻结快照的30/30定向复核、provider URL/画布/专用profile/安全下载相关回归均通过。此前通过的三项typecheck、两端build与lint、Gateway全量Go、Mirror Check结果继续保留，未重复声称本地全套全绿。

LiveAgent实现提交 `aee59246e238bfb04342b2bbc20086f20e631a71` 的CI run `41742001262` 共9项成功；Rust与Desktop Gateway按路径跳过，draft阶段治理检查跳过。追加本验收记录后，继续核对最终PR head及治理检查到终态，最终远端状态以各PR检查记录为准。

截至2026-11-04，最新正式K-brain仍为v0.107.11，发布时间为2026-11-03T12:57:36Z。上游已于2026-11-04T00:20:40Z合入K-brain #86，merge commit为 `235167c21780db38e23a2b012a3f0eb96321293d`，包含最终head `ce12074`。本次工作没有创建tag或触发发布；正式lock与四平台校验值未更新。Moonup后端修复的安装版交付仍需等待包含补丁的正式产物发布，供应商格式和精确4K限制也继续保留。
