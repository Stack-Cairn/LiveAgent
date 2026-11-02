# 2026-10-13 图像工作台续作记录

## 授权和基线

用户本轮启动继续实施Goal；通过alma goal登记原文并读取确认active。继续原有任务分支，不新建分支或重做代码。LA在feat-image-studio-v2，HEAD 85528984，fetch upstream v2-kbrian后确认最新上游2f1807c8已在当前分支。保留用户.gitignore、未跟踪计划/研究/记录和浏览器.vite目录，不删除或暂存。

真正K-Brain实施目录为 `.liveagent/subprojects/K-brain`；外部Go目录不是此任务实施仓库。子仓fetch upstream main从ae66cc1更新至67f7d6b；clean工作区rebase upstream/main成功，保留两个已有实现提交，当前HEAD为7308d71e7d81a7641bb775c6d0763335bc32b3b0。没有新commit/push/PR。

## 代码修改

`internal/backend/image_settings_test.go`：旧TestImageTrustedVerificationLifecycle仍期待已退役VerifyImageTarget回调生效，实际函数明确返回IMAGE_UNSUPPORTED_OPERATION。替换为TestImageLegacyVerificationCallbackCannotPublishEvidence，确认正常与陈旧revision均拒绝、callback零调用、durable配置未写验证证据、target未启用。现有image_verification_test.go的任务式生产验证测试随backend整包通过。没有为了绿灯放宽生产验证。

## 实际检查

Go测试清空继承LIVEAGENT_HOME、K_BRAIN_HOME和相关backend token；HOME/USERPROFILE指定工作区`.liveagent/image-studio-test-home`，由各测试自身临时目录继续隔离；backend/config指定Git Bash。未读取个人配置或事故日志。

| 检查 | 实际结果 |
| --- | --- |
| go test ./internal/imaging/... ./internal/backend ./internal/config -count=1，首次 | imaging/direct/async/config通过；backend旧验证测试失败 |
| 同命令修正后复测 | 全部通过：imaging1.410s、async0.205s、direct0.080s、backend35.187s、config5.551s |
| K-Brain git diff --check | 通过；仅Git提示未来checkout时LF转CRLF |
| GUI pnpm typecheck | 通过 |
| WebUI pnpm typecheck | 通过 |
| GUI test/image-studio/*.test.mjs | 60/60通过 |
| agent-ui/src/lib/imaging/*.test.mjs，在GUI cwd正确../路径重跑 | 25/25通过 |
| WebUI test/image-studio*.test.mjs | 14/14通过 |

第一条GUI测试命令额外写了错误../../agent-ui路径，不能把它算共享客户端覆盖；随后按正确../agent-ui路径单独验证25项。前端专项共99项通过；未宣称全仓测试通过或浏览器/Tauri人工通过。

## 在线官方文档核对

- OpenAI官方图像指南 `https://developers.openai.com/api/docs/guides/image-generation` 本轮搜索正文返回403；不能依据摘要更新契约或liveVerified。
- Google generateContent图像页面 `https://ai.google.dev/gemini-api/docs/generate-content/image-generation` 搜索命中但正文超时；未完成当前版本字段复核。
- 即梦官方 `https://www.volcengine.com/docs/JimengAI/JimengAI-ImageGeneration40-InterfaceDocumentation` 正文读取成功，但工具文档含大段HTML被截断；只核对可见部分，不声称全文已读。已看到POST visual.volcengineapi.com、Action=CVSync2AsyncSubmitTask、Version=2022-08-31、Region=cn-north-1、Service=cv、输入JPEG/PNG15MB/最多10张/4096平方、输出上限15减输入张数，建议force_single控制输出数和费用；现有jimeng适配force_single=true与之对应。查询状态和全部字段仍需从已存工具archive继续读或官方定向页面核对。
- RunningHub官方 `https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287342` 正文完整返回。工作流示例明确upload `/task/openapi/upload`、create `/task/openapi/create`、outputs `/task/openapi/outputs`，请求apiKey、workflowId、nodeInfoList和taskId；节点映射nodeId/fieldName/fieldValue；旧outputs样例804执行中、813排队、805失败，输出fileUrl/fileType/nodeId。该页面说明旧查询示例，不能证明当前Adapter另用的新版查询路径与选定用户工作流已验证。
- 火山方舟本轮尚未重新读取正文。历史2026-10-11证据仍保留，日期不自动改写为本轮已复核。

没有读取用户真实账号、调用付费API或修改生产验证状态。

## 已确认阻塞与后续

1. 图片URL输出在internal/imaging/assets.go仍返回ErrUnsupported，有对应测试。此前下载实现动作曾被自动安全审核拒绝possible cybersecurity risk，本轮未重试被拒绝动作或以其他途径实现。该阻塞影响URL输出平台完整闭环，不能宣称完成。
2. Gateway可信用户principal接入、桌面全面测试隔离、真实五平台凭据与模型/工作流条件仍待确认；本轮未启动Tauri或访问个人数据。
3. 专项代理启动失败：spawn cmd.exe ENOENT。本轮直接完成检查和单文件测试修正，没有绕过工具调用编码CLI。
4. Goal继续保持active。下一步核对官方剩余正文、新旧查询协议和现存UI验证入口；全仓检查、真实平台及人工验收仍未完成。提交、PR及CI等待用户人工验收后执行。

## 本轮续作：验证转发与方舟格式

- Gateway新增验证start/receipt路径白名单、Configure权限检查及X-Idempotency-Key传输。ServeHTTP失败测试先复现4项404，修复后handler/kbrain/auth/server相关包全部通过；Gateway全仓go test ./... -count=1通过。
- GUI与WebUI pnpm build均exit0；构建有插件耗时和大chunk提示，不冒充无警告。没有新增源码以外的启动服务或真实平台调用。
- 方舟官方页面本轮确认默认output_format=jpeg。当前最小验证只接受PNG，已将adapter请求默认输出显式指定png并更新fixture，新增HTTP请求断言先失败后通过。随后隔离运行go test ./internal/imaging/... ./internal/backend -run 'Contract|Image|Verification|Scheduler|Recover' -count=1全部通过，backend15.527s。此次修改未更改已明确output_format=jpeg的参数覆盖逻辑。
- 公开官方资料本轮复核范围与截断/403限制记录在[协议复核](../research/image-studio-protocol-review-2026-10-13.md)。不自动覆盖历史证据状态或liveVerified。
- 验证路由修复不等于WebUI验证UI已完成；生产Gateway仍NewHTTPServerWithImages(...,nil,...)，没有可信principal不会启用。图像真实调用、完整人工验收、用户通过、提交PR与CI仍未完成。

## 19:01 后续：共享客户端与实际验证面板

- 新增ImageStudioClient可选startTargetVerification/getTargetVerification，保持旧host mock兼容。请求限制generate/count=1、confirmPaid=true、非空prompt、安全revision与幂等键；强类型解析receipt并校验状态。未确认收费客户端零请求，任务式POST透传X-Idempotency-Key，查询GET不再生成。
- 新增共享ImageTargetVerification并接入ImageSettings，桌面/WebUI共用。仅展示当前后端允许的OpenAI/方舟最小profile：无可选参数、generate、PNG、count=1、无输入和不支持的扩展能力。选择已有项目和提示词，明确勾选可能收费后提交；请求冻结并用原key核对，查询不自动重复收费；验证成功后仍需显式点启用并保存。
- 同一个client作用域按target保留请求/收据内存缓存，切换目标重挂载可复用；不跨backend/owner client共享。整页刷新没有durable恢复，不宣称已经完成完整恢复验收；用户可手动输入已有receipt ID做GET查询。本页不自动轮询，卸载后异步结果不更新旧UI。
- 客户端回归先因缺方法失败，随后通过。真实React DOM测试确认未勾选不可提交、双击只1请求、查询只GET、verified不会自动enable；明确点击启用才回调。实现过程的字符串转义与cache闭包类型错误已修正，最终两端类型检查通过。
- 运行GUI test/image-studio/*.test.mjs和共享lib/imaging/*.test.mjs共87/87通过；WebUI image-studio专项14/14通过，共101项。最终缓存展示小修后GUI/WebUI build均通过（GUI build含typecheck）；未宣称全仓前端回归通过。
- 本轮修改的共享TS/TSX和client测试定向Biome check通过，git diff --check通过。构建仍有已有插件耗时/大chunk警告。没有收费调用、Tauri启动、提交或PR。
- URL输出授权询问此前超时，本轮用户提醒继续Goal不等于对被拒绝下载动作作出具体授权，未重新提交或绕过审核。生产Gateway可信身份仍未装配，Google/即梦/RunningHub实际验证入口和完整平台调用仍有缺口。
## 19:14 后续：响应丢失后的只读验证恢复

- 新增K-Brain GET /v1/image/targets/{targetId}/verifications/by-key，通过X-Idempotency-Key在可信scope下推导既有收据ID，再走原Get。未创建/提交任务。缺失或重复key为422，不回显key；原CanConfigure校验保持。测试先因404失败，修复后通过。
- 共享客户端新增getTargetVerificationByKey，面板无receiptId但持有原冻结请求时允许查询。恢复GET不需要重新提交付费请求；回来的receiptId写入面板，后续普通GET继续查询。卸载后结果不更新旧UI。整页刷新持久化仍未完成，本轮只处理在当前作用域内响应丢失。
- Gateway现有验证路径白名单覆盖by-key，新增转发Header专项。handler/kbrain包复测通过；客户端+真实React DOM回归19/19通过，含response lost后提交次数始终1。GUI与WebUI typecheck通过，改动TS定向Biome通过，两仓diff --check通过。未重复全仓build；前次build结果不扩大到本轮改动。
- 权限专项发现SettingsManager的checkImageScope当前只允许明确local owner；跨owner恢复被403拒绝，未读取收据。最初测试预期404与现有权限不符，修正为明确403并保留独立缺key422测试；没有放宽产品权限。多用户Gateway生产身份需要同时解决身份与设置scope，本轮未装配，不宣称已解决。
- 当前Gateway只有共享管理token；HTTPMiddleware只验证该令牌，不建立用户principal。GatewayApp的可信identity仍由host props提供，不从服务器自动取得。部署身份来源需要明确，不能从浏览器自报owner或共享管理token猜用户。
- URL下载重新审核未获用户明确答复，未绕过；五平台真实调用、Tauri隔离与人工验收、PR/CI仍未完成。需要补真实调用预算授权和运行条件，不在读取个人配置前推断是否已存在账号。
## 19:23 后续：验证请求持久化与刷新恢复

- 新增客户端verificationStorage和loadVerificationAttempt，记录version、targetId、原幂等键、白名单请求字段及收据。所有收费验证先持久化再POST，日志写入失败、校验失败或读回不一致时零网络提交。没有持久化secret、token、下载URL或图片字节。
- 桌面作用域为local+backend URL+workspace；WebUI作用域为gateway+可信owner+backend ID+workspace。复用host现有存储，默认客户端无外部storage只作测试/内存兼容；实际面板发现hasVerificationPersistence=false时禁用新收费验证并解释原因。
- 整页刷新或client重建后，面板从日志恢复原prompt、原key和receipt；缺receipt时GET by-key恢复，不自动提交。查询结果也更新日志。pending/unknown或未确认终态的日志不能清除；只有verified或实际job终态可由用户再次明确确认后开始新验证。
- 客户端刷新恢复/不可写日志测试先失败，再实现并通过；增加损坏日志、竞争新key、未结束重置防护，以及桌面/WebUI跨owner/backend/workspace隔离测试。真实React DOM测试确认重建面板仅恢复与GET、不发POST。
- 最终GUI+共享图像专项94/94通过；WebUI图像专项15/15通过，共109项。双端typecheck和build通过；9个改动文件定向Biome通过、UI boundary check通过、git diff --check通过。没有运行真实浏览器或原生窗口，不把React/jsdom算人工验收。
- 读取现有隔离browser README，确认历史本地地址访问被工具拒绝：browser.allowPrivateUrls未允许；本轮未试图改设置、换地址或其他方式绕过。真实浏览器验收保留为阻塞。URL下载、生产身份决策、账号调用/预算、用户签字、提交PR/requiredCI仍未完成。
## 19:40 后续：Google最小实际验证入口

- 依据已核对的官方generateContent文生图示例与gemini-nano-banana-2.1模型页，增加最小验证profile：仅该stable模型、Adapter v1、generate、count=1、无输入、无可选参数、声明PNG、不支持续接/预览/取消/核对。扩展能力和Google Interactions不随之启用。
- 生命周期回归先失败IMAGE_UNSUPPORTED_OPERATION；增加最小profile后又发现配置层无条件拒绝Google，即便已有成功durable任务证据。修改为要求BindingDigest和JobID，并沿用原ContractComplete/LiveVerifiedAt/连接和target revision校验。HTTP写入仍不能伪造私有证据；未验证普通任务仍拒绝。
- 使用真实原生格式的httptest fixture：/v1beta/models/gemini-nano-banana-2.1:generateContent、x-goog-api-key、contents.parts、candidates/model/inlineData、STOP。生命周期覆盖8个同key并发重放、重启、资产落盘、证据save失败、显式启用、secret轮换失效；只发1个fake上游请求。新增empty/rejected/unknown回归，均不认证也不在重启后重新收费。
- 新增最小范围负例：未知模型、edit、输入图、count>1、continuation、image_size参数均拒绝。共享验证面板同步同一白名单；Google真实React DOM确认收费勾选和未知模型禁用。
- 最终隔离go test ./internal/imaging/... ./internal/backend ./internal/config -count=1全通过：imaging1.789s、async0.227s、direct0.116s、backend28.723s、config5.663s。GUI和WebUI构建通过；GUI/共享图像95/95通过；UI boundary通过。最后一条中文说明改为“一次请求、验证要求1张PNG、实际费用以供应商为准”，仅文案及Biome复查，不重复全构建。
- 本轮没有真实Google/OpenAI/其他平台调用，未读取账号或修改liveVerified。测试fixture内证据不会进入用户数据。历史Google全参数/多轮/格式/candidate保证未决状态继续保留，不能将最小profile完成推广成完整Google协议完成。若上游实际返回多图或非PNG，验证仍blocked，不对目标发成功证据。
- 其余未决项保持：OpenAI REST正文403；URL下载被拒绝后仍未获重审授权；Gateway单/多用户部署身份选择未收到答复；本地浏览器私有地址验收被拒绝；真实付费调用预算/条件、人工验收、提交PR/requiredCI未完成。Goal保持active，无新提交。
## 19:53 后续：OpenAI官方REST规范证据

- 官方openai-openapi README成功读取，确认公开规范文件路径；raw main/openapi.json直连20秒超时，本命令临时代理重试成功，4792164字节UTF-8内容，SHA256 cf31ebfa19c49cf081757985deec50b28d10f9b7900e5f391eb1a899c1ce22f5。仅Images paths和相关schema进入模型可见摘录，未宣称全文阅读。
- 已有工具输出把单行JSON拆成多行，第一次按单行解析失败；从同一archive去除工具换行后完整解析，不重新下载源。提取契约保存docs/research/image-studio-2026-10-11/openai-rest-contract-2026-10-13.json，公开文档无私人凭据。
- JSON编辑格式、images/image_url/file_id/mask、prompt和模型范围获得官方正文依据。发现生成schema required要求未定义image、两处引用定义在取得的schema集合中缺失，记录在openai.md，不强行增加文生图输入或宣告全契约一致。
- 未改运行代码、未重复已通过测试。真实调用、URL下载重审授权、Gateway部署身份选择、本地浏览器授权、人工验收及提交PR/requiredCI仍缺条件；自动Goal提醒并不提供这些具体决定。