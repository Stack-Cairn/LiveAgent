# MCP OAuth 设计与实现基线

| 元数据 | 内容 |
|---|---|
| 状态 | In Progress / 首版实现基线 |
| 版本 | v0.1 |
| 日期 | 2026-08-24 |
| 所属计划 | [2026 H2 能力路线图](./2026h2-capability-roadmap.md) P1-③ |

## 1. 问题与目标

remote MCP server（transport=http/sse）目前只支持静态 `headers` 鉴权，接不通要求 OAuth 2.1 的托管 MCP server（Sentry、Linear、Notion、GitHub 等 2026 年主流托管连接器）。目标：按 MCP Authorization 规范（2025-06-18 及后续修订）实现完整授权码流——发现、动态注册、PKCE、token 刷新、keychain 存储——桌面端一键 Connect 即可接通。

## 2. 现实修正（对 roadmap 假设的偏差，均已核对代码）

1. **无 mcp.rs SDK**。roadmap 写「接入 `mcp.rs` 的 HttpTransport/SseTransport」；实际仓库不依赖 MCP SDK，transport 是 `commands/integration/mcp.rs` 内自研的阻塞式 JSON-RPC（reqwest blocking + 手写 SSE 解析）。OAuth 挂接点即该文件的 `HttpTransport`/`SseTransport`/`McpClient`。
2. **不引 oauth2 v5 crate**。其 pluggable HTTP trait 适配我们 reqwest 0.13 + `system_proxy` 出站纪律的胶水量超过手写协议本身（token 交换/刷新只是两个 form POST，PKCE 是 40 行）；仓库对 MCP/SSE 协议层本就全手写。新依赖仅 `keyring` v3。
3. **auth 类型不设 `"headers"` 枚举值**。静态 headers 已是 `McpServerConfig.headers` 独立字段且继续生效；`auth` 缺省或 `type:"none"` 即现状，`type:"oauth"` 才启用本特性。避免无意义的存量迁移。
4. **Linux 降级存储为 0600 明文 JSON 而非「加密文件」**。无 OS keystore 时加密密钥无处安放（密钥只能落在 token 旁边），加密是安全剧场；诚实降级 + 文档/诊断明示。

## 3. 核心设计

| 决策 | 取向 | 理由 |
|---|---|---|
| 授权触发 | **只由显式用户手势触发**（MCP Hub 卡片 Connect / McpManager test 引导）；transport 内 401 只做静默刷新 + 标记性错误，绝不弹浏览器 | 对话中途并发工具调用会弹 N 个浏览器窗口；授权是配置态动作不是运行态动作 |
| 发现链 | 401 `WWW-Authenticate` 的 `resource_metadata`（RFC 9728）→ PRM `authorization_servers[0]` → RFC 8414 AS 元数据（路径感知探测 + OIDC fallback）；无 `WWW-Authenticate` 时按 server URL 推导 PRM well-known，再退 2025-03-26 旧规范（AS=server origin，缺元数据时默认 `/authorize` `/token` `/register` 端点） | 兼容新旧两代托管 server；旧 Cloudflare workers 类 server 只有默认端点 |
| 客户端 | 配置可带静态 `auth.clientId`；否则 RFC 7591 动态注册（`token_endpoint_auth_method:"none"` 公共客户端），注册结果随 token 同存 keychain；复用后授权失败（invalid_client、超时等）只把该 client 标记为可疑（进程内），下次授权跳过复用直接重注册——存量 token 保留，防止一次未完成的 Reauthorize 销毁仍有效的凭据 | 托管 server 普遍开 DCR；静态 client 供企业 AS 用 |
| 授权流 | Authorization Code + **PKCE(S256) + state 校验**；系统浏览器（`tauri-plugin-opener`）+ `127.0.0.1:随机端口` loopback 回调（RFC 8252）；authorize/token 请求都带 RFC 8707 `resource` 参数（server URL 规范化） | MCP 规范强制 PKCE 与 resource 绑定；loopback 随机端口免冲突 |
| scope | `auth.scope` 覆盖 > PRM `scopes_supported` 全量 > 省略 | 对齐 MCP 规范推荐 |
| 存储 | `keyring` v3（macOS Keychain / Windows Credential Manager / Linux secret-service）；keyring 不可用（无 secret-service、headless）降级 `~/.liveagent/mcp-oauth-tokens.json`（明文；Unix 上 0600，Windows 依赖用户目录默认 ACL） | roadmap 凭据纪律；降级保证 Linux 可用 |
| 存储键 | service=`LiveAgent MCP OAuth`，account=server id；blob 内含 `server_url`，与当前配置 URL 不符即视为无 token | 防 URL 改指向后 token 串用到别的 server（audience 混淆） |
| 进程内缓存 | `mcp_oauth::store` 持全局 `Mutex<HashMap<server_id, TokenRecord>>`，keyring 只在 miss/授权/刷新/清除时读写 | Keychain IPC 有毫秒级开销，不能每请求一次 |
| 刷新 | 请求前 `expires_at - 60s` 窗口主动刷新；401 被动刷新一次并重试（沿用 `SessionExpired404` 的单次重试骨架）；refresh token 轮换即持久化 | 无感续期；重试骨架已被验证 |
| 同步纪律 | token/client_secret **永不进 settings/SQLite** → Gateway settings sync 与 WebDAV 备份天然不含凭据；config 只加 `auth: { type, scope?, clientId? }` | roadmap 既定取舍，零脱敏改造 |
| 远程限制 | 授权流仅桌面端可发起（系统浏览器在桌面弹出）；WebUI 侧仅状态展示（follow-up，见 §8） | roadmap 明确；device-code 流留作后续 |
| 出站纪律 | 所有 OAuth HTTP（探测/元数据/注册/token）走 `system_proxy::blocking_client_builder()`，代理异常 fail fast | 仓库既有纪律：不静默直连 |

