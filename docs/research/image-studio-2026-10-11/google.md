# Google：Gemini Developer API generateContent 图像协议核对

核对日期：**2026-10-11**。产品范围：Google AI for Developers / Gemini Developer API；首个候选 Adapter 为 `google.gemini.generateContent`，不把 Interactions、Imagen 或 Vertex 的协议合并进来。本文依据在线官方网页及其 REST / schema 示例，不包含真实生成请求。用户已授权基于 LiveAgent 的 `v2-kbrian` 接入基础继续实施；K-Brain 源码目录的文件工具授权仍未生效。

## 证据状态与来源

- **官方文档事实**：下表标 D 的页面实际在线读取成功。摘录日期是本次读取日期；页面 Last updated 单独记录，不能代替核对日。
- **实现建议 / 推断**：明确标记为 I；用于收紧 Adapter，不是供应商保证。
- **真实请求验证**：未执行；`liveVerified=false`。没有读取凭据、进入 AI Studio 登录页或调用收费 API。
- **完成度**：同步 generate/reference/edit 和保留历史的静态协议已具备实现依据。本次补读了输出 MIME/ratio/size 的完整 schema 枚举、所选模型详情/生命周期和可用地域；新 `responseFormat.image` 的指南字符串与 reference enum 差异仍未消除，所选图像模型的 `candidateCount>1` / 可选输出 MIME 支持也未获模型级保证。整份目标契约继续 `contractComplete=false`，最小冻结范围见下文；`liveVerified=false`，生产目标保持 disabled。

| ID | 官方 URL | 本次读取结果 / 页面更新时间 |
| --- | --- | --- |
| D1 | https://ai.google.dev/gemini-api/docs/image-generation | 成功；Interactions API (Recommended)；2026-10-09 |
| D2 | https://ai.google.dev/gemini-api/docs/generate-content/image-generation | **有效**；带 `?hl=en` 的同路径页面成功打开；浏览器标题 `Gemini Generate Content API (Legacy)`；正文 generateContent API；2026-10-09 |
| D3 | https://ai.google.dev/api/generate-content | 成功；generateContent / streamGenerateContent、Content、Part、响应、配置完整 schema；2026-09-23 |
| D4 | https://ai.google.dev/gemini-api/docs/generate-content/api-errors | 成功；明确针对 GenerateContent；2026-09-20 |
| D5 | https://ai.google.dev/gemini-api/docs/generate-content/image-understanding | 成功；输入 MIME / inline 请求大小；2026-10-09 |
| D6 | https://ai.google.dev/gemini-api/docs/generate-content/api-key | 成功；API key / auth key 迁移说明；2026-10-06 |
| D7 | https://ai.google.dev/gemini-api/docs/api-versions | 成功；v1 stable、v1beta、SDK 默认版本；2026-09-23 |
| D8 | https://ai.google.dev/gemini-api/docs/rate-limits | 成功；项目级 RPM/TPM/RPD/IPM；2026-10-09 |
| D9 | https://ai.google.dev/gemini-api/docs/imagen | 成功；Gemini API 的 Imagen 已关闭；2026-09-17 |
| D10 | https://ai.google.dev/gemini-api/docs/interactions | 成功；服务端状态 / previous_interaction_id / background；2026-10-09 |
| D11 | https://ai.google.dev/gemini-api/docs/api-errors | 成功；**针对 Interactions**，不能用于 generateContent 错误解码；2026-09-20 |
| D12 | https://ai.google.dev/gemini-api/docs/troubleshooting | 成功；SDK 默认重试 / REST 退避建议；2026-10-01 |
| D13 | https://cloud.google.com/vertex-ai/generative-ai/docs/image/generate-images | 原轮成功；Vertex Imagen predict 路径 / Bearer；2026-10-09；原轮记录页面提示该文档不再更新，应转 Gemini Enterprise Agent Platform；本次未复读，不据此扩大当前可用性结论 |
| D14 | https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1?hl=en | 本次成功；stable 模型详情；Last updated 2026-10-06 UTC，模型 Latest update October 2026 |
| D15 | https://ai.google.dev/gemini-api/docs/available-regions?hl=en | 本次成功；Developer API / AI Studio 国家和地区清单；2026-04-28 UTC |
| D16 | https://ai.google.dev/gemini-api/docs/deprecations?hl=en | 本次成功；Nano Banana 发布/关停表；2026-10-09 UTC |
| D17 | https://ai.google.dev/gemini-api/docs/models?hl=en | 本次成功；模型目录的 2.1 条目标为 New Stable，直链 D14；未提取页脚更新时间 |

