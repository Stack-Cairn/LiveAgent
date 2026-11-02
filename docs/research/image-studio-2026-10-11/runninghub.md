# RunningHub 工作流 API 协议核对

核对/访问日期：**2026-10-11**。依据 image-studio 的 `00-provider-verification.md` 和 `design.md`。本轮只读公开官方文档，无凭据读取、登录、Cookie、逆向、任务创建、上传、查询或收费调用；未使用非官方仓库。

## 产品选择和完成度

选定研究产品为**RunningHub 国内站 `www.runninghub.cn` 的 ComfyUI 工作流 API**，首个可编码提交入口为 `/task/openapi/create`，通过已配置工作流 ID 与白名单 `nodeInfoList` 修改节点。它与模型 API、AI应用API、LLM兼容协议不同。[R0], [R1]

**未取得用户可用的 workflowId、其 API-format JSON、实际输入/输出节点与 revision。** 官方示例ID和节点只能解释结构，不能登记为已配置目标。本文件不编造工作流ID或真实映射。

`contractComplete=false`：本次官方“开始”页已将工作流纳入 V2 查询流程，通用 skeleton 可冻结 create + V2 query + V2 upload + cancel。旧 status/outputs 的 deprecated 标记已从实页复核，**不等于已证实停止服务**。V2 仍无输出 nodeId；非弃用的 webhook detail 成功样例能提供 nodeId，但存在 schema/样例差异且需该任务生成 webhook 事件，不能无条件替代结果查询。具体工作流输入/输出契约仍未齐；`liveVerified=false`，生产目标保持 disabled。[R6], [R16], [R17]

```json
{
  "vendor": "runninghub",
  "product": "RunningHub CN ComfyUI Workflow API",
  "checkedAt": "2026-10-11",
  "sourceUrls": [
    "https://www.runninghub.cn/",
    "https://www.runninghub.cn/runninghub-api-doc-cn/",
    "https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013.md",
    "https://www.runninghub.cn/runninghub-api-doc-cn/api-425749014.md",
    "https://www.runninghub.cn/runninghub-api-doc-cn/api-425749015.md",
    "https://www.runninghub.cn/runninghub-api-doc-cn/api-425749003.md",
    "https://www.runninghub.cn/runninghub-api-doc-cn/api-425749004.md",
    "https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306.md",
    "https://www.runninghub.cn/runninghub-api-doc-cn/api-425749007.md",
    "https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287336.md",
    "https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287338.md",
    "https://www.runninghub.cn/runninghub-api-doc-en/doc-8287471"
  ],
  "execution": "workflow",
  "verifiedOperations": [],
  "documentedProtocolActions": ["upload", "submit", "poll", "outputs", "cancel", "getWorkflowJson"],
  "contractComplete": false,
  "liveVerified": false,
  "workflowId": null,
  "workflowMapping": null
}
```

`verifiedOperations=[]` 表示没有具体工作流证据可以确认generate/reference/edit/mask能力，不表示通用API未提供执行动作。

## 官方入口、地域和版本

官网页脚“文档中心”链接 `https://www.runninghub.cn/runninghub-api-doc-cn/`；文档站公开提供LLMs.txt和 `.md` OpenAPI资料，属于官网直接链接的第一方文档，不是抓取内部网页执行接口。[R0], [R14]

| 字段 | 官方证据与范围 | 来源 |
| --- | --- | --- |
| base | `https://www.runninghub.cn`，OpenAPI servers项明确如此 | [R1]—[R7] |
| region | 国内站profile；未取得云厂商式Region/Service签名字段，不凭输出CDN地址推算执行区域 | [R0], [R1] |
| version | 混合路径：工作流`/task/openapi/*`，V2查询/上传`/openapi/v2/*`。导出spec的`openapi=3.0.1`/`info.version=1.0.0`是文档schema版本，不是统一远端协议版本 | [R1]—[R7] |
| service / Action | 无火山式service/region/Action query，行为由method/path确定 | [R1]—[R7] |
| Key类型 | 工作流/AI应用可用消费级会员、企业共享、企业独占Key；模型/LLM仅企业共享。不同key有不同权益与并发 | [R0] |
| 跨站点 | 本轮只确认`.cn` endpoint。英文官方示例引用`.ai`工作流展示页但实际请求仍为`.cn`；不证明`.ai`与`.cn`的Key可互用 | [R12] |
| 凭据位置 | 工作流legacy操作的当前schema要求Authorization Bearer并在body放apiKey；旧官方脚本只放body apiKey。必须记录这个文档差异，不宣称已实测两种认证等价 | [R1], [R10], [R12] |

