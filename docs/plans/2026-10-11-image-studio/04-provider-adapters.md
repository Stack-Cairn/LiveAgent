# 04：五个平台图像 Adapter 实施计划

> 执行者逐任务勾选，优先使用 subagent-driven-development 或 executing-plans；不可用时按本文执行。验收前不提交。

**Goal：**分别实现并验证OpenAI、Google、火山、即梦、RunningHub的具体产品接入，不污染统一任务引擎。

**Architecture：**每个Adapter满足design的4方法接口；平台profile只表达有官方依据的差异。凭据、HTTP client和只读资产由后端注入，任务持久化和下载归一化由Service完成。

**Tech Stack：**Go net/http、multipart、JSON、httptest、fake上游、00脱敏fixture。

**Spec：**[统一规格](design.md)、[协议核对](00-provider-verification.md)。

## 全局约束

未完成00对应产品记录，不编造endpoint、不启用目标。官方协议fixture用于静态测试，不冒充真实请求结果。真实调用需额度授权。方法不支持返回ErrUnsupported；供应商原生错误经过白名单脱敏。五个平台任务可并行，共享Interface只能由01/03负责人改。

## 共用测试模式与文件

每个平台新增 `internal/imaging/adapters/<vendor>/adapter.go`、`request.go`、`response.go`、`adapter_test.go`、`testdata/`；特殊认证另建auth.go。新增 `internal/imaging/adapters/registry.go` 只注册已实现版本，不以品牌推断兼容。

每个测试至少保存：有效请求、直接/异步成功、明确拒绝、限流、未知状态、无图片、非法输出。request测试比较实际method/path/content-type/body字段；response测试调用Adapter而非只解析fixture字符串。不能把整个任意JSON映射器当验证。

```go
// placed in adapters/openai；newTestAdapter 在该任务中注入HTTP和secret。
func TestContractGeneratePath(t *testing.T) {
    called := false
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        called = true
        if r.Method != "POST" || r.URL.Path != "/v1/images/generations" {
            t.Errorf("请求路径不符合Images协议: %s %s", r.Method, r.URL.Path)
        }
        w.Header().Set("Content-Type", "application/json")
        _, _ = io.WriteString(w, `{"data":[{"b64_json":"not-base64"}]}`)
    }))
    defer srv.Close()
    a := newTestAdapter(srv.URL)
    _, err := a.Submit(context.Background(), testGenerateRequest())
    if !called || err == nil { t.Fatal("未拒绝无效图片结果") }
}
```

newTestAdapter返回design Adapter，testGenerateRequest创建明确模型target和count=1；这些test helper只在本平台测试文件定义，不作为公共接口。

## Task 1：OpenAI Images

**Consumes：**00 openai.md、ExecuteRequest/RemoteResult、ResolvedAsset。

**Produces：**协议 `openai-images` 的Adapter；模型能力来自显式目标清单。

- [ ] 先写请求测试：generate走JSON `/v1/images/generations`；edit走官方规定multipart `/v1/images/edits`。同key只内部幂等，未经官方确认不把任意Header当上游幂等保证。
- [ ] 实现模型、prompt、size/quality/format/count等已验证字段映射；reference操作根据官方能力走edit/reference路径，未知参数拒绝。
- [ ] 输入流上传保持顺序，mask严格验证原图关系、尺寸及官方透明度语义，关闭所有ReadCloser。
- [ ] 解析合法base64/URL和usage，空data失败。显式错误按delivery=rejected；网络写入不确定按uncertain。Poll/Cancel/Reconcile无官方支持时ErrUnsupported。
- [ ] 流式图片仅在00确认事件格式和目标支持后加入，预览不是最终资产；首版不开启未经验证流功能。
- [ ] 运行 `go test ./internal/imaging/adapters/openai -run Contract -v`。

**验收：**生成、参考/编辑按能力通过；409/429/拒绝/无图测试通过；实际确认至少一次生成和一次支持的编辑，收据列明model、操作和保存asset，不包含秘密。

## Task 2：Google图像生成

**Consumes：**00 google.md中选定的具体协议。

**Produces：**协议 `google-generate-content-image` 或 `google-interactions-image`；实际选哪种由证据决定，不能两种编码混在同一个路径。

