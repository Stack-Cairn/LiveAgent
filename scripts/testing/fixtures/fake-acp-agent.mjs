import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    console.log(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fixture-agent" } },
      }),
    );
  } else if (request.method === "session/list") {
    console.log(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { sessions: [{ sessionId: "fixture-session", cwd: process.cwd(), title: "fixture" }] },
      }),
    );
  }
}