## endpoint / body / auth

| 动作 | method/path | Content-Type、认证与body | 来源 |
| --- | --- | --- | --- |
| 简易/高级Submit | `POST /task/openapi/create` | JSON；当前schema列Host=`www.runninghub.cn`、Authorization=`Bearer <API_KEY>`必填；body apiKey:string、workflowId:string必填，nodeInfoList可选 | [R1], [R13] |
| 获取工作流JSON | `POST /api/openapi/getJsonApiFormat` | JSON；Host+Authorization；body `{apiKey,workflowId}`；返回code/msg/data.prompt，prompt为JSON字符串 | [R2] |
| Cancel | `POST /task/openapi/cancel` | JSON；Host+Authorization；body `{apiKey,taskId}`；schema required只列apiKey，但动作和示例依赖taskId，客户端应要求taskId | [R3] |
| 旧Poll（deprecated） | `POST /task/openapi/status` | JSON；Host+Authorization；body `{apiKey,taskId}`，返回code/msg/data状态字符串 | [R4] |
| 旧Outputs（deprecated） | `POST /task/openapi/outputs` | JSON；Host+Authorization；body `{apiKey,taskId}`，返回code/msg及随状态变化的数据类型 | [R5] |
| V2查询 | `POST /openapi/v2/query` | JSON；Authorization Bearer必填；body仅taskId:string必填；响应样例直接为taskId/status/errorCode/errorMessage/results，没有旧code/msg envelope；R16 将工作流纳入此查询流程 | [R6], [R16] |
| webhook事件详情（可选节点结果来源） | `POST /task/openapi/getWebhookDetail` | JSON；Host+Authorization；body `{apiKey,taskId}`；外层code/msg/data，data.eventData是带nodeId结果的JSON字符串成功样例；有事件/schema缺口 | [R17], [R1] |
| 当前Upload | `POST /openapi/v2/media/upload/binary` | multipart/form-data；Authorization Bearer必填，`file`二进制必填；schema不列body apiKey或fileType | [R7] |

所有path均拼接已证实的国内站base。认证profile应明确到动作，不把上传V2的Header-only契约与legacy body-key接口合并为全平台唯一模式。**实现建议**：legacy请求可以依据当前schema同时发送相同Key的Authorization和apiKey；这是对官方矛盾的保守选择，尚无真实验证。凭据只在后端注入，不进入job快照、fixture、日志或公开字段。

### 高级提交字段

| 字段 | 官方定义或文档差异 | 来源 |
| --- | --- | --- |
| `workflowId` | string；必须已存在；本研究没有可用值 | [R1] |
| `nodeInfoList` | array，元素nodeId:string、fieldName:string、fieldValue；原始schema为string，正文又称any且与原输入类型一致，官方示例脚本将数字转字符串 | [R1], [R8], [R10] |
| `accessPassword` | string可选；工作流加密访问时使用，属于秘密，不进入workflowMapping/公开参数快照 | [R1], [R11] |
| `addMetadata` | boolean默认true，将提示词等元信息写入图片 | [R1] |
| `webhookUrl` | string可选；完成回调，示例event=TASK_END，eventData是JSON字符串 | [R1] |
| `workflow` | string自定义完整JSON；正文称传入后忽略workflowId，schema仍要求一个存在的workflowId；本首版不启用此自由字段以免绕过design白名单映射 | [R1] |
| `instanceType` | default=24G、plus=48G、ultra=84G | [R1] |
| `usePersonalQueue` | boolean默认false，只对独占Key生效；个人队列上限1000，超出814 PERSONAL_QUEUE_COUNT_LIMIT | [R1] |
| `retainSeconds` | integer，可选10—180，企业共享Key专用；成功后保留实例复用，**保留期另计费**。不是任务结果TTL，不默认开启 | [R1], [R11] |

