# 即梦视觉服务 OpenAPI signed_request 协议核对

核对/访问日期：**2026-10-11**。读取依据为 image-studio 的 `00-provider-verification.md` 与 `design.md`。本轮只读取公开官方文档，没有读取私人凭据、Cookie或登录页，没有收费请求、上传、任务查询或 Adapter 测试。

## 产品范围与完成度

选定产品：**即梦AI 图片生成4.0，视觉服务 OpenAPI 同步转异步接口，AK/SK Header 签名认证，service=cv，region=cn-north-1，req_key=jimeng_t2i_v40**。[J1] 不使用即梦网页逆向接口，不使用方舟 API Key 替代视觉凭据。

`contractComplete=true` 仅针对这个收窄的**签名提交+按 task_id 轮询、URL输入、单图默认**静态协议：官方动作、版本、签名算法、请求/响应、状态和错误可用于编码。它不表示研究计划全部验收完成：未取得 CV 专用官方固定签名向量，未做 fixture 或真实验证。生产目标按 design 仍保持 disabled。

```json
{
  "vendor": "jimeng",
  "product": "Jimeng AI Image Generation 4.0 / Visual OpenAPI signed_request",
  "checkedAt": "2026-10-11",
  "sourceUrls": [
    "https://docs.volcengine.com/docs/JimengAI/JimengAI-ImageGeneration40-InterfaceDocumentation?lang=zh",
    "https://www.volcengine.com/docs/6444/1390583",
    "https://www.volcengine.com/docs/6369/67268",
    "https://www.volcengine.com/docs/6369/67269",
    "https://www.volcengine.com/docs/6444/69728",
    "https://docs.volcengine.com/docs/APISignatureCallGuide/Commonerrorcode-10?lang=zh",
    "https://docs.volcengine.com/docs/AIGCAIzhongtaigongyongwendang/api-key-usage-guide?lang=zh"
  ],
  "execution": "async",
  "verifiedOperations": ["generate", "reference", "edit"],
  "contractComplete": true,
  "contractScope": "jimeng_t2i_v40, signed submit/poll, URL inputs, no-mask, no-provider-cancel",
  "liveVerified": false,
  "cvOfficialFixedSignatureVectorAvailable": false
}
```

`verifiedOperations` 只表示文档支持。模型语义编辑有证据；精确 mask 不在此 req_key 的请求字段中。目录另有 inpainting/4.6 产品，本记录未核对，不把其能力合并到4.0。

## endpoint / auth / version / service / region / action

| 字段 | 官方值 | 来源 |
| --- | --- | --- |
| base / path | `https://visual.volcengineapi.com`，canonical path `/` | [J1], [J2] |
| method / Content-Type | POST，`application/json` | [J1] |
| Submit | `POST https://visual.volcengineapi.com/?Action=CVSync2AsyncSubmitTask&Version=2022-08-31` | [J1] |
| Poll | `POST https://visual.volcengineapi.com/?Action=CVSync2AsyncGetResult&Version=2022-08-31` | [J1] |
| service / region | 固定 `cv` / `cn-north-1`，不是方舟的 `ark` / `cn-beijing` | [J1], [J2] |
| auth | AK/SK，`Authorization: HMAC-SHA256 Credential=<AK>/<YYYYMMDD>/cn-north-1/cv/request, SignedHeaders=<列表>, Signature=<小写hex>` | [J2], [J3] |
| 版本 | OpenAPI query `2022-08-31` 与模型 req_key 中 v40 为两个独立版本维度 | [J1] |
| UTC日期 | `X-Date: YYYYMMDDTHHMMSSZ`，精确到秒 | [J2], [J3] |
| body hash | `X-Content-Sha256` 为发送的 body 原始字节 SHA-256 小写hex | [J2] |
| STS | 使用临时凭证时 `X-Security-Token` 必须携带，并按官方签名示例加入参与签名 header；长期 AK/SK 无需 | [J3], [J4] |
| 签名有效期 | 公共参数 `X-Expires` 默认900秒。此为通用签名有效期；没有取得“允许时钟偏差正负900秒”的证据 | [J3], [J4] |
| cancel | 4.0接口页没有取消动作说明；不能从别的产品或通用路由反推此模型支持 | [J1], [J7] |

