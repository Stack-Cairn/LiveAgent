// 网关管理平面 REST 客户端：Agent 目录、名称与独立凭证管理。
// 与聊天/控制平面（gatewaySocket）分离——管理操作是 REST + 网关 Token（Bearer），
// 参照 uploadReadableFiles.ts / gatewayAuth.ts 的既有范式。
import { normalizeGatewayAccessToken } from "@/lib/gatewayAuth";

// AdminAgentEntry 是目录条目（对应 Go agentDirectoryEntry 的 JSON 形状）。
export type AdminAgentEntry = {
  agent_id: string;
  online: boolean;
  has_token: boolean;
  registered_at: string;
  token_created_at?: string;
  name: string;
  agent_version?: string;
  connected_since?: number;
};

// AdminAgentsPage 是数据库分页的一页 Agent 目录及实时状态。
export type AdminAgentsPage = {
  agents: AdminAgentEntry[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
};

export type AdminAgentStatus = "all" | "online" | "offline";

const GENERATED_AGENT_ID_PATTERN =
  /^agent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isGeneratedAgentID(value: string): boolean {
  return GENERATED_AGENT_ID_PATTERN.test(value.trim());
}

async function readError(response: Response, fallback: string): Promise<string> {
  const raw = (await response.text()).trim();
  if (!raw) {
    return fallback;
  }
  try {
    const payload = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const text =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : "";
    return text.trim() || raw;
  } catch {
    return raw;
  }
}

function authHeaders(token: string): HeadersInit {
  const normalized = normalizeGatewayAccessToken(token);
  if (!normalized) {
    throw new Error("请输入管理 Token。");
  }
  return { Authorization: `Bearer ${normalized}` };
}

export async function listAdminAgents(
  token: string,
  page: number,
  pageSize: number,
  status: AdminAgentStatus = "all",
): Promise<AdminAgentsPage> {
  const url = new URL(`${window.location.origin}/api/agents`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(pageSize));
  url.searchParams.set("status", status);
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(await readError(response, "加载 Agent 目录失败。"));
  }
  return (await response.json()) as AdminAgentsPage;
}

// issueAdminToken 签发/轮换凭证并让当前 Agent 会话立即下线；明文只在本次响应返回，调用方须立即展示且不可再取。
export async function issueAdminToken(
  token: string,
  agentId: string,
  name: string,
): Promise<string> {
  const url = `${window.location.origin}/api/agents/${encodeURIComponent(agentId)}/token`;
  const response = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, "签发凭证失败。"));
  }
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) {
    throw new Error("签发响应缺少凭证明文。");
  }
  return payload.token;
}

export async function updateAdminAgentName(
  token: string,
  agentId: string,
  name: string,
): Promise<void> {
  const url = `${window.location.origin}/api/agents/${encodeURIComponent(agentId)}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, "修改客户端名称失败。"));
  }
}

export async function deleteAdminAgent(token: string, agentId: string): Promise<void> {
  const url = `${window.location.origin}/api/agents/${encodeURIComponent(agentId)}`;
  const response = await fetch(url, { method: "DELETE", headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(await readError(response, "删除客户端失败。"));
  }
}