静态提交结构（占位符不可执行，不是配置好的工作流）：

```json
{
  "apiKey": "<backend-resolved API key>",
  "workflowId": "<configured workflow ID>",
  "nodeInfoList": [
    {
      "nodeId": "<verified node ID>",
      "fieldName": "<verified input name>",
      "fieldValue": "<encoded declared value>"
    }
  ]
}
```

成功样例 `code=0,msg=success,data={taskId,taskStatus,clientId,promptTips,netWssUrl?}`；任务初始状态样例QUEUED/RUNNING，正文还列FAILED。[R1] taskId正文及JSON样例为string，但components TaskCreateResponse定义为int64；客户端需将字符串或无损整数统一保存为opaque string，禁止经JS Number造成精度丢失。`promptTips`是JSON字符串，含result/error/outputs_to_execute/node_errors；可用于校验诊断，不能由它单独判断任务成功。netWssUrl可能带供应商认证参数，只能后端保存，不能照抄公开样例URL进日志/fixture。[R1]

## status / results / errors

### 旧工作流状态和结果：证据明确但已弃用

| 状态或返回码 | 官方定义 / 推荐映射 | 来源 |
| --- | --- | --- |
| Status data=`QUEUED` | pending/queued | [R4] |
| `RUNNING` | pending/running | [R4] |
| `SUCCESS` | 还需获取与验证outputs并保存资产；不能仅状态字面值就完成saving | [R4], design |
| `FAILED` | failed，读取脱敏失败原因 | [R4], [R5] |
| create schema `CREATE` | 在通用TaskCreateResponse枚举中出现，但语义/后续转换未取得；保守unknown，不当成功 | [R1] |
| Outputs code=0、data=array | 结果列表，元素fileUrl/fileType/nodeId/taskCostTime，另有consumeCoins、thirdPartyConsumeMoney、consumeMoney样例 | [R5] |
| Outputs code=804 | APIKEY_TASK_IS_RUNNING，data可为netWssUrl对象；非任务失败 | [R5] |
| Outputs code=813 | APIKEY_TASK_IS_QUEUED，data=null；非任务失败/非需重发 | [R5] |
| Outputs code=805 | APIKEY_TASK_STATUS_ERROR，data可能含failedReason异常类型/节点/消息；可能中断/取消，不证明某个专门取消终态 | [R5], [R9] |
| 任务找不到807/423 | unknown，可能ID错或已清理；不能解释为已成功取消或免费重发 | [R9] |
| 其他未知状态/格式 | unknown，保留handle；不能将所有非零code都标任务failed | [R4], [R5], design |

Outputs的data可能为数组、对象或null，需要判别式解码。结果可能包含非图像模态；fileType只是提示，还必须下载真实解码并限制PNG/JPEG/WebP，按允许输出节点过滤，不能把视频/音频/ZIP当图片。[R5], [R7], design

消费字段的单位/结算完整定义没有取得；consumeCoins是RH币样例，不等同法币金额。未知Amount/Currency保持null，不填0或猜人民币。失败traceback/current_inputs可包含输入信息，保存前脱敏。

### V2查询：不能悄悄替代旧工作流输出映射

[R6]公开返回**样例**为：

```json
{
  "taskId": "<opaque string>",
  "status": "SUCCESS",
  "errorCode": "",
  "errorMessage": "",
  "results": [{"url": "https://example.invalid/result.jpg", "outputType": "jpg"}],
  "clientId": "",
  "promptTips": ""
}
```

此处URL为替换后的安全占位符，结构依据官方样例；非真实调用收据。官方还列RUNNING(results=null)和FAILED(errorCode="1000")样例。schema的响应properties为空，**没有完整字段required/状态枚举/输出nodeId或outputName**。不能把样例推断升级为完整schema。