- [ ] 写协议快照测试：鉴权Header、路径、图片与文字输入、输出模态/图像配置严格匹配官方版本。
- [ ] 保存多模态response的全部最终图片和可显示说明，区别中间/思考图片和最终输出。仅文字响应映射NO_IMAGE_OUTPUT。
- [ ] 续接需要的signature/interaction handle作为opaque后端字段保存。跨平台编辑只发送明确选择的资产，不携带Google内部续接数据。
- [ ] 不声明精确mask，除非所选接口确实有该能力；prompt区域修改声明普通edit。
- [ ] content blocked、quota、过期续接、无图片、usage缺失分别测试。不支持查询的提交超时保持unknown。
- [ ] 运行 `go test ./internal/imaging/adapters/google -run Contract -v`。

**验收：**多图混合输出不丢图；文字无图不误报成功；实际生成与第二轮编辑收据完整。Vertex若列为额外产品，必须独立认证profile和fixture，不自动沿用Developer API设置。

## Task 3：火山方舟图像接口

**Consumes：**00 volcengine.md 的已选产品和API版本。

**Produces：**协议 `volcengine-ark-image` 或经证明兼容的openai profile。

- [ ] 从官方样例固定path/body/auth，测试火山专属字段、尺寸表示、组图、参考图字段、格式和超限。
- [ ] 如果复用openai Adapter，以两组fixture证明请求/输出兼容；火山专属参数在profile白名单映射，禁止混入OpenAI目标。
- [ ] 处理该产品实际返回的URL/base64/流事件；未知状态失败或unknown，不默认完成。
- [ ] 区分官方批量/组图与多个独立请求，usage和部分成功按真实计费单位记录。
- [ ] 运行 `go test ./internal/imaging/adapters/volcengine -run Contract -v`。

**验收：**官方方舟产品身份与凭据明确；实际生成和支持的参考操作完成。未支持的编辑/取消在capabilities显示关闭。

## Task 4：即梦具体开放接口

**Consumes：**00 jimeng.md，签名认证向量和提交/查询记录。

**Produces：**协议 `jimeng-image` 的专用Adapter。

- [ ] 写固定时间戳、虚构key、固定body的签名测试，比较官方向量的canonical request/signature；不自行推测算法。
- [ ] 实现所选动作与版本，测试request ID和异步handle抽取。Submit返回pending，Service保存handle后poll。
- [ ] 对官方状态逐项映射：queued/running→pending，success且有输出→completed，fail→failed，未知状态→unknown；字段依据00填写。
- [ ] 测试签名失效、时间偏差、过期任务、无输出、查询限流。认证秘密不出现在错误、事件、fixture。
- [ ] 上游取消仅有明确官方接口时实现；没有时返回ErrUnsupported/local_only。
- [ ] 运行 `go test ./internal/imaging/adapters/jimeng -run Contract -v`。

**验收：**实际提交后查询得到图片并保存；引擎重启只poll不重复submit；凭据条件不齐时目标保持disabled并记录阻塞，不能替换为网页逆向。

## Task 5：RunningHub工作流

**Consumes：**00 runninghub.md 的上传、workflow、node mapping、输出规则。

**Produces：**协议 `runninghub-workflow`；已配置映射驱动目标表单。

- [ ] 固定最小workflow版本和合法输入映射，测试缺必填、节点不存在、未声明字段、图片上传引用顺序。
- [ ] 输入asset上传按官方接口，记录remote文件引用但不暴露给前端；同attempt可缓存上传，重启不能假设临时remote文件永久有效。
- [ ] Submit冻结映射版本，返回任务handle；Poll处理排队/执行/成功/失败，筛选已声明图片输出节点。视频/压缩包不能当图片下载。
- [ ] 输入成本与生成成本分别记录，工作流非标准usage保持null；执行超时unknown，保留task handle供核对。
- [ ] 上游workflow更新时检测revision变化，不让已接收任务悄悄使用新映射。
- [ ] 运行 `go test ./internal/imaging/adapters/runninghub -run Contract -v`。

**验收：**最小工作流真实执行生成图；缺映射时提交前422；重启恢复查询；多输出中无效文件被拒绝，合法图片保留。

## Task 6：注册与能力审计

- [ ] 每个Adapter注册adapter ID+支持版本+能力profile；target enabled需contractComplete，生产启用须记录liveVerified时间与连接身份。
- [ ] 协议验证调用显式由设置动作发起；无收费的health测试不能标成生图验证通过。
- [ ] 运行 `go test ./internal/imaging/... ./internal/backend`，证明新增平台不改变聊天factory行为。
- [ ] 记录五平台实际验证与阻塞矩阵，07据此验收，不把静态契约通过算作平台真实支持。
