# 提示词、Loop、文件资源与外部服务续测

后续文件写入、项目提示词、真实 SSH/隧道及验收边界见 [完整验收记录](2026-10-24-full-acceptance.md)；下文保留本轮当时的只读阶段结果。

## 分支与边界

前一轮修复已推送：LA `audit/full-capability-alignment`（`d4aefae6`），KB `audit/memory-organizer-client`（`d239940`）。本轮继续在这两个分支提交，没有合并主分支或创建 release。

所有测试使用 `/tmp/la-full-audit` 的隔离数据，不导入真实用户会话或读取用户服务密钥。页面通过 Chrome 的真实 WebSocket → Gateway → KB HTTP 接口测试；模型回复使用本地流式服务，不代表外部模型质量测试。

## 本轮修复

- Gateway 直连 KB 的 `/v1/commands`，不再依赖桌面在线；保留项目提示词信任判断在 KB。直连目标过滤尚未支持的 `/goal`，不恢复已经退役的 prompt-template RPC。
- Gateway 直连 KB 的会话 Loop 创建、查询、取消；支持前端实际发送的 interval-only 创建。复用已有会话映射，不为资源请求创建新会话；写请求失败不自动重放。
- Web 设置的全局提示词模板读取与保存接入 KB `/v1/prompts`、`/v1/prompts/templates`；空数组可清除模板，格式错误与后端失败不会返回保存成功。
- KB 新增认证后的 `/v1/fs`，目前支持根目录、子目录、文件树和 UTF-8 文本读取；Gateway 只投影已知类型，不执行模型工具。
- 文件范围由后端 `-filesystem-root` 决定，可重复指定，默认仅后端工作目录。浏览器不能仅通过指定 workdir 扩大范围。使用 `os.Root` 限制路径及符号链接逃逸，文本最大 2 MiB，列表支持分页和深度限制。

```sh
kn backend -listen 127.0.0.1:47321 -token '<token>' \
  -filesystem-root /path/to/projects \
  -filesystem-root /another/authorized/root
```

根目录之外的旧工作空间会显示配置范围错误，需由后端启动者增加对应根目录。当前只读文件资源不应描述为完整文件编辑迁移。

## 实测结果

| 项目 | 证据与结果 |
| --- | --- |
| 全局模板 | Web 1440/390 宽度创建模板，检查 KB 持久化并重载页面确认存在；额外验证启用、编辑、停用写回；通过 |
| Loop | Web 两档创建真实会话后输入 `/loop 10m …`，出现任务 ID；经实际 WebSocket 查询、取消并确认后端删除；通过 |
| 文件资源 | Web 两档通过实际 WebSocket 读取 roots、目录、文件列表、文本；通过。目录选择器两档添加后端文件夹为工作空间；实际打开隔离工作空间的文件树并列出 `config.json` 等文件；通过。未验收编辑保存 |
| 文件路径隔离 | KB 测试拒绝目录穿越、工作空间外符号链接、未配置根目录、二进制、过大深度和不支持的写操作；认证测试通过 |
| 原生桌面基础回归 | macOS debug 实际调用带版本校验的文件写入、文件列表、Git 状态及终端输入/输出/调整尺寸/重命名/关闭；通过 |
| 真实 Google 公共订阅 | 实际请求 Google 公共假日日历 ICS；后端订阅 `lastSyncedAt` 非空、`lastError=null`，保存 30 个事件；通过。不是私人 Google 账号、CalDAV 或双向同步验收 |
| 图像工作台 | 配置独立 image backend 后，Web 两档 identity、capabilities、历史列表页面可用，正确提示没有已验证模型；未执行真实生成 |
| macOS 系统通知 | 实际调用 `planning_notification_test`，debug 裸二进制返回需要 `.app` bundle；未验证真实通知横幅，不计通过 |
| SSH/SFTP | 源码确认执行仍在原生端，KB canonical terminal 仅接受运行绑定的本地终端，不承载 SSH 凭据；尚未迁移 |
| 隧道 | Gateway HTTP/SSE/WebSocket 隧道测试通过，但执行端使用模拟 agent；不代表真实 KB 隧道接管 |
| 语音 | Gateway STT 自动测试通过；真实供应商测试需显式提供配置库，默认跳过。没有使用用户密钥或实际麦克风录音验收 |

## 自动验证

- Gateway：全量 `go test -p 1 ./...`、`go vet ./...`；kbrain/websocket race 通过。
- KB：全量 `go test ./...`、`go vet ./...`；backend/planning race 通过；最终文件文本行数调整后再次执行 filesystem 定向测试与 vet。
- Web：818/818 测试通过，类型检查通过，生产构建通过。
- LA lint 通过，保留已有 1 warning、1 info；生产构建保留已有动态导入提示。

## 仍需完成

1. 项目提示词、`brain.md` / `AGENTS.md` / `CLAUDE.md` 文件管理的 Web 端完整保存链路；本轮仅完成全局模板和指令目录。
2. KB 文件创建、编辑、重命名、删除、图片读取、文件引用及 ignore 规则对齐；编辑需保留预期版本校验，不能以无条件覆盖代替。
3. SSH 主机密钥校验、交互认证、SFTP、连接生命周期迁入 KB，再对齐 Web 权限和秘密配置；不放宽现有门控。
4. KB 隧道资源管理与数据面接入，以及真实本地 HTTP/SSE/WebSocket 服务穿透验收。
5. 私有 Google/iCloud/Exchange 订阅、账号权限及双向同步。当前实现是 ICS 只读订阅，不是这三类账号的原生双向同步。
6. 从已签名/有 bundle 的桌面应用验证通知权限、后台提醒和实际系统横幅。
7. 使用明确提供的测试模型/图像/语音配置进行真实生成、录音、识别和错误恢复测试；STT 当前仍由 Gateway 执行，并非已统一迁入 KB。

临时日志和截图位于 `/tmp/la-full-audit/next-*`，不提交原始请求日志、连接配置或测试密钥。
