// Deterministic OpenAI-compatible model server for the desktop E2E suite.
// Replies are chosen from markers in the latest user message so each spec can
// steer the agent without any real provider:
//   - "[e2e:tool]" asks for a Bash tool call that writes a marker file; once the
//     tool result is in the transcript the model answers with a summary.
//   - anything else streams a short reply that echoes the prompt in chunks.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export const FAKE_MODEL_ID = "e2e-model";
export const FAKE_PROVIDER_ID = "e2e";
export const TOOL_MARKER = "[e2e:tool]";
export const TOOL_OUTPUT = "e2e-tool-ok";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
  }
  return "";
}

// The backend wraps the typed prompt in <kbrain-*> context blocks; drop them so
// replies only depend on what the spec typed.
function stripContext(text) {
  return text.replace(/<(kbrain-[a-z-]+)>[\s\S]*?<\/\1>/g, "").trim();
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return stripContext(textOf(messages[index].content));
  }
  return "";
}

/** The visible reply text for a plain prompt; specs assert on it. */
export function replyFor(prompt) {
  const firstLine = prompt.split("\n").find((line) => line.trim()) ?? "";
  return `E2E reply to: ${firstLine.trim().slice(0, 80)}`;
}

/** Title the fake model proposes for a conversation started with `prompt`. */
export function titleFor(prompt) {
  return `E2E ${prompt.trim().slice(0, 40)}`.trim();
}

function chunk(id, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: FAKE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function usage(id) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: FAKE_MODEL_ID,
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  })}\n\n`;
}

// A minimal runtime model catalog. The app merges it over the bundled snapshot,
// so serving it keeps the catalog refresh on loopback without changing models.
const catalogSections = {
  openai: [{ id: "e2e-catalog-probe", contextWindow: 32000, maxOutputToken: 1024 }],
};
const catalogDocument = {
  schemaVersion: 1,
  snapshotDate: "2099-01-01",
  sections: catalogSections,
  sha256: createHash("sha256").update(JSON.stringify(catalogSections)).digest("hex"),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the fake provider on 127.0.0.1. `markerFile` is the absolute path the
 * tool call writes, so specs can verify the approved command really ran.
 * `catalogPath` (optional) serves the runtime model catalog.
 */
export async function startFakeProvider({ port = 0, chunkDelayMs = 40, markerFile, catalogPath } = {}) {
  const requests = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    let raw = "";
    for await (const part of request) raw += part;
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: FAKE_MODEL_ID, object: "model" }] }));
      return;
    }
    if (request.method === "GET" && catalogPath && url.pathname === catalogPath) {
      response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(JSON.stringify(catalogDocument));
      return;
    }
    if (request.method === "GET" && url.pathname === "/__e2e/requests") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(requests));
      return;
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `fake provider: no route ${request.method} ${url.pathname}` } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fake provider: invalid JSON" } }));
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const prompt = lastUserText(messages);
    const toolNames = (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
    const toolResult = messages.findLast?.((message) => message.role === "tool");
    sequence += 1;
    const id = `e2e-${sequence}`;
    requests.push({
      id,
      stream: body.stream === true,
      prompt,
      tools: toolNames.length,
      toolResult: toolResult ? textOf(toolResult.content).slice(0, 400) : undefined,
    });

    if (body.stream !== true) {
      // Auxiliary calls (titles, summaries, reviews) get a short plain answer.
      // Titles end with the conversation text, so echoing the last line gives
      // every session a distinct, predictable sidebar title.
      const lastLine = prompt.split("\n").filter((line) => line.trim()).at(-1) ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: 1,
          model: FAKE_MODEL_ID,
          choices: [{ index: 0, message: { role: "assistant", content: titleFor(lastLine) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
      );
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const wantsTool = prompt.includes(TOOL_MARKER) && toolNames.includes("Bash");
    if (wantsTool && !toolResult) {
      const target = markerFile;
      const command = target ? `printf ${TOOL_OUTPUT} > '${target}' && cat '${target}'` : `echo ${TOOL_OUTPUT}`;
      response.write(chunk(id, { role: "assistant", content: "" }));
      response.write(
        chunk(id, {
          tool_calls: [
            {
              index: 0,
              id: `call-${sequence}`,
              type: "function",
              function: { name: "Bash", arguments: JSON.stringify({ command }) },
            },
          ],
        }),
      );
      response.write(chunk(id, {}, "tool_calls"));
      response.write(usage(id));
      response.end("data: [DONE]\n\n");
      return;
    }

    const text = wantsTool
      ? `Tool finished: ${textOf(toolResult?.content).includes(TOOL_OUTPUT) ? TOOL_OUTPUT : "no output"}`
      : replyFor(prompt);
    response.write(chunk(id, { role: "assistant", content: "" }));
    for (const piece of text.match(/.{1,6}/gs) ?? []) {
      if (response.destroyed) return;
      response.write(chunk(id, { content: piece }));
      await sleep(chunkDelayMs);
    }
    response.write(chunk(id, {}, "stop"));
    response.write(usage(id));
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