**本次补核访问收据（2026-10-11，browser 实际联网读取正文）：**D1/D2 使用 `?hl=en` 时首次导航均超时，随后读取已加载正文与标题成功；这不是 404 或协议弃用的证据。D3 使用 `?hl=en` 和 `#GenerationConfig` 读取 schema，确认 Last updated 2026-09-23；D4/D6/D7/D12 使用 `?hl=en` 成功复读，页脚日期与上表一致。D5/D8—D11 保留原轮证据，本次未重新访问，不将其写成新增验证。本次补核确认 2.1 模型、October 2026 详情、2026-05-28 key 迁移、Legacy 标题和 responseFormat enum 都存在于实页，不能因名称/日期较新而用模型记忆替换。未获取独立 HTTP 状态收据。

D2 初次导航等待超时，稍后成功读取页面；不能把初次超时写成 404。页面导航中的 `Nano Banana` 链接也直接指向该第二网址。正文、REST 代码和官方导航共同证明它是有效的 generateContent 图像文档。没有取得独立的 HTTP 状态抓取收据，不虚构 HTTP 200。

## 产品、版本、endpoint 与认证

**D2 官方 REST 示例：**

```http
POST https://generativelanguage.googleapis.com/v1/models/gemini-nano-banana-2.1:generateContent
x-goog-api-key: <由后端注入，不回显>
Content-Type: application/json
```

**D3 reference：**

```text
POST https://generativelanguage.googleapis.com/v1beta/{model=models/*}:generateContent
POST https://generativelanguage.googleapis.com/v1beta/{model=models/*}:streamGenerateContent
```

`model` 必填，形式为 `models/{remoteId}`。D7 明确 `v1` 为 stable、SDK 默认 `v1beta`，且 “All models are supported in both v1 and v1beta”，版本差异针对 endpoint / schema 特性。因此指南 v1 和 reference v1beta 不应被解释为模型只在其中一个版本可用。**I：**首个静态 profile 固定 `v1beta` 与 D3 的 schema，后续 v1 单独冻结 profile；不能由 UI 随意替换版本。

D6 记录认证迁移：2026-05-28 起 AI Studio 新建 key 默认是绑定服务账号的 authorization key；不受限制的 standard key 已拒绝，有显式限制的 standard key 继续工作。**这不是把 REST header 改成 OAuth Bearer**：D2 的 REST 示例仍使用 `x-goog-api-key`。运行时以 `api_key_header` 注入，前端只持秘密引用。

Developer API 示例没有 project/location 路径段，不能把 Vertex location 当该协议的可配置参数。**D15 已读取：**Gemini API / AI Studio 支持清单包含美国、英国、日本、新加坡、台湾等；完整清单以 D15 为准。本次读取清单没有中国大陆或香港条目，不能声明国内部署自动可用。D15 特别说明 Colab 按实例所在地域限制；它不是数据驻留或实际执行机房的保证。页面还说明 AI Studio 的 18+ 与年龄验证前置条件。没有访问账号，目标环境的出口地域、账号资格、额度及计费计划仍未核实。

## 请求体：确定可实现的最小边界

D3 必填 `contents[]`；`Content.parts[]` 包含文本或图片；多轮 `role` 使用 `user` / `model`。`Part` 的数据是 union，一部分只放一种数据。reference 的规范 JSON 键为 camelCase：`inlineData`、`mimeType`、`thoughtSignature`。D2 某些 REST 示例使用 snake_case；首版按 D3 规范输出，不把 SDK 的字段拼写当 wire 契约。

**生成请求，按 D2 文生图示例与 D3 schema 合成；未调用：**

```json
{
  "contents": [{
    "role": "user",
    "parts": [{"text": "Create an illustration of a yellow ceramic cup on a blue table."}]
  }],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"]
  }
}
```

