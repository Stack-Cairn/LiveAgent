// Review of review_scope "per_run" on the desktop K-brain client (d0c14c2a).
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const perRunHealth = {
  status: "ok",
  version: "kbrain.agent.v1",
  capabilities: { permission_modes: ["normal", "auto_review"], ai_review_per_run: 1 },
};

async function serve(t, handler) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    handler(req, res, raw);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

// The composer's goal command starts its run through POST /goal (turn.ts startRun ->
// client.postGoal), not startRun; K-brain keeps that run's options for every goal round.
test("goal runs opt into per-run review like ordinary runs", async (t) => {
  let goalBody;
  const url = await serve(t, (req, res, raw) => {
    if (req.url === "/v1/health") return res.end(JSON.stringify(perRunHealth));
    goalBody = JSON.parse(raw);
    res.end(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "session", status: "active", run: { version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1 } }));
  });
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client");
  const client = createKBrainClient({ baseUrl: url });
  await client.postGoal("session", {
    action: "set",
    goal: "ship it",
    run: { client_request_id: "goal-1", prompt: "/goal ship it", options: { mode: "agent", permission_mode: "normal" } },
  }).catch(() => {});
  assert.ok(goalBody, "goal request was not sent");
  assert.equal(goalBody.run.options.review_scope, "per_run");
});

// Before d0c14c2a a normal-mode startRun never waited on /v1/health. The shared capability
// read takes no signal, so Stop cannot end a startRun stuck behind a slow health reply.
test("Stop ends a normal-mode startRun while the capability read is pending", async (t) => {
  const url = await serve(t, (req, res) => {
    if (req.url === "/v1/health") return; // never answers
    res.end(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "session", run_id: "run", accepted_seq: 1 }));
  });
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client");
  const client = createKBrainClient({ baseUrl: url });
  const controller = new AbortController();
  const started = client.startRun(
    { conversation_id: "session", client_request_id: "r-1", prompt: "hi", options: { mode: "agent", permission_mode: "normal" } },
    controller.signal,
  );
  setTimeout(() => controller.abort(new Error("stopped")), 50);
  const outcome = await Promise.race([
    started.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 1000)),
  ]);
  // Before d0c14c2a this resolved at once (no health read for normal mode); now it must at
  // least honour Stop.
  assert.notEqual(outcome, "still pending", "startRun ignored Stop for a full second");
});