V2 页属于“任务和查询 & webhook”，spec 为 `deprecated=false`、`x-apifox-status=released`。**本次补读 [R16] 官方“开始”页的“第一次调用 / 调用模型 API / AI 应用 API / 工作流 API”：**正文统一写这三类通常采用任务型调用，并给出第二步 `POST https://www.runninghub.cn/openapi/v2/query`、Bearer + JSON `{taskId}`。因此 **V2 查询对 ComfyUI 工作流的通用文档适用性已补齐**，不再因 2026-01-15 的目录移动历史将其限定为模型 API。[R11] 的那条更新日志本次也实页核实，只说明当时目录调整，不是工作流排除声明。R16 第一步 `/openapi/v2/{endpoint}` 是通用占位示例，**不替换** R1 已证实的 `/task/openapi/create`。

### 弃用后的可实现最小查询 profile 与输出身份缺口

**实现裁决（未调用）：**create 成功后保存 opaque taskId，Poll 与有 handle 的 Reconcile 使用 R6 V2 查询，不自动 fallback 旧 status/outputs。按 R6 已给样例映射 RUNNING→pending、FAILED→failed、SUCCESS→进入输出校验；QUEUED 的语义在旧 R4 / create R1 有证据，但 V2 未给该状态样例，静态 decoder 可保守处理为 pending 并标明证据级别。未知状态/任务不存在/取消终态不当成功。SUCCESS 的 results 无合法且可映射图片时不能直接完成资产保存。它能恢复已保存 handle 的任务查询，不能恢复提交前后丢失的 taskId。

| 输出身份来源 | 官方实际支持内容 | 能否替代缺失映射 |
| --- | --- | --- |
| R6 国内 V2 | results 样例仅 `url/outputType`，响应 properties 为空 | 无 nodeId/outputName；不能用结果下标、文件名、URL 猜节点 |
| R18 官方英文 V2 | 显式 schema：taskId/status/errorCode/errorMessage/clientId/promptTips 为必填 string；results 可 null，元素仅 url/outputType | 同样无 nodeId/outputName。英文 server=.ai 且 status=developing，与国内 released 不同；仅作交叉证据，不升级国内 schema 或假定跨站 key 可用 |
| R5 旧 outputs | data[].nodeId:string、fileUrl/fileType；本次再次确认 deprecated=true | 可解释旧数据映射，不作为新实现永久依赖；弃用标记未给关停日期 |
| R1 完成回调 | `event=TASK_END`，eventData 为 JSON 字符串，内层 data[] 有 nodeId/fileUrl/fileType | 完成事件样例支持节点身份；未冻结 webhook 验签/重放，首版不把未认证入站回调作为成功权威 |
| R17 getWebhookDetail | **非弃用、released** 的已认证读取接口，成功样例 data.eventData 字符串内含同样 nodeId/fileUrl/fileType | 具有文档可编码的节点结果读取形态，但依赖 webhook 事件存在；不是无条件通用 outputs 替代 |

**R17 具体接口：**`POST https://www.runninghub.cn/task/openapi/getWebhookDetail`；JSON；当前 spec Host + Authorization Bearer 必填，body `{apiKey,taskId}`（schema未列 required，客户端依动作要求二者）；success envelope `{code:0,msg:"success",data:{id,taskId,eventData,callbackStatus,callbackResponse,retryCount,createTime,updateTime,...}}`。这是官方成功**样例**；其 `R?` schema 却将 data 定义为 null，完整字段类型/required 未被规范保证。R17 文案用途是按 taskId 调试用户 webhook，取得 event id 后可重试；本轮没有调用重发接口。