**参考图 / 编辑请求，图片需由已校验资产解析得到；未调用：**

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      {"text": "Change the cup to green and preserve the composition."},
      {"inlineData": {"mimeType": "image/png", "data": "<BASE64_IMAGE_BYTES>"}}
    ]
  }],
  "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}
}
```

`data` 为图片字节的 base64，不是 data URL。`fileData:{mimeType,fileUri}` 也在 D3 schema 中存在；D5 允许 Files API 引用，但文件上传/保留/删除协议本轮未冻结，**I：**首版仅启用 inline 输入。不能把任意本地路径或公网上图片 URL 当成 `inlineData.data`。

D2 默认混合 text/image，可只请求 IMAGE；D3 列出的枚举为 `TEXT` / `IMAGE` / `AUDIO`。**I：**首版只发 `TEXT,IMAGE` 或 `IMAGE`，不开放音频。

### 配置字段：完整枚举证据与尚未消除的冲突

本次复读 D3 的 [GenerationConfig](https://ai.google.dev/api/generate-content?hl=en#GenerationConfig)、[ImageConfig](https://ai.google.dev/api/generate-content?hl=en#ImageConfig)、[ImageResponseFormat](https://ai.google.dev/api/generate-content?hl=en#ImageResponseFormat) 及其 enum 表。以下是**通用 schema 事实**，不是所有图像模型支持每种配置的保证；D3 开头明确 “Not all parameters are configurable for every model”。

| 字段 | D3 官方类型/值 | 冻结范围 |
| --- | --- | --- |
| `generationConfig.responseMimeType` | string；用于 candidate **text**：`text/plain`、`application/json`、`text/x.enum` | 不能填 image/png 来控制图片编码；2.1 模型 D14 不支持 structured outputs |
| `generationConfig.imageConfig.aspectRatio` | string；`1:1,1:4,4:1,1:8,8:1,2:3,3:2,3:4,4:3,4:5,5:4,9:16,16:9,21:9` | D2 的 2.1 尺寸表覆盖同一组；可作为受限旧字段 profile 的文档基线 |
| `generationConfig.imageConfig.imageSize` | string；`512,1K,2K,4K`，未设置默认 1K | 2.1 按 D2/D14 收紧为 `1K,2K,4K`，不能选 512；uppercase K，512 无 K |
| `generationConfig.responseFormat.image.mimeType` | enum；`MIME_TYPE_UNSPECIFIED`（unused 默认）、`IMAGE_JPEG` | 通用 schema 只列 JPEG；没有 PNG/WebP 可选枚举，也没有 D14 的模型级支持保证 |
| `generationConfig.responseFormat.image.delivery` | enum；`DELIVERY_UNSPECIFIED`（unused）、`INLINE`、`URI` | schema 有这两种交付形态；首版仍只接受最小 inline 输出，不因此启用 URI |

D3 `responseFormat.image.aspectRatio` 的完整 enum / 语义映射：

| reference enum | 比例 |
| --- | --- |
| ASPECT_RATIO_ONE_BY_ONE | 1:1 |
| ASPECT_RATIO_TWO_BY_THREE | 2:3 |
| ASPECT_RATIO_THREE_BY_TWO | 3:2 |
| ASPECT_RATIO_THREE_BY_FOUR | 3:4 |
| ASPECT_RATIO_FOUR_BY_THREE | 4:3 |
| ASPECT_RATIO_FOUR_BY_FIVE | 4:5 |
| ASPECT_RATIO_FIVE_BY_FOUR | 5:4 |
| ASPECT_RATIO_NINE_BY_SIXTEEN | 9:16 |
| ASPECT_RATIO_SIXTEEN_BY_NINE | 16:9 |
| ASPECT_RATIO_TWENTY_ONE_BY_NINE | 21:9 |
| ASPECT_RATIO_ONE_BY_EIGHT | 1:8 |
| ASPECT_RATIO_EIGHT_BY_ONE | 8:1 |
| ASPECT_RATIO_ONE_BY_FOUR | 1:4 |
| ASPECT_RATIO_FOUR_BY_ONE | 4:1 |

另有 `ASPECT_RATIO_UNSPECIFIED` unused 默认。D3 `responseFormat.image.imageSize` 完整 enum 为 `IMAGE_SIZE_UNSPECIFIED`（unused 默认）、`IMAGE_SIZE_FIVE_TWELVE`（512px）、`IMAGE_SIZE_ONE_K`（1K）、`IMAGE_SIZE_TWO_K`（2K）、`IMAGE_SIZE_FOUR_K`（4K）。这些名字和语义确由 reference 表格支持；**尚未验证 ratio 字符串是否是 enum 的 wire 别名**。

D2 新 REST 示例却使用 `generationConfig.responseFormat.image:{aspectRatio:"16:9",imageSize:"2K"}`。D3 将这两个新字段列为 enum；本次重读未发现同页说明二者可互换。不能自行猜测 SDK 转换或 REST 自动归一化，也不能把该冲突记成已解决。D2 签名样例的 `inline_data.mime_type="image/png"` 只证明 PNG 响应样例形态；文件名 `.png` 本身不证明编码。D3 新输出选择器只列 JPEG，**不推导默认 PNG 已关闭或 JPEG 已在所选模型实测成功**。

**I：最小冻结 profile** 固定 `POST /v1beta/models/gemini-nano-banana-2.1:generateContent`、JSON、`x-goog-api-key`、text/inline image 的 contents，`responseModalities=["TEXT","IMAGE"]` 或 `["IMAGE"]`，不发送 `responseFormat`、`responseMimeType`、`candidateCount`、工具、Files 或 Batch。默认 1K，比例由模型选择；可另将 `imageConfig` 字符串 ratio/size 按 D2/D3/D14 收紧后构造静态契约，但首个无可选配置请求不依赖这一字段。禁止同时发两套配置来猜测兼容。此冻结是所选 **Legacy generateContent** 协议范围；D1 推荐 Interactions 没有改变这次选择，也不表示 generateContent 已关停。

## 成功响应、混合内容与续接

D3 `GenerateContentResponse` 含 `candidates[]`、`promptFeedback`、`usageMetadata`、`modelVersion`、`responseId`、`modelStatus`。Candidate 含 `content.parts[]`、`finishReason`、`safetyRatings` 等。D2 遍历每个 part，分别处理 text 和 inline 图片。

**下面是按官方 schema 合成的成功结构示例，不是官方响应收据，占位 base64 不能当可解码 fixture：**

```json
{
  "candidates": [{
    "index": 0,
    "content": {
      "role": "model",
      "parts": [
        {"text": "Here is your illustration.", "thoughtSignature": "<OPAQUE_SIGNATURE_A>"},
        {"inlineData": {"mimeType": "image/png", "data": "<BASE64_IMAGE_BYTES>"}, "thoughtSignature": "<OPAQUE_SIGNATURE_B>"}
      ]
    },
    "finishReason": "STOP"
  }],
  "modelVersion": "<PROVIDER_MODEL_VERSION>",
  "responseId": "<PROVIDER_RESPONSE_ID>"
}
```

**I：**遍历所有候选/parts，保存全部合法的非 thought 图片，保留文本顺序供后续多轮使用；不得只取第一个 part、把文本当图片、把 200 或 STOP 单独当成功。`thought:true` 的中间图片不是最终资产。usageMetadata 是 token 用量，非已结算金额；金额未知为 null，不能按 0 元填入。

**D2 续接事实：**“if you receive a thought signature ... pass it back exactly as received”；不传可能导致失败。非 thought 输出的图片 part 应有签名；开头第一个非 thought 文本 part 也可能有签名；thought 中的图片没有签名。D3 wire 为 `thoughtSignature`，类型 opaque base64。**I：**后端保留整段原始 Content/Part 历史，包括顺序、图片、所有签名，下一轮 contents 追加完整 model content 与新的 user content。禁止签名裁剪、合并签名、解密、写到 UI / 公开 job。D2 的简短多轮 REST 示例省略签名，不能据此覆盖其 Thought signatures 段落要求。

多轮编辑是新一次生成、可能新计费，**不是**丢失请求的恢复查询。`responseId` 仅在 D3 被描述为响应标识，未发现据其查询 generateContent 结果的 endpoint。

## 模型能力、输入与输出限制

D2 当前列出的 remoteId：

| 模型 | 官方描述 / 已明确限制 |
| --- | --- |
| gemini-nano-banana-2.1 | 当前主力；生成/对话编辑；1K/2K/4K；最多 14 参考图；10 物体 + 4 人物一致性；不支持 512 |
| gemini-3.1-flash-lite-image | 快且低成本；仅 1K；文档说明不针对多参考/连续多轮编辑优化；不能等同声明多轮质量保证 |
| gemini-3.1-flash-image | 上代主力；512/1K/2K/4K；建议新项目用 2.1 |
| gemini-3-pro-image | 高复杂度任务；最多 14 总参考图；正文部分还写 5 张高保真，表格另有物体/人物/风格分类，不能把高保真子类计数直接相加为总上限 |
| gemini-2.5-flash-image | legacy；最佳输入不超过 3 张是质量建议，不等于已证明硬上限；推荐迁往 Lite |

**当前选定模型详情（D14/D17，本次实页）：**remoteId 固定 `gemini-nano-banana-2.1`，Stable；输入 Text/Image/Video/PDF，输出 Image/Text；输入 token limit 131,072，输出 32,768；默认 1K，可选 1K/2K/4K；参考图最多 14（4 人物、10 物体一致性），Thinking minimal/medium/high，默认 medium。支持 image generation、thinking、search grounding、Batch；不支持 audio generation、caching、code execution、file search、function calling、Maps grounding、Live、structured outputs、URL context、Flex/Priority inference。首版仍仅 text/inline image，模型支持更多输入不自动扩展 operation。详情页模型 Latest update 是 October 2026，页脚 Last updated 2026-10-06 UTC；这是两类日期。

**生命周期（D16）：**2.1 release date 为 2026-10-06，关停栏为 “No shutdown date announced”；3.1 Flash Image / 3 Pro Image 的 stable 条目发布为 2026-05-28，Lite Image 为 2026-06-30；2.5 Flash Image 的 earliest shutdown 是 2027-03-15，替代为 Lite。旧 `gemini-3.1-flash-image-preview` / `gemini-3-pro-image-preview` 表中关停为 2026-06-25，不能把旧 preview 别名当当前所选 stable 模型。关停表说明日期是最早可能日期且会提前通知；不能将尚未发生的 2027 日期当已经关闭。上述较新字段本次实际在线读取，非记忆补写。

D2：不支持音频输入；模型不一定遵守提示词要求的精确输出图片数量；所有生成图包含 SynthID；semantic masking 是用自然语言指定区域，不是精确二进制 mask。D2 明确透明背景不支持，不能把“白底贴纸”标成 alpha 透明能力。

D5：PNG/JPEG/WebP/HEIC/HEIF；inline **整个请求**（含文本、system instructions、inline bytes）限 20MB，不是每张图 20MiB。通用图像理解的 3,600 文件上限不适用于生图模型参考图能力。**I：**首版按 D2 将 2.1 `maxInputs` 收紧为 14，服务默认 16 要进一步收紧；以最终序列化请求长度校验 20MB，计入 base64 膨胀。LA 本地图片 20MiB 限制不能替代这个请求体限制。

**candidateCount 的证据边界（本次 D3/D12/D14/D2）：**D3 是“Number of generated responses”，默认 1，且明确对 **Gemini 1.0 family 不生效**；GenerationConfig 总说明提示各模型不是所有参数都可配置。D12 通用 troubleshooting 表给 1—8，但没有为 `gemini-nano-banana-2.1` 声明这个范围。D14 模型详情未列 candidateCount 的模型级上下限；D2 只明确不保证提示词要求的精确图片数量，没有列 candidateCount=1-only。故本次**未验证 2.1 支持 >1 或硬上限只为 1**，也不能从通用表推断支持 8 张图。**I：**最小 profile 不发送/不开放 candidateCount，单次计划 count=1 是本地收紧，非供应商模型硬限制；用户批量由引擎创建独立收费项，保存每次响应实际产生的全部合法图片。候选 response 数量与候选内 image parts 数量分别计数。

D8：限额按 project，不按 key；RPM、TPM、RPD，以及图片模型 IPM；RPD 太平洋时间午夜重置，实际额度取决于模型/usage tier/账号，不冻结未经账号核实的数字。

## 同步、异步、查询、取消、幂等

| 项目 | 有证据的事实 | Adapter 建议（I） |
| --- | --- | --- |
| 同步提交 | D3 generateContent 返回完整响应；没有 task resource | Submit 成功返回 completed、bytes；不伪造 pending handle |
| 流式 | D3 streamGenerateContent 返回 GenerateContentResponse 流 | 首版不启用；它不是持久异步任务，也没有已核实断线重放契约 |
| 异步批量 | D2 明确 Batch API 生图，周转最多 24 小时 | 独立 batch profile；本轮未冻结提交/查询/取消路径，不混入同步 Adapter |
| 查询 / reconcile | D3 没有按 responseId 获取同步结果的方法；未找到 client submission key 查询证据 | Poll / Reconcile 返回 ErrUnsupported；supportsReconcile=false |
| 供应商取消 | 同步 API 未找到独立 cancel endpoint；D4 499 CANCELLED 表示客户端断开等 | supportsCancel=false；已提交取消按 design local_only；断连不保证免计费或完成回滚 |
| 幂等 | 所读 generateContent schema 未记录 Idempotency-Key / requestId 去重与收费只一次保证 | SubmissionKey 只供本地 durable 去重，不能声称供应商幂等；uncertain 不自动重发 |
| 对话续接 | D2/D3 完整 contents 历史 + 原样签名 | supportsContinuation=true，但不代表 supportsReconcile |

“未找到”是本轮证据范围内的缺口，不宣称 Google 所有产品绝对没有这些能力。D12 虽建议 SDK / REST 重试网络、429、5xx，**没有给 generateContent 的收费去重保证**；首版直接 REST，由引擎控制重试，避免 SDK 的默认自动重试绕过 attempt 记账。

## 错误与状态映射

**D4 明确的 generateContent 错误体：**

```json
{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      "reason": "API_KEY_INVALID",
      "domain": "googleapis.com",
      "metadata": {"service": "generativelanguage.googleapis.com"}
    }]
  }
}
```

这来自官方示例，不是本项目收到的错误。`code` 整数、`status` SCREAMING_CASE；不能用 D11 Interactions 的 string snake_case code 解码。

| HTTP / status（D4） | 含义 | 实现分类（I） |
| --- | --- | --- |
| 400 INVALID_ARGUMENT | 字段/版本错误；无效 key 也可能是 400 | rejected；解析 details.reason 区分认证与参数 |
| 400 FAILED_PRECONDITION | 国家/免费层或 billing 前置条件 | rejected；禁用目标并显示脱敏原因 |
| 402 RESOURCE_EXHAUSTED | Prepay 余额耗尽 | rejected；不自动重发 |
| 403 PERMISSION_DENIED | 权限不足 | rejected |
| 404 NOT_FOUND | 资源/文件/版本不存在 | rejected |
| 429 RESOURCE_EXHAUSTED | RPM/TPM/RPD/spend 限额 | 明确拒绝时 rejected；不以 retryable 直接自动重提交收费项 |
| 499 CANCELLED | 通常客户端关闭连接 | uncertain，除非有可靠未送达证据 |
| 500 INTERNAL / 503 UNAVAILABLE / 504 DEADLINE_EXCEEDED | 服务错误/过载/截止 | 可能执行过，保守 uncertain；不可 blind retry |
| 无响应 / body 截断 / 非 JSON | 未必知道上游是否执行 | 发出后 uncertain；发送前可靠失败才 not_sent |

HTTP 200 还需检查 D3 `promptFeedback.blockReason`、candidate.finishReason 与图片内容。D3 记录 IMAGE_SAFETY、IMAGE_PROHIBITED_CONTENT、IMAGE_OTHER、IMAGE_RECITATION、NO_IMAGE、MISSING_THOUGHT_SIGNATURE 等 finishReason；prompt 被阻断可能无 candidates。**I：**安全阻断/无图片映射 failed；MAX_TOKENS 等伴随已有图片时保存图片并记录不完整状态，不假定成功。未知 enum 保留脱敏原值，不当成功。

## 与 Interactions / Imagen / Vertex 的边界

- D1/D10 当前推荐 Interactions，`POST /v1beta/interactions`，请求为 `model,input`，图像 input 为 `{type:"image",data,mime_type}`，输出遍历 `steps` 中 `model_output.content` 的 text/image；复杂混合输出不能只取 `.output_image`（便利属性只取最后生成图片）。D1 的 `response_format` 是 `{type:"image",mime_type,aspect_ratio,image_size}`，与 generateContent 的 generationConfig 不同。
- D10：`previous_interaction_id` 服务端状态、默认存储、`store=false` 可无状态；`background=true` 处理长任务。这里没有冻结图像模型对应的 background/get/cancel/恢复事件完整契约，不能据此把同步 generateContent 标支持异步恢复。首次可实现的研究基线仍选择 generateContent：D3 请求/响应 schema 完整，改动边界清楚；新项目采用 Interactions 应是单独协议决策。
- D9 明确：“Imagen ... shut down and no longer available in the Gemini API”。因此 **Developer API 不再选 Imagen 作为首版接入**。不推广成“Google 的所有 Imagen 服务关闭”。
- D13 Vertex 示例使用 `POST https://REGION-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/REGION/publishers/google/models/MODEL_VERSION:predict`，Bearer access token，body `instances:[{prompt}],parameters:{sampleCount}`，output `predictions:[{bytesBase64Encoded,mimeType}]`。这是另一产品/认证/区域/响应，不能拿 Developer API key 直套；该页自身声明旧 Vertex 文档不再更新，所以也不能凭此页宣布其当前生产可用性已验证。

