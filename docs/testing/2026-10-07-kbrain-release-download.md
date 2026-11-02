# LiveAgent 使用 K-brain Release 二进制

## 原因

PR #924 的 GUI CI 在 `prompts-backend.test.mjs` 中执行 `go build ./cmd/kn`，
达到 60 秒超时。多个前端测试分别编译后端，桌面发布也重复编译同一后端。

## 实现

- K-brain 在自己的仓库构建并发布 `v0.107.6-beta.1`，源码提交为
  `629b58fba876641e59c77c73f25058efb2bd1586`。
- LA 的 `scripts/release/kbrain.lock.json` 固定上述提交、Release URL 及四个
  桌面目标平台的 backend/computer 两个资产的 SHA256。
- GUI CI 不再检出 K-brain 源码或安装 Go，先下载校验二进制再运行原有测试。
- 提示词、时区和调用轨迹的真实后端测试使用同一个 Release；下载失败直接失败，
  不因缺少源码而跳过，也不回退到源码编译。
- macOS、Windows、Linux 打包任务直接下载相同的锁定资产，删除 LA 中间编译任务。
- Release/CI 忽略本地旧源码产物记录，禁止本地二进制覆盖。
- 下载缓存按 SHA256 寻址，每次使用重新校验；并行测试使用独立的可执行文件目录。
- K-brain beta 标签明确标记为 prerelease，不改变 stable Latest。

## 验证

- K-brain 构建工作流成功：
  https://github.com/Stack-Cairn/K-brain/actions/runs/37624277518
  首次 Linux 桌面集成测试未发现 GTK fixture，重跑失败任务后成功。
- Release 包含六个平台的十二个二进制和 `SHA256SUMS`。
- 发布脚本测试 28 项通过，包含下载校验、缓存复用、校验失败拒绝、旧产物隔离、
  GUI/桌面工作流不再编译后端的约束检查；源码构建脚本测试使用模拟执行器，不调用 Go。
- macOS ARM64 两个 Release 二进制下载及 SHA256 校验成功。
- 使用下载后的真实后端，提示词、时区、工具和子代理调用轨迹测试共 9 项通过，
  没有因缺少源码而跳过测试。
- 前端完整测试共 3000 项，2999 项通过、1 项跳过、0 项失败。

## 更新后端版本

1. 在 K-brain 仓库发布新版本，等待 Release 资产和 `SHA256SUMS` 完整可用。
2. 更新 LA lock 中的 `releaseTag`、`sourceRevision` 和各平台下载 URL/SHA256。
3. 运行 `node scripts/release/prepare-kbrain.mjs --release` 校验当前平台下载。

禁止使用浮动 `latest` URL。显式本地源码构建脚本保留供开发调试，既不是 CI 路径，
也不是桌面发布或测试缺失资产时的回退路径。

本次未发布新的 LiveAgent 安装包，未包含 K-brain 工作区尚未完成的缓存优化。