R17 样例 `callbackStatus=FAILED` 同时内层 `eventData.code=0` 且有结果，说明 **callbackStatus 是回调送达状态，不是生成状态**。可编码候选为：任务配置 webhookUrl 后，V2 查询生成状态，已认证 getWebhookDetail 获取事件内容，按内层成功 code 和 data[].nodeId 对配置输出节点过滤。必须核对外层与任务 taskId、一层字符串 JSON 的类型/大小、允许节点与下载内容；只保留需要的结果，忽略/脱敏 userApiKey、webhookUrl、callbackResponse。此候选尚缺事件生成/可查询时机、无 webhook 时行为、事件/结果 TTL、不存在与失败样例及目标收据，**不能将其登记为已完成的 production mapping**。如果节点身份缺失则保持结果未知/目标禁用，不猜映射。

原生 ComfyUI proxy [R19] 文档只给 `/proxy/<key>` / `/proxy-plus/<key>` 并声称等同本地地址，未冻结针对本 taskId 的 history/outputs schema；它是另一执行协议，含 URL key，不能凭“等同”把它接到现有 create/V2 任务或宣称补齐输出节点。

### 错误登记

| 官方code/标识 | 含义与实现建议 | 来源 |
| --- | --- | --- |
| 301 PARAMS_INVALID / 380 WORKFLOW_NOT_EXISTS | 参数/工作流不存在，提交rejected | [R9] |
| 433 VALIDATE_PROMPT_FAILED / 803 APIKEY_INVALID_NODE_INFO | 工作流校验或节点字段不匹配；不自动换工作流/节点 | [R9] |
| 810 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING | 官方要求在平台保存并手动运行一次；真实启用缺此验收，不以本研究替代 | [R9] |
| 801 / 802 / 811 | 免费用户不支持、Key未授权/失效、企业Key无效 | [R9] |
| 416 / 812 | 钱包/企业余额不足 | [R9] |
| 415 / 421 | 独占机器不足/共享并发上限；官方415建议等30—120秒，但不得对送达不明的提交自动重发 | [R9], design |
| 804 / 813 | 正在运行/排队，应继续查，不新建任务 | [R9] |
| 805 / 807 / 423 | 状态异常/任务未找到，与上表同 | [R9] |
| 808 / 809 | 上传失败/文件超限；未取得统一字节限额 | [R9] |
| 1002 / 1003 / 1004 / 1007 / 1008 | Key错误/频率/任务不存在/参数/文件超限；这些为通用错误，未保证所有legacy接口都返同一种码 | [R9] |
| 1000 / 1005 / 1006 / 1010 / 1011 / 1012 | 未知/内部/超时/不可用/忙/上游异常；先区分已创建handle、提交拒绝与uncertain | [R9], design |
| 1101 / 1501 / 1504 | 节点信息/内容审核/模型超时 | [R9] |
| Upload code=401样例 | message=`ApiKey verification failed: API Key不存在`，data=null；这是body code样例，文档在HTTP200响应下展示，不能当已确认HTTP401 | [R7] |

HTTP非2xx与业务code/status必须分别处理，不能仅HTTP200判成功。官方文字建议retry也不授权收费重提；依据design，not_sent可有限重试、rejected不自动重提、uncertain先核对。

## upload / cancel / limits / reconcile

