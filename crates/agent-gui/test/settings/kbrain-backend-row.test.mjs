import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { KBrainBackendRow } = env.loadModule("src/pages/settings/KBrainBackendRow.tsx");
const { parseKBrainHealth } = env.loadModule("@liveagent/ui/lib/kbrain/health.ts");
const vectors = JSON.parse(
  readFileSync(new URL("../../../agent-ui/src/lib/kbrain/health-contract-vectors.json", import.meta.url), "utf8"),
);
const vector = (name) => vectors.accept.find((item) => item.name === name).body;

async function render(loadHealth) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () => {
    root.render(env.React.createElement(KBrainBackendRow, { loadHealth }));
  });
  await env.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    text: () => host.textContent,
    cleanup: () => env.act(async () => root.unmount()).then(() => host.remove()),
  };
}

test("structured K0 health shows build, protocol, capability revision and short instance", async () => {
  const health = parseKBrainHealth(vector("K0 structured health"));
  const view = await render(async () => health);
  const text = view.text();
  assert.match(text, /K-brain v0\.108\.0-beta\.1 \(prerelease\)/);
  assert.match(text, /kbrain\.agent 1\.1/);
  assert.match(text, /111111111111/);
  assert.match(text, /c438bc67/);
  assert.doesNotMatch(text, /c438bc67-0445/, "instance id is shortened, not dumped");
  await view.cleanup();
});

test("legacy backends are labelled instead of inventing a version", async () => {
  const health = parseKBrainHealth(vector("legacy beta.23 with capabilities"));
  const view = await render(async () => health);
  assert.match(view.text(), /kbrain\.agent 1\.0/);
  assert.doesNotMatch(view.text(), /K-brain \?/);
  assert.equal(health.legacy, true);
  await view.cleanup();
});

test("a contract violation is shown with its reason instead of a version", async () => {
  const view = await render(async () =>
    parseKBrainHealth({ status: "ok", version: "kbrain.agent.v1", protocol: { name: "kbrain.agent", major: 2, minor: 0 } }),
  );
  assert.match(view.text(), /health contract violation/);
  assert.doesNotMatch(view.text(), /K-brain v/);
  await view.cleanup();
});
