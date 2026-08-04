# 阶段 4 · 前端网络化

**状态:⬜ 未开始**(依赖阶段 3)

## 目标

让前端**只通过网络**和后端说话。Tauri IPC 这条隐藏的第二路径彻底消失。

做完这步,「本地」和「远程」的区别退化成一个字符串:

```ts
const backend = createBackendClient({ baseUrl, password });
//                                    ↑ 唯一的本地/远程差异
```

## 要求

| # | 要求 | 为什么 |
|---|---|---|
| 1 | 只留 18 个前端专属 `invoke` | 托盘/窗口/更新是壳能力,不该走网络 |
| 2 | 事件订阅从 `listen()` 换成 WS | 同上,统一传输 |
| 3 | 本地模式由 Tauri 壳注入密码并跳过登录页 | 决策 8。桌面版开箱体验不能退化 |
| 4 | 删除 `services/gateway/*` 与 `gateway_bridge.rs` | 它们在这一步失去全部用户 |
| 5 | 前端行为零变化 | 用户不该感知到这次重构 |

## 改动面(实测基线)

| 项 | 数量 |
|---|---|
| import `@tauri-apps/api/core`(`invoke`)的文件 | **57** |
| import `@tauri-apps/api/event`(`listen`)的文件 | **17** |
| `@tauri-apps/plugin-opener` | 7 |
| `api/window` / `api/webview` / `api/path` | 各 1 |

替换后真正剩下的 Tauri 专属只有约 **10 个文件**。

## 删除清单

| 目标 | 行数 |
|---|---|
| `services/gateway/*.rs` | 10,228 |
| `services/gateway_bridge.rs` | ~1,400 |
| `src-tauri/gateway_sink.rs` | ~150 |
| 21 个 `deleted.txt` 里的 command | — |
| `commands/integration/gateway.rs` 的 20 个中继命令 | — |
| Go gateway 的 chat 可靠性补丁(阶段 3 已验证为死代码) | ~3,800 |

## 必须一起处理:`settings_save_remote` 拆两半

阶段 1 分类的已知缺陷(见 `backend-boundary.md`「已知分类缺陷」)。
`RemoteSettingsPayload`(`commands/config/settings/types.rs:23`)混了两类字段:

| 字段 | 处置 |
|---|---|
| `gateway_url`、`gateway_port`、`token`、`agent_id`、`auto_reconnect`、`heartbeat_interval` | **删除** —— 「连到哪个 Gateway」这个概念不存在了 |
| `enable_web_terminal`、`enable_web_ssh_terminal`、`enable_web_git` 等 | **保留** —— 并入后端的访问控制设置,门控远程前端能干什么 |

## 破坏性变更(无法避免)

**旧模型是桌面端 outbound 拨向 gateway,新模型是前端 outbound 拨向后端 ——
两边都在等对方来连,技术上对不上。** 现有部署了
`ghcr.io/stack-cairn/liveagent-gateway` 的用户一定会断。

按决策 15:

- 发**大版本**(v2.0)
- 旧 gateway 镜像 tag **冻结保留可拉**,旧桌面端配旧网关继续可用
- 新桌面端检测到旧网关地址时给**明确提示**,不静默失败
- README 写迁移指南

## 验收标准

- 同一份前端二进制,**只改 base URL** 就能在「本机后端」和「远程后端」之间切换,
  行为一致
- 桌面版双击即用:壳注入密码、跳过登录页、无感
- 浏览器访问远程后端:走登录页、输密码
- `rg '@tauri-apps/api/core' crates/agent-gui/src` 只剩前端专属命令的文件
- 旧 gateway 镜像仍可拉、旧桌面端仍可连