### signed_request 编码步骤与向量证据

下述算法来自官方 HTTP Java/Go/Python/PHP 示例及公共签名规范，不是实际调用验证。[J2], [J4]

1. 先固定 UTF-8 JSON body 原始字节；hash 与实际发出的 body 必须完全相同，签名后不可再格式化 JSON。
2. URI=`/`；query包含 Action/Version；名称与值以 RFC3986 编码，参数名ASCII升序，空格 `%20`，用 `&` 拼接。
3. 参与签名的 header 名称转小写，值 trim；CanonicalHeaders 的顺序必须与 SignedHeaders 一致。可固定为 `content-type;host;x-content-sha256;x-date`，对应 `application/json`、`visual.volcengineapi.com`、payloadHash、UTC时间。官方 Go/Java 视觉样例用另一顺序，Python/PHP用此顺序；公共规范要求两者一致，不能把两份样例的不同顺序混合。
4. `CanonicalRequest = method + "\n" + URI + "\n" + query + "\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash`。canonicalHeaders 本身以换行结尾，因此 SignedHeaders 前有一个空行。
5. `scope = YYYYMMDD + "/cn-north-1/cv/request"`；`StringToSign = "HMAC-SHA256\n" + X-Date + "\n" + scope + "\n" + SHA256Hex(CanonicalRequest)`。
6. 二进制 HMAC 链：`kDate=HMAC(SK原始字符串字节,YYYYMMDD)`；`kRegion=HMAC(kDate,"cn-north-1")`；`kService=HMAC(kRegion,"cv")`；`kSigning=HMAC(kService,"request")`；signature=`Hex(HMAC(kSigning,StringToSign))`。SK 即便看起来像 base64，也不能自行先解码；样例直接用其字符串字节。
7. 加入 Authorization 和其他签名 header。生产实现不能照搬示例的打印 Authorization/完整请求/签名日志。

**官方固定向量的严格区分：**

- [J4] 公共签名方法页确实提供**假设 AK/SK、固定时间与 body、派生密钥、预期签名**的完整通用向量。该向量属于 `billing` 服务，POST `ListBill`，时间 `20250329T180937Z`，body `{"Limit":10,"BillPeriod":"2023-08"}`，官方预期签名 `5e8480ceea12d0000a23c054151c50dd02c1a7dec835004057d19f13d53a7658`；canonical hash `27383e3b56d03850f5634483527fbddcbf06cf98de1bc8a6679ef2300bff3b15`。可回源用于通用 signer 契约测试，不能标成 CV 或即梦向量。本文件不复制公开示例密钥，未执行计算或请求。
- [J2] 视觉服务样例只有占位 key、动态时间和待替换 body，**没有取得 `cv` / `jimeng_t2i_v40` 的官方固定输入与预期签名**。不自行计算一个签名再冒称官方向量。研究计划 Task2 的 CV 专用官方向量验收仍缺；应向官方获取可公开测试向量，或以后明确登记“依据官方算法自建”的 fixture，不能混同证据来源。

## body / upload / limits

| 提交字段 | 类型、必填和限制 | 来源 |
| --- | --- | --- |
| `req_key` | 必填 string，固定 `jimeng_t2i_v40` | [J1] |
| `prompt` | 必填 string，中英文；建议最长不超过800字符，过长可能出图异常。不是声明的硬性最大值 | [J1] |
| `image_urls` | 可选 string[]，0—10；建议≤6以保参考效果；此产品页未列可提交的 base64 输入字段 | [J1] |
| `size` | 可选int，图像面积，默认4194304；范围 `[1048576,16777216]` | [J1] |
| `width` / `height` | 同时传才生效，面积须在上述区间，宽高比须在min_ratio/max_ratio之间；与size同时传时优先宽高 | [J1] |
| `scale` | float，默认0.5，`[0,1]`，支持两位小数；越大文字影响越大、输入图影响越小 | [J1] |
| `force_single` | bool，默认false；true强制单图，否则由prompt理解判断图数 | [J1] |
| `min_ratio` / `max_ratio` | float，默认1/3与3，各自范围 `[1/16,16)`；不是传宽高的字符串字段 | [J1] |
| 输入图片要求 | JPEG/PNG，单文件≤15MB，最多10张；输入分辨率最大4096×4096，输入宽高比 `[1/3,3]` | [J1] |
| 输出数量 | 最大输出数=15−输入数；组图数量建议prompt控制9及以内。没有准确 count/n 参数 | [J1] |
| 输出尺寸 | 最大限制按像素面积而不是“每边均≤4096”；官方列4K输出6198×2656等示例。输入限制与输出限制不同 | [J1] |
| 上传 endpoint | 此产品页仅接受 image_urls，未提供专属二进制上传动作；本地资产须经明确配置的可访问存储 URL 输入，不能填任意本地路径 | [J1] |
| 速率 / 并发 | 有QPS/并发超限错误；无目标账号具体值，不能编造额度 | [J1] |
| `callback_url` | 仅异步回调方式，可选string，需公网可访问；轮询方式无需 | [J1] |
| `return_url` / `logo_info` / `aigc_meta` | 提交时仅对异步回调配置生效；logo_info/aigc_meta为JSON序列化字符串，不能误用到轮询参数位置 | [J1] |

静态最小提交（依据官方字段自拟，未执行）：

```http
POST /?Action=CVSync2AsyncSubmitTask&Version=2022-08-31 HTTP/1.1
Host: visual.volcengineapi.com
Content-Type: application/json
X-Date: <UTC_TIMESTAMP>
X-Content-Sha256: <BODY_SHA256_HEX>
Authorization: HMAC-SHA256 Credential=<AK>/<YYYYMMDD>/cn-north-1/cv/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=<SIGNATURE_HEX>

{"req_key":"jimeng_t2i_v40","prompt":"一只陶瓷小鸟，纯色背景","force_single":true,"size":4194304}
```

成功提交官方结构：`{"code":10000,"data":{"task_id":"<opaque string>"},"message":"Success","request_id":"<id>","time_elapsed":"104.852309ms"}`。[J1] ID按字符串保存，不把示例任务 ID 当有效任务。不等同完成。

轮询 body：

```json
{
  "req_key": "jimeng_t2i_v40",
  "task_id": "<submit returned task_id>",
  "req_json": "{\"return_url\":true}"
}
```

`req_json` 是**JSON字符串**，不是嵌套对象；可含 `return_url`、`logo_info` 对象及 `aigc_meta` 对象。LogoInfo字段：add_logo默认false、position默认0（0右下/1左下/2左上/3右上）、language默认0（0中文/1英文）、opacity默认1且`[0,1]`、logo_text_content可选。AIGCMeta若使用，producer_id为必填，content_producer/content_propagator/propagate_id可选。[J1] 首版请求可以只配置return_url并避免回调认证缺口。

## status / results / errors

先检查网关层 `ResponseMetadata`；官方通用文档说其非null时优先处理此结构，错误字段为 `Error.Code`/`Error.Message`，请求标识为 `RequestId`。否则解析服务层 `code`/`message`/`request_id`；**先判断code再解引用data**。[J5] `time_elapsed` 通用表标int，但4.0官方样例是带ms字符串，不能绑定严格int或据此计算收费。[J1], [J5]

| 官方字段或状态 | 官方含义 / 引擎映射建议（后者为实现裁决） | 来源 |
| --- | --- | --- |
| submit `code=10000` | 成功；data.task_id为后续查询句柄，RemoteResult=pending | [J1] |
| submit `code!=10000` | 不返回task_id；明确业务拒绝不当作已成功创建 | [J1] |
| `data.status=in_queue` | 已提交，映射pending/queued | [J1] |
| `generating` | 已被消费、处理中，映射pending/running | [J1] |
| `done` | 处理结束，可能成功也可能失败；必须结合外层code/message与实际输出，不能单独当成功 | [J1] |
| `not_found` | 无此任务或过期（12小时）；映射unknown，不解释成已取消或可免费重发 | [J1] |
| `expired` | 任务过期；官方建议重新提交，但design禁止自动重发已可能收费的attempt；保留unknown及句柄 | [J1], design |
| `data.image_urls` | string[]，输出PNG，链接24h有效 | [J1] |
| `data.binary_data_base64` | string[]，输出base64；根据返回格式可能null | [J1] |
| 外层 `status` 数字 | 官方样例明确忽略；与data.status字符串不同 | [J1] |
| 新增未知status / 空结果 | 未取得语义；保持unknown，不能当成功 | [J1], design |

查询HTTP错误、暂时网络失败、限流属于查询失败，不自动将已受理任务标failed。明确终态失败/业务拒绝与服务不可达需分开。结果下载保存完才由Service转succeeded；数量不足按design保留已取得资产并标partial_succeeded。任务查询有效期12h与图片链接24h是不同生命周期，不把有效URL当查询记录仍可恢复的保证。

| 错误 | 官方证据 | 来源 |
| --- | --- | --- |
| 网关400 `InvalidTimestamp` (100006) | 签名过期或时间来自未来；检查UTC/时钟，没有取得精确可容忍偏差 | [J6] |
| 网关401 `InvalidAccessKey` (100009), `SignatureDoesNotMatch` (100010) | 密钥不合法/签名不匹配 | [J6] |
| 网关401 `InvalidSecretToken` (100026) | STS错误，可能签名/到期；不记录token明文 | [J6] |
| 网关403 `AccessDenied` (100013) | IAM权限不足 | [J6] |
| 网关400 `InvalidAuthorization` / `InvalidCredential` | Authorization或Credential结构错误 | [J6] |
| 服务401 `50400` | 权限校验失败：开通/应用/签名等 | [J5] |
| 400 `50200`, `50201`, `50204`, `50205`, `50207`, `50213`, `50215` | 参数、缺参数、类型、尺寸、解码、body过大、输入不满足服务要求 | [J5] |
| 400 `50411`, `50412`, `50413`, `50518` | 输入图片/文本/版权审核拒绝，官方无需重试 | [J1] |
| 400 `50511`, `50519` | 输出图片审核/版权审核，官方标可重试；引擎不据此自动新增收费提交 | [J1], design |
| 400 `50512`, `50520`, `50521`, `50522` | 输出文本审核或审核相关服务异常，官方表标无需重试 | [J1] |
| 429 `50429`, `50430` | QPS/并发超限，官方标可重试；通用旧文档将50429列404，应以此4.0产品页429优先，并仍解析body code | [J1], [J5] |
| 500 `50500`, `50501` | 内部/内部RPC错误，4.0表标无需重试 | [J1] |

`request_id` 是诊断字段，没有按它查任务/幂等重放的证据。提交送达不明属于Delivery=uncertain；官方“可重试”不能覆盖design的收费提交规则。

## cancel / reconcile / continuation / workflow mapping

- **Cancel：**签名4.0产品页未给取消契约，`supportsCancel=false`。J7通用API Key页列CVCancelTask，不足以证明jimeng_t2i_v40支持取消，更没有该模型取消终态、是否退款等证明。Cancel应返回ErrUnsupported，本地取消依design记录local_only。
- **Poll恢复：**已经durable保存task_id，可按同一req_key/账号继续查询，最长受任务12h窗口约束。可实现`Reconcile(handle)`复用Poll；若`supportsReconcile=true`，必须在说明中明确它**只支持已知handle**。
- **提交丢失核对：**没有客户SubmissionKey/idempotency key、按key查task_id或任务列表匹配请求的官方证据。未持久化task_id不能靠request_id/请求hash恢复，不自动重新提交；即使能力布尔为true也不能宣称此种核对成功。
- **Continuation：**重新传上次图像是新调用，不是会话续接，supportsContinuation=false。
- **Preview / mask：**轮询/回调结果无渐进图像预览证据，supportsPreview=false。4.0无mask输入字段，不能登记精确mask。
- **WorkflowMapping：**不适用，kind=model，remoteId建议为req_key；协议版本与profile作为冻结目标信息保留。没有RunningHub节点输入映射。

## 另一个官方入口：视觉 API Key（本记录不混用）

4.0接口页明确链接“API_KEY请求示例”。该公开说明当前提供以下映射：[J1], [J7]

| Action | 独立视觉API Key POST路径 | 来源 |
| --- | --- | --- |
| CVSync2AsyncSubmitTask | `https://openapi.cv.volces.com/api/common/v3/submit_task_v2` | [J7] |
| CVSync2AsyncGetResult | `https://openapi.cv.volces.com/api/common/v3/get_result_v2` | [J7] |
| CVSubmitTask / CVGetResult / CVProcess | `/api/common/v3/submit_task` / `get_result` / `process` | [J7] |
| CVCancelTask | `/api/common/v3/cancel_task`，通用例body=req_key+task_id；4.0适用性未证实 | [J7] |

该入口auth=`Authorization: Bearer <视觉API Key Secret>`，Content-Type=json，示例不携带Action/Version query。它与signed_request具有不同域名/路径/认证，**不是方舟Bearer key通用兼容**。不能说“即梦只能用AK/SK”，也不能因为此新文档存在而自动切换本次选定的signed_request profile。

## 具体缺口与获取方式

- 无CV专用官方固定签名向量；只有J4通用billing官方向量和J2视觉算法样例。需官方提供或后续明确分类自建fixture，本轮不编造。
- 无已丢失task_id的核对/幂等证据；无4.0专用取消；无回调签名/重放防护保证。需产品正式协议/供应商答复，首版用轮询避免回调信任问题。
- 未取得4.0输入base64/二进制上传的证据，本地资产URL承载环境未配置；不默认借用其他req_key参数。
- 未取得目标账户QPS/并发额度、合法服务开通、真实成功/失败/到期收据；本轮无fixture/test，liveVerified=false。后续真实验证需指定模型、输入、次数、预算、环境并独立授权。
- 版本/弃用：2022-08-31仍为4.0页指定版本；未取得该产品正式弃用时间。4.6目录项不说明4.0已自动弃用。

## 官方来源索引

所有URL访问日均为**2026-10-11**；旧产品文档URL自动跳转新语义路径。页面更新时间仅辅助定位，不替代checkedAt。

[J1]: https://docs.volcengine.com/docs/JimengAI/JimengAI-ImageGeneration40-InterfaceDocumentation?lang=zh
[J2]: https://www.volcengine.com/docs/6444/1390583
[J3]: https://www.volcengine.com/docs/6369/67268
[J4]: https://www.volcengine.com/docs/6369/67269
[J5]: https://www.volcengine.com/docs/6444/69728
[J6]: https://docs.volcengine.com/docs/APISignatureCallGuide/Commonerrorcode-10?lang=zh
[J7]: https://docs.volcengine.com/docs/AIGCAIzhongtaigongyongwendang/api-key-usage-guide?lang=zh

- [J1] 即梦AI-图片生成4.0-接口文档，更新时间 `2026.09.21 15:47:02`。
- [J2] 视觉HTTP请求示例，更新时间 `2025.03.05 11:25:02`。
- [J3] OpenAPI公共参数，更新时间 `2025.05.19 20:12:26`。
- [J4] 签名方法，跳转 `https://docs.volcengine.com/docs/APISignatureCallGuide/Signaturemethod-9?lang=zh`，更新时间 `2025.09.15 19:16:09`。
- [J5] 通用返回字段及错误码，更新时间 `2025.03.05 11:25:02`。
- [J6] 网关公共错误码，更新时间 `2023.07.05 19:49:14`。
- [J7] 使用API Key调用说明，更新时间 `2026.09.21 11:27:37`。
