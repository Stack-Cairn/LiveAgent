# 多 Agent 与凭证管理

网关支持多台桌面 Agent 同时在线（个人多设备到上百台规模），浏览器可分别
控制任意一台。本文是部署与凭证运维手册；协议细节见
[protocols.md](../architecture/protocols.md)。

## 部署清单

1. 每个桌面端首次初始化设置时都会生成全局唯一且稳定的 `agent-UUIDv4`，可在
   “设置 → Remote → Agent ID”中查看和复制。该标识由客户端管理，用户不能修改；
   不同客户端独立生成，不依赖 hostname。
2. 网关默认自动创建每 Agent 凭证存储。凭证存于内嵌 SQLite 数据库
   （纯 Go 驱动，无需额外安装任何东西）；需要固定位置时可指定数据库路径：

   ```bash
   liveagent-gateway \
     -token "<网关 Token，浏览器与 REST 使用>" \
     -agent-db /var/lib/liveagent/agents.db
   ```

   等价环境变量：`LIVEAGENT_GATEWAY_AGENT_DB`。**容器部署必须在
   `/var/lib/liveagent` 挂载持久卷**，否则重启丢凭证。

   不指定 `-agent-db` 时，数据库默认创建在
   `LIVEAGENT_GATEWAY_DATA_DIR/gateway.db`，或用户配置目录下的
   `liveagent/gateway.db`。Agent 链路同时接受网关 Token 和按 `agent_id` 签发的
   独立凭证；无论使用哪种凭证，Agent 都必须携带稳定的 `agent_id`。

3. 桌面端可直接将网关 Token 填入“访问令牌”并连接。若改用独立凭证，先复制
   桌面端自动生成的 Agent ID，在 WebUI“设置 → 多客户端管理”中粘贴该 ID，
   可选填写客户端名称并签发，再把响应中的 `agt_...` 填回该桌面端的“访问令牌”。
4. WebUI 首次连接会从 `agent_list` 自动选择一个在线 Agent；多 Agent 场景可在
   顶栏选择器切换，后续所有目标型请求都会携带明确 `agent_id`。

## 并发连接上限

三条 v2 链路的并发连接上限可配置（超限的连接在升级前收到 503）：

| flag | 环境变量 | 默认 |
|---|---|---|
| `-max-agent-connections` | `LIVEAGENT_GATEWAY_MAX_AGENT_CONNECTIONS` | 256 |
| `-max-browser-connections` | `LIVEAGENT_GATEWAY_MAX_BROWSER_CONNECTIONS` | 128 |
| `-max-terminal-connections` | `LIVEAGENT_GATEWAY_MAX_TERMINAL_CONNECTIONS` | 512 |

## 凭证运维

有两种方式管理 Agent 凭证：**管理界面**（推荐）或 **curl**。

### 管理界面

登录 WebUI 后进入“设置 → 多客户端管理”即可分页浏览所有已登记 Agent，使用
网关 Token 或独立凭证成功连接都会自动登记。页面支持按全部、在线或离线筛选，
以及签发/轮换独立凭证、编辑或清空可选名称、删除客户端。轮换会立即断开当前客户端，
旧凭证不能重连；独立 Token 可持续用于
该客户端连接，但明文只在签发/轮换响应中展示一次；删除会移除整条记录、凭证并
断开当前连接。使用共享网关 Token 的客户端之后再次连接时会按其 Agent ID 重新登记。
页面直接复用当前登录的网关 Token；
`/admin/devices` 仅作为可直接访问的备用入口。

### curl

管理 API 使用网关 Token 鉴权；`$GW` 为网关地址，`$TOKEN` 为网关 Token。

```bash
# Agent 目录分页（默认每页 50，上限 200）
curl -sS -H "Authorization: Bearer $TOKEN" "$GW/api/agents?page=1&page_size=50"

# 仅查看在线 Agent；status 还可取 all 或 offline
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$GW/api/agents?status=online&page=1&page_size=50"

# 签发/轮换：name 可省略或为空；轮换会立即断开当前会话，明文只在本次响应展示
# 新 Token 可持续用于客户端连接
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"家里的台式机"}' \
  "$GW/api/agents/agent-550e8400-e29b-41d4-a716-446655440000/token"

# 修改名称；传空字符串可清空名称
curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"办公室电脑"}' \
  "$GW/api/agents/agent-550e8400-e29b-41d4-a716-446655440000"

# 删除整条客户端记录、凭证，并立即断开活跃会话
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$GW/api/agents/agent-550e8400-e29b-41d4-a716-446655440000"
```

数据库仅含凭证的 SHA-256 哈希（文件 0600 权限），明文不落盘；网关重启后
凭证与客户端名称均保持。

数据库首版只使用 `agents` 单表保存 Agent ID、可选名称、创建时间和独立凭证哈希。
凭证校验、名称修改和删除使用 `agent_id` 主键索引；目录分页的
`ORDER BY created_at, agent_id` 使用 `(created_at, agent_id)` 组合索引。
目录 API `GET /api/agents` 在数据库内完成状态筛选、计数和分页（每页默认 50、
上限 200）；Go 层只传入在线 ID 快照并合并当前页实时状态，不读取全量目录分页。

## 安全模型（角色-凭证绑定矩阵）

| 凭证 | 浏览器链路 /ws/v2 | Agent 链路 /ws/v2/agent | 管理 REST /api/* |
|---|---|---|---|
| 网关 Token | ✅ | ✅ | ✅ |
| Agent 凭证（agt_*） | ❌ | 仅限签发时绑定的 agent_id ✅ | ❌ |

- 单个 Agent 凭证泄露的最大损害 = 冒充/顶替**该一台** Agent；无法控制其他
  Agent、无法冒充浏览器（控制端）、无法调用管理 API。
- 未知 agent_id 与错误凭证统一报 "unauthorized"（常量时间比较，防枚举）。
- 跨 Agent 隔离由网关按已认证会话身份强制：事件打标、快照分仓、隧道帧
  stream_id 归属校验，Agent 无法伪造他人身份的数据。
