import { createServer } from "node:http";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return {
    host: options.host ?? "127.0.0.1",
    port: options.port === undefined ? 48171 : Number(options.port),
    text: options.text ?? "session sync fixture response",
    delayMs: options.delay === undefined ? 0 : Number(options.delay),
  };
}

const options = parseArguments(process.argv.slice(2));
const counters = { requests: 0, models: 0, chat: 0 };
const server = createServer(async (request, response) => {
  counters.requests += 1;
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (request.method === "GET" && url.pathname === "/v1/models") {
    counters.models += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "session-sync-model", object: "model" }] }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(counters));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    counters.chat += 1;
    for await (const _chunk of request) {
      // Drain the request before streaming the deterministic response.
    }
    if (options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const id = `fixture-${counters.chat}`;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: "session-sync-model",
        choices: [{ index: 0, delta: { role: "assistant", content: options.text }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: "session-sync-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: `fixture route not found: ${request.method} ${url.pathname}` } }));
});

server.listen(options.port, options.host, () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock model has no TCP address");
  console.log(
    JSON.stringify({
      pid: process.pid,
      baseUrl: `http://${options.host}:${address.port}/v1`,
      metricsUrl: `http://${options.host}:${address.port}/metrics`,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
