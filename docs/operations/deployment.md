# 部署与发布

## 部署形态

只有两种，区别在于**后端跑在哪台机器上**：

| 形态 | 后端 | 前端 | 适用 |
|---|---|---|---|
| 桌面端自带 | Tauri 壳在自己进程里起 `backend`，监听 `127.0.0.1:<随机端口>` | 壳内 WebView | 单机使用，装完即用 |
| 独立后端 | Docker 跑 `backend`，监听 `0.0.0.0:8443` | 浏览器打开同一台机器提供的页面并填地址+密码 | 后端放服务器/家里的机器，从别处访问 |

两者**不能同机并跑**——共用同一个 `~/.liveagent` 数据目录。

> **NAT 穿透不再是应用的事。** 后端在家、人在公司仍然要打洞，但这现在是**网络
> 问题**：用 tailscale / frp / cloudflared 任选其一。应用里不再有会合注册代码
> （旧 Go gateway 那约 1,100 行随阶段 6 一起删除）。这不是功能退化，是把网络问题
> 还给网络工具——它们做得比我们好，而且用户本来就在用。

## 后端镜像

根目录 `Dockerfile`，两阶段：

| 阶段 | 内容 |
|---|---|
| `backend-builder` | Rust，`cargo build -p backend --release` |
| `runtime` | `node:22.19.0-bookworm-slim`，非 root（uid 10001），Rust 二进制 + 全局安装的 pi CLI |

```
ARG PI_VERSION=0.83.0
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}"

ENV LIVEAGENT_DATA_DIR=/var/lib/liveagent HOME=/var/lib/liveagent
VOLUME ["/var/lib/liveagent"]
EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/backend"]
```

运行时基底是 `node:*-slim` 而不是 `debian-slim`：chat 引擎 pi 是 Node 程序，
后端按会话把它作为子进程拉起，底座必须自带 Node。**代价是镜像比旧的 Go 版本
大**——这是决策 3 的已知成本，记下来而不是假装没有。

两处版本不能随手改：

- **Node 不得低于 22.19.0**。pi 的 `engines.node` 就是这个下限，低于它 npm 装不上。
  与 `mise.toml` 固定的开发期版本一致，避免容器和本地跑在两个 Node 上。
- **pi 锁到具体补丁号**。它的 RPC 事件形状是翻译层的输入契约
  （见 [pi-rpc-event-contract.md](../design/pi-rpc-event-contract.md)），
  让它随 `^` 漂移等于让契约漂移。升级 pi 是一次要重新核对事件契约的动作，
  不该由一次镜像重建悄悄发生。

本地构建与冒烟：

```bash
make backend-docker-build     # docker build -t liveagent-backend:local .
make backend-docker-run       # -p 8443:8443
make backend-docker-smoke     # 起容器 + 轮询 /healthz，60s 上限
```

冒烟给 60s 而不是 30s：留给冷启动和镜像首次落盘的余量。`/healthz` 不依赖
chat 引擎——pi 进程要到第一次 `chat_send` 才惰性拉起，所以健康检查通过
**不等于** pi 可用。

## 启动参数

`backend` 每个命令行参数都有环境变量兜底，**argv 优先**（手写解析，
不引 clap——六个参数不值一整棵依赖树）：

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--port <PORT>` | `PORT` | `8443` | 监听端口，绑 `0.0.0.0`。Railway 一类平台注入的 `PORT` 直接生效 |
| `--password <PW>` | `LIVEAGENT_BACKEND_PASSWORD` | 随机生成 | Bearer token。不给就生成一个 32 位 base62 串并**打到 stderr** |
| `--tls-cert <PEM>` `--tls-key <PEM>` | `LIVEAGENT_TLS_CERT` / `LIVEAGENT_TLS_KEY` | 无 | 两个一起给才启用内建 TLS；只给一个直接报错退出 |
| `--data-dir <DIR>` | `LIVEAGENT_DATA_DIR` | `~/.liveagent` | 数据目录。官方镜像预设为 `/var/lib/liveagent` |

chat 引擎没有对应的 argv 参数：默认取 PATH 上的 `pi`，用 `LIVEAGENT_PI_BIN`
指向别处。引擎位置是部署事实，不是每次启动要调的旋钮。

密码打 stderr 不打 stdout，是为了让 stdout 能被管道消费。

## TLS

三种都支持（决策 14），选一种：

| 方式 | 配置 |
|---|---|
| 内建 TLS | `--tls-cert cert.pem --tls-key key.pem`，直接 `https://` 对外 |
| 反向代理 | 不给证书参数，明文监听，由 nginx / Caddy / 平台终结 TLS |
| 隧道 | tailscale / cloudflared 自带加密，后端明文监听即可 |

