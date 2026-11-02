# 火山方舟 Seedream 协议核对

核对/访问日期：**2026-10-11**。依据 `docs/plans/2026-10-11-image-studio/00-provider-verification.md` 和 `design.md`。本文件只记录公开官方协议；未读取私人凭据，未登录控制台，未调用生成/上传/查询接口，未执行 Adapter 测试。`verifiedOperations` 指文档证据，不代表真实调用。

## 证据结论及产品范围

选定首个可编码 profile：**中国北京区域，火山方舟数据面 Images API，Doubao Seedream 5.0 pro，普通单图生成/参考图/语义编辑，非流式**。官方当前示例明确使用 `doubao-seedream-5-0-pro-260628`；不是凭记忆填写 ID。[V1]

`contractComplete=true` 仅表示这个收窄 profile 的请求、认证、结果、错误与限制已具备静态编码依据；不代表账号已开通、配额已验证或生产目标可启用。按照 design，`liveVerified=false` 的生产目标仍应 disabled。取消、提交丢失后的核对、会话续接、精确 mask 均不得宣称支持。

```json
{
  "vendor": "volcengine",
  "product": "Volcano Ark Images API / Doubao Seedream 5.0 pro",
  "checkedAt": "2026-10-11",
  "sourceUrls": [
    "https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh",
    "https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh",
    "https://docs.volcengine.com/docs/ark/error-codes?lang=zh",
    "https://docs.volcengine.com/docs/ark/image-generation-streaming-responses?lang=zh"
  ],
  "execution": "direct",
  "verifiedOperations": ["generate", "reference", "edit"],
  "contractComplete": true,
  "contractScope": "seedream-5.0-pro, non-streaming, single-image, bearer, no-mask",
  "liveVerified": false
}
```

## endpoint / auth / version / service / region / action

| 字段 | 官方证据 | 来源 |
| --- | --- | --- |
| Base URL | `https://ark.cn-beijing.volces.com/api/v3` | [V2] |
| 提交 endpoint | `POST https://ark.cn-beijing.volces.com/api/v3/images/generations` | [V1] |
| Content-Type | `application/json` | [V1] |
| auth | `Authorization: Bearer <ARK_API_KEY>`；图像接口页列 API Key 鉴权 | [V1], [V2] |
| region | 北京，Base URL 中为 `cn-beijing`；本记录未验证其他区域域名 | [V1], [V2] |
| version | 数据面路径版本 `v3`；模型版本独立于协议版本 | [V1], [V2] |
| model | 必填 string，可为 Model ID 或 Endpoint ID；选定公开样例 ID 为 `doubao-seedream-5-0-pro-260628` | [V1] |
| service / Action | 本 Bearer 数据面请求不携带云 OpenAPI `Service`/`Action`/`Version` query；不能套用视觉服务 `cv` | [V1], [V2] |
| 管控面区别 | `https://ark.cn-beijing.volcengineapi.com/`，签名 service=`ark`、region=`cn-beijing`；例如 `ListEndpoints` 的 `Version=2024-01-01`。这些不是图片生成路径参数 | [V2] |
| Access Key 边界 | 通用鉴权页还提供 AK/SK 数据面方式，且 model 必须为 Endpoint ID；本首版 profile 未核对其图像专用签名契约，不能自动替换 Bearer | [V2] |
| 查询 / 取消 | 本图片 API 页没有图片 task handle、查询或取消路径。视频生成任务的查询/取消不适用于此 endpoint | [V1] |

## body 与模型参数

| 字段 | 类型、必填和语义 | 来源 |
| --- | --- | --- |
| `model` | string，必填；账号必须开通所选模型 | [V1] |
| `prompt` | string，图片生成场景必填；中英文支持。中文不超过 300 字、英文不超过 600 词是建议，不是硬性长度上限 | [V1] |
| `image` | 可选 string 或 string[]；可访问 URL 或 `data:image/<小写格式>;base64,<数据>` | [V1] |
| `size` | pro/flash 图片生成默认 `2K`，档位 `1K`/`1.5K`/`2K`；也可传 `宽x高`。像素乘积须在 `[921600,4624220]`，宽高比 `[1/16,16]` | [V1] |
| `response_format` | `url`（默认）或 `b64_json`；URL 生成后 24 小时有效 | [V1] |
| `output_format` | pro/flash/lite 支持 `jpeg`（默认）或 `png`；不能据此给 4.5/4.0 开此参数 | [V1] |
| `watermark` | boolean，默认 true；右下角“AI 生成”标识 | [V1] |
| `optimize_prompt_options.mode` | `standard` 默认；pro 可用 `fast`。flash/lite/4.5 当前不支持 fast | [V1] |
| `sequential_image_generation` | 仅 lite/4.5/4.0；`disabled` 默认单图，`auto` 由模型判断组图数。pro/flash 不支持配置此字段 | [V1] |
| `sequential_image_generation_options.max_images` | 仅上述组图模型，integer `[1,15]`，默认 15，是最大值而非准确产出数量 | [V1] |
| `stream` | 默认 false；lite/4.5/4.0 支持 true；pro/flash 暂不支持流式 | [V1], [V4] |
| `tools` | 只有 lite 的工具配置在当前页面有证据，`type=web_search`；pro/flash 不支持联网搜索 | [V1] |
| `layer_decomposition` | pro/flash 支持，默认 false。开启需单张图片，最多 1 张底图+16 图层；任一图层失败整体失败。design 首版排除图层，不启用 | [V1] |
| `background` | pro/flash 支持 `opaque` 默认或 `transparent`；透明模式只支持单张有透明通道输入，输出 PNG，与 JPEG 冲突会报错；未纳入首个收窄 profile | [V1] |
| `n` / mask | 当前请求 schema 无 OpenAI `n` 或二进制 mask 字段；不推导支持 | [V1] |

