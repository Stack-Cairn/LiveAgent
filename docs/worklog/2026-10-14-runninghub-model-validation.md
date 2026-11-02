# 2026-10-14 RunningHub 凭据补充与最小调用验证

## 授权与凭据边界

用户提供RunningHub API Key、说明余额119元且希望尽量少调用，并给出官方飞书使用说明书。本文、测试fixture、脚本文件均不复制密钥。密钥仅用于当前授权请求和隔离后端秘密写入，验证结束清理自身隔离secrets.json。119元是余额，不作为可花完预算。RollDek既有8/50账本不受本轮影响。

本轮自限：只选择一款Lite文生图模型，先官方价格预估，复核不高于0.22 CNY后只提交一次。没有视频、批量、自动重发生成或其他平台收费。

## 官方来源与阅读范围

- 用户指定 https://runninghub.feishu.cn/wiki/Vc77w5EaUirOY5kyTQNcrr7GnUd ：WebFetch仅返回加载样式，不算正文；侧栏会话和独立浏览器实际读取标题“RunningHub使用说明书”及初始内容，确认平台区分ComfyUI工作流、模型API、应用。长文虚拟加载，未声称全文读取。仅作为平台使用入口。
- 模型API官方完整OpenAPI https://www.runninghub.cn/runninghub-api-doc-cn/api-494858275.md ：POST /openapi/v2/rhart-image-n-g31-flash-lite-official/text-to-image；Bearer认证；prompt必填1—20000字符，aspectRatio默认1:1；返回taskId/status/errorCode/results，查询/openapi/v2/query；结果url/outputType/text。
- 价格预估 https://www.runninghub.cn/runninghub-api-doc-cn/api-454850620.md ：同一参数发POST /openapi/v2/price-preview/{model-route}，只报价不创建生成任务，estimatedPrice/currency/isFreeThisCall。
- 错误码 https://www.runninghub.cn/runninghub-api-doc-cn/doc-8435517.md ：1002无效key，1007参数，1014权限（标准模型API仅限企业级共享Key），其他限流/任务/内容失败。不能仅凭报价推断生成权限。
- 账号信息 https://www.runninghub.cn/runninghub-api-doc-cn/api-425748943.md ：POST /uc/openapi/accountStatus，返回apiType、remainMoney、currency、currentTaskCounts。只读且不回显原始账户数据或密钥。

## 实施变更

K-Brain新增internal/imaging/adapters/async/runninghub_model.go及测试，Adapter ID=runninghub-model，目标remoteId=rhart-image-n-g31-flash-lite-official、kind=model。与原runninghub-workflow完全分开，不使用graph、nodeInfoList、webhook。

最小范围仅generate、count=1、无输入/续接/可选参数，原生body prompt/aspectRatio=1:1。生产factory限制https://www.runninghub.cn及Bearer作用域secret引用。Submit接受QUEUED/RUNNING并持久化handle，Poll只查询同一taskId，SUCCESS必须一个合法图片URL及格式，最终资产成功仍由核心安全下载/解码/事务决定。Cancel/Reconcile返回不支持，不伪造供应商幂等。

新增最小验证profile和可信证据启用规则：未验证普通目标仍disabled；需要当前验证任务JobID+BindingDigest才能启用，不能通过HTTP公开配置伪造证据。设置与共享验证面板新增“RunningHub 模型 API”，原工作流项保留。

测试先因缺构造函数失败，再实现通过。验证真实method/path/auth、原生字段、submit→poll、不同taskId/非法格式/HTTP图片/无图/新状态拒绝、未知费用为null。另复现无taskId明确errorCode（字符串/数字1014）被归unknown，修改按官方明确拒绝分类；保留未知上游错误uncertain，不重发生成。这个fake测试不证明本次真实响应就是1014。

## 真实调用与费用观察

权威账本：[runninghub-validation-ledger.json](runninghub-validation-ledger.json)。

1. 价格预估HTTP200：estimatedPrice=0.22、currency=CNY、isFreeThisCall=false，未生成。
2. 隔离当前源码K-Brain提交一次最小文生图；receiptState=unknown、jobStatus=result_unknown、assetCount=0。未取得成功生成或已保存图片，不能登记liveVerified。
3. 检查自身WAL仅过滤执行结构，providerHandle为空，attempt=result_unknown；没有可核对上游taskId，不再发送生成请求。
4. 官方账户只读HTTP200/code0：apiType=SHARED、remainMoney=119.000、currency=CNY、currentTaskCounts=0。查询时未观察余额下降或运行中任务，但不将原未知请求改为成功或保证以后不会扣费。估价不等于实际结算，实际费用目前未知。

没有追加第二次生成；用户Key有效且SHARED，不能断言无效Key或1014权限是失败原因。真实返回原文没有保存，因此当前原因仍未确定。后续优先只读和离线诊断，新增生成需有明确修复依据。

## 验证结果

- async Adapter包通过（0.209s），包含明确拒绝与原有异步平台。
- 最新隔离go test ./internal/imaging/... ./internal/backend ./internal/config -count=1全通过：imaging1.695s、async0.230s、direct0.099s、backend28.331s、config5.548s。
- GUI/WebUI typecheck、build通过；图像共享/桌面95/95通过；UI boundary通过；改动Biome/diff检查通过。
- 原完整GUI/WebUI回归在本模块新增前已有通过收据；未声称新增后的所有全仓检查已经重做。

后台fixture退出通知已读取全输出：Vite只到达600秒超时，stderr空。此前真实浏览器失联和取消记录不失效，不把服务超时标为产品失败。

## 尚未完成

RunningHub模型真实出图验收未通过；ComfyUI工作流仍需实际workflowId、API-format JSON、节点和输出映射，API Key本身不能替代这些。模型成功也不会被当工作流成功。原生Tauri/生产双端人工验收、其他平台条件、提交PR/requiredCI继续按原计划推进，不宣告总Goal完成。
