# 2026-10-06 真实 MCP 与缓存命中联合验收

## 实测环境

- macOS `LiveAgent Acceptance.app`，LA `v2-kbrian` 基线 `7242b8e0`，KB `b1e0747`；独立验收配置 `/tmp/la-desktop/home/config.json`。
- 桌面端 Agent 模式，供应商已配置的 `gpt-6-luna`，真实外部模型请求，无模拟模型响应。
- 通过桌面 MCP Hub 添加 `acceptance-fs`，实际运行官方 npm 包 `@modelcontextprotocol/server-filesystem@2026.8.31`。14个工具发现成功；本轮实际调用2种工具。
- stdio 转发记录器只记录并转发 JSON-RPC，不生成或替换工具结果。文件服务仅允许 `/private/tmp/la-mcp-cache-acceptance/files`，测试不读取私人文件。

## 桌面端三轮测试

1. 在测试目录生成随机 nonce，不把值写入提示词。桌面发送消息要求 MCP `read_text_file` 读取文件，实际工具结果和模型回复均与磁盘值一致。
2. 在桌面外更新同一文件为另一随机 nonce，再发消息要求重新读取。实际再次发生 MCP 调用，模型返回新值；同时此轮两次模型请求均报告缓存命中。因此命中的是模型输入缓存，不是旧工具结果复用。
3. 要求 MCP `write_file` 写入 `MCP_WRITE_OK_1006`，再调用 `read_text_file` 读回。协议记录、KB历史中的工具调用、工具结果、磁盘文件及最终回复一致。

实际共4次 MCP调用：read_text_file、read_text_file、write_file、read_text_file。没有使用内置 Read/Bash 冒充 MCP。

## 缓存数据

以下为KB持久化的供应商 usage，单位为 tokens。没有根据响应速度推测命中。

| 模型请求 | 输入 | 缓存读取 | 输出 | 命中率 |
| --- | ---: | ---: | ---: | ---: |
| 第一轮工具调用 | 10,379 | 0 | 40 | 0% |
| 第一轮最终回复 | 10,465 | 9,728 | 23 | 92.96% |
| 第二轮工具调用 | 10,556 | 9,728 | 40 | 92.16% |
| 第二轮最终回复 | 10,639 | 9,728 | 20 | 91.44% |
| 第三轮写文件 | 10,735 | 9,728 | 48 | 90.62% |
| 第三轮读文件 | 10,818 | 0 | 39 | 0% |
| 第三轮最终回复 | 10,884 | 9,728 | 11 | 89.38% |
| 合计 | **74,476** | **48,640** | **221** | **65.31%** |

- 7次请求中5次报告命中。命中率不是“命中请求数/请求数”，而是缓存读取 tokens / 输入 tokens。
- 桌面累计显示“↑7.4万 · ↓221 · 命中65%”，和持久化计数四舍五入一致；离开会话后重开仍保持该值和工具回复。
- 第6次请求缓存读取为0，不能声称连续请求必定命中。未获取供应商内部路由/缓存日志，无法确认该次未命中的内部原因。
- 这是当前供应商报告的输入缓存用量，不证明官方模型身份、计费折扣或所有供应商都有相同缓存行为。

## 收尾与边界

- 测试完成后通过桌面禁用 `acceptance-fs`，后端读回 `enabled:false/status:disabled`。配置保留供复测；默认模型仍为 `gpt-6-luna`。
- 会话标题 `MCP文件读取验收nonce校验`，后端会话 ID `f193adef`。
- 本次没有发现这两条路径需要代码修复，没有更改KB、发布标签或beta附件。
- 本次覆盖官方本地stdio MCP的发现、读写、模型工具循环及缓存用量；不代表远程HTTP MCP、OAuth、断链恢复或其余12种工具已验收。

## 证据

- 原始测试目录：`/private/tmp/la-mcp-cache-acceptance/`。
- `mcp-wire.jsonl`：真实双向JSON-RPC；`session-evidence.json`：KB历史、工具调用与usage；`verification.json`：计数及命中率；`expected.json`：两个随机校验值。
- 断言已验证两个不同nonce、4次MCP调用、写入文件内容和最终回复，以及历史重开的65%统计。
- 桌面截图：`mcp-configured.png`、`mcp-first.png`、`mcp-second.png`、`mcp-write-read.png`、`mcp-cache-reopened.png`，位于 `/private/tmp/all-features/desktop/`。
- 报告、截图和记录同步到 `/Users/a/Desktop/2026-10-06-v2-kbrian-backend-compat-audit/real-mcp-cache/`。
