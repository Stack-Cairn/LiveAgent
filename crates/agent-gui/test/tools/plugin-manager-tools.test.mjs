import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function inventoryItem() {
  return {
    id: "com.liveagent.conversation.commit-style",
    name: "Commit Style",
    version: "1.0.0",
    description: "Keep commit messages consistent",
    packageHash: "a".repeat(64),
    generation: 2,
    runtime: { kind: "declarative", args: [], scope: "workspace", timeoutMs: 30_000, fuel: 50_000_000 },
    permissions: [],
    grantedPermissions: [],
    contributes: { tools: [], promptSections: [], hooks: [], settings: [] },
    enabled: true,
    phase: "active",
    trustLevel: "integrity_verified",
    installedAt: 1,
    updatedAt: 1,
    config: {},
    configRevision: 0,
  };
}

test("PluginCreate maps a conversation request to the authoritative Rust creator", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return inventoryItem();
        },
      },
    },
  });
  const { createPluginManagerTools } = loader.loadModule("src/lib/tools/pluginManagerTools.ts");
  const bundle = createPluginManagerTools({ workdir: "/workspace" });
  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-1",
    name: "PluginCreate",
    arguments: {
      slug: "commit-style",
      name: "Commit Style",
      description: "Keep commit messages consistent",
      instructions: "Always format commit messages using Conventional Commits.",
      max_tokens: 600,
    },
  });

  assert.equal(bundle.metadataByName.get("PluginCreate").kind, "manage_plugin");
  assert.deepEqual(invocations, [
    {
      command: "plugin_create_prompt",
      args: {
        request: {
          workspace: "/workspace",
          slug: "commit-style",
          name: "Commit Style",
          description: "Keep commit messages consistent",
          instructions: "Always format commit messages using Conventional Commits.",
          maxTokens: 600,
          replace: false,
        },
      },
    },
  ]);
  assert.equal(result.isError, false);
  assert.equal(result.details.pluginId, "com.liveagent.conversation.commit-style");
  assert.equal(result.details.nextTurnRequired, true);
  assert.match(result.content[0].text, /next user message/);
});

test("PluginCreate aborts before invoking Rust", async () => {
  let invoked = false;
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke() {
          invoked = true;
          return inventoryItem();
        },
      },
    },
  });
  const { createPluginManagerTools } = loader.loadModule("src/lib/tools/pluginManagerTools.ts");
  const controller = new AbortController();
  controller.abort();
  const result = await createPluginManagerTools({ workdir: "/workspace" }).executeToolCall(
    {
      type: "toolCall",
      id: "call-2",
      name: "PluginCreate",
      arguments: {},
    },
    controller.signal,
  );
  assert.equal(invoked, false);
  assert.equal(result.isError, true);
  assert.equal(result.details.changed, false);
});
