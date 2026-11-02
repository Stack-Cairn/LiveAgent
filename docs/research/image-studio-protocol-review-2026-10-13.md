# 图像协议复核：2026-10-13

本轮为在线官方资料与现存代码的定向核对，未读取私人凭据或执行收费生成。历史2026-10-11矩阵不覆盖本轮新测试，生产目标的liveVerified均未由本次研究更新。

## 来源与可见范围

| 平台 | 本轮官方来源 | 已确认内容与限制 |
| --- | --- | --- |
| OpenAI | [官方SDK images.ts](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/images.ts) | 可见源码确认POST /images/generations与/images/edits、Bearer认证、GPT Image默认b64_json、png/jpeg/webp、编辑图数量16和单图50MB上限、PNG遮罩4MB且尺寸一致；读取的是有长度上限的源码片段，不声称完整仓库或最新tag已核对。master是可变来源。 |
| OpenAI REST | [编辑reference](https://developers.openai.com/api/reference/resources/images/methods/edit)、[生成reference](https://developers.openai.com/api/reference/resources/images/methods/generate) | 正文403。搜索摘录显示JSON images对象的file_id/image_url及mask对象，与历史记录一致；摘录不是完整协议验证，不能据此修改contractComplete。官方SDK用multipart不能证明REST不支持JSON。保留已有JSON实现，未擅自切换格式。 |
| Google | [generateContent图像指南](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)、[所选模型](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1) | 指南可见REST v1/models/...:generateContent、x-goog-api-key、contents.parts、inlineData、TEXT/IMAGE；长正文输出被截断，定向查看已有archive不等于完整阅读。模型页完整返回：stable gemini-nano-banana-2.1、文字/图片输出、最多14参考图、默认1K、最后更新时间2026-10-06 UTC；实际地域/权限/可选格式/续接支持仍需目标验证。 |
| 火山方舟 | [图片API](https://www.volcengine.com/docs/ark/image-generation-api)、[系列教程](https://www.volcengine.com/docs/ark/seedream-4-0-5-0) | 搜索工具提取的233行页面正文已完整读取：POST https://ark.cn-beijing.volces.com/api/v3/images/generations、Bearer Key、output_format默认jpeg、response_format默认url；Seedream5.0 pro单图、不支持组图/流式/搜索，可输入2—10参考图；示例model为doubao-seedream-5-0-pro-260628。参数折叠细节未完整展开，不能声明每个尺寸/枚举已重核。教程长HTML只定向提取模型ID。页面更新时间2026-10-10 22:39:45与本轮核对日期分开。 |
| 即梦 | [图片4.0文档](https://www.volcengine.com/docs/JimengAI/JimengAI-ImageGeneration40-InterfaceDocumentation) | 可见提交POST visual.volcengineapi.com、CVSync2AsyncSubmitTask、2022-08-31、Region cn-north-1/Service cv、req_key jimeng_t2i_v40、force_single建议。JPEG/PNG、15MB、最多10输入、4096平方、输出最多15减输入数。正文长HTML被截断；本次定向提取未覆盖查询状态全文，不冒充查询枚举复核完成。 |
| RunningHub | 下列官方OpenAPI文档 | 创建/获取graph/V2上传/V2查询/Webhook详情正文已读到完整返回；特定工作流仍缺实际ID、API-format JSON、节点映射和可用回调条件，不从官方样例借用用户目标。 |

## RunningHub当前协议

- [高级创建](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013.md)：/task/openapi/create，JSON apiKey/workflowId/nodeInfoList，header Authorization；nodeId/fieldName/fieldValue。示例初始状态QUEUED/RUNNING/FAILED，通用schema另有CREATE/SUCCESS。未知状态保持unknown，不能当执行成功。retainSeconds额外收费，不默认开启。
- [获取工作流](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749014.md)：/api/openapi/getJsonApiFormat，data.prompt为JSON字符串；没有可依据的官方revision字段，当前代码用冻结内容hash比较，不能称为供应商revision。
- [V2上传](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749007.md)：/openapi/v2/media/upload/binary，Bearer和multipart file；ComfyUI使用返回fileName，不能将fileName拼成公网URL。URL有效期与文件用途必须区别；报告不保留签名URL。
- [V2查询](https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306.md)：/openapi/v2/query，Bearer，JSON taskId；SUCCESS/RUNNING/FAILED示例，results包含url/outputType，没有nodeId保证。
- [Webhook详情](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749005.md)：/task/openapi/getWebhookDetail，data.eventData里的fileUrl/fileType/nodeId；该页schema把data写null而示例为object，这处不一致仍需实际响应验证。现存代码仅在有回调条件和已声明节点时取这些输出。

旧[完整示例](https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287342)给出/task/openapi/outputs及804/813/805；不能用旧示例替换V2当前实现。一次误选旧页面ID只得到导航，没有得到目标查询正文，不计为有效接口证据。方舟.md地址落到产品简介，也不计接口证据。

## 与代码对应的修复

1. 方舟本地最小验证目标声明PNG，生产验证Get要求原图MIME=image/png，但原请求未指定output_format。默认JPEG可能生成成功却无法认证目标。新增实际HTTP请求断言先失败，随后request.go默认Format=png，fixture同步；用户显式JPEG仍走参数覆盖。
2. Gateway已有目标验证接口targets/{id}/verify与targets/{id}/verifications/{receiptId}被路由白名单拒绝。新增ServeHTTP回归先复现404，再开放限定路径并要求Configure权限；透传X-Idempotency-Key，保留不自动重放POST原则。没有替代可信principal。

## 剩余明确条件

OpenAI当前JSON编辑完整REST正文、Google所选目标的格式/续接保证、即梦查询与签名向量、RunningHub用户graph和回调、URL结果安全保存仍未全部完成。后端最小生产验证仅允许OpenAI/方舟，Google/即梦/RunningHub目标不能因静态测试通过而直接启用。共享客户端及设置UI还没有完整接入任务式验证提交/收据；Gateway生产构造仍传nil身份adapter，必须继续实现部署身份装配。真实平台调用、Tauri与浏览器交互、用户签字、提交PR和required CI全部未完成。
