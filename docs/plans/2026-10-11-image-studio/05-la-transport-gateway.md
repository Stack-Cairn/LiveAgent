# 05：LA 桌面与 Gateway 图像接入实施计划

> 执行者逐任务勾选，优先使用 subagent-driven-development 或 executing-plans；不可用时按本文执行。验收前不提交。

**Goal：**让共享UI通过同一个ImageStudioClient访问本地或远程K-Brain，可靠上传、订阅、读取和导出。

**Architecture：**共享wire types和客户端Interface置于agent-ui；桌面Adapter复用fetchKBrain；Gateway在认证后转发至选定后端，并绑定可信Scope。所有供应商认证留在K-Brain。

**Tech Stack：**TypeScript、fetch streaming、eventsource-parser、Tauri/Rust、Go HTTP Gateway。

**Spec：**[统一规格](design.md)，依赖01 fixture；联调依赖02/03。

## 全局约束

严格沿design的ImageStudioClient，不新增另一个不兼容客户端。SSE需Bearer等认证时使用fetch解析，不能把token写进URL。客户端自动重连GET，但不自动重放POST。大图不进JSON或WS消息。Gateway不能信任浏览器自报owner。

## 文件地图

LA新增 `crates/agent-ui/src/features/image-studio/types.ts`、`client.ts`、`wire.ts`；桌面新增 `crates/agent-gui/src/lib/kbrain/images.ts`、`imageEvents.ts`、`agent-ui-adapters/imageStudio.ts`；WebUI新增 `crates/agent-gateway/web/src/lib/imageStudio.ts`、`agent-ui-adapters/imageStudio.ts`。

修改真实入口 `crates/agent-gui/src/lib/kbrain/transport.ts`、`src-tauri/src/services/kbrain_backend.rs`（仅需新增数据能力时）、`crates/agent-gateway/internal/kbrain/client.go`、`internal/server/http.go`、`internal/auth/http_middleware.go`。Gateway新增 `internal/kbrain/images.go`、`internal/handler/image.go`与测试。Tauri导出按现有commands注册惯例新增 `src-tauri/src/commands/image_export.rs`，执行前确认命令模块注册路径。

测试新增 `crates/agent-gui/test/providers/kbrain-images.test.mjs`、`kbrain-image-events.test.mjs`；Gateway新增 `internal/handler/image_test.go`；WebUI新增 `test/image-studio-client.test.mjs`。JS测试遵已有test runner的TS加载习惯，不自行引入第二套测试框架。

## Task 1：wire客户端与multipart

**Consumes：**01 wire-v1.json、design ImageStudioClient。

**Produces：**桌面与WebUI客户端全部方法，错误归一化为ImageClientError(code,status,retryable)。

- [ ] 从freeze fixture实现类型与运行时必需字段校验；unknown event可跳过但必须保留seq，非法job拒绝，不把任意JSON强转成成功。
- [ ] 改fetchKBrain的content-type判断：仅明确JSON body设置JSON；FormData让浏览器生成boundary，Blob/stream遵显式type。保留auth和只重试read的规则。

```ts
const headers = new Headers(init.headers);
const multipart = typeof FormData !== "undefined" && init.body instanceof FormData;
if (init.body !== undefined && !multipart && typeof init.body === "string" && !headers.has("Content-Type")) {
  headers.set("Content-Type", "application/json");
}
```

字符串body调用者仍需明确协议；现有聊天JSON请求必须回归。

- [ ] upload只发file字段；提交固定Idempotency-Key，网络结果未知时由UI查已知任务或重放相同key，不生成新key悄悄重试。
- [ ] capability probe兼容旧health字段缺失；旧后端隐藏入口，401/503当真实错误显示，不当不支持。
- [ ] 运行 `node --test crates/agent-gui/test/providers/kbrain-images.test.mjs`，覆盖multipart boundary、JSON、401刷新不重放写、同key保留、旧后端。

