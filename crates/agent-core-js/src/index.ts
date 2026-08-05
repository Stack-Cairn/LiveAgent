// Node 引擎入口:loopback HTTP 服务,只被 Rust(agent-backend)反向代理访问。
// 业务在 engine.ts;这里只做认证、路由、JSON 编解码。

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  abortConversation,
  acceptChatSend,
  type ChatSendRequest,
  getConversationLiveSnapshot,
} from "./engine";

const nodePort = process.env.LIVEAGENT_NODE_PORT;
const backendPort = process.env.LIVEAGENT_BACKEND_PORT;
const internalToken = process.env.LIVEAGENT_INTERNAL_TOKEN;

// 校验所有必需的环境变量
if (!nodePort) {
  console.error("Missing required environment variable: LIVEAGENT_NODE_PORT");
  process.exit(1);
}

if (!backendPort) {
  console.error("Missing required environment variable: LIVEAGENT_BACKEND_PORT");
  process.exit(1);
}

if (!internalToken) {
  console.error("Missing required environment variable: LIVEAGENT_INTERNAL_TOKEN");
  process.exit(1);
}

/// 校验请求的 Authorization header。
function verifyAuth(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  return authHeader === `Bearer ${internalToken}`;
}

/// 解析请求体。
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf-8");
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("Invalid JSON in request body");
  }
}

function respondJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/// 主 HTTP 服务器。
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // 健康检查端点，不需要验证 token
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // 校验认证
  if (!verifyAuth(req.headers.authorization)) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Unauthorized");
    return;
  }

  try {
    const body = req.method === "POST" ? await readBody(req) : undefined;

    if (req.method === "POST" && req.url === "/chat_send") {
      // 受理即回 202(决策 2):增量与终态全走 WS 广播,不在这个响应里。
      const result = acceptChatSend(body as ChatSendRequest);
      respondJson(res, 202, { ok: result });
    } else if (req.method === "POST" && req.url === "/chat_abort") {
      const { conversationId } = (body ?? {}) as { conversationId?: string };
      if (!conversationId) {
        respondJson(res, 400, { error: "conversationId required" });
        return;
      }
      respondJson(res, 200, { ok: { aborted: abortConversation(conversationId) } });
    } else if (req.method === "GET" && req.url?.startsWith("/conversation_live")) {
      const url = new URL(req.url, `http://127.0.0.1:${nodePort}`);
      const conversationId = url.searchParams.get("conversationId");
      if (!conversationId) {
        respondJson(res, 400, { error: "conversationId required" });
        return;
      }
      const snapshot = getConversationLiveSnapshot(conversationId);
      if (!snapshot) {
        // 引擎内存里没有 ≠ 会话不存在:可能只是本进程还没跑过它的 turn。
        // 前端应把 404 当作「无 live 增量」,基线走历史接口。
        respondJson(res, 404, { error: "no live session for conversation" });
        return;
      }
      respondJson(res, 200, { ok: snapshot });
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  } catch (error) {
    console.error("Request handling error:", error);
    respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(parseInt(nodePort), "127.0.0.1", () => {
  console.log(`Node engine listening on 127.0.0.1:${nodePort}`);
});

// 优雅关闭
process.on("SIGTERM", () => {
  server.close(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  server.close(() => {
    process.exit(0);
  });
});
