# STT MVP 验收说明

本文记录当前语音转文字（STT）MVP 的运行边界、凭据处理方式和可复现验收方法。它描述的是自动化验证与手工验收范围，不代表所有平台或所有云厂商已经完成真实语音联调。

## 运行架构

桌面端和 WebUI 使用相同的 PCM 规范、设置字段和 Composer transient 文本契约。桌面 WebView 通过 Tauri IPC 把音频交给 Rust `SttManager`，Rust 直接连接供应商；WebUI 浏览器通过 Gateway 的 `/ws/v2/stt` Protobuf 数据面连接 Gateway 内的 Go `SttManager`。WebUI 不要求桌面 Agent 持续在线，也不经 `/ws/v2/agent` 或 `/ws/v2/terminal` 转发音频。

桌面端保存的 STT 配置会在连接或修改后同步到 Gateway；WebUI 中的修改也会经认证设置通道回写桌面端。公开设置快照只携带非敏感参数和 `configured` 标记，云厂商凭据使用一次性私密 sidecar 在桌面端与 Gateway 后端之间同步，并在任何 Web 广播前删除。浏览器只在用户输入时短暂接触明文，密钥不会进入 localStorage、普通设置快照、广播、日志或错误响应。Gateway 重启后可从自身存储恢复脱敏状态和 Web STT 运行时，因此不需要先打开设置页，也不要求桌面 Agent 当时在线。空白密钥更新保留旧值，带 `clearSecrets` 的明确更新会同时清空桌面端和 Gateway。

## 数据面与音频契约

`/ws/v2/stt` 是独立的 Protobuf 二进制数据面：首帧为 hello/token，随后是 `start`、`audio`、`stop` 或 `cancel` oneof。单连接只允许一个活动 session；PCM 必须是非空、偶数字节、最大 6400 字节的 16 kHz 单声道 signed 16-bit little-endian 数据。序号必须从零开始连续递增。连接关闭会取消对应云端 session，ready、partial、final、error、closed 事件均携带 session ID。

共享采集器按约 100 ms（1600 个采样）分块，连接建立前缓存最多 10 秒 PCM；ready 后先按序排空 FIFO，再发送实时块。停止采集后追加 400 ms（6400 个零采样）尾音，再发送供应商结束协议。Composer 在当前 selection 建立 transient marker，partial 只更新该区间，final 固化并把光标放到区间之后；失败清理 marker，可选择保留最后 partial。

## 供应商配置与协议隔离

支持的 provider 及必填字段如下：

| Provider | 必填字段 | 协议边界 |
| --- | --- | --- |
| 腾讯云 | App ID、Secret ID、Secret Key、Engine Model Type | URL 查询参数 HMAC-SHA1 签名；按 `index` 合并结果并等待 `end` |
| 火山引擎实时语音识别 | App ID、Access Token、Resource ID | v3 端点、请求头和二进制帧 |
| 阿里云 DashScope | API Key | WebSocket `Authorization: Bearer`；`task-started` 后 ready，`finish-task` 必须得到 `task-finished` |
| 百度实时识别 | 数字 App ID、API Key/AppKey、数字 `dev_pid` | 嵌套 `START` JSON；`MID_TEXT`/`FIN_TEXT`；发送 `FINISH` 后正常关闭可完成；`3301/-3005` 表示无语音 |

配置页面可同时保存多家 provider，但一次只选择一个当前 provider。当前 MVP 不包含自动故障转移、TTS、录音保存、翻译、热词或动态模型切换。

## 权限与平台边界

macOS 包含 `NSMicrophoneUsageDescription` 和 `com.apple.security.device.audio-input`，原生 AVFoundation 权限获得允许后才开始 WebView 采集。拒绝、受限和无设备分别返回稳定错误；Windows WebView2、Linux WebKitGTK/GStreamer 缺少媒体能力时仅禁用 STT，不影响键盘聊天。页面卸载、窗口隐藏、设备断开、连接失败和停止路径都会释放 MediaStream、AudioContext、计时器及连接 session。

## 自动化验收命令

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
go test ./...
pnpm test:gui
pnpm test:webui
pnpm lint:ui
pnpm lint:gui
pnpm lint:webui
STT_TARGET_DIR=$(mktemp -d /tmp/liveagent-cargo.XXXXXX)
CARGO_TARGET_DIR="$STT_TARGET_DIR" cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests
CARGO_TARGET_DIR="$STT_TARGET_DIR" cargo test --manifest-path crates/agent-gui/src-tauri/Cargo.toml
pnpm build:gui
pnpm build:webui
```

协议生成还应在不含 AppleDouble 元数据的临时 Buf 副本中执行 `buf lint`、`buf breaking` 和 `buf generate`，再与工作区生成文件比较。仓库内的 `._*` 文件属于环境污染，不删除、不修改、不加入提交。

## 手工与未覆盖项目

没有 provider 凭据时，真实云连接测试不执行，也不会在仓库中写入假凭据。提供合法测试凭据后，应逐家验证连接测试分类、ready/partial/final/closed、慢连接首句 FIFO、手动/静音/无语音停止、复杂 Composer 光标位置以及清空凭据后的不可用状态；测试结束删除临时配置，不保存原始音频。

跨平台真实麦克风设备、系统权限对话框、WebView2、WebKitGTK 和五家云厂商的线上协议兼容性仍属于手工验收项。自动化 fixture 不等同于“已支持所有平台真实语音”。