## Task 2：事件恢复和图片读取

**Produces：**subscribe、readAsset、AbortSignal取消订阅。

- [ ] 用eventsource-parser支持UTF-8多字节跨chunk、注释heartbeat和多行data；不能直接split每个网络chunk。
- [ ] 事件seq去重，asset.ready更新输出，断线从lastSeq续接；409 EVENT_GAP读getJob刷新再订阅。客户端重连退避1/2/4/8/15秒并尊重AbortSignal。
- [ ] 终态后关闭流；切后端卸载旧订阅、Blob URL和draft作用域，避免混入其他后端任务。
- [ ] 图片fetch带认证返回Blob，UI只生成临时object URL并在释放时revoke；列表优先缩略图，不同时加载全部原图。
- [ ] 运行 `node --test crates/agent-gui/test/providers/kbrain-image-events.test.mjs`；断流重连只获取缺失seq，不重复展示结果。

## Task 3：Gateway身份与路由

**Consumes：**现有登录认证、remote target访问规则；design Scope。

**Produces：**受认证的 `/api/image/...` 到K-Brain `/v1/image/...` 路由；客户端无需知道远端凭据。

- [ ] 在现有server/http.go路由分发中注册独立image路径，不挂开放static分支。校验用户对后端目标的权限及目标选择。
- [ ] 若现有目标是共享backend token，新增可信scope委派：Gateway签名声明含sub、backendId、iat、exp≤60秒、aud=image、nonce；K-Brain通过已配置信任key验证。对用户自报scope header全部丢弃。
- [ ] 委派测试过期、错aud、错backend、伪造签名、重放nonce、其他owner资产读取；未经可信委派的共享目标拒绝多用户访问，不悄悄映射local。
- [ ] 转发binary和SSE流不buffer完整响应；上游断开传播，HTTP超时按提交/查询/下载分别设置，body限制与design一致。资产文件名不作为路径拼接。
- [ ] secret管理限目标配置权限；仅可执行图像的用户不能更新连接或读取配置secret ref目录。
- [ ] 运行 `go -C crates/agent-gateway test ./internal/kbrain ./internal/handler ./internal/auth/... ./internal/server`；K-Brain委派侧运行 `go test ./internal/backend -run 'ImageDelegation|ImageScope' -v`。

**注意：**可信委派是05对01认证层的明确依赖修改，不能由04某个平台Adapter自行处理。

## Task 4：导出与主机边界

**Produces：**exportAsset的3种目的地与真实saved结果。

- [ ] download：WebUI读取认证Blob再触发浏览器下载；取消时saved=false，不报告已写工作区。
- [ ] local_workspace：桌面明确选定导出路径，Rust从可信K-Brain资产读取写入，限制到用户授权目录；禁止接收任意URL作为导出来源。
- [ ] remote_workspace：使用已有远程文件能力，在目标授权目录写入；没有该能力隐藏选项。不能把本机路径交远端写入。
- [ ] 文件冲突提示覆盖/改名，不静默覆盖。写temp→rename后回saved；用户取消、磁盘满、无权限均返回实际错误。
- [ ] 原图和缩略图不可混用；导出name限制路径分隔符和控制字符，内容校验依资产元数据。
- [ ] 运行 `cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests`；Rust新增导出测试mock输入，检验失败时不留半文件。

## Task 5：两端集成验证

- [ ] 运行 `pnpm --dir crates/agent-gui typecheck`、`pnpm --dir crates/agent-gateway/web build`、`node scripts/check-mirror.mjs`。
- [ ] fake image后端分别从桌面和WebUI上传、提交、断线续接、获取结果和导出。
- [ ] 验证两个登录用户不能互读；旧K-Brain提示升级且聊天仍可用。

**验收：**无平台密钥即可验收传输闭环；真实平台与长任务联调在07。模块失败不使整个聊天应用崩溃。
