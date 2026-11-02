# 图像任务引擎与设计工作台统一规格

版本：`kbrain.image.v1`。日期：2026-10-11。本文是 00—07 的共同契约；修改公共字段必须同步所有消费者及契约测试。代码片段是计划契约，不表示源码已有实现。

## 目标与边界

K-Brain 同进程独立 `internal/imaging` 模块管理配置、执行、项目和资产。现有 `internal/ai/factory.go` 的聊天协议与 `/v1/generate`、`/v1/text/generate` 语义保持兼容。LA 的 `agent-ui` 提供共享 UI，桌面与 Gateway 提供 host Adapter；前端不持有供应商执行秘密。

首版覆盖：文生图、参考图生成、能力允许的图片编辑/遮罩、模型及已配置工作流、任务历史、批量部分成功、结果对比、父资产追踪、下载/导出。画布图层、Agent 生图工具、任意可执行/声明式 HTTP 插件市场、对外 OpenAI-compatible Images API、OAuth 交互授权、精确自动价格结算不在首版。平台所需认证必须覆盖；若只能通过 OAuth 授权而无可用服务器认证，需要新增明确方案后才能启用该目标。

## 固定工程限制

- K-Brain Go 版本由其 go.mod 决定（调查值 1.27.0）；Gateway 调查值 1.25.12。各仓独立构建，不共享 internal 包。
- LA 使用 pnpm、现有 React 19/TypeScript/Tauri 2/Go Gateway。复用共享包与 host Adapter 模式。
- K-Brain 首版不新增 SQLite 依赖；使用单进程写者、目录独占锁、追加事务日志与周期快照。
- 实现依项目 `/goal`、分支和用户验收门禁；未验收不 commit/push。
- 不在文档、日志、fixture、任务和 UI 回显凭据；供应商原始响应须脱敏再保存。
- 图像接口是 K-Brain 自有协议，不宣称是 OpenAI 或 Google 原生格式。

## 领域对象与所有权

所有 ID 由 K-Brain 生成，使用带类型前缀的随机 UUID：`ic_` 连接、`it_` 目标、`ip_` 项目、`ij_` 任务、`ii_` 执行项、`ia_` 资产。`ownerId` 只由认证上下文生成，不接收前端自报。用户必须显式选择执行后端，记录 `backendId`；换后端不混入相同 ID 的本地草稿。

桌面后端可映射为 local owner。Gateway 由登录用户和所选远程目标构造执行作用域，转发的 owner 必须有可信服务器证明或按用户隔离后端凭据；客户端 Header 自报身份不能作为证明。共享 K-Brain 如没有可信身份委派，禁止启用多用户图像路由，05 必须先实现可信委派。

| 对象 | 权威位置 / 关键字段 |
| --- | --- |
| ImageConnection | K-Brain 设置；id、vendor、binding、并发、网络、公开认证状态 |
| ImageTarget | K-Brain 设置；id、connectionId、adapter、kind、remoteId、revision、capabilities、parameters、workflowMapping |
| ImageProject | K-Brain 图像存储；id、ownerId、title、workspaceRef、revision、createdAt |
| ImageJob | K-Brain 存储；id、ownerId、projectId、targetSnapshot、requestHash、status、items、assetIds、revision |
| ImageItem | 一次计划生成；id、jobId、status、attempts、providerHandle、outputAssetIds |
| ImageAttempt | 一次实际上游提交；attemptNo、startedAt、submissionState、requestId、错误与用量 |
| ImageAsset | K-Brain 存储；id、ownerId、hash、mime、bytes、width、height、source、parentAssetIds |
| ImageEvent | K-Brain 存储；jobId、seq、type、revision、timestamp、data |

原始凭据解析表达式、供应商句柄、续接签名和下载 URL 不属于公开对象。目标/任务快照也不复制秘密。项目/任务仅通过权限校验的资产 ID 引用图片，不接受任意文件路径。

## Go / wire 类型基准

新增 `internal/imaging/types.go`，所有 wire JSON 用 camelCase，状态用下述字面值；现有 Agent 协议的 snake_case 不改变。

