# 阶段 6 · 删除 Go 与切换发布

**状态:⬜ 未开始**(依赖阶段 5)

## 目标

删掉最后的 Go 代码,切换构建与发布,重写文档。仓库从三语言收敛为两语言。

## 删除清单

| 目标 | 行数 |
|---|---|
| `crates/agent-gateway/` 手写 Go | 13,914 |
| 生成的 protobuf(Go) | 17,357 |
| Go 测试 | 10,827 |
| `proto/v2/*.proto` + buf 工具链 | — |
| **合计** | **42,098+** |

`proto/v2` 一起删是因为决策 6 把线上协议定为 JSON —— 契约不再需要 protobuf,
`prost`/`protobufjs` 依赖、buf codegen、生成物漂移门禁一并消失。

> 注意 `crates/agent-gui/src-tauri/build.rs` 里有 prost-build 调用编译
> `crates/agent-gateway/proto/v2/*.proto`,删 proto 时要同步清理。

## 构建与 CI 切换

| 项 | 现在 | 之后 |
|---|---|---|
| `Dockerfile` | 3 阶段:node 构建 SPA → golang 构建二进制 → debian-slim | 构建 `agent-backend` + 打包 Node runtime |
| CI `gateway` job | proto lint + breaking check + 生成物漂移 + golangci-lint + go test | `cargo test` + `cargo clippy` |
| CI `GUI/WebUI Mirror Check` | 强制两套前端字节相同 | 阶段 5 已删 |
| `Makefile` | `dev-gateway` / `gateway-build` / `gateway-docker-*` | 改名为 `dev-backend` / `backend-build` / … |
| `railway.json` | healthcheck `/healthz` | 保留(新后端也有 `/healthz`) |

新增门禁建议:

- `cargo tree -p agent-core | grep tauri` 命中则失败(编译期防线的 CI 版)
- 阶段 1 的 command 分类 diff(P1-13)

## 文档重写

| 文件 | 处置 |
|---|---|
| `docs/architecture/gateway.md` | **删除**(Gateway 不存在了) |
| `docs/architecture/overview.md` | 重写三层结构 |
| `docs/architecture/protocols.md` | 重写为 JSON over HTTP+WS |
| `docs/architecture/webui.md` / `gui.md` | 合并成一份(阶段 5 已合并前端) |
| `docs/operations/deployment.md` | 重写部署方式 |
| `README.md` / `README.zh-CN.md` | 见下 |

## README 需要修的三处

1. **技术栈表(第 283 行附近)** 列了 `@openai/codex-sdk` 和 `claude-agent-sdk`,
   但 `crates/agent-gui/package.json` **没有这两个依赖** —— 实际只有
   `@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core`。这是现存的事实错误,
   与本次迁移无关但顺手修掉。
2. **架构图(第 254–270 行)** 的三层结构整体作废,重画。
3. **定位表述**:第 82 行「本地优先」、第 352 行「秘钥仅保存在桌面端本地」。
   新架构下密钥在**后端**,后端可能在服务器上。改成「密钥只在后端,后端由你自己部署」。

另外 NAT 穿透的表述要改:后端在家、人在公司仍需打洞,但这现在是**网络问题**
(tailscale / frp / cloudflared),不是应用问题 —— 应用里不再有约 1,100 行会合注册代码。

## 验收标准

```bash
# 仓库无 Go、无 proto
find . -name '*.go' -not -path './target/*' | wc -l   # 期望 0
find . -name '*.proto' -not -path '*/node_modules/*' | wc -l   # 期望 0

cargo test --workspace && cargo clippy --workspace -- -D warnings
cargo tree -p agent-core | grep -q tauri && echo "防线破了" || echo "防线完好"
```

端到端:

- Docker 跑 headless 后端,笔记本上的桌面端连过去,全功能验证:
  history / settings / terminal / 上传 / git review / skills / memory / cron /
  chat(冷启动 / 长挂起 / 断网重连)
- 浏览器连同一个后端,同样全过
- **旧 gateway 镜像 tag 仍可拉、旧桌面端仍可连**(决策 15)
- 记录镜像体积与启动时间,与 Go 版本对比 —— Node runtime 会让镜像变大,
  这是决策 3 的已知代价,记下来而不是假装没有
