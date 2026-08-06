<p align="center">
  <img src="docs/images/banner.webp" alt="LiveAgent" />
</p>

<h1 align="center">LiveAgent</h1>

<p align="center">
  <strong>Your Self-Hosted AI Agent Workspace</strong><br/>
  Multi-model access · Real tool execution · MCP & Skills ecosystem · Browser or desktop, same backend
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blueviolet" />
  <img alt="Tauri" src="https://img.shields.io/badge/built%20with-Tauri%202-FFC131?logo=tauri&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-B7410E?logo=rust&logoColor=white" />
  <img alt="Node" src="https://img.shields.io/badge/Node-22-5FA04E?logo=nodedotjs&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
</p>

<p align="center">
  <a href="#core-features">Core Features</a> •
  <a href="#download--deployment">Download & Deployment</a> •
  <a href="#faq">FAQ</a> •
  <a href="docs/">Docs</a>
</p>

---

## 🌟 Special Thanks

<p align="center">
  <a href="https://linux.do">
    <img src="docs/images/linuxdo.png" alt="LINUX DO" width="420" />
  </a>
</p>
<p align="center"><b>For all things AI, head to LINUX DO! Wishing the community ever greater success~</b></p>

---

## ❤️ Sponsor

<table>
<tr>
<td width="200" align="center" valign="middle"><a href="https://www.packyapi.com/register"><img src="docs/images/partners/packycode.png" alt="PackyCode" width="160"></a></td>
<td valign="middle">PackyCode is a reliable, efficient, and professional API relay service provider, offering relay services for Claude Code, Codex, Gemini, Chinese domestic models, and more — a long-established, top-tier relay. <b>The vast majority of the model resources used to develop this software were provided by PackyCode — thank you, Laonong!</b> Register <a href="https://www.packyapi.com/register">here</a> to get started!</td>
</tr>
<tr>
<td width="200" align="center" valign="middle"><a href="https://rightapi.ai/register"><img src="docs/images/partners/rightcode.jpg" alt="RightCode" width="160"></a></td>
<td valign="middle">Right Code provides stable relay services for Claude Code, Codex, Gemini, Chinese domestic models, and more. Invoices are available upon top-up, and enterprise and team users receive dedicated one-on-one support. <b>The remaining model resources used to develop this software were provided by RightCode — thanks to the RC site owner and the support team!</b> Register <a href="https://rightapi.ai/register">here</a> to get started!</td>
</tr>
<tr>
<td width="200" align="center" valign="middle"><a href="https://cubence.com/signup"><img src="docs/images/partners/cubence.png" alt="Cubence" width="160"></a></td>
<td valign="middle">Cubence is a reliable and efficient API relay service provider, offering relay services for Claude Code, Codex, Gemini, and more, with pay-as-you-go billing. <b>Thanks to Cubence for supporting this project!</b> Register <a href="https://cubence.com/signup">here</a> to get started!</td>
</tr>
</table>


---

## 🤝 Come Build With Us!

<p align="center">
  <img src="docs/images/QQ.png" alt="LiveAgent QQ Group" width="300" />
</p>

<p align="center">
  Scan the QR code to join our QQ group and help drive LiveAgent development!<br/>
  (Why a QQ group? It just packs a few more features than a WeChat group~)
</p>


---

## Why LiveAgent?

LiveAgent is a **self-hosted** AI agent you run yourself. It deeply integrates large language model reasoning with real system tools, so the AI can genuinely operate your file system, run commands, and manage scheduled tasks — and you reach it from a desktop app or a browser, both talking to the same backend.

- **An agent that actually gets things done** — beyond chat: read and write files, make precise edits, run Bash, and supervise long-running processes
- **A fully open ecosystem** — bridge any external tool via the MCP protocol, and load Skills packages on demand
- **Your keys stay on your backend** — the backend is the only thing that holds credentials, and you decide where it runs: your laptop, your home server, or your own VPS

---

## Core Features

![](docs/images/product.webp)

### 🧠 Multi-Model & Chat

- **Multi-model routing** — Claude (Anthropic), Codex (OpenAI), and Gemini protocols, with custom Base URL support for third-party compatible services
- **Rich rendering** — streaming Markdown with built-in KaTeX math, Mermaid diagrams, and Monaco code preview
- **History compaction** — dual-layer Segment + Summary Checkpoint persistence keeps long conversations from losing context
- **Internationalization** — built-in i18n multi-language framework

