import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createModelFromConfig } = loader.loadModule("src/lib/providers/runtime/modelFactory.ts");

test("xAI direct base URLs are forced onto the openai-responses API even when completions is requested", () => {
  const model = createModelFromConfig(
    "codex",
    "grok-4.5",
    "https://api.x.ai/v1",
    "openai-completions",
  );
  assert.equal(model.api, "openai-responses");
  assert.equal(model.id, "grok-4.5");
});

test("formal xai provider type always uses openai-responses", () => {
  const model = createModelFromConfig(
    "xai",
    "grok-4.5",
    "https://api.x.ai/v1",
    "openai-completions",
  );
  assert.equal(model.api, "openai-responses");
  assert.equal(model.thinkingLevelMap?.minimal, "low");
  assert.equal(model.thinkingLevelMap?.high, "high");
  assert.equal(model.thinkingLevelMap?.off, null);
});

test("xAI direct detection uses the upstream base URL when requests are proxied", () => {
  const model = createModelFromConfig(
    "codex",
    "grok-4.5",
    "http://127.0.0.1:18080/proxy/codex",
    "openai-completions",
    undefined,
    "https://api.x.ai/v1",
  );
  assert.equal(model.api, "openai-responses");
});

test("xAI chat-completions style base URLs also normalize onto the responses API", () => {
  const model = createModelFromConfig(
    "codex",
    "grok-4.5",
    "https://api.x.ai/v1/chat/completions",
  );
  assert.equal(model.api, "openai-responses");
});

test("non-xAI relays keep the requested completions API", () => {
  const model = createModelFromConfig(
    "codex",
    "grok-4.5",
    "https://relay.example.com/v1",
    "openai-completions",
  );
  assert.equal(model.api, "openai-completions");
});

test("xAI direct default request format remains openai-responses", () => {
  const model = createModelFromConfig("codex", "grok-4.5", "https://api.x.ai/v1");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.reasoning, true);
});
