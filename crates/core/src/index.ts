// Node 引擎入口:loopback HTTP 服务,只被 Rust(backend)反向代理访问。
// 业务在 engine.ts;这里只做认证、路由、JSON 编解码。

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  abortConversation,
  acceptChatSend,
  type ChatSendRequest,
  disposeConversation,
  getConversationLiveSnapshot,
} from "./engine";
import type { MemoryOrganizeRun } from "./memory/api";
import { acceptOrganizerRun } from "./memory/organizer/run";
import {
  type ConversationTitleRequest,
  generateConversationTitle,
} from "./turns/conversationTitle";
import { pokeCronPromptRuns, startCronPromptRunner } from "./automation/cronPromptRunner";

const nodePort = process.env.LIVEAGENT_NODE_PORT;
const backendPort = process.env.LIVEAGENT_BACKEND_PORT;

// 校验所有必需的环境变量
if (!nodePort) {
  console.error("Missing required environment variable: LIVEAGENT_NODE_PORT");
  process.exit(1);
}

if (!backendPort) {
  console.error("Missing required environment variable: LIVEAGENT_BACKEND_PORT");
  process.exit(1);
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
  // 健康检查端点
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // 无认证:只监听 127.0.0.1,请求只可能来自本机的 Rust backend。

  try {
    const body = req.method === "POST" ? await readBody(req) : undefined;

    if (req.method === "POST" && req.url === "/chat_send") {
      // 受理即回 202(决策 2):增量与终态全走 WS 广播,不在这个响应里。
      // 编辑重发是例外:acceptChatSend 会等截断落库后才 resolve。
      const result = await acceptChatSend(body as ChatSendRequest);
      respondJson(res, 202, { ok: result });
    } else if (req.method === "POST" && req.url === "/chat_abort") {
      const { conversationId } = (body ?? {}) as { conversationId?: string };
      if (!conversationId) {
        respondJson(res, 400, { error: "conversationId required" });
        return;
      }
      respondJson(res, 200, { ok: { aborted: abortConversation(conversationId) } });
    } else if (req.method === "POST" && req.url === "/conversation_dispose") {
      const { conversationId } = (body ?? {}) as { conversationId?: string };
      if (!conversationId) {
        respondJson(res, 400, { error: "conversationId required" });
        return;
      }
      respondJson(res, 200, { ok: { disposed: disposeConversation(conversationId) } });
    } else if (req.method === "POST" && req.url === "/memory_organize_run") {
      // 受理即回 202:一次整理可能跑几分钟,阶段进度与终态走 memory_organize_* 事件。
      const { run } = (body ?? {}) as { run?: MemoryOrganizeRun };
      if (!run) {
        respondJson(res, 400, { error: "run required" });
        return;
      }
      respondJson(res, 202, { ok: acceptOrganizerRun(run) });
    } else if (req.method === "POST" && req.url === "/conversation_title_generate") {
      // 同步返回:标题是一次性的短请求,没有增量可播。失败一律 null,
      // 调用方沿用 fallbackTitle。
      const { titleSourceText, selectedModel } = (body ?? {}) as Partial<ConversationTitleRequest>;
      if (typeof titleSourceText !== "string" || !titleSourceText.trim()) {
        respondJson(res, 400, { error: "titleSourceText required" });
        return;
      }
      let title: string | null = null;
      try {
        title = await generateConversationTitle({ titleSourceText, selectedModel });
      } catch (error) {
        console.warn("conversation title generation failed:", error);
      }
      respondJson(res, 200, { ok: { title } });
    } else if (req.method === "POST" && req.url === "/cron_prompt_poke") {
      // 立即认领:引擎自带对账定时器,这条只是把「刚排进队列」提前告知,
      // 省掉一个轮询周期。执行进度与终态走 cron_prompt_* 事件。
      respondJson(res, 202, { ok: pokeCronPromptRuns() });
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
  // 定时任务的对账循环归引擎所有:不开界面也照常跑。
  startCronPromptRunner();
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