## 能力结论与下一步缺口

| design 能力 | 静态结论 |
| --- | --- |
| generate / reference / edit | D2 已证明；参考/编辑共用 generateContent 的文本+图片输入 |
| mask | 不支持首版精确 mask；只确认 semantic masking |
| supportsCancel / supportsReconcile | false（所选同步协议没有已核实操作） |
| supportsContinuation | true（完整历史/opaque thoughtSignature） |
| supportsPreview | false（首版不启用流，thought 图不当 preview 成品） |
| maxInputs / maxCount | 2.1 输入 14；首版单次 count=1 为实现收紧，非供应商硬上限 |
| outputFormats | 最小成功示例证明 image/png 数据形态；模型级可选输出 MIME 枚举尚未冻结，不声明全体 PNG/JPEG/WebP 可选 |

```json
{
  "vendor": "google",
  "product": "Gemini Developer API generateContent",
  "checkedAt": "2026-10-11",
  "sourceUrls": [
    "https://ai.google.dev/gemini-api/docs/generate-content/image-generation",
    "https://ai.google.dev/api/generate-content",
    "https://ai.google.dev/gemini-api/docs/generate-content/api-errors",
    "https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1?hl=en",
    "https://ai.google.dev/gemini-api/docs/available-regions?hl=en",
    "https://ai.google.dev/gemini-api/docs/deprecations?hl=en"
  ],
  "execution": "direct",
  "verifiedOperations": ["generate", "reference", "edit"],
  "verificationBasis": "official_documentation_only",
  "contractComplete": false,
  "liveVerified": false
}
```