```go
package imaging

type Operation string // generate | reference | edit | mask

type JobStatus string // queued | running | saving | succeeded | partial_succeeded | failed | cancel_requested | cancelled | result_unknown

type InputAsset struct {
    AssetID string `json:"assetId"`
    Role string `json:"role"` // source | reference | mask
}
type CreateJobRequest struct {
    ProjectID string `json:"projectId"`
    TargetID string `json:"targetId"`
    Operation Operation `json:"operation"`
    Prompt string `json:"prompt"`
    Inputs []InputAsset `json:"inputs"`
    Parameters map[string]any `json:"parameters"`
    Count int `json:"count"`
    ParentAssetID string `json:"parentAssetId,omitempty"`
}
type Scope struct { OwnerID, BackendID string }
type PageRequest struct { Cursor string; Limit int }
type Page[T any] struct {
    Items []T `json:"items"`
    NextCursor string `json:"nextCursor,omitempty"`
}
```

`ImageJob` 必有 `ID`、`Status`、`Revision uint64`、`AssetIDs []string`、`Items []ImageItem`、`Usage *Usage`；均使用对应 camelCase JSON 标签。`Usage` 中 `Amount *string`、`Currency string`、`Source string`、`Estimated bool`；字符串金额避免浮点结算。未知 usage 为 null，不能填 0。

配置：binding 为 `{kind:"provider_ref",providerId}` 或 `{kind:"independent",baseUrl,authKind,secretRefs,customHeaders,useSystemProxy}`。秘密输入通过独立写入操作，公开配置只含引用 ID 和 configured 状态，不包含可执行秘密解析表达式。认证类型首版实现 bearer/api_key_header/signed_request；具体签名算法由已验证平台 Adapter 实现。无需签名的平台不得自由配置执行脚本。

能力描述含 `operations`、`supportsCancel`、`supportsReconcile`、`supportsContinuation`、`supportsPreview`、`maxInputs`、`maxCount`、`outputFormats`。参数采用受限 schema：string/number/integer/boolean，枚举、上下限、默认值、必填和单位；不允许递归脚本和任意表达式。未知参数返回错误，不能悄悄忽略。工作流映射只允许绑定声明字段到已知节点输入，保留版本。

## 引擎与 Adapter 接口

新增 `internal/imaging/adapter.go`；Adapter 只表达平台执行行为，调度、资产持久化和公开事件属于 Service。

```go
type RemoteResult struct {
    State string // pending | completed | failed | unknown
    Handle string // 仅后端可见
    Outputs []OutputSource
    Usage *Usage
    NextPollAfter time.Duration
    ErrorCode string
}
type OutputSource struct {
    Kind string // bytes | url
    MIME string
    Data []byte
    URL string // 仅后端使用
}
type ExecuteRequest struct {
    ItemID string
    Target TargetSnapshot
    Request CreateJobRequest
    Inputs []ResolvedAsset // 校验权限后的只读资产
    SubmissionKey string
    Continuation []byte // 后端保存的 opaque 数据
}
type Adapter interface {
    Submit(context.Context, ExecuteRequest) (RemoteResult, error)
    Poll(context.Context, string) (RemoteResult, error)
    Cancel(context.Context, string) error
    Reconcile(context.Context, string) (RemoteResult, error)
}
```

`ResolvedAsset` 为 `AssetID string; MIME string; Bytes int64; Open func()(io.ReadCloser,error)`。`TargetSnapshot` 为冻结 revision 的无秘密目标定义；Adapter 实例按连接注入受限 HTTP client 和 secret resolver。默认不支持的方法返回 `ErrUnsupported`，不是假成功。提交错误必须携带 `Delivery string`：not_sent / rejected / uncertain，用于引擎决策。

Service 公共接口：

```go
CreateJob(context.Context, Scope, string, CreateJobRequest) (ImageJob, bool, error) // key, request；bool=已存在
GetJob(context.Context, Scope, string) (ImageJob, error)
ListJobs(context.Context, Scope, string, PageRequest) (Page[ImageJob], error) // projectId
CancelJob(context.Context, Scope, string) (ImageJob, error)
ReadEvents(context.Context, Scope, string, uint64, int) ([]ImageEvent, error) // afterSeq
ImportAsset(context.Context, Scope, io.Reader, string) (ImageAsset, error) // MIME
OpenAsset(context.Context, Scope, string, string) (io.ReadCloser, ImageAsset, error) // original|thumbnail
```

类型在 01/02 按本文补齐，实现者不能为同一个功能另起不同字段名。依赖注入时钟与 Adapter，测试通过公开 Service 检查恢复、收费请求次数和资产状态。

## 状态和并发不变量

- 提交前先 durable 记录 attempt=submitting。保存 provider handle 后才进入可恢复 pending。
- 进程在提交与句柄持久化之间退出：结果未知，先 reconcile；不支持核对时保持未知，用户明确重试创建新任务。
- 严格按 owner+backend+key 唯一，JSON 参数规范化后 SHA-256；相同 key 不同请求返回 409。保留键与任务同生命周期，删除任务保留 30 天键 tombstone。
- `saving` 完成需所有成功输出已原子保存；数量不足为部分成功并保留已有图片。原生批量不能强行声明每个结果可单独恢复。
- 取消、完成和资产提交在存储事务串行化。取消之后迟到结果已保存时保留记录；不允许成功变回取消。UI 展示上游取消能力。
- 从 queued 取消不发上游请求。已提交且无取消能力的任务：停止自动处理，标 cancelled 并记录 `cancelEffect=local_only`、可能计费；结果未知不冒充已停止上游。
- 不自动切供应商、不重复提交 uncertain。查询和下载可有限重试。

## 固定首版默认值

并发默认每连接 2、全局 4；可配置 1—16。提交超时 180 秒，单任务截止 30 分钟；长工作流可显式配置到 120 分钟。查询间隔 2 秒指数退避至 15 秒，尊重 Retry-After；查询连续失败上限 5 次后结果未知，保留句柄。下载最多重试 3 次。not_sent 请求最多重试 2 次；rejected 不自动重复；uncertain 仅核对。全部重试受任务截止时间约束。

上传单图 20 MiB、像素 40 MP，任务最多 16 输入、count 最多 16，目标可进一步收紧；输出单图 100 MiB、像素 100 MP。允许 PNG/JPEG/WebP，真实解码验证 MIME/尺寸，缩略图最长边 512 px。限制可作为显式管理员配置，但任务仍遵守目标上限。

默认不自动删除用户作品。未引用且已失效的临时上传 7 天后 GC；删除项目不删除有其他任务引用的资产；GC 宽限 24 小时并先标记再删除。下载 URL 默认只允许 HTTPS、公共地址、最多 3 次跳转，每次重新校验 DNS/IP；代理也执行相同策略。本地可信服务需显式目标网络许可，不是默认任意内网访问。

## HTTP、事件与客户端

所有响应携带 `version:"kbrain.image.v1"`。错误：`{version,error:{code,message,retryable,requestId,details}}`，details 只含脱敏字段。401 未认证、403 无能力、404 找不到或不属于当前 owner 的对象、409 幂等/配置版本冲突、413 大文件、422 参数不支持、429 配额、503 模块未开启。旧后端无 image capability 时隐藏入口并提示升级，不反复调用不存在路由。

| 方法 / 路由 | 请求 / 响应 |
| --- | --- |
| GET /v1/image/targets | `{version,items:ImageTarget[]}`，禁用目标返回状态与原因但不能执行 |
| GET/PUT /v1/image/settings | GET 公开配置；PUT `{expectedRevision,connections,targets}`，返回新 revision；秘密写入独立于公开文档 |
| POST /v1/image/secrets | 写入或更换 owner 所有的秘密，返回 opaque ref 和 configured 状态；不支持 GET 明文 |
| POST /v1/image/assets | multipart 的 file 字段，201 `{version,asset}` |
| GET /v1/image/assets/{id}/content?variant=original\|thumbnail | 有权限的二进制响应；同一资源支持 HEAD |
| POST /v1/image/projects | `{title,workspaceRef?}`；201 `{version,project}` |
| GET /v1/image/projects | cursor+limit；`{version,items,nextCursor}` |
| PATCH/DELETE /v1/image/projects/{id} | PATCH 带 expectedRevision；DELETE 保留任务 tombstone 和引用规则 |
| POST /v1/image/jobs | Header Idempotency-Key；202 `{version,job,replayed:false}`；重复 200 且 replayed=true |
| GET /v1/image/jobs | projectId/cursor/limit；limit 默认 30、上限100 |
| GET /v1/image/jobs/{id} | `{version,job}` |
| POST /v1/image/jobs/{id}/cancel | `{version,job}`，重复取消同状态 |
| GET /v1/image/jobs/{id}/events | SSE：id=seq，event=image.event，data 为 ImageEvent |

事件类型：job.accepted / job.state_changed / item.state_changed / asset.ready / job.finished。不传秘密、原始下载地址或大图。Last-Event-ID 恢复；事件保留至少 30 天，超过可回放范围返回 409 IMAGE_EVENT_GAP，客户端读快照后重新订阅。无真实进度使用不确定指示器。

客户端 Interface 在 `agent-ui` 定义，桌面/WebUI 共用：

```ts
interface ImageStudioClient {
  capabilities(): Promise<{ supported: boolean; version?: string }>;
  listTargets(): Promise<ImageTarget[]>;
  getSettings(): Promise<ImageSettings>;
  saveSettings(input: ImageSettingsUpdate): Promise<ImageSettings>;
  writeSecret(input: ImageSecretInput): Promise<{ ref: string; configured: boolean }>;
  listProjects(cursor?: string): Promise<Page<ImageProject>>;
  createProject(title: string, workspaceRef?: string): Promise<ImageProject>;
  updateProject(id: string, title: string, expectedRevision: number): Promise<ImageProject>;
  deleteProject(id: string): Promise<void>;
  upload(file: Blob, name: string, signal?: AbortSignal): Promise<ImageAsset>;
  createJob(input: CreateJobRequest, key: string): Promise<ImageJob>;
  getJob(id: string): Promise<ImageJob>;
  listJobs(projectId: string, cursor?: string): Promise<Page<ImageJob>>;
  cancelJob(id: string): Promise<ImageJob>;
  subscribe(id: string, afterSeq: number, onEvent: (e: ImageEvent) => void, signal: AbortSignal): Promise<void>;
  readAsset(id: string, variant: "original" | "thumbnail", signal?: AbortSignal): Promise<Blob>;
  exportAsset(id: string, destination: "download" | "local_workspace" | "remote_workspace"): Promise<{ saved: boolean }>;
}
```

`ImageSettingsUpdate` 含 expectedRevision；secret 写入只有 POST 返回 ref，不回显值。前端模型字段与 Go wire 一致，schema 输出至版本化 fixture 再做两端契约测试。导出目的地由 host 显式支持，不能以浏览器 download 伪装远程工作区写入。

## 实施时的完整字段登记

以下是共享类型的最小必备字段；01创建Go定义，05创建对应TS定义。公开对象不能直接marshal内部持久化对象，采用白名单projection，避免把providerHandle/secret/owner内部信息暴露。时间全部RFC3339 UTC，seq/revision为0—2^53-1整数。

| 类型 | 必备公开字段 |
| --- | --- |
| ImageSettings | revision:number、connections:ImageConnection[]、targets:ImageTarget[] |
| ImageSettingsUpdate | expectedRevision:number、connections:ImageConnection[]、targets:ImageTarget[] |
| ImageConnection | id:string、name:string、vendor:string、enabled:boolean、binding:ConnectionBinding、credentialConfigured:boolean、maxConcurrent:number |
| ConnectionBinding | provider_ref时kind/providerId；independent时kind/baseUrl/authKind/secretRefs/customHeaders/useSystemProxy；secretRefs为用途到opaque ref的map |
| ImageTarget | id/name/connectionId/adapter:string、adapterVersion:string、kind:model或workflow、remoteId:string、revision:number、enabled:boolean、disabledReason?:string、capabilities:TargetCapabilities、parameters:ParameterSpec[]、workflowMapping?:WorkflowMapping |
| TargetCapabilities | operations:Operation[]、supportsCancel/supportsReconcile/supportsContinuation/supportsPreview:boolean、maxInputs/maxCount:number、outputFormats:string[] |
| ParameterSpec | key/label/type:string、required:boolean、enum?:标量数组、minimum/maximum?:number、default?:标量、unit?:string；只支持四种schema类型 |
| WorkflowMapping | revision:number、inputs:{parameterKey,nodeId,inputName}[]、outputs:{nodeId,outputName}[] |
| ImageProject | id/title:string、workspaceRef?:string、revision:number、createdAt/updatedAt:string |
| ImageJob | id/projectId:string、request:CreateJobRequest、targetSnapshot:TargetSnapshot、status:JobStatus、revision:number、assetIds:string[]、items:ImageItem[]、usage:Usage或null、cancelEffect?:string、error?:ImageError、createdAt/updatedAt:string |
| ImageItem | id:string、status:JobStatus、attemptCount:number、outputAssetIds:string[]、error?:ImageError；providerHandle和attempt详细信息私有 |
| ImageAsset | id/hash/mime:string、bytes/width/height:number、source:upload或generated、parentAssetIds:string[]、jobId?:string、createdAt:string、available:boolean |
| ImageEvent | jobId:string、seq/revision:number、type:string、timestamp:string、data:ImageEventData |
| ImageEventData | status?:JobStatus、itemId?:string、asset?:ImageAsset、error?:ImageError；只允许白名单字段，job.finished须带status |
| ImageError | code/message/requestId:string、retryable:boolean、details?:脱敏字段对象 |
| ImageSecretInput | connectionId:string、purpose:string、value:string；仅写请求，value不存公开配置或客户端草稿 |
| TargetSnapshot | ImageTarget全部已验证执行字段的冻结副本，去除mutable enabled和配置诊断；connectionId指向秘密解析位置，不复制秘密 |

内部补充类型与函数归属：

- 01：Registry提供 `ResolveTarget(ctx,scope,id)(TargetSnapshot,error)`；`PublicConnection(c ImageConnection,configured bool) ImageConnection` 清理秘密表达式并设置credentialConfigured；`ResolvedConnection`含私有HTTP client、secret resolver和可信网络profile，禁止序列化。
- 03：Clock提供Now/After；`AdapterError`有Code、Delivery、RetryAfter、Cause，并实现Error；ErrUnsupported可errors.Is识别。Delivery只允许not_sent/rejected/uncertain，原始Cause只写脱敏诊断。
- 02：Transaction提供 `PutProject(ImageProject) error`、`PutJob(ImageJob) error`、`PutAsset(ImageAsset) error`、`AppendEvent(ImageEvent) error`、`GetIdempotency(Scope,string)(IdempotencyRecord,bool)`、`PutIdempotency(Scope,string,string,string) error`。scope由内部事务上下文绑定，记录持久化owner/backend而不在公开对象暴露。IdempotencyRecord含Hash、JobID、ExpiresAt。
- 02：Store有ReadProject/ReadJob/ReadAsset，均先验Scope，再投影公开对象；数据库级内部OwnerID字段不能由HTTP反序列化填入。

### 冲突与范围裁决

未验证目标默认disabled。验证记录包括contractComplete和liveVerified；fake Adapter仅在显式测试模式注册，不能冒充生产验证。配置管理员可进行已授权的验证请求，未验证目标不允许普通工作台提交。关闭验证限制必须是明确开发模式，不默认开启。

任务历史列出所选后端的项目；跨后端资产不能直接引用，要通过用户明确导入复制创建新资产。连接配置按当前执行后端保存，换后端不自动同步秘密。

事件first available seq与snapshot lastEventSeq一起返回，EVENT_GAP后从快照对应序号续接，不能用UI最后看到的旧seq反复重连。已终态job的subscribe立即回放缺失事件并关闭。任务成功后的late cancel保持成功，已经local_only取消的迟到输出若被接收则保存为附加结果并发布asset.ready，不修改终态；detail明确图片晚到，避免状态倒退。
