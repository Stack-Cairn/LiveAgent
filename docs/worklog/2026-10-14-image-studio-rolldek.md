# 2026-10-14：RollDek 协议差异与单人 Gateway 续作

前置授权：2026-10-13 23:42 用户明确允许单人Gateway、限定URL下载重审、本地127.0.0.1:18473浏览器验收，以及只用RollDek最多50张图片。持续原Goal，无新提交/推送/PR。

## RollDek协议与代码

读取RollDek官方 https://www.rolldek.com/docs/ 正文，明确其gpt-image-2默认response_format=url，显式b64_json才返回base64；与OpenAI官方GPT Image默认base64不同。文档对gpt-image-2固定medium且quality不生效，编辑只给multipart，不证明JSON编辑兼容。因此新增内部Profile=rolldek，目前只实现无可选参数的单次generate，显式response_format=b64_json，不扩展编辑或ignored参数。

Profile仅允许HTTPS的rolldek.com或api-cn.rolldek.com、无显式port，并由生产registry对精确已知BaseURL装配；不根据浏览器body推断。其他OpenAI地址维持原格式。离线HTTP测试验证n=1/b64_json、结果图片实际解码、ignored参数不发请求、不能把profile配置到OpenAI官方域名。direct包回归通过。

连接读取使用Alma已配置RollDek记录，只输出白名单元数据和credentialConfigured；不回显apiKey、header或原始配置。开始时地址为https://rolldek.com/v1，模型列表2和2.5；00:49再读发现地址已改成https://api-cn.rolldek.com/v1且本地模型只列2.5，第二次脚本在调用前拒绝，额度未增加。没有恢复用户配置。对当前新地址GET /models只读核验HTTP200，实际目录包括gpt-image-2、gpt-image-2-high、gpt-image-2.5，之后用有官方文档依据的gpt-image-2在独立配置继续，不更改用户的列表。2.5别名及完整能力未冻结，不能因目录存在就认为支持。

## 真实调用账本

权威JSON：[rolldek-image-validation-ledger.json](rolldek-image-validation-ledger.json)。数量预算为50张，不是金额预算；所有unknown仍计入可能生成的占用，不通过重新运行脚本清零。

| 请求 | 实际情况 | 额度保守占用 |
| --- | --- | --- |
| first，隔离K-Brain，旧地址，gpt-image-2 | result_unknown，IMAGE_RESULT_UNKNOWN，未保存资产。随后发现RollDek默认URL与官方OpenAI profile不同，但未取得该次原始响应，不能断言它唯一失败原因就是URL | 1 |
| base64-second，当前新地址 | 通过隔离K-Brain和新profile执行；明确failed/IMAGE_INVALID_INPUT，无资产。未对个人设置写验证证据 | 1 |
| diagnostic-third，当前新地址 | 单独直接原生POST，仅用于HTTP状态/脱敏分类诊断；工具执行60秒超时中断，未取得响应，最终unknown。它不构成K-Brain闭环验收 | 1 |

合计：保守占用3张、已确认出图0张、剩余47张。无自动重试。不认为明确拒绝必定不扣费。第一次启动失败是隔离JSON含旧models/mcpServers字段，按当前配置改正后才发请求；这些启动失败不算图片调用。凭据只存隔离秘密文件，运行结束清理自身secrets.json；不从个人配置复制目录。

## 单人Gateway实现

显式启动开关：`--image-single-user` 或 `LIVEAGENT_GATEWAY_IMAGE_SINGLE_USER=true`。需要现有Gateway token、KBrainURL、KBrainToken、KBrainAgentID；本轮没有设置或打印真实token。

当前可用范围为Gateway与K-Brain同机：KBrainURL必须是带认证的数值回环地址，如http://127.0.0.1:47321；非回环、localhost别名、userinfo/query/fragment均不启用。K-Brain监听自身回环并允许local scope。单用户服务器认证管理token后固定owner=local，不能推导多用户。

GET /api/image/identity返回ownerId/backendId/mode=single_user，no-store，不返回token。WebUI认证请求该接口获取身份，并绑定origin和当前login token；失败不打开工作台。服务器移除浏览器scope/delegation头，单人本机转发不发签名委派，资产与桌面同local作用域。原ImageRequest仍要求签名delegation，新增LocalImageRequest仅允许认证loopback，避免破坏共享模式安全要求。

说明：默认开关false维持禁用；未真实部署服务或以生产WebUI操作验证。此实现不支持跨机器K-Brain，也不宣称多用户登录。

## URL输出与验证

授权后新增assets_download.go并接入SaveOutput，工具未再返回拒绝。公网HTTPS/443、无userinfo/fragment、DNS全部地址验证、连接绑定已验证IP、每个重定向再验、无proxy/cookie/auth继承、3次跳转、60秒截止、大小/像素/PNG-JPEG-WebP实际解码、原子保存与任务事务沿用原有实现。明确阻止私网、loopback、metadata、CGNAT、特殊/测试网段和Azure平台特殊地址。

离线测试通过：合法图字节解码、私网URL及跳转不进入transport、跳转上限、Content-Length超限、非法字节、凭据不外传、调度失败不发asset。真实公网CDN下载尚未获得成功收据，不能以fake下载成功代替真实平台验收。

## 实际检查

- 最新隔离 `go test ./internal/imaging/... ./internal/backend ./internal/config -count=1` 全部通过：imaging2.435s、async0.295s、direct0.270s、backend33.190s、config5.608s。
- Gateway `go test ./... -count=1`全通过，含单用户身份和local forwarding测试。
- GUI/WebUI typecheck通过；WebUI build通过（大chunk警告保留）；UI boundary通过。
- WebUI身份与image-studio专项16/16通过。没有宣称GUI全仓测试/原生Tauri人工验收通过。
- 公网下载策略最后补Azure特殊地址及192.88.99段，追加 `go test ./internal/imaging -run 'ImageOutput' -count=1` 通过（0.013s），差异检查通过；不扩大为最后改动后的全仓回归。

浏览器：前一轮实际在授权本地夹具创建项目、提交1个fake job、完成SSE、两张320px图实际解码展示；夹具固定两图不代表上游n行为。其余移动端/取消/失联场景仍须实际执行。假图不计入RollDek50张。

## 未完成与后续

RollDek真实请求还未成功；需要安全诊断当前模型拒绝/返回格式。2.5只能在协议依据充分后加入profile，不能凭别名套官方模型。运行脚本有既有账本防重复，生成预算不得重置。完整Tauri和生产Gateway人工验收、远程平台缺口、用户通过、commit/PR/requiredCI未完成。所有已有用户改动保留，真实调用收据不含凭据或图片下载签名。