官方镜像的冒烟与 CI 都跑**明文**路径——容器内不配证书，TLS 由外层终结是更常见的
部署姿势。

## 数据持久化

后端把全部状态写在**数据目录**下（`backend/src/storage.rs`）。解析顺序：
`--data-dir` → `LIVEAGENT_DATA_DIR` → 运行用户的 `~/.liveagent`（路径是写死的
字符串，不随包名漂移——桌面壳不传参数，永远落在 `~/.liveagent`）：

```
<数据目录>/
  config.sqlite               设置
  chat-history.sqlite3        会话历史 + FTS
  memory/**/*.md              记忆事实源
  memory/memory-index.sqlite3 记忆索引
  skills/                     Skills root
  uploads/<batch>/            上传暂存
```

**密钥也在这里。** provider API key 存在后端的设置库里，前端不再持有它们。所以
「密钥只在本地」这句话现在应该说成**「密钥只在后端，后端由你自己部署」**——如果
你把后端放在别人的服务器上，密钥就在别人的服务器上。

> **官方镜像的数据卷**：镜像预设 `LIVEAGENT_DATA_DIR=/var/lib/liveagent` 并声明
> `VOLUME ["/var/lib/liveagent"]`（目录已建好、归 uid 10001）。持久化只需挂卷：
> `docker run -v liveagent-data:/var/lib/liveagent ...`。不挂卷则数据随容器删除而丢失。

## 客户端接入

### 浏览器

打开前端页面后，登录页填三项：主机、端口、密码。也可以直接发链接，跳过登录页：

```
https://your-box:8443/?backendHost=your-box&backendPort=8443&token=<password>&secure=true
```

URL 参数会被持久化到 localStorage，下次打开不用重填。`secure` 缺省跟随页面协议。

一个后端支持**多个前端同时连**（决策 9）。前端不在场不阻塞后端主流程（决策 10）：
对话照跑，工具审批该超时超时、有推荐项自动选。

### 桌面端

桌面端连的是**它自己进程里那个后端**：`get_backend_endpoint` 返回的 host 恒为
`127.0.0.1`，端口和随机密码由壳注入，用户永远不输密码、也看不到登录页。

> ⚠️ **桌面壳目前无法连接远程后端。** `commands/app/backend.rs` 只会返回内嵌后端
> 的端点，没有填写远程地址的入口。阶段 6 验收里「Docker 跑 headless 后端，
> 笔记本上的桌面端连过去」这一条**当前实现不支持**，远程访问只有浏览器一条路。

## 从旧 Gateway 迁移

| 项 | 处置 |
|---|---|
| 旧镜像 `ghcr.io/<owner>/liveagent-gateway` | **历史 tag 全部保留、仍可拉取**（决策 15）。只是不再发布新 tag |
| 新镜像 | `ghcr.io/<owner>/liveagent-backend:vX.Y.Z` / `:latest` |
| 旧桌面端 | 仍可连旧 gateway 镜像。这是大版本切换，不是原地升级 |
| `LIVEAGENT_GATEWAY_*` 环境变量 | 全部作废。新后端认 `PORT`、`LIVEAGENT_BACKEND_PASSWORD`、`LIVEAGENT_TLS_CERT/KEY`、`LIVEAGENT_DATA_DIR`、`LIVEAGENT_PI_BIN`（argv 优先） |
| `LIVEAGENT_ENGINE_BUNDLE` / `--engine-bundle` | 已删除。Node 引擎被 `pi --mode rpc` 取代，不再有 bundle 可指 |
| 每 Agent 凭证、`agent_id`、多 Agent 目录 | 概念消失。一个前端只连一个后端（决策 12） |
| 浏览器里的旧 token | 前端检测到 `liveagent.gateway.token` 会在登录页给迁移提示 |

## CI

`.github/workflows/ci.yml`：

