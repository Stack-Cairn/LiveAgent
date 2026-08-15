# LiveAgent Mobile

基于 Tauri 2 + React 的移动端 Agent 客户端，复用 `@liveagent/ui` 与桌面端相同的 UI/协议层，面向 Android 平台。

## 技术栈

- **Tauri 2**：Rust 后端 + Android WebView（`com.xiaofei.liveagent`）
- **React 19 + TypeScript + Vite**：前端，构建产物输出到 `dist/`
- **pnpm workspace**：包名为 `@liveagent/mobile`

## 目录结构

```text
crates/agent-mobile/
├── src/                  # React 前端源码
├── src-tauri/
│   ├── src/              # Rust 后端（lib.rs / main.rs）
│   ├── Cargo.toml        # Rust 依赖（liveagent_mobile）
│   ├── tauri.conf.json   # Tauri 配置（version / identifier / bundle）
│   ├── capabilities/     # 权限声明
│   └── gen/android/      # 生成的 Android 工程（已提交，用于 CI 复现构建）
├── package.json          # @liveagent/mobile 前端脚本与依赖
└── vite.config.ts        # Vite 配置（dev server / 代理）
```

## 前置依赖

| 依赖        | 版本     | 说明                       |
| ----------- | -------- | -------------------------- |
| Node.js     | 22.x     | 前端构建                   |
| pnpm        | 10.x     | workspace 包管理           |
| Rust        | stable   | 后端编译                   |
| JDK         | **17**   | Tauri 2 与 AGP 8.x 要求    |
| Android SDK | API 36   | 项目 `compileSdk = 36`     |
| Android NDK | r26 系列 | 交叉编译 Rust Android 目标 |

## 快速开始（开发）

从仓库根目录安装依赖：

```bash
pnpm install
```

仅前端开发（Vite dev server，代理 `/api`、`/ws`、`/image-proxy` 到本地 Gateway）：

```bash
pnpm --filter @liveagent/mobile dev
```

在 `crates/agent-mobile` 目录下进行 Android 开发/构建：

```bash
# 连接真机或启动模拟器后，编译并安装 debug 包
pnpm tauri android dev

# 前端类型检查 + 构建
pnpm build

# 前端 lint
pnpm lint
```

## Android 构建配置

> 本节参照 [tauri-ble-example](https://github.com/Islatri/tauri-ble-example/blob/main/README.md) 的安卓构建配置整理。首次构建前请按顺序完成以下步骤。

### 1. JDK

安装 JDK 17（Oracle / OpenJDK / `choco install openjdk` 均可），并确认：

```bash
java -version
```

### 2. Android SDK

安装 [Android Studio](https://developer.android.com/studio) 或独立的命令行工具，然后在 SDK Manager 中安装 **API 36** 平台与 **NDK（Side by side，r26 系列）**。

设置两个环境变量（Windows PowerShell 示例）：

```powershell
$env:ANDROID_SDK_ROOT = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_HOME      = "$env:LOCALAPPDATA\Android\Sdk"
```

设置后刷新当前会话的环境变量，并确认：

```powershell
$env:ANDROID_SDK_ROOT
```

Linux / macOS 建议把这两项写入 shell 配置（`~/.bashrc` / `~/.zshrc`），指向 Android SDK 安装目录。

### 3. Rust Android 目标

安装交叉编译所需的 Rust target：

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
```

验证：

```bash
rustup target list | grep installed
```

### 4. 生成签名 keystore

> [!CAUTION]
> 签名密钥非常重要，请妥善保管：一旦丢失或被窃取，只能生成新密钥，且**无法**对已发布的 App 做原地更新签名。

用 `keytool` 生成 keystore（`-alias` 推荐使用 `upload`，与 CI 约定保持一致）：

```bash
keytool -genkey -v -keystore liveagent-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

### 5. 配置 local.properties

在 `src-tauri/gen/android/local.properties` 写入签名信息（该文件已被 `.gitignore` 忽略，不要提交）：

```properties
storePassword=你的 keystore 密码
keyPassword=你的 key 密码
keyAlias=upload
storeFile=你的 .jks 绝对路径
```

> `keyAlias` 必须与生成 keystore 时使用的 `-alias` 一致。

### 6. 构建

```bash
pnpm tauri android build
```

默认会为全部 ABI 构建 universal APK 与 AAB，产物位于：

- APK：`src-tauri/gen/android/app/build/outputs/apk/universal/release/`
- AAB：`src-tauri/gen/android/app/build/outputs/bundle/universalRelease/`

## 签名与密钥安全

- **不要提交** `src-tauri/gen/android/local.properties`、`*.jks` / `*.keystore` 到 Git（已被 `.gitignore` 覆盖）。
- **不要**在代码或 CI 日志中明文暴露签名密码。
- 建议用环境变量 / CI Secret 注入签名，而不是把密码写死在文件里。
- `local.properties` 只在本机构建使用；CI 构建时由 workflow 从 GitHub Secrets 动态生成。

## CI/CD

- **Check**：`ci.yml` 中的 `mobile` job 对前端做类型检查、构建与 lint；`mobile-rust` job 对 `src-tauri` 做 `cargo check --tests`。
- **Release**：`mobile-release.yml` 中的 `android` job 在 `v*` tag / 手动触发时，从 tag 解析版本号、解码签名 keystore、构建并签名 APK 与 AAB，再发布到 GitHub Release。

发布版本号以 Git tag 为事实来源（例如 `v0.1.3` → Android `versionName=0.1.3`，`versionCode` 由 `major*1000000 + minor*1000 + patch` 自动推导），无需手动改 `tauri.conf.json`。

## GitHub Secrets 配置

Android release 需要以下 Secrets（在 GitHub 仓库 `Settings → Secrets and variables → Actions → New repository secret` 中配置）：

| Secret                      | 说明                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | 签名 `.jks` 文件的 base64 编码（`base64 -w0 liveagent-release.jks`）。 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore（store）密码。                                                |
| `ANDROID_KEY_PASSWORD`      | key 密码。                                                             |
| `ANDROID_KEY_ALIAS`         | key 别名，推荐 `upload`（须与生成 keystore 时一致）。                  |

生成 `ANDROID_KEYSTORE_BASE64`：

```bash
base64 -w0 liveagent-release.jks
# 或 macOS：base64 -i liveagent-release.jks | tr -d '\n'
```

配置完成后，推一个 `vX.Y.Z` tag 或手动触发 `mobile-release.yml`，即可在 Release 产物中看到 `LiveAgent-vX.Y.Z-Android.apk` 与 `LiveAgent-vX.Y.Z-Android.aab`。
