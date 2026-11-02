# 2026-10-14 RollDek HTTPS / gpt-image-2.5 真实闭环

用户确认：api-cn.rolldek.com/v1 HTTPS直连，rolldek.com文档走代理；gpt-image-2.5可用。原授权累计50张图片，非50元。以[调用账本](rolldek-image-validation-ledger.json)为准，不清零未知请求。

## 实测与修复

第七条单图诊断得到HTTP200、application/json、data有一张url，没有b64_json，尽管请求指定response_format=b64_json。这证明RollDek2.5实际URL行为，不能推广为官方OpenAI行为。后端只有RollDek profile或方舟允许URL，OpenAI官方仍base64-only；RollDek2.5别名仅该profile允许。公共HTTP例外已移除，实际验证HTTPS且不自动跟随生成请求重定向。文档临时代理访问HTTP200，未修改全局代理。

第八条通过当前源码构建K-Brain：接收验证任务、一次生成、URL响应、公网HTTPS限定下载、PNG解码、原子保存、读取原图、可信证据发布。receiptState=verified，jobStatus=succeeded，assetCount=1。

- Job：ij_f42dcd0d-d5c1-4048-9ea8-fb940051eb5a。
- Asset：ia_ca16f3526a38c972a88a012e522f2bea。
- 格式image/png，1011516字节。
- SHA256：1b0d8d517c104b734551e858c24dddef3623113c0300d49dca6630e384489ffc。
- [实际生成原图](../testing/rolldek-gpt-image-2.5-2026-10-14.png)：导出后hash与后端原图一致。

账本：保守占用8/50，确认生成2张（第七为直接协议诊断、第八为完整资产闭环），剩余42张。未重发未知任务、未更改个人供应商列表、未回显密钥或签名URL。历史第四/第五HTTP记录不删除，分别unknown及301；它们不算成功生成。

## 验证结果

最新隔离go test ./internal/imaging/... ./internal/backend ./internal/config -count=1通过：imaging1.573s、async0.208s、direct0.084s、backend28.876s、config5.532s。GUI共享图像95/95通过；GUI/WebUI构建通过；UI boundary通过；改动Biome与diff检查通过。设置页新增RollDek独立协议，不把它列成官方OpenAI模型。

上轮写此文件的工具流未完成，检查发现空文件；本轮补完整收据，之前不视为记录成功。

## 范围与未完成

这是RollDek2.5文生图真实闭环，不等于官方OpenAI、Google、即梦、火山和RunningHub全部真实接入验收。原生Tauri与生产Gateway交互、平台剩余契约/适配范围、全仓验证、用户人工通过、提交PR与requiredCI仍待执行。用户只允许RollDek收费，不能为了计划矩阵偷偷使用其他账号。

按计划继续：复核01—06缺口，先实现不依赖外部账号的剩余事项；07自动检查与人工验收按实际结果记录。已有用户修改保持不动，人工验收前不提交。
