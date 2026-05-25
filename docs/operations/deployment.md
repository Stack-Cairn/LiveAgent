# CI/CD 与发布

本文档描述当前自动化发布链路：CI 检查、Gateway Docker 镜像、用户自部署 Gateway、桌面端 macOS/Windows Release。

## 自动化入口

| 入口 | Workflow | 动作 |
|---|---|---|
| PR / `main` push | `.github/workflows/ci.yml` | 跑 Gateway、WebUI、GUI、Tauri Rust 测试和 proto 一致性检查。 |
| `v*` tag / 手动指定 tag | `.github/workflows/gateway-docker.yml` | 构建并推送 `vX.Y.Z` 与 `latest` Gateway 镜像。 |
| `v*` tag | `.github/workflows/desktop-release.yml` | 并行构建 macOS Intel、macOS Apple Silicon 和 Windows x64 桌面包，并上传到 GitHub Release。 |

## Gateway 镜像

根目录 `Dockerfile` 是 Gateway 的生产镜像：

| 阶段 | 内容 |
|---|---|
| `webui` | 用 Node 22 和 pnpm 构建 `crates/agent-gateway/web/dist`。 |
| `gateway-builder` | 用 Go 编译 `cmd/gateway`，WebUI 静态资源通过 `go:embed` 打进二进制。 |
| `runtime` | Debian slim + CA certificates + `liveagent-gateway`，非 root 用户运行。 |

运行时变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `LIVEAGENT_GATEWAY_TOKEN` | 是 | WebUI、HTTP API、桌面 gRPC 的共享访问 token。 |
| `PORT` | Railway 自动提供 | HTTP/WebUI 监听端口，未提供时 Dockerfile 默认 `8080`。 |
| `LIVEAGENT_GATEWAY_GRPC_ADDR` | 否 | gRPC 监听地址，默认 `:50051`。 |

本地 smoke run 示例：

```bash
make gateway-docker-smoke
```

CI 中的 `Gateway Docker Smoke` job 会执行同等检查：构建镜像、启动容器、访问 `/healthz`。

## 用户自部署 Gateway

LiveAgent 不提供托管 Gateway 服务。需要公网 Remote Gateway 的用户可以用自己的 Railway 账号部署本仓库，或在其他 Docker 平台部署 `ghcr.io/<owner>/liveagent-gateway:vX.Y.Z` / `latest` 镜像。

Railway 自部署路径：

1. 在 Railway 新建项目，选择 GitHub Repository。
2. 选择 `Stack-Cairn/LiveAgent` 或用户自己的 fork。
3. 分支选择包含根目录 `Dockerfile` 和 `railway.json` 的分支。
4. 在 service variables 中设置 `LIVEAGENT_GATEWAY_TOKEN=<long-random-token>`。
5. 保持 `LIVEAGENT_GATEWAY_GRPC_ADDR=:50051`，或按平台 TCP Proxy 要求调整。
6. 部署成功后生成 Public Domain，并访问 `/healthz` 验证健康检查。

推荐生产部署模型：

| 流量 | Railway 能力 | Remote 配置 |
|---|---|---|
| WebUI / HTTP / WebSocket | Public Networking HTTPS 域名 | `Gateway URL=https://<service>.up.railway.app` |
| 桌面端 gRPC | TCP Proxy | `gRPC Endpoint=http://<tcp-proxy-host>:<tcp-proxy-port>` |

Gateway WebUI 和桌面 gRPC 地址分开后，Railway 的 HTTPS 域名和 TCP Proxy 地址可以独立配置。

Gateway 运行时变量由用户在自己的平台配置：

| 变量 | 说明 |
|---|---|
| `LIVEAGENT_GATEWAY_TOKEN` | WebUI、HTTP API、桌面 gRPC 的共享访问 token。 |
| `LIVEAGENT_GATEWAY_GRPC_ADDR` | 保持 `:50051`，供 Railway TCP Proxy 转发。 |

## GitHub Secrets

macOS signed/notarized release 需要这些 secrets：

| Secret | 说明 |
|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | Developer ID Application `.p12` 的 base64。 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码。 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: wenlin fei (UU94JSVAA9)`。 |
| `APPLE_ID` | Apple Developer 账号邮箱。 |
| `APPLE_TEAM_ID` | `UU94JSVAA9`。 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password。 |

脚本化写入 GitHub 配置：

```bash
BOOTSTRAP_APPLE_SECRETS=1 \
APPLE_CERTIFICATE_PASSWORD=<p12-export-password> \
  scripts/release/bootstrap-github-secrets.sh
```

如果 `CERT_DIR/developer_id_application.p12` 不存在，脚本会从本机 Keychain 中的 `Developer ID Application: wenlin fei (UU94JSVAA9)` 自动导出，并生成 `.p12` 密码写入 GitHub Secret。`CERT_DIR` 默认优先使用 `~/Personal/cert`，不存在时使用 `~/Downloads/cert`。已有 `.p12` 时需要传入 `APPLE_CERTIFICATE_PASSWORD=<p12-password>`。

如果自动导出失败，先确认本机能看到可签名 identity：

```bash
security find-identity -v -p codesigning "$HOME/Library/Keychains/login.keychain-db"
```

Keychain 中必须是带私钥的 `Developer ID Application` identity。若 macOS 拒绝私钥导出，可以在 Keychain Access 中手动导出 `.p12` 到 `P12_PATH`，再用同一个 `APPLE_CERTIFICATE_PASSWORD` 重新运行脚本。

脚本默认读取：

| 文件 | 用途 |
|---|---|
| `CERT_DIR/developer_id_application.p12` | CI 导入的签名 identity。 |
| `CERT_DIR/app key.md` | Apple app-specific password。 |

## 桌面产物

`desktop-release.yml` 产物：

| 平台 | Runner | 产物 |
|---|---|---|
| macOS Intel | `macos-13` | `LiveAgent_<tag>_x64.dmg`，Developer ID 签名、公证、staple。 |
| macOS Apple Silicon | `macos-14` | `LiveAgent_<tag>_aarch64.dmg`，Developer ID 签名、公证、staple。 |
| Windows x64 | `windows-latest` | Tauri 生成的 `.msi` 和 NSIS `.exe`。 |

Windows 当前没有代码签名 secret，release workflow 会先自动发布 unsigned 包。接入 Windows `.p12/.pfx` 或 Trusted Signing 后再补签名步骤。
