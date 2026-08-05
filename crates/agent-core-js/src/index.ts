import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { callBackend } from "./backendClient";
import { createLiveTranscriptStore, type LiveTranscriptStore } from "./chat/conversation/liveTranscriptStore";

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

/// 维护每个 conversation 的 live transcript store。
const transcriptStores = new Map<string, LiveTranscriptStore>();

/// 获取或创建 transcript store。
function getOrCreateTranscriptStore(conversationId: string): LiveTranscriptStore {
  if (!transcriptStores.has(conversationId)) {
    transcriptStores.set(conversationId, createLiveTranscriptStore());
  }
  return transcriptStores.get(conversationId)!;
}

/// 校验请求的 Authorization header。
function verifyAuth(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  const expectedAuth = `Bearer ${internalToken}`;
  return authHeader === expectedAuth;
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

/// 处理 POST /chat_send 请求。
async function handleChatSend(
  req: IncomingMessage,
  res: ServerResponse,
  _body: unknown
): Promise<void> {
  // 暂时返回 202 Accepted
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: { status: "accepted" } }));

  // TODO: 实际实现：
  // 1. 解析请求参数
  // 2. 调用 runAgentConversationTurn 或 runTextConversationTurn
  // 3. 将增量事件广播给 Rust 侧
}

/// 处理 POST /chat_abort 请求。
async function handleChatAbort(
  _req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  try {
    const { conversationId } = body as { conversationId?: string };
    if (!conversationId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "conversationId required" }));
      return;
    }

    // TODO: 实际实现：中止进行中的 turn
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: { aborted: true } }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  }
}

/// 处理 GET /conversation_live 请求。
async function handleConversationLive(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const conversationId = url.searchParams.get("conversationId");

    if (!conversationId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "conversationId required" }));
      return;
    }

    const store = getOrCreateTranscriptStore(conversationId);
    const state = store.getSnapshot();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: state }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  }
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
  const authHeader = req.headers.authorization;
  if (!verifyAuth(authHeader)) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Unauthorized");
    return;
  }

  try {
    // 解析请求体（POST 请求）
    const body = req.method === "POST" ? await readBody(req) : undefined;

    // 路由请求
    if (req.method === "POST" && req.url === "/chat_send") {
      await handleChatSend(req, res, body);
    } else if (req.method === "POST" && req.url === "/chat_abort") {
      await handleChatAbort(req, res, body);
    } else if (req.method === "GET" && req.url?.startsWith("/conversation_live")) {
      await handleConversationLive(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  } catch (error) {
    console.error("Request handling error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
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

