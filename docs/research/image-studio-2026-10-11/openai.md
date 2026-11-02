# OpenAI Images 原生协议核对

核对/访问日期：**2026-10-11**。本轮读取官方指南、API reference、模型与错误文档，没有读取凭据、上传、生成、查询或运行 Adapter 测试。`verifiedOperations` 表示文档证据，不是实测能力。

## 所选产品与范围

首个静态 profile 选择 OpenAI Images API、显式 `gpt-image-2` 或快照 `gpt-image-2-2026-04-21`，非流式生成与 JSON 编辑。当前指南推荐新集成使用 GPT Image 2.5；API reference 仍明确列出 GPT Image 2，不能把它写成最新模型，也不能让上游默认模型代替已选目标。[O1—O4]

`contractComplete=true` 只针对上述收窄请求/结果协议；不代表 fixture、测试、账号权限或真实接入完成。生产目标仍 disabled。

```json
{
  "vendor": "openai",
  "product": "OpenAI Images API / GPT Image 2",
  "checkedAt": "2026-10-11",
  "sourceUrls": [
    "https://developers.openai.com/api/docs/guides/image-generation",
    "https://developers.openai.com/api/reference/resources/images/methods/generate",
    "https://developers.openai.com/api/reference/resources/images/methods/edit",
    "https://developers.openai.com/api/docs/models/gpt-image-2",
    "https://developers.openai.com/api/reference/overview",
    "https://developers.openai.com/api/docs/guides/error-codes",
    "https://developers.openai.com/api/docs/deprecations"
  ],
  "execution": "direct",
  "verifiedOperations": ["generate", "reference", "edit", "mask"],
  "contractComplete": true,
  "contractScope": "gpt-image-2, non-streaming, JSON generations and edits; mask-guided editing without exact pixel guarantee",
  "liveVerified": false
}
```

## 路径、认证与原生请求

| 项目 | 已核实协议 | 来源 |
| --- | --- | --- |
| Base URL | `https://api.openai.com/v1`；未核对特殊地域/数据驻留域名 | O2、O5 |
| 认证 | `Authorization: Bearer <服务端解析的API Key>`；秘密仅后端持有 | O2、O5 |
| 生成 | `POST /images/generations`，JSON，必填 `model`、`prompt` | O2 |
| JSON编辑 | `POST /images/edits`，`images` 数组，元素用 `image_url` 或 `file_id` 引用；`prompt` 必填，model虽可选但本适配器必须显式发送 | O3 |
| 参考输入 | `image_url` 可为 HTTPS URL 或 base64 data URL；原生字段不是 K-Brain 的 assetId | O3 |
| 多输入 | 编辑最多16张，数组顺序保留 | O3 |
| mask | JSON对象使用 `image_url`/`file_id`，每个引用二选一 | O3 |
| multipart证据 | 官方指南另有 `-F image[]=@...`、`-F mask=@...` 和SDK文件输入样例；与reference的JSON `images[]`是不同编码分支 | O1、O3 |

计划04不能把编辑只限于multipart。本轮首选reference明确提供的JSON分支，使用data URL避免增加 Files API 资源生命周期。multipart若实现，应有独立请求fixture；不能把JSON `images`与表单 `image[]`混写。

以下请求为依据字段自拟，**未执行**，不是官方或真实调用收据。Host为 `api.openai.com`，Content-Type为 `application/json`，认证Header由后端注入。

```http
POST /v1/images/generations HTTP/1.1

{"model":"gpt-image-2","prompt":"A ceramic bird on a plain blue background","n":1,"size":"1024x1024","quality":"low","output_format":"png"}
```

```json
{
  "model": "gpt-image-2",
  "prompt": "Keep the composition and change the background to warm yellow",
  "images": [{"image_url": "data:image/png;base64,<validated input bytes>"}],
  "n": 1,
  "output_format": "png"
}
```

## 字段与限制

生成profile白名单采用 `size`、`quality`、`output_format`、`output_compression`、`background` 和 `n`；编辑增加 `images`/`mask`。`n`范围1—10，输出格式png/jpeg/webp，压缩仅用于jpeg/webp、范围0—100。GPT Image 2质量使用low/medium/high/auto；不借用2.5的xhigh/max。生成prompt最大32000字符。[O2、O3]

参考/编辑请求必须先校验本地资产权限；data URL的reference长度上限为20971520，需计入编码膨胀，不能把20MiB原图直接视为必定可发送。JSON编辑prompt为1—32000字符。GPT Image 2省略 `input_fidelity`。自定义尺寸要求边长为16的倍数、宽高比1:3—3:1；较高分辨率有实验性限制，首个profile仅开已明确的1024x1024、1536x1024、1024x1536。[O2、O3]

mask应用于第一张输入图；指南要求同格式/尺寸、小于50MB、alpha通道。GPT Image遮罩是模型指导，不保证严格遵循轮廓，UI不能承诺像素级锁定。`mask`操作有输入协议证据，但启用前仍须验证选定模型、图片透明度语义和真实编辑结果。[O1]

## 返回、错误与执行状态