以下是**依据官方字段构造的静态请求**，没有执行，非真实收据；示例 prompt 为自拟。

```http
POST /api/v3/images/generations HTTP/1.1
Host: ark.cn-beijing.volces.com
Authorization: Bearer <ARK_API_KEY>
Content-Type: application/json

{"model":"doubao-seedream-5-0-pro-260628","prompt":"一只陶瓷小鸟，纯色背景","size":"2K","response_format":"b64_json","output_format":"jpeg","watermark":true}
```

参考图或语义编辑复用相同 endpoint，加 `image`。输入资产权限检查及图片转 data URL 属于 K-Brain 实现，不是平台上传动作。pro 单次只输出单张；K-Brain `count>1` 应调度多个独立执行项并分别记录 attempt，不能向上游加 `n`。

## status / results / errors

| 字段 | 官方定义及解析顺序 | 来源 |
| --- | --- | --- |
| `created` | Unix 秒 integer | [V1] |
| `model` | 实际使用模型 string | [V1] |
| `data[]` | 输出数组，公共字段 `url` 或 `b64_json`、`size`；pro/flash 可返回 `output_format` | [V1] |
| 顶层 `error` | 当整个请求未生成任何图片时返回 `code`/`message` | [V1] |
| `data[].error` | 组图模型单图失败的 `code`/`message`；其他成功图不受影响。审核失败继续下一张；内部 500 不继续下一张 | [V1] |
| `usage.generated_images` | 成功生成图数，不含失败图；官方说明按成功张数计费 | [V1] |
| `usage.input_images` | pro/flash 输入图数 | [V1] |
| `usage.output_tokens` / `total_tokens` | 当前说明输出 token 为图像像素乘积之和/256取整，total 等于 output；不能直接当金额 | [V1] |
| `usage.tool_usage.web_search` | lite 工具次数，只有该功能开启时有此字段 | [V1] |

**实现判断（非供应商状态字面值）**：普通同步 Submit 返回且有合法图像时映射 RemoteResult `completed`；顶层错误或无成功输出且明确失败映射 `failed`；断线、超时、响应截断、无法解码且已经可能送达映射 Delivery=`uncertain`/`result_unknown`。输出原子保存前由 Service 标 `saving`，不能仅凭 HTTP 200 标 `succeeded`。URL 必须后台及时下载，base64 必须真实解码验证。

| HTTP / 官方错误码示例 | 含义与引擎处理建议 | 来源 |
| --- | --- | --- |
| 400 `MissingParameter`, `InvalidParameter`, `InvalidParameter.UnsupportedParameter` | 参数拒绝；Delivery=`rejected`，不自动重复提交 | [V3] |
| 400 `InputTextSensitiveContentDetected`, `InputImageSensitiveContentDetected`, `OutputImageSensitiveContentDetected` | 输入/输出审核错误；保留脱敏 code/message，不能自动绕过或悄悄换提示词 | [V3] |
| 401 `AuthenticationError` | Key 缺失或无效；连接认证错误 | [V3] |
| 403 `AccessDenied`, `AccountOverdueError`, `OperationDenied.ServiceNotOpen` | 权限/欠费/服务未开通 | [V3] |
| 404 `InvalidEndpointOrModel.NotFound`, `ModelNotOpen` | 模型/Endpoint不存在、无权限或未开通 | [V3] |
| 429 `ModelAccountIpmRateLimitExceeded` | 模型账户 IPM 限制 | [V3] |
| 429 `RateLimitExceeded.EndpointRPMExceeded`, `ModelAccountRpmRateLimitExceeded`, `QuotaExceeded`, `InflightBatchsizeExceeded` | 限流/额度/并发等；具体数值依目标账户，不把通用错误列表当每个模型均会返回的保证 | [V3] |
| 500 `InternalServiceError` | 官方建议稍后重试；引擎必须先判断 delivery，已可能送达的生成提交不自动重发 | [V3], design |

