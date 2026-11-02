# 00：五个平台原生协议核对实施计划

> 执行者逐任务勾选，优先使用 subagent-driven-development 或 executing-plans 工作方式；这些技能不可用时按本文件顺序执行。实施遵循仓库门禁，不自动提交。

**Goal：**为每个平台选定具体产品，形成可编码、可测试的协议证据，避免把品牌当成协议。

**Architecture：**证据分为官方文档、脱敏契约 fixture 和真实调用收据三层。静态 Adapter 可依据完整官方文档编码，但生产目标启用需目标环境的实际验证。

**Tech Stack：**Markdown、JSON fixture、Go httptest；付费调用需独立授权。

**Spec：**[统一规格](design.md)。

## 全局约束

本阶段不读取私人凭据，不抓取登录页面，不调用收费生成接口，不覆盖历史研究文档。所有日期为证据读取日期，不把文章发布日期当作当前有效性。平台 API 不确定时停止该 Adapter 的启用，不阻塞 fake 引擎或其他平台。遵守 README 实施纪律。

## 文件与产物

在 LA 创建 `docs/research/image-studio-2026-10-11/`，五个平台各有 `openai.md`、`google.md`、`volcengine.md`、`jimeng.md`、`runninghub.md`，以及 `matrix.md`。在 K-Brain 创建 `internal/imaging/adapters/<vendor>/testdata/` 中的脱敏 JSON/HTTP fixture；fixture 生成纳入 04 的实现任务，研究记录先给出字段证据。

每份研究必须包含：产品和区域、文档 URL、访问日期、认证方案、提交/查询/取消路径、Content-Type、请求必填字段、响应状态映射、结果格式、限额、续接、收费请求是否可核对、错误、版本与弃用信息。区别“官方写明”“真实请求验证”“样例推断”“不支持”，不得用推断当事实。

## Task 1：OpenAI 和 Google

**Consumes：**design 的 Operation 与 Adapter 契约。

**Produces：**两份产品协议记录；OpenAI Images 与 Google 具体协议标識，不统一为聊天协议。

- [ ] 打开 OpenAI 官方图像指南 `https://developers.openai.com/api/docs/guides/image-generation` 及 API reference，核对 Images 生成/编辑与 Responses 图像工具的差别。首版以 Images 为目标；模型发现不能假设完整生图能力可由 `/v1/models` 推断。
- [ ] 逐项摘录 JSON 与 multipart 请求、reference/mask 要求、输出 URL/base64、批量和流事件、错误以及幂等/请求查询证据。没有官方幂等支持时标记 uncertain 不可自动重发。
- [ ] 打开 Google `https://ai.google.dev/gemini-api/docs/image-generation`、`https://ai.google.dev/gemini-api/docs/generate-content/image-generation`、`https://ai.google.dev/gemini-api/docs/imagen` 和 Vertex AI 官方图像文档。记录 Gemini Developer API 与 Vertex 的不同认证/路径。
- [ ] 对 Interactions 与 generateContent 分别记录图片输出、混合文字、续接和签名保留要求；决定首个可实现协议并写明原因。关于 Imagen 可用性仅依据所选产品实时官方说明，不沿用前次网页摘录作无条件结论。
- [ ] 写能力矩阵，逐项列生成、参考、编辑、mask、取消、续接。不能把语义区域修改标为精确遮罩。

**验收：**两份文档足以构造一个完整请求与成功/错误响应；协议版本可定位；原生 endpoint 与 K-Brain 自有接口分别标注。

## Task 2：火山与即梦分别调查

**Produces：**`volcengine.md` 和 `jimeng.md`，每份指定具体官方产品。

- [ ] 从 `https://www.volcengine.com/docs/` 的官方产品目录定位方舟图像生成/Seedream 文档，记录区域 Base URL、API Key、输入图字段、参数和输出。
- [ ] 单独定位即梦开放接口/视觉服务官方文档，核对访问密钥签名、服务/区域/版本/动作名、异步任务及查询。不得把方舟的 Bearer API Key 当成即梦签名认证。
- [ ] 若官方仅提供网页产品无开放接口，记录官方依据，拒绝用网页 Cookie 或非官方逆向接口替代；明确尚未达到目标接入条件。
- [ ] 若某个火山产品声称 OpenAI 兼容，比较 method/path/auth/body/output/errors 六项；不同点写为平台 profile 或独立 Adapter 的修改任务。
- [ ] 为签名接口准备固定虚构 key、时间戳和 body 的官方签名向量；不使用真实 key。检查签名失败、时钟偏差和 token 到期错误。

**验收：**两个品牌不混用认证和接口；每个平台都具备明确产品范围，未核实的具体 endpoint 不进入代码。

## Task 3：RunningHub 工作流接口

**Produces：**`runninghub.md` 与一份最小可验证工作流输入/输出契约。

- [ ] 从 `https://www.runninghub.cn/` 定位官方开发者文档或官方链接的文档站。核对站点区域/版本，不能假定不同域名共享认证。
- [ ] 区分模型调用、AI 应用、工作流执行等官方产品；选择有文档支持的首个执行入口。
- [ ] 记录上传文件、提交任务、查询状态、读取输出和取消的真实接口。整理鉴权位置以及任务 ID 类型。
- [ ] 选择一个简单工作流，记录节点输入映射、提示词字段、图片字段、输出节点和映射 revision；确认官方允许的输入类型。
- [ ] 记录排队、执行、成功、失败、未知状态，输出可能为多图/文件/其他模态时明确只接受合法图片。未知状态不当成功。

**验收：**04 可以从记录重建实际工作流请求；没有 workflow ID 或合法账号时，静态契约测试可进行，真实启用验收保持阻塞。

## Task 4：冻结证据与可启用矩阵

- [ ] 汇总五个平台，每项附证据文件链接、协议版本与更新时间，记录凭据/额度/工作流是否齐全。
- [ ] 生成证据索引结构：

```json
{
  "vendor": "openai",
  "product": "Images API",
  "checkedAt": "2026-10-11",
  "sourceUrls": ["https://developers.openai.com/api/docs/guides/image-generation"],
  "execution": "direct",
  "verifiedOperations": [],
  "contractComplete": false,
  "liveVerified": false
}
```

这里空能力数组是待执行调查的初始状态，不是最终验收产物。完成时必须填入有证据的能力并把 contractComplete 设为真实结果。

- [ ] 契约 fixture 使用虚构 key、非真人图片和安全 URL。记录 SHA-256、来源、脱敏规则；真实收据不含下载签名、request headers 或供应商续接秘密。
- [ ] 将未获官方依据的能力标为不可启用，并给出缺少哪份官方记录或哪项授权材料；必须描述具体证据缺口和获取方式。

**验证命令：**实施阶段在 K-Brain 对每个具体 Adapter 运行 `go test ./internal/imaging/adapters/<vendor> -run Contract -v`。本研究阶段只检查记录内容和链接，不冒充已运行这些尚不存在的测试。

**退出条件：**官方协议记录、静态 fixture 与真实调用分别记录完成程度；完整交付五平台接入需要五项真实验证均完成。如果需要真实收费请求，列出模型、次数、输入、预计预算与执行环境后取得授权，不能因研究授权自动调用。