| 项目 | 官方事实与边界 | 来源 |
| --- | --- | --- |
| Upload body | V2 multipart只含file；不能照抄旧脚本的apiKey/fileType表单 | [R7], [R10] |
| Upload success | code=0、message、data.type/download_url/fileName/size；size为字符串schema | [R7] |
| 上传用途 | download_url给标准模型API；**fileName给ComfyUI节点**，它是服务器相对路径，不能随意拼外链 | [R7] |
| 上传格式 | 图片JPG/PNG/JPEG/WEBP；API还接受音频、视频、ZIP，但image-studio首版只接受合法图像 | [R7], design |
| 上传URL TTL | 一天；不是长期图床/文件存储。无上传后fileName存储保留期的明确数值证据 | [R7] |
| 输出URL TTL | 旧outputs/英文示例未给固定时长，只称依平台规则；不能套用上传24h到生成输出 | [R5], [R12] |
| 旧Upload | `/task/openapi/upload`在官方接入脚本出现，目录将“上传资源”标弃用；当前首选V2上传 | [R0], [R7], [R10] |
| Cancel结果 | code=0/msg=success/data=null；不存在code=807。无退款/完成竞态/取消状态枚举的完整契约 | [R3] |
| supportsCancel | 通用ComfyUI接口有取消证据，可实现Cancel；具体目标须验证queued/running取消效果，不能直接把ACK当所有结果已停止 | [R3], design |
| 并发 | 与Key权益有关；正文给独占个人队列1000，未给该用户并发值 | [R0], [R1] |
| 队列发现接口 | `GET /openapi/v2/queue/status` Bearer，返回apiKeyType/concurrentLimit/runningCount/queuedCount/totalCurrentTasks；spec状态developing，样例concurrentLimit=30不是通用默认值，本轮未调用 | [R15] |
| 文件字节/尺寸/count | 无统一硬上限数字证据；执行数量、输入图数、尺寸由实际节点和workflow决定，不填写16为供应商上限 | [R1], [R7], [R9] |
| Poll / Reconcile | 保存taskId后可查询，Reconcile(handle)可复用选定查询profile；未取得客户提交key查taskId/幂等重放，taskId丢失无法恢复 | [R4]—[R6], design |
| continuation | taskId/clientId/WSS重连不是图像会话续接；不宣称supportsContinuation | [R1], [R12] |
| preview | 有节点执行进度WSS示例，但无图像预览帧契约；不能因此标supportsPreview=true | [R12] |

取消时由Service串行处理本地状态，完成已保存后迟到Cancel不能倒退成功；取消ACK本身不等于计费停止。结果未知而无handle不调用cancel。查询/下载可有限重试，但不能额外创建任务。

## workflow mapping：可编码规则与未完成的目标契约

官方规定nodeId来自API格式JSON；fieldName是该节点`inputs`的key，fieldValue替换该字段。仅前端字段如control_after_generate/group没有API输入，不可映射；连线数组不建议修改。API会强制重置seed，需要固定时应显式放nodeInfoList。[R8]

| K-Brain字段 | 上游映射规则 | 证据/缺口 |
| --- | --- | --- |
| remoteId | 用户授权且可用的workflowId，保持string | [R1]；当前缺值 |
| workflowMapping.inputs[].nodeId | API-format JSON键，检查节点存在 | [R2], [R8] |
| inputs[].inputName | 节点inputs中存在的字段名，提交转成fieldName | [R8] |
| inputs[].parameterKey | K-Brain声明参数/输入资产角色；只允许配置白名单，不自动导出所有节点参数 | design；非供应商字段 |
| 提示词 | 实际CLIPTextEncode类节点的text；官方样例nodeId="6"，不是任意工作流固定节点 | [R2], [R8] |
| seed / steps | 实际KSampler对应inputs；官方样例nodeId="3"，不保证用户工作流如此；fieldValue类型差异需冻结fixture | [R2], [R8] |
| count / size | 只有实际已核对节点支持时才绑定batch_size/width/height等；官方示例EmptyLatentImage node="5"，不能通用硬编码 | [R2] |
| 图片输入 | LoadImage.image应传上传返回fileName；LoadImageFromUrl.image可传URL。官方示例nodeId="14"/"13"，当前无用户实际节点ID | [R7], [R8] |
| outputs[].nodeId | 旧outputs返回nodeId，可按配置SaveImage输出节点过滤；官方JSON样例node="9"只是示例 | [R2], [R5] |
| outputs[].outputName | design要求字段，但旧outputs只给nodeId，未给稳定outputName；API-format SaveImage.inputs.images是输入socket，不自动当结果outputName | [R2], [R5]；证据缺口 |
| revision | K-Brain映射配置版本，由本地管理并冻结；没有供应商可用的工作流revision字段证据 | design，[R2] |

**未完成的最小工作流契约**：workflowId=null，workflowMapping=null，promptNodeId=null，imageNodeId=null，outputNodeId=null，mappingRevision未分配，maxInputs/maxCount未知。不给这些字段填官方示例值来制造“已验证”。

建议后续流程（实现裁决，非本轮执行）：用户提供其工作流ID/API-format JSON；校验声明的输入字段和类型、输出节点与合法图片；冻结配置revision及非秘密JSON摘要；选择并确认输出查询版本；获取该目标成功/排队/失败/取消样例，再生成脱敏fixture。不能照抄官方脚本将所有inputs（包括连接数组）都字符串化后替换，design只允许声明字段绑定。

## 证据缺口与版本风险

1. **工作流目标缺失**：合法workflowId、API-format JSON、声明输入/输出节点、revision、所需模型/节点可用性都未取得。获取方式为用户已配置工作流导出和后续合法环境验证；不从示例冒认ID。
2. **旧查询弃用/V2迁移**：R4/R5的OpenAPI明确deprecated=true。R6只提供弱schema样例，缺nodeId/outputName及工作流适用性保证；需要官方完整契约或独立授权验证，未确认不能启用。
3. **鉴权/类型矛盾**：当前schema要求Header+body key，正文/官方脚本仅body；fieldValue正文any、schema/string示例不同；taskId string/int64不同。需为选定profile取得真实脱敏fixture，保守解析无损ID。
4. **取消与续接边界**：通用取消存在，但无完整取消终态/退款/已完成竞态；无提交幂等或丢失句柄检索；clientId重连不等于SubmissionKey。供应商信息不足时按design保持unknown。
5. **输出映射设计缺口**：供应商旧输出未返回outputName，新V2甚至未返回nodeId。不能编造稳定字段或修改design；需后续明确适配裁决并保持具体目标disabled。
6. **limits/TTL/回调**：上传最大字节/尺寸、实际并发、生成结果保留期、webhook认证完整规范未取得。retainSeconds是计费实例保留，不是结果TTL。首版可采用轮询，避免信任无认证回调。
7. 本轮未制作fixture、未运行Go测试、未做收费调用；生产验证层未完成。官方更新日志的2026-04-27 accessPassword与2026-04-08 retainSeconds可定位版本变化，但不是完整服务版本保证。

## 官方来源索引

以下均于 **2026-10-11** 访问。`.md`与对应无后缀HTML为同一官方文档导出；读取的是公开文档，不调用页面所描述的执行API。没有把公开样例的认证下载URL/WSSURL转存为fixture。

[R0]: https://www.runninghub.cn/runninghub-api-doc-cn/
[R1]: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013.md
[R2]: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749014.md
[R3]: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749015.md
[R4]: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749003.md
[R5]: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749004.md
[R6]: https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306.md
[R7]: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749007.md
[R8]: https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287336.md
[R9]: https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287338.md
[R10]: https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287342.md
[R11]: https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287335.md
[R12]: https://www.runninghub.cn/runninghub-api-doc-en/doc-8287471
[R13]: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749012
[R14]: https://www.runninghub.cn/runninghub-api-doc-cn/llms.txt
[R15]: https://www.runninghub.cn/runninghub-api-doc-cn/api-432926239.md

- 官网来源：`https://www.runninghub.cn/`页脚文档中心直链R0。
- [R0] 开始/Key产品分类，页面更新时间 `2026-07-05 12:58:06`。
- [R1] 高级ComfyUI提交；[R13]简易提交，HTML更新时间 `2026-04-28 02:34:30`。
- [R2] 工作流API格式JSON；[R3]取消；[R4]旧状态（弃用）；[R5]旧输出（弃用）；[R6]V2查询；[R7]当前V2上传。
- [R8] 关于nodeInfoList；[R9]官方错误码；[R10]中文工作流完整接入；[R11]更新日志。
- [R12]英文官方任务进度显示示例，更新时间 `2026-08-25 11:21:05`，代码同时证明create/outputs/getJsonApiFormat的官方工作流示例。它不是新的API规范，不能覆盖R4/R5弃用标记。
- [R14]官网文档的LLMs.txt索引；[R15]队列状态（spec标developing）。除明确列出的HTML更新时间外，本轮没有取得各.md页面统一更新时间，不猜测。