错误页列 Type/Code/Message 与 HTTP 状态；图片页明确最小 `error.code/message`。本轮未取得图片 endpoint 所有网关错误的逐个完整 HTTP fixture、统一 request-id header 契约；不得从错误文本拼造可查询的句柄。

流式扩展的官方事件为 `error`、`image_generation.partial_succeeded`、`image_generation.partial_failed`、`image_generation.completed`。单图事件含 `image_index`；成功含 `url` 或 `b64_json`、`size`，失败含 `error`，completed 含汇总 usage。它是逐张结果，不是渐进预览，也没有断线重放证明。[V4] 本首版 pro profile 不使用 stream；后续 lite/4.x profile 实现须另外冻结事件 fixture。

## upload / limits / reconcile / workflow mapping

| 项目 | 结论及边界 | 来源 |
| --- | --- | --- |
| upload | 图片生成直接接收 image URL/data URL；未见该 endpoint 接收 Files API `file_id` 的证据。不把通用 Files 上传当图像生成必需流程 | [V1], [V2] |
| 单图输入 | 生成场景：jpeg/png/webp/bmp/tiff/gif/heic/heif，≤30MB，宽高均>14px，像素乘积 `[196,36000000]`，宽高比 `[1/16,16]` | [V1] |
| maxInputs | pro/flash=10；lite/4.5/4.0=14 | [V1] |
| maxCount | pro/flash单次=1；lite/4.5/4.0组图输入数量+最终输出数量≤15，max_images是上限；不能承诺准确 count | [V1] |
| 其他模型尺寸 | 4.0：1K/2K/4K，像素 `[921600,16777216]`；4.5：2K/4K，像素 `[3686400,16777216]`；lite：2K/3K/4K，同4.5像素范围。三者自定义宽高比均 `[1/16,16]` | [V1] |
| 速率/并发 | 取得 IPM/RPM/并发错误证据；未取得目标账户具体额度，不填写固定 QPS 或“默认无限” | [V3] |
| cancel | 未取得图片取消协议；`supportsCancel=false`，Cancel 返回 ErrUnsupported。本地取消按 design `local_only`，不是已停止上游 | [V1], design |
| reconcile | 无任务 ID、客户幂等 key 或按请求 key 检索结果的官方证据；`supportsReconcile=false`，Poll/Reconcile 返回 ErrUnsupported | [V1], design |
| continuation | image 可重新引用已保存资产，但不是供应商会话续接；`supportsContinuation=false` | [V1] |
| preview / mask | pro 无 stream，且无 mask 参数；`supportsPreview=false`，不登记精确 mask operation。坐标/框选/箭头提示式编辑不能自动等同透明遮罩 | [V1] |
| workflow mapping | 不适用，kind=`model`；remoteId 为模型或已配置 Endpoint ID，不能填写 RunningHub node mapping | [V1], design |

K-Brain 自有限制与平台限制取交集：单图上传默认20MiB/40MP，但此平台像素上限36MP；pro最大10输入、单次1输出。服务说明的30MB未声明 MiB，不把单位擅自替换。输出 PNG/JPEG 仍须真实 MIME/尺寸验证，URL 不公开，usage 金额未知为 null。

## 缺口和验收层次

- 已有：所选非流式单图 profile 的公开协议、具体模型示例 ID、必填字段、输入输出与错误分类；可据此做静态编码。
- 未做：契约 fixture、Go 测试、真实提交与图片下载、账户开通和额度核验；`liveVerified=false`。账号 API Key/权限/预算只能在以后单独授权的环境验证。
- 未取得：图片专用幂等/任务查询/取消/续接证据，其他区域 URL，目标实际 IPM/并发，所有错误原始 fixture。需要官方新文档/供应商确认或另行授权验证，不以猜测填参数。
- 版本/弃用：图片页2026-10-10更新，列5.0 pro/flash/lite、4.5、4.0；页面未声明这些版本全部永久可用，也未取得它们的正式弃用时间。不能把页面更新日期当本次读取日期。

## 官方来源索引

以下 URL 均于 **2026-10-11** 公开访问；旧 `https://www.volcengine.com/docs/82379/1541523` 自动跳转到 V1。字段证据读取包含页面公开折叠字段正文，无控制台调试或内部接口逆向。

[V1]: https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh
[V2]: https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh
[V3]: https://docs.volcengine.com/docs/ark/error-codes?lang=zh
[V4]: https://docs.volcengine.com/docs/ark/image-generation-streaming-responses?lang=zh

- [V1] 图片生成 API；页面更新时间 `2026.10.10 22:39:45`。
- [V2] Base URL及鉴权；页面更新时间 `2026.10.09 14:36:33`。
- [V3] 错误码；页面更新时间 `2026.10.08 16:16:57`。
- [V4] 图片生成流式响应事件；页面更新时间 `2026.09.22 12:13:36`。