| Job | 内容 |
|---|---|
| Backend Rust | `make check-routes`（生成物漂移）、`make check-command-classes`（新命令必须归类）、**`cargo tree -p backend \| grep tauri` 命中即失败**、`cargo test` + `clippy -D warnings` |
| Backend Docker Smoke | 构建镜像、起容器、轮询 `/healthz` |
| GUI | 前端测试 |
| Tauri Rust Check | `src-tauri` 单独跑（它要 GTK/WebKit，不能塞进后端 job） |
| Diff Hygiene | 空白字符检查 |

「backend 不许依赖 tauri」是编译期防线的 CI 版：这个 crate 一旦依赖 tauri，
headless 后端就再也编不出来了，而这种依赖是顺手 `use` 一下就会引入的。

## 发布

| 触发 | Workflow | 产物 |
|---|---|---|
| `v*` tag / 手动 | `.github/workflows/backend-docker.yml` | `ghcr.io/<owner>/liveagent-backend:<tag>` + `:latest`，`linux/amd64` |
| `v*` tag / 手动 | `.github/workflows/desktop-release.yml` | macOS Intel/ARM `.dmg`、Windows `.msi`/`.exe`、Linux `.AppImage`/`.deb`/`.rpm`，各带 updater 用的压缩包与 `.sig` |

发布 job 上传完平台产物后生成 `latest.json`。桌面端「设置 → 关于」按用户是否允许
预发布，从 GitHub Releases 里筛带 `latest.json` 的版本。

### 桌面版本号来源

日常开发只维护一处：`crates/frontend/package.json`。Tauri 配置、前端 About 页和
Rust 运行时都从这里读。

正式发布**不依赖人工改 package.json**。`desktop-release.yml` 先解析 tag：

```bash
node scripts/release/prepare-app-version-from-tag.mjs vX.Y.Z
```

| 输出 | 示例 | 用途 |
|---|---|---|
| `LIVEAGENT_RELEASE_TAG` | `v0.1.3` | Release 名、产物命名、下载 URL |
| `LIVEAGENT_APP_VERSION` | `0.1.3` | About 页与 Rust 运行时 |
| `LIVEAGENT_IS_PRERELEASE` | `false` | 是否标记 prerelease |
| `LIVEAGENT_TAURI_VERSION_CONFIG` | `src-tauri/tauri.version.generated.conf.json` | Tauri 构建时的临时 config overlay（不提交） |

各平台 job 复用同一份 metadata，用 `--config "$LIVEAGENT_TAURI_VERSION_CONFIG"`
注入版本。这样 tag 是唯一事实源，**忘记改 `package.json` 不会导致发布包显示旧版本**。

### macOS 签名与公证

需要的 GitHub Secrets：

| Secret | 说明 |
|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | Developer ID Application `.p12` 的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: wenlin fei (UU94JSVAA9)` |
| `APPLE_ID` | Apple Developer 账号邮箱 |
| `APPLE_TEAM_ID` | `UU94JSVAA9` |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password |
| `TAURI_SIGNING_PRIVATE_KEY` | updater 私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater 私钥密码，无密码可空 |
| `TAURI_UPDATER_PUBLIC_KEY` | updater 公钥，编译进桌面端校验更新包 |

脚本化写入：

```bash
BOOTSTRAP_APPLE_SECRETS=1 \
APPLE_CERTIFICATE_PASSWORD=<p12-export-password> \
  scripts/release/bootstrap-github-secrets.sh
```

`CERT_DIR/developer_id_application.p12` 不存在时，脚本会从本机 Keychain 的
`Developer ID Application: wenlin fei (UU94JSVAA9)` 自动导出。`CERT_DIR` 优先
`~/Personal/cert`，不存在时用 `~/Downloads/cert`。

自动导出失败先确认本机能看到可签名 identity：

```bash
security find-identity -v -p codesigning "$HOME/Library/Keychains/login.keychain-db"
```

必须是**带私钥**的 `Developer ID Application`。macOS 拒绝导出私钥时，在 Keychain
Access 里手动导出 `.p12` 到 `P12_PATH`，再用同一个 `APPLE_CERTIFICATE_PASSWORD`
重跑脚本。

Windows 暂无签名 secret，release workflow 先发 unsigned 包；接入 `.p12/.pfx` 或
Trusted Signing 后再补签名步骤。

## 相关文档

- [development.md](development.md) —— 本地开发与运行
- [../architecture/overview.md](../architecture/overview.md) —— 三层结构
- [../architecture/protocols.md](../architecture/protocols.md) —— 端点与认证