| 项目 | 解析与边界 | 来源 |
| --- | --- | --- |
| 非流式结果 | `created`、`data[].b64_json`，可能追加format/quality/size字段；输出需base64解码、真实图像校验、持久化后才成功 | O2、O3；保存判定为本地设计要求 |
| URL返回 | GPT Image返回base64；不能向它发送已弃用的 `response_format=url` 或依赖 `data[].url` | O2 |
| usage | schema为可选；reference仍有“仅gpt-image-1”的历史说明，而样例展示usage。选定2模型的字段齐全性未实测；缺失保持null，token不等于金额 | O2、O4 |
| 400/401/403 | 参数、认证、访问等拒绝；保存脱敏类别，不复制完整供应商message中的输入或凭据 | O6 |
| 429 | 区分速率与额度；不能仅凭429承诺未产生收费提交 | O6；delivery裁决为本地设计要求 |
| 500/503/超时 | 即使官方建议稍后重试，也须区分未发送、明确拒绝和送达不确定 | O6；delivery裁决为本地设计要求 |

无合法图片的HTTP200不是成功。输出少于预期时保留已有图片；这些是K-Brain引擎判定，不是OpenAI任务状态字面值。

## 取消、幂等、续接与流

- 当前Images路由没有按图片task ID查询、取消或按客户端提交key核对的已取得契约。`Poll`/`Cancel`/`Reconcile`不得假成功；超时送达不明保持unknown，不自动重复收费提交。
- `x-request-id`用于诊断，不等于可查询的图片句柄；本轮未取得Images收费提交幂等保证。K-Brain的Idempotency-Key仅保证其本地去重。[O5]
- Responses图像工具可参与会话，其输入、返回对象、模型选择和生命周期与Images不同；本profile不复用Responses的查询/取消/previous_response_id。重新引用保存图片是新请求。[O1]
- reference给出 `stream`/`partial_images` 及部分图、完成事件，但所选2模型页标streaming不支持。首版profile关闭预览与流；不能由通用字段推导模型支持。[O2、O4]

## 版本、条件和缺口

模型页列alias与2026-04-21快照，并按usage tier说明限额，Free不支持；目标账号具体权限和额度未核查。[O4] reference明确DALL·E 2/3在2026-05-12退役，不作为首版目标。[O2、O7] 本轮未取得GPT Image 2正式停止服务日期；后续恢复实施时重新核对，不把本次可见清单当永久保证。

缺少：Go fixture与测试、所选连接的真实生成/编辑/遮罩收据、实际usage和请求错误样本、账号组织验证及预算确认。本轮所有真实验证状态为false。`/v1/models`枚举不能自动证明图像操作能力。

## 官方来源

以下均在2026-10-11读取；本轮未记录这些页面统一的最后更新时间，不将访问日期写成发布日期。

[O1]: https://developers.openai.com/api/docs/guides/image-generation
[O2]: https://developers.openai.com/api/reference/resources/images/methods/generate
[O3]: https://developers.openai.com/api/reference/resources/images/methods/edit
[O4]: https://developers.openai.com/api/docs/models/gpt-image-2
[O5]: https://developers.openai.com/api/reference/overview
[O6]: https://developers.openai.com/api/docs/guides/error-codes
[O7]: https://developers.openai.com/api/docs/deprecations

## 2026-10-13：官方OpenAPI替代正文与不一致发现

OpenAI官方公开仓库README说明openapi.json/openapi.yaml自动同步上游REST规范：https://raw.githubusercontent.com/openai/openai-openapi/master/README.md 。据此实际读取 https://raw.githubusercontent.com/openai/openai-openapi/main/openapi.json 。直连20秒超时；仅本命令通过 http://127.0.0.1:7890 临时代理重试成功，没有修改全局代理。读取整个JSON并只提取Images相关paths/schemas；未声称人工阅读全部4792164字节规范。

来源UTF-8内容SHA-256：cf31ebfa19c49cf081757985deec50b28d10f9b7900e5f391eb1a899c1ce22f5 。原始规范未作为临时下载文件落盘；选定契约与元数据保存于[REST契约收据](openai-rest-contract-2026-10-13.json)。其来源为可变main分支，hash定位本次读取内容，不伪造commit SHA。

已核对正文：

- /images/generations requestBody声明application/json；/images/edits同时声明multipart/form-data和application/json。
- JSON edits schema为EditImageBodyJsonParam，required images/prompt，images数组1—16，prompt1—32000。
- ImageRefParam明确image_url或file_id二选一，additionalProperties=false；image_url允许完整URL或base64 data URL，maxLength20971520。mask引用同类对象。
- 规范明确gpt-image-2及2026-04-21快照可作为模型；output_format枚举png/jpeg/webp，默认png；GPT Image返回base64，legacy response_format不适用；quality额外xhigh/max限定2.5，不能推广到2。现有收窄JSON编辑request有正文依据。

不得掩盖的官方规范冲突：

1. CreateImageRequest.required包含model、prompt、image，但properties没有image。官方openai-node的generate body定义和已有官方指南文生图示例不要求输入图片。现有文生图不擅自添加不存在的image字段；这条不能由我们自行修正规范后宣告全契约一致。
2. paths引用ImagesResponse和CreateImageEditRequest，但本次取得的components.schemas中未提取到这些定义；SDK可补充返回结构/上传接口信息，但不能冒充这些缺失定义来自本次规范正文。
3. REST主站当前403未解除，JSON编辑与生成请求规范已取得更多证据，并不等于403页面全文已读。真实账号调用仍未运行，liveVerified不变，范围外流式、批量、所有模型不作支持承诺。

OpenAI REST请求格式不再只有搜索摘要作为依据；整体核对仍保留上述矛盾和真实调用条件，不自动修改既有证据索引的contractComplete/liveVerified。