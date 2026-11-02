# 01：K-Brain 图像配置与内部契约实施计划

> 执行者逐任务勾选，优先使用 subagent-driven-development 或 executing-plans 工作方式；不可用时按本计划执行。用户验收前不提交实现代码。

**Goal：**建立独立图像连接、目标及 wire 契约，确保旧聊天配置与消费者保持兼容。

**Architecture：**类型置于 `internal/imaging`，图像设置嵌入现有 K-Brain 配置管理生命周期，公开文档与秘密写入分离。HTTP 路由使用自有 `kbrain.image.v1`，不复用聊天 factory。

**Tech Stack：**Go、encoding/json、httptest、现有 secret resolver 与配置机制。

**Spec：**[统一规格](design.md)。

## 全局约束

遵守 design 固定限制。公开 wire 为 camelCase；owner 来自认证上下文。新增配置可选，缺省不启动网络或 scheduler。配置更新使用 expectedRevision；没有图像配置的旧文件可以加载。图像路径不进入现有 AI factory。

## 文件地图

K-Brain 新增 `internal/imaging/types.go`、`config_types.go`、`config_validate.go`、`errors.go`、`adapter.go`、`config_test.go`；新增 `internal/backend/image_settings.go`、`image_settings_test.go`、`image_routes.go`、`image_contract_test.go`。

修改真实入口：`internal/config/config.go`（可选 image 配置）、`internal/config/load_file.go`（确认 unknown-field 行为与兼容加载）、`internal/config/secret.go`（仅需要时扩展引用封装，不改变现有解析语义）、`internal/backend/settings.go`（关联写锁/保存）、`internal/backend/server.go`（路由与模块 capability）。配置具体 snapshot 和保存函数须在执行基线上定位后使用，不发明旧函数名。

LA 在 05 添加 client；本阶段产物 `internal/imaging/testdata/wire-v1.json` 是后续两端共用契约来源。

## Task 1：类型与配置校验

**Consumes：**design 的 Go/wire 对象定义。

**Produces：**`ValidateSettings(ImageSettings) error`、`NormalizeRequest(CreateJobRequest) ([]byte,error)`、`HashRequest(CreateJobRequest) (string,error)`，以及全部配置/公开类型。

- [ ] 新建配置类型：ImageSettings 包含 Revision、Connections、Targets；连接和 target ID 唯一，引用必须存在；kind=model/workflow；工作流映射包含 revision。
- [ ] 写表驱动测试覆盖旧配置、空目标、重复 ID、悬空 providerRef、未知 Adapter、非法枚举、默认值超范围、workflow 未声明字段。Unknown Adapter 可以保存为 disabled，但不能标 executable。
- [ ] 在 Request 哈希测试中交换 map key 顺序，保持数组顺序；相同语义 map 哈希一致、prompt 改变哈希不同。拒绝 NaN、无限数和参数类型不符。

```go
func TestHashRequestOrder(t *testing.T) {
    a := CreateJobRequest{ProjectID:"ip_a", TargetID:"it_a", Operation:"generate", Prompt:"海报", Count:1, Parameters:map[string]any{"quality":"high", "size":"square"}}
    b := a
    b.Parameters = map[string]any{"size":"square", "quality":"high"}
    ha, err := HashRequest(a); if err != nil { t.Fatal(err) }
    hb, err := HashRequest(b); if err != nil { t.Fatal(err) }
    if ha != hb { t.Fatal("参数顺序改变了请求身份") }
}
```

- [ ] 运行 `go test ./internal/imaging -run 'Config|HashRequest' -v`，先确认失败，再补校验和规范化实现，直至通过。

**验收：**旧聊天配置通过原测试；图像请求拒绝未知参数而非忽略；所有字段符合 design。

## Task 2：秘密与网络配置引用

**Produces：**`ResolveImageConnection(context.Context, Scope, string) (ResolvedConnection,error)`；ResolvedConnection 仅执行层可见，禁止 JSON serialization。

- [ ] provider_ref 在提交任务时解析所引用 Provider 的网络/secret；不拷贝聊天 model/API/reasoning。独立连接按 authKind 查找 owner 所有 opaque secret ref。
- [ ] 复用已有 provider secret 管理与持久化模式，新增 owner 隔离的 image secret namespace。没有安全 owner 隔离时只允许 local 单用户，等待 05 委派完成。
- [ ] 写入秘密必须原子保存；公开 GET 只返回 configured=true/false 与 opaque ref。公开错误不能包含 resolver command、header value、query credential。
- [ ] 同一个事务检查连接删除依赖；存在 target 或执行中任务时返回 `IMAGE_CONNECTION_IN_USE`。禁用连接不影响已接收任务的配置快照，但撤销凭据后执行返回明确认证失效。
- [ ] 用虚构 secret sentinel 测试公开 JSON 和错误串均不含 sentinel，不调用真实凭据命令。

```go
// 公开状态构造的白名单测试，PublicConnection 是本任务类型。
func TestPublicConnectionRedactsSecrets(t *testing.T) {
    c := ImageConnection{ID:"ic_test", Vendor:"openai"}
    raw, err := json.Marshal(PublicConnection(c, true)); if err != nil { t.Fatal(err) }
    if bytes.Contains(raw, []byte("apiKey")) || bytes.Contains(raw, []byte("secretExpression")) {
        t.Fatal("公开配置包含执行秘密字段")
    }
}
```

- [ ] 运行 `go test ./internal/config ./internal/imaging ./internal/backend -run 'Image|Secret' -v`；现有 secret 用例不得退化。

## Task 3：HTTP 配置路由和协议版本

**Consumes：**types、errors、ResolveImageConnection。

**Produces：**settings/targets/secrets 真实路由、capability 与 wire fixture，任务路由挂载接口由 03 提供。

- [ ] 在 backend Server 新增可选 image module 字段；无 module 时 capability=false；开启但存储故障返回503，不能假装旧后端不支持。
- [ ] 实现 GET/PUT `/v1/image/settings`、GET targets、POST secrets；PUT 在单一配置锁内检查 revision，原子写入新 revision 后发布 snapshot。
- [ ] 在现有 health 返回追加可选 `capabilities.image={supported,version}`；不改旧字段含义。旧消费者忽略该字段。
- [ ] 契约测试覆盖 401、403、revision 409、参数422、无模块503；对象泄漏使用404。method 不匹配405。
- [ ] 固化 `wire-v1.json` 含公开连接、模型/工作流目标、job、event、错误和 partial_succeeded 的示例；使用同一 fixture 生成 LA types 验证。

```json
{"version":"kbrain.image.v1","error":{"code":"IMAGE_REVISION_CONFLICT","message":"配置已变化，请刷新后重试","retryable":false,"requestId":"test-request"}}
```

- [ ] 运行 `go test ./internal/backend -run 'ImageSettings|ImageContract' -v`，检查旧 `/v1/settings` 契约测试也通过。

## Task 4：冻结消费接口

- [ ] 将 type 和错误集合发给 02、03、05、06 执行者；错误至少包括 INVALID_INPUT、UNSUPPORTED_OPERATION、REVISION_CONFLICT、IDEMPOTENCY_CONFLICT、CONNECTION_IN_USE、AUTH_REQUIRED、RATE_LIMITED、EVENT_GAP，wire 加 IMAGE_ 前缀。
- [ ] 修改字段需同时更新 fixture 和消费者，不能用 map[string]any 敷衍强类型公共 job/event。
- [ ] 记录公开协议和私有执行信息的区别，确认没有 HTTP 原生地址被前端拼接调用。

**独立验收：**空图像配置启动 K-Brain，旧聊天设置和模型列表仍正常；用虚构连接保存、读取、冲突更新，秘密不回显。可全部用 httptest 完成，不需要付费接口。实际提交只在 07 门禁满足后执行。