## 4. 流程

### 4.1 交互授权（`mcp_oauth_authorize` 命令，spawn_blocking 内串行执行）

```
探测 server URL（POST initialize，预期 401）
 ├─ WWW-Authenticate: Bearer resource_metadata="…"   → GET PRM（RFC 9728）
 ├─ 无 header → 按 URL 推导 /.well-known/oauth-protected-resource{path} 探测
 └─ PRM 拿不到 → 旧规范 fallback：issuer = server origin
GET AS 元数据（RFC 8414 候选序列，见 §4.3）→ 校验 code_challenge_methods_supported ∋ S256
决定 client：auth.clientId > keychain 存量注册 > RFC 7591 动态注册
绑定 127.0.0.1:0 loopback listener（先绑端口再注册/拼 redirect_uri）
拼 authorization URL（code + PKCE S256 + state + resource + scope）→ 系统浏览器打开
等待回调（5 分钟超时，state 不符拒绝，one-shot）→ 授权码
POST token_endpoint（code + code_verifier + redirect_uri + resource）→ TokenRecord 入 keychain + 缓存
```

### 4.2 运行时（transport 内，每请求）

```
oauth 启用 → store::ensure_bearer(id, url)：缓存/keyring 读 TokenRecord
 ├─ URL 不符或无记录 → 无 Bearer（请求裸发，401 后报「需授权」标记错误）
 ├─ 将过期且有 refresh_token → 主动刷新（失败则继续用旧 token 尝试）
 └─ 注入 Authorization: Bearer
响应 401（oauth 启用时）→ McpTransportError::Unauthorized
 → McpClient 被动刷新一次成功 → 重试原请求
 → 刷新不可行/仍 401 → 错误信息带稳定标记（前端据此显示 Connect 引导）
```

SSE transport：长连 GET 流每次重连时从 store 取当前 Bearer（不固化在 spawn 时的 HeaderMap），POST 与 http transport 同语义。

### 4.3 AS 元数据候选序列（issuer 带路径 `https://as.example.com/tenant` 为例）

1. `https://as.example.com/.well-known/oauth-authorization-server/tenant`（RFC 8414 路径插入）
2. `https://as.example.com/.well-known/openid-configuration/tenant`（OIDC 路径插入）
3. `https://as.example.com/tenant/.well-known/openid-configuration`（OIDC 路径追加）

无路径时依次试 `/.well-known/oauth-authorization-server`、`/.well-known/openid-configuration`。全败且处于旧规范 fallback 分支时，用默认端点 `{issuer}/authorize` `{issuer}/token` `{issuer}/register`。

## 5. 组件与文件

**Rust（`crates/agent-gui/src-tauri`）**

- `src/services/mcp_oauth/mod.rs`（新）— 公共 API：`authorize` / `status` / `clear` / `ensure_bearer` / `refresh_after_unauthorized`；同 server 授权互斥
- `src/services/mcp_oauth/discovery.rs`（新）— 401 探测、`WWW-Authenticate` 解析、PRM/AS 元数据获取与候选序列
- `src/services/mcp_oauth/register.rs`（新）— RFC 7591 动态注册
- `src/services/mcp_oauth/flow.rs`（新）— PKCE/state 生成、loopback 回调 listener、authorize URL、code 交换、refresh
- `src/services/mcp_oauth/store.rs`（新）— TokenRecord、keyring 读写 + 文件降级 + 进程内缓存
- `src/commands/integration/mcp.rs` — `McpServerConfig.auth` 字段；transport Bearer 注入；`Unauthorized` 错误变体与刷新重试；`McpRuntimeTestResponse.auth_status` 诊断
- `src/commands/integration/mcp_oauth.rs`（新）— `mcp_oauth_authorize` / `mcp_oauth_status` / `mcp_oauth_clear` 命令
- `src/lib.rs` / `src/services/mod.rs` / `src/commands/integration/mod.rs` — 注册
- `Cargo.toml` — `keyring = { version = "3", features = ["apple-native", "windows-native", "sync-secret-service"] }`、`getrandom`

**TS**

- `crates/agent-ui/src/lib/settings/types.ts` + `index.ts` — `McpAuthConfig`（`type/scope/clientId`）、normalize
- `crates/agent-gui/src/shims/` 或既有 invoke 通道 — 三条命令桥接
- `crates/agent-ui/src/pages/mcp-hub/McpServerCard.tsx` / `McpServerEditModal.tsx` — http/sse server 的授权状态徽章 + Connect/Reauthorize/断开；编辑弹窗 auth 选项
- 删除 server 路径调用 `mcp_oauth_clear`；i18n 双端补 key

## 6. 安全要点

- loopback 只绑 `127.0.0.1`，one-shot，5 分钟超时；`state` 恒定比较校验；回调页为纯静态成功/失败 HTML
- 浏览器只打开 `https:` 或 loopback `http`（`127.0.0.1`/`localhost`，RFC 8252 §7.3）的授权 URL（阻断 `javascript:` 等注入面）
- token/client_secret 不落日志、不进 settings/DB/同步/备份；诊断输出仅状态与过期时间
- Bearer 只发给配置里的 server URL（TokenRecord.server_url 一致性校验，防 audience 混淆）
- `resource` 参数（RFC 8707）绑定 token 受众

## 7. 验收（roadmap P1-③ 摘录 → 落点）

- [ ] 接通至少 2 个真实托管 MCP server → 手动验收脚本（候选：Cloudflare demo、Linear、Notion MCP）
- [ ] token 过期自动刷新无感 → 主动 + 被动刷新路径单测 & 长会话手测
- [ ] 卸载 server 清理 keychain 条目 → 删除路径挂 `mcp_oauth_clear`
- [ ] 重启后免重授权 → keychain 持久化 + 启动后首请求 ensure_bearer 手测

## 8. 已知边界（首版）

1. **WebUI parity 后续补**：授权本就只能在桌面完成；WebUI 侧「authorization required」状态展示 + 引导（gateway 事件/proto 字段）作为紧随的独立改动，`check-ui-boundaries.mjs` 门禁保底。
2. **device-code 流不做**（roadmap 既定）。
3. **SSE GET 流对 401 不主动重授权**：GET 流重连时取最新 token；流中失效依赖下一次 POST 的 401 触发刷新。
4. **Linux 无 secret-service 时为 0600 明文文件**（§2-4 的诚实降级）；诊断输出会标注 `storage: file`。
5. **同 server 多桌面实例**：keyring 为机器级共享，互相覆盖 token 无害（都有效）；授权互斥仅进程内。

## 9. 测试

- `WWW-Authenticate` 解析、PRM/AS 元数据候选序列推导、resource 规范化 — 纯函数单测
- TokenRecord 文件降级 roundtrip、URL 不符失效、过期窗口判定 — store 单测
- PKCE verifier/challenge、state、authorize URL 拼装 — flow 单测
- 401 → 刷新 → 重试 / 刷新不可行 → 标记错误 — McpClient 层单测（mock transport）
- 集成：本地 mock AS + mock MCP server 跑全流程（授权码流 + 刷新 + 撤销），进 CI；真实托管 server 属手动验收