### 🔧 Local Tool Execution

- **Full file-system capabilities** — precise `Read` / `Write` / `Edit` / `Delete`, plus `Glob` / `Grep` pattern and regex search
- **Bash & long-running processes** — non-interactive command execution (cwd / timeout), with `ManagedProcess` supervising dev servers and other resident tasks
- **Sub-agent delegation** — independent sub-agents execute in parallel with worktree isolation and automatic merging
- **Tunnel exposure** — `TunnelManager` exposes local services to the public internet in one click

### 🧩 MCP & Skills Ecosystem

- **MCP protocol bridging** — the backend natively bridges any stdio / http MCP server for unlimited tool extension
- **Skills packages** — progressive disclosure and on-demand loading, with install / create / package support and the ClawHub ecosystem

### 💾 Memory & Automation

- **Persistent memory** — Markdown + SQLite FTS full-text search for cross-session knowledge management
- **Scheduled tasks** — bash / http / prompt cron job types, executed automatically in the background

### 🌐 Browser and Desktop, One Backend

- **Same code, two shells** — the desktop app and the browser run the identical frontend build; the only difference is which backend URL it points at
- **Disconnect recovery** — the event WebSocket reconnects and replays, with backend-side persistence as the safety net

---

## Download & Deployment

Installers are automatically built, signed, and published by GitHub Actions — grab the latest version from [**GitHub Releases**](https://github.com/Stack-Cairn/LiveAgent/releases/latest).

### System Requirements

| Platform | Requirements |
|---|---|
| macOS | Both Intel (x64) and Apple Silicon (aarch64) architectures |
| Windows | x64; requires the WebView2 runtime (bundled with Windows 11) |
| Linux | x86_64; requires WebKitGTK 4.1 (Ubuntu 22.04+ / Debian 12+, etc.) |

### macOS

Download the DMG matching your chip from [Releases](https://github.com/Stack-Cairn/LiveAgent/releases/latest), open it, and drag LiveAgent into Applications:

- Apple Silicon (M-series): `LiveAgent-<version>-macOS-aarch64.dmg`
- Intel: `LiveAgent-<version>-macOS-x64.dmg`

> The installer is signed and notarized by Apple — no manual security override is needed on first launch.

### Windows

Pick an installation method from [Releases](https://github.com/Stack-Cairn/LiveAgent/releases/latest):

| Method | File | Best for |
|---|---|---|
| Setup wizard | `LiveAgent-<version>-Windows-x64-Setup.exe` | Most users |
| MSI package | `LiveAgent-<version>-Windows-x64.msi` | Enterprise distribution / silent install |
| Portable | `LiveAgent-<version>-Windows-x64-portable.zip` | No install — unzip and run |

### Linux

Choose by distribution from [Releases](https://github.com/Stack-Cairn/LiveAgent/releases/latest):

| Format | Distributions | Install |
|---|---|---|
| AppImage | Any distribution | `chmod +x`, then run directly |
| DEB | Debian / Ubuntu family | `sudo dpkg -i LiveAgent-<version>-Linux-x86_64.deb` |
| RPM | Fedora / openSUSE family | `sudo rpm -i LiveAgent-<version>-Linux-x86_64.rpm` |

### Need Remote Access? (Legacy Gateway)

> **⚠️ 计划在 v2.0 停用 / Deprecated in v2.0** —— 下面这套 Gateway 部署方式在
> v2.0 会断。已经部署的用户请先读 [v2.0 迁移指南](#v20-迁移指南--v20-migration-guide)。

In v2.0 there is no Gateway: you deploy the **backend** where you want it, and the desktop app or a browser points straight at it. If the backend sits behind NAT and you are not, that is a networking problem with networking answers — [Tailscale](https://tailscale.com/), [frp](https://github.com/fatedier/frp), or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — not something the app punches through for you.

The instructions below are the v1 Gateway path, kept for users who already run it.

**Note: when deployed behind an Nginx reverse proxy, set the Gateway address on the Settings → Remote page to the HTTPS URL and use port 443.**

```bash
# Pull the image (built by GitHub Actions, multi-arch: amd64 / arm64)
docker pull ghcr.io/stack-cairn/liveagent-gateway:latest

# Run in the background (HTTP/WebSocket → host 3000)
docker run -d \
  --name liveagent-gateway \
  --restart unless-stopped \
  -p 3000:8080 \
  -v liveagent-gateway-data:/var/lib/liveagent \
  -e LIVEAGENT_GATEWAY_TOKEN=your-token \
  ghcr.io/stack-cairn/liveagent-gateway:latest
```

The named volume persists the Gateway database and independently issued Agent tokens across container upgrades.

**One-command upgrade to the latest version** — pull the new image → remove the old container → recreate it with the same arguments (if you changed the port mappings or token, adjust the arguments below accordingly):

```bash
docker pull ghcr.io/stack-cairn/liveagent-gateway:latest \
  && docker rm -f liveagent-gateway \
  && docker run -d \
    --name liveagent-gateway \
    --restart unless-stopped \
    -p 3000:8080 \
    -v liveagent-gateway-data:/var/lib/liveagent \
    -e LIVEAGENT_GATEWAY_TOKEN=your-token \
    ghcr.io/stack-cairn/liveagent-gateway:latest \
  && docker image prune -f
```

<details>
<summary><b>Nginx reverse proxy configuration</b> — reference for custom domains / TLS</summary>

> Since protocol v2, all traffic — the WebUI, the HTTP API, and the WebSocket links of both the browser and the desktop app — goes through the single HTTP port (default 3000).
>
> WebSocket upgrades happen on several paths (`/ws/v2`, `/ws/v2/agent`, `/ws/v2/terminal`, and tunnels under `/t/`), so the simplest correct setup enables the upgrade on the whole vhost:

```nginx
# WebUI SPA/static/API + every WebSocket link (browser and desktop)
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # WebSocket upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Required: the Gateway's same-origin check compares the browser's
    # Origin header against X-Forwarded-Proto + Host
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # The Gateway pings every WebSocket connection every 15s,
    # so a generous-but-finite timeout is enough
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
}
```

> The upstream port maps to the host port from the `docker run` above: HTTP/WebSocket 3000 (inside the container, HTTP actually listens on `PORT=8080`). The server block needs `listen 443 ssl;` and a `client_max_body_size` large enough for attachment uploads (e.g. `100m`).

</details>





### Build from Source

Expand the Development Guide below for the full set of Make commands.

<details>
<summary><b>Architecture Overview</b> — diagram & tech stack</summary>

```
┌──────────────────────────────────────────────────────────────┐
│                    Frontend (one codebase)                    │
│      React 19 · Vite · runs in a browser tab, or inside       │
│         the Tauri 2 desktop shell — same build output         │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTP POST /api/<command>  (JSON)
                             │ WebSocket /api/events     (JSON)
┌────────────────────────────▼─────────────────────────────────┐
│                   Backend · backend                     │
│     Rust · axum · SQLite · password auth · static assets      │
│        The only public listener. Holds the API keys.          │
│            (laptop / home server / Docker / VPS)              │
└────────────────────────────┬─────────────────────────────────┘
                             │ loopback HTTP (never exposed)
┌────────────────────────────▼─────────────────────────────────┐
│                    Engine · core                     │
│                Node 22 · TypeScript · pi-agent-core           │
├──────────┬────────────┬───────────┬────────────┬─────────────┤
│ Models   │ Runtime    │ Tools     │ Skills     │ Memory/Cron │
│ pi-ai    │ multi-turn │ FS/Bash/  │ progressive│ SQLite+MD   │
│          │ + SubAgent │ MCP bridge│ + Hub      │ FTS index   │
└──────────┴────────────┴───────────┴────────────┴─────────────┘
```

The desktop shell is a shell: it renders the frontend and adds native niceties
(tray, notifications, file dialogs). It is not a second implementation — point
the same frontend at a remote backend URL and everything works identically.

**Tech Stack**

| Component | Technology |
|---|---|
| **Frontend** · Framework | React 19 + TypeScript 6 |
| **Frontend** · Build | Vite 8 + pnpm |
| **Frontend** · Styling | Tailwind CSS 4 + Base UI |
| **Frontend** · Rendering | streamdown + KaTeX + Mermaid + Monaco Editor |
| **Desktop shell** | Tauri 2 (optional — the browser is a first-class target) |
| **Backend** · `backend` | Rust + Tokio + axum + SQLite (rusqlite) |
| **Backend** · Protocol | JSON over HTTP + WebSocket |
| **Engine** · `core` | Node 22 + TypeScript |
| **Engine** · LLM | @earendil-works/pi-ai · @earendil-works/pi-agent-core |
| **Deployment** | Docker (backend + Node runtime in one image) · Railway CI/CD |

</details>

<details>
<summary><b>Development Guide</b> — common Make commands (run <code>make help</code> for the full list)</summary>

| Command | Description |
|---|---|
| `make dev` | Start the Tauri development environment |
| `make build` | Build the desktop app |
| `make backend-docker-build` | Build the backend Docker image |
| `make backend-docker-run` | Run the backend image (HTTPS on 8443) |
| `make backend-docker-smoke` | Build + `/healthz` check |
| `make desktop-build-macos-release` | macOS signed release build |
| `make update-routes` | Regenerate the backend route layer from the command wrappers |
| `make check-routes` | Fail if the generated routes have drifted (CI gate) |
| `make clean` | Clean build artifacts |

</details>

<details>
<summary><b>Project Structure</b> — directory tree</summary>

```
LiveAgent/
├── crates/
│   ├── frontend/                # Frontend + desktop shell
│   │   ├── src/                  # React frontend (browser and desktop share it)
│   │   │   ├── components/       #   UI components
│   │   │   ├── lib/              #   Core logic (chat, tools, skills, memory)
│   │   │   ├── pages/            #   Pages (Chat, Settings)
│   │   │   ├── i18n/             #   Internationalization
│   │   │   └── prompt/           #   System prompt templates
│   │   └── src-tauri/            # Tauri 2 desktop shell (Rust)
│   │
│   ├── backend/                  # Rust backend — the only public listener,
│   │   │                         #   plus the shared core (tools, runtime, storage)
│   │   ├── src/server/           #   HTTP command routes and the event WebSocket
│   │   ├── src/engine_process.rs #   Spawns and supervises the Node engine
│   │   └── src/engine_proxy.rs   #   Chat reverse proxy and event backflow
│   │
│   └── core/                     # Node engine — model calls and the agent loop
│       └── src/                  #   TypeScript, bundled with esbuild
│
├── docs/                         # Project docs
│   ├── architecture/             #   Architecture design
│   ├── features/                 #   Feature guides
│   └── operations/               #   Operations & deployment
│
├── scripts/release/              # Release automation
├── .github/workflows/            # CI/CD
├── Dockerfile                    # Backend container image (Rust + Node runtime)
├── Makefile                      # Build commands
└── Cargo.toml                    # Rust workspace
```

</details>

---

## v2.0 迁移指南 / v2.0 Migration Guide

**v2.0 会改掉远程访问的整个架构。已经部署 `ghcr.io/stack-cairn/liveagent-gateway`
的用户一定会断 —— 这是无法避免的破坏性变更,不是 bug。**

### 为什么会断

旧模型:桌面端**主动拨出**连到 Gateway,浏览器再连 Gateway,Gateway 在中间转发。
新模型:后端(Rust + Node)自己就是服务端,**前端直接连后端**。

两边都在等对方来连,技术上对不上,没有兼容层可写。

### 你的选择

| 情况 | 怎么办 |
|---|---|
| 现在跑得好好的,不想动 | **什么都不用做。** 旧镜像 tag 冻结保留、可以继续拉;旧桌面端配旧网关继续可用 |
| 想升到 v2.0 | 按下面的步骤迁移 |

旧镜像会一直留在 registry 里,但**不再收到更新**(包括安全修复)。

### 迁移步骤

1. **把旧版本钉死,不要用 `:latest`。** 升级前先确认旧部署用的是具体 tag:

   ```bash
   docker pull ghcr.io/stack-cairn/liveagent-gateway:v1  # 冻结的旧 tag
   ```

2. **备份 Gateway 数据卷。** 里面有 Agent token 和数据库:

   ```bash
   docker run --rm -v liveagent-gateway-data:/data -v "$PWD":/backup \
     alpine tar czf /backup/liveagent-gateway-backup.tar.gz -C /data .
   ```

3. **在要远程访问的那台机器上部署 v2.0 后端**(替代 Gateway 容器)。
   它同时提供 HTTP API、WebSocket 和前端静态资源,一个端口。

4. **前端只需要两样东西:base URL + 密码。**
   「连到哪个 Gateway」「Agent ID」「自动重连」「心跳间隔」这些设置项在 v2.0
   不存在了 —— 本地和远程的唯一差别就是那个 base URL:

   ```ts
   const backend = createBackendClient({ baseUrl, password });
   ```

   - 桌面版:壳自动注入密码,跳过登录页,双击即用
   - 浏览器:访问后端地址,走登录页输密码

5. **旧 Agent token 不迁移。** v2.0 用密码直接当 Bearer token,旧的 Agent token
   体系没有对应物。部署后端时重新设一个密码即可。

6. **确认无误后再删旧容器:**

   ```bash
   docker rm -f liveagent-gateway
   ```

### 新桌面端连旧网关会怎样

不会静默失败,但目前的提示是**调用时**给的,不是配置时给的:前端仍残留的
`gateway_*` 调用点会被本地拦下并抛出

> v2 不再需要 Gateway:桌面端不再外拨连接它,改为前端直连后端(本机或远程)。
> 迁移步骤见 README 的 v2 迁移指南。

「在设置页检测到旧网关地址就直接提示」还没做。

---

## FAQ

<details>
<summary><b>Where do my API keys live?</b></summary>

Only on the backend — and you decide where the backend runs. The frontend never sees a key: it sends commands, the backend calls the model. If you run the backend on your own laptop the keys never leave the machine; if you deploy it to your own server, they live there and nowhere else. There is no service of ours in the path.

</details>

<details>
<summary><b>Do I have to deploy anything?</b></summary>

Not for local use — the desktop app ships the backend inside it and works out of the box. Deploy the backend separately when you want to reach the same agent from a browser, from another machine, or keep it running while your laptop is closed.

</details>

<details>
<summary><b>Which models are supported?</b></summary>

Claude (Anthropic), Codex (OpenAI), and Gemini protocols are built in, plus custom Base URL support for any compatible third-party service.

</details>

<details>
<summary><b>Will long conversations / disconnects lose context?</b></summary>

No. The backend persists the full history with Segment + Summary Checkpoints, and it keeps running while you are disconnected — the frontend reconnects to the event stream and catches up.

</details>

---

## Contributing

Issues and pull requests are welcome! See the [Development Guide](docs/operations/development.md) for setting up a dev environment.

Before submitting a PR, make sure all of the following checks pass (they match the CI gates):

**Frontend · `crates/frontend`**

1. Type check & build pass: `pnpm build`
2. Lint passes: `pnpm lint`
3. Frontend unit tests pass: `pnpm test:frontend` (also run `pnpm test:release` when touching release scripts)
4. Desktop shell check passes: `cargo check --manifest-path crates/frontend/src-tauri/Cargo.toml --tests` (run from the repo root)

**Backend · `crates/backend` (if changed)**

1. Generated routes are in sync: `make check-routes` (adding a command without a route must fail here)
2. Backend tests pass: `cargo test -p backend`

**Diff hygiene**

- Keep the diff clean (no trailing whitespace): `git diff --check`

---

## 👥 Contributors

Thanks to everyone who has contributed to LiveAgent!

<a href="https://github.com/Stack-Cairn/LiveAgent/graphs/contributors">
  <img src="https://raw.githubusercontent.com/Stack-Cairn/LiveAgent/chart-assets/contributors.svg" alt="Contributors" />
</a>

---

## Star History

<a href="https://www.star-history.com/?repos=Stack-Cairn%2FLiveAgent&type=date&legend=top-left">

 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Stack-Cairn/LiveAgent/chart-assets/star-history-dark.svg" />
   <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Stack-Cairn/LiveAgent/chart-assets/star-history-light.svg" />
   <img alt="Star History Chart" src="https://raw.githubusercontent.com/Stack-Cairn/LiveAgent/chart-assets/star-history-light.svg" />
 </picture>
</a>

---

## License

MIT © StackCairn
