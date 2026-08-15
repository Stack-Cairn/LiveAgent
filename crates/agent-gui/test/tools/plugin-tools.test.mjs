import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function snapshot(overrides = {}) {
  return {
    revision: "snapshot-1",
    workspace: "/workspace",
    tools: [
      {
        pluginId: "com.example.demo",
        pluginVersion: "1.2.3",
        packageHash: "a".repeat(64),
        generation: 7,
        contribution: {
          id: "inspect",
          modelName: "plugin_inspect",
          title: "Inspect",
          description: "Inspect caller data",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
          handler: "inspect",
          readOnly: true,
        },
      },
    ],
    promptSections: [],
    hooks: [],
    ...overrides,
  };
}

test("plugin tools preserve snapshot fencing and result provenance", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return {
            content: [{ type: "text", text: "plugin result" }],
            details: { source: "demo" },
            isError: false,
          };
        },
      },
    },
  });
  const { createPluginToolBundles } = loader.loadModule("src/lib/tools/pluginTools.ts");
  const [bundle] = createPluginToolBundles("/workspace", snapshot());

  assert.equal(bundle.groupId, "plugin:com.example.demo");
  assert.equal(bundle.tools[0].name, "plugin_inspect");
  assert.equal(bundle.metadataByName.get("plugin_inspect").pluginId, "com.example.demo");

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-1",
    name: "plugin_inspect",
    arguments: { text: "hello" },
  });

  assert.deepEqual(invocations, [
    {
      command: "plugin_invoke_tool",
      args: {
        workspace: "/workspace",
        pluginId: "com.example.demo",
        modelName: "plugin_inspect",
        generation: 7,
        arguments: { text: "hello" },
      },
    },
  ]);
  assert.equal(result.isError, false);
  assert.equal(result.content[0].text, "plugin result");
  assert.deepEqual(result.details, {
    pluginId: "com.example.demo",
    pluginVersion: "1.2.3",
    packageHash: "a".repeat(64),
    generation: 7,
    contributionId: "inspect",
    plugin: { source: "demo" },
  });
});

test("plugin hooks are fenced to the prepared turn snapshot", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          return [];
        },
      },
    },
  });
  const { dispatchPluginHook } = loader.loadModule("src/lib/tools/pluginTools.ts");
  const turnSnapshot = snapshot({
    hooks: [
      {
        pluginId: "com.example.demo",
        pluginVersion: "1.2.3",
        packageHash: "a".repeat(64),
        generation: 7,
        contribution: {
          id: "observer",
          event: "turn_start",
          observeOnly: true,
          handler: "observe",
          timeoutMs: 2_000,
        },
      },
    ],
  });

  await dispatchPluginHook(turnSnapshot, {
    event: "turn_start",
    workspace: "/workspace",
    payload: { round: 1 },
  });

  assert.deepEqual(invocations, [
    {
      command: "plugin_dispatch_hook",
      args: {
        request: {
          event: "turn_start",
          workspace: "/workspace",
          payload: { round: 1 },
          snapshotRevision: "snapshot-1",
          hooks: turnSnapshot.hooks,
        },
      },
    },
  ]);
});

test("plugin prompt sections escape provenance and enforce CJK-aware budgets", () => {
  const loader = createTsModuleLoader();
  const { buildPluginPrompt, buildPluginPromptWithProvenance, limitPromptContent } = loader.loadModule(
    "src/lib/tools/pluginTools.ts",
  );
  const { estimateTextTokenUnits } = loader.loadModule(
    "@liveagent/ui/lib/chat/contextUsage.ts",
  );
  const limited = limitPromptContent("这是一个很长的插件提示内容", 5);
  assert.ok(limited.endsWith("…"));
  assert.ok(estimateTextTokenUnits(limited) <= 5);

  const promptSnapshot = snapshot({
      promptSections: [
        {
          pluginId: 'com.example.\"unsafe',
          pluginVersion: "1.0.0",
          packageHash: "b".repeat(64),
          generation: 2,
          id: "context",
          content: "workspace guidance",
          maxTokens: 20,
        },
      ],
    });
  const prompt = buildPluginPrompt(promptSnapshot);
  const builtPrompt = buildPluginPromptWithProvenance(promptSnapshot);
  assert.match(prompt, /plugin="com\.example\.&quot;unsafe"/);
  assert.match(prompt, /contribution="context"/);
  assert.match(prompt, /workspace guidance/);
  assert.equal(builtPrompt.prompt, prompt);
  assert.deepEqual(builtPrompt.pluginContext, {
    snapshotRevision: "snapshot-1",
    promptSections: [
      {
        pluginId: 'com.example."unsafe',
        pluginVersion: "1.0.0",
        packageHash: "b".repeat(64),
        generation: 2,
        contributionId: "context",
        truncated: false,
      },
    ],
  });

  const boundedPrompt = buildPluginPrompt(
    snapshot({
      promptSections: Array.from({ length: 10 }, (_, index) => ({
        pluginId: "com.example.demo",
        pluginVersion: "1.0.0",
        packageHash: "c".repeat(64),
        generation: 1,
        id: `context-${index}`,
        content: "界".repeat(3_000),
      })),
    }),
  );
  const boundedContents = Array.from(
    boundedPrompt.matchAll(/<liveagent-plugin-context[^>]*>\n([\s\S]*?)\n<\/liveagent-plugin-context>/g),
    (match) => match[1],
  );
  assert.ok(boundedContents.length > 0 && boundedContents.length < 10);
  assert.ok(
    boundedContents.reduce((total, content) => total + estimateTextTokenUnits(content), 0) <=
      16_000,
  );
  assert.ok(estimateTextTokenUnits(boundedPrompt) <= 16_000);
  assert.ok(boundedContents.every((content) => estimateTextTokenUnits(content) <= 2_000));
  const boundedContext = buildPluginPromptWithProvenance(
    snapshot({
      promptSections: Array.from({ length: 10 }, (_, index) => ({
        pluginId: "com.example.demo",
        pluginVersion: "1.0.0",
        packageHash: "c".repeat(64),
        generation: 1,
        id: `context-${index}`,
        content: "界".repeat(3_000),
      })),
    }),
  ).pluginContext;
  assert.equal(boundedContext.promptSections.length, boundedContents.length);
  assert.ok(boundedContext.promptSections.every((section) => section.truncated));
});