缺口获取方式：新 `responseFormat.image` 的完整 enum 已抄录，但指南字符串与 schema enum 的 wire 兼容仍需官方明确说明或另行授权的目标环境收据；2.1 的可选 MIME 与 candidateCount 模型约束仍未验证。本次已补读模型详情/发布及弃用表/可用地域，不再将这些列为未读缺口。最小 Legacy profile 排除新格式选择、candidateCount、Files/Batch/Interactions；这些扩展各自需要完整证据后才可增加。账号资格、项目额度、计费、部署出口地域和收费请求收据仍缺，目标保持 disabled，`contractComplete=false/liveVerified=false`。没有运行 Go 契约测试、生成 fixture 或真实调用收据。

## 2026-10-13：收窄的验证入口实施补充

新增的生产验证入口仅接受gemini-nano-banana-2.1无输入、无可选参数的generate目标。其请求使用官方contents/responseModalities基本示例，执行后必须实际保存且确认仅1张PNG，才能给该冻结配置写入验证证据。未知模型、参数、编辑/参考、续接、候选数量配置、输出格式配置不在此profile内。

这不是对上文所有能力声明contractComplete=true。模型页和指南并不保证任意提示词一定返回指定张数/格式；验证流程在得到输出后检查，不满足时blocked，不自动重发或认证。实际收费以平台为准，界面要求明确确认。当前只有隔离fixture通过，用户账号liveVerified仍false，未进行收费调用。实际代码与验证命令见 ../../worklog/2026-10-13-image-studio-resume.md 。