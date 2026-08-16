import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createLoader(contentsByPath) {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          const text = contentsByPath[args.absolute_path];
          if (text === undefined) throw new Error(`missing fixture: ${args.absolute_path}`);
          return {
            mimeType: "text/plain; charset=utf-8",
            data: Buffer.from(text, "utf8").toString("base64"),
            sizeBytes: Buffer.byteLength(text),
          };
        },
      },
    },
  });
  return { loader, calls };
}

function createModel(api) {
  return {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    api,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    input: ["text"],
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

test("DeepSeek inlines multiple large pastes while preserving ordinary Read attachments", async () => {
  const { loader, calls } = createLoader({
    "/workspace/.liveagent/paste-1.txt": "first pasted body\n第二行",
    "/workspace/.liveagent/paste-2.txt": "second pasted body",
  });
  const uploadedFiles = loader.loadModule("@liveagent/ui/lib/chat/uploadedFiles.ts");
  const { inlineDeepSeekLargePastes } = loader.loadModule(
    "src/lib/providers/deepSeekAttachments.ts",
  );
  const { DEEPSEEK_CHAT_COMPLETIONS_API, serializeDeepSeekRequest } = loader.loadModule(
    "src/lib/providers/deepSeekNative.ts",
  );
  const files = [
    {
      relativePath: ".liveagent/paste-1.txt",
      absolutePath: "/workspace/.liveagent/paste-1.txt",
      fileName: "paste-1.txt",
      kind: "text",
      sizeBytes: 20,
      displayMode: "largePaste",
      displayLabel: "Pasted text 1",
    },
    {
      relativePath: ".liveagent/paste-2.txt",
      absolutePath: "/workspace/.liveagent/paste-2.txt",
      fileName: "paste-2.txt",
      kind: "text",
      sizeBytes: 18,
      displayMode: "largePaste",
      displayLabel: "Pasted text 2",
    },
    {
      relativePath: "docs/report.pdf",
      absolutePath: "/workspace/docs/report.pdf",
      fileName: "report.pdf",
      kind: "pdf",
      sizeBytes: 100,
    },
    {
      relativePath: "docs/notes.txt",
      absolutePath: "/workspace/docs/notes.txt",
      fileName: "notes.txt",
      kind: "text",
      sizeBytes: 30,
    },
  ];
  const message = uploadedFiles.createUserMessageWithUploads(
    "Review [Pasted text 1: .liveagent/paste-1.txt] and [Pasted text 2: .liveagent/paste-2.txt]",
    files,
    1,
  );

  const context = await inlineDeepSeekLargePastes({ messages: [message] }, "/workspace");
  const content = context.messages[0].content;
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.command === "system_read_uploaded_native_attachment"));
  assert.match(content, /first pasted body\n第二行/);
  assert.match(content, /second pasted body/);
  assert.doesNotMatch(content, /\[Pasted text/);
  assert.doesNotMatch(content, /paste-1\.txt \(text\)/);
  assert.doesNotMatch(content, /paste-2\.txt \(text\)/);
  assert.match(content, /Use Read with these exact paths/);
  assert.match(content, /\/workspace\/docs\/report\.pdf \(pdf\)/);
  assert.match(content, /\/workspace\/docs\/notes\.txt \(text\)/);

  const request = serializeDeepSeekRequest(
    createModel(DEEPSEEK_CHAT_COMPLETIONS_API),
    context,
    {},
  );
  const wire = JSON.stringify(request);
  assert.doesNotMatch(wire, /input_file/);
  assert.doesNotMatch(wire, /file_data/);
  assert.match(wire, /first pasted body/);
});

test("DeepSeek appends recovered paste text when a legacy message lost its display reference", async () => {
  const { loader } = createLoader({
    "/workspace/.liveagent/paste.txt": "recovered legacy paste",
  });
  const { inlineDeepSeekLargePastes } = loader.loadModule(
    "src/lib/providers/deepSeekAttachments.ts",
  );
  const context = await inlineDeepSeekLargePastes(
    {
      messages: [
        {
          role: "user",
          content: "Legacy message",
          timestamp: 1,
          liveAgentAttachments: [
            {
              relativePath: ".liveagent/paste.txt",
              absolutePath: "/workspace/.liveagent/paste.txt",
              fileName: "paste.txt",
              kind: "text",
              sizeBytes: 10,
              displayMode: "largePaste",
              displayLabel: "Pasted text 1",
            },
          ],
        },
      ],
    },
    "/workspace",
  );
  assert.match(context.messages[0].content, /Pasted text 1:\nrecovered legacy paste/);
});

test("DeepSeek requires a workdir and an absolute path for large-paste recovery", async () => {
  const { loader } = createLoader({});
  const { inlineDeepSeekLargePastes } = loader.loadModule(
    "src/lib/providers/deepSeekAttachments.ts",
  );
  const message = {
    role: "user",
    content: "[Pasted text 1: paste.txt]",
    timestamp: 1,
    liveAgentAttachments: [
      {
        relativePath: "paste.txt",
        fileName: "paste.txt",
        kind: "text",
        sizeBytes: 10,
        displayMode: "largePaste",
      },
    ],
  };
  await assert.rejects(inlineDeepSeekLargePastes({ messages: [message] }, ""), /workdir is empty/i);
  await assert.rejects(
    inlineDeepSeekLargePastes({ messages: [message] }, "/workspace"),
    /absolute path is unavailable/i,
  );
});

test("DeepSeek native stream inlines a large paste before payload hooks and fetch", async () => {
  const { loader } = createLoader({
    "/workspace/.liveagent/paste.txt": "native stream pasted body",
  });
  const uploadedFiles = loader.loadModule("@liveagent/ui/lib/chat/uploadedFiles.ts");
  const { DEEPSEEK_CHAT_COMPLETIONS_API, streamDeepSeekNative } = loader.loadModule(
    "src/lib/providers/deepSeekNative.ts",
  );
  const message = uploadedFiles.createUserMessageWithUploads(
    "Inspect [Pasted text 1: .liveagent/paste.txt]",
    [
      {
        relativePath: ".liveagent/paste.txt",
        absolutePath: "/workspace/.liveagent/paste.txt",
        fileName: "paste.txt",
        kind: "text",
        sizeBytes: 25,
        displayMode: "largePaste",
        displayLabel: "Pasted text 1",
      },
    ],
    1,
  );
  let hookPayload;
  let fetchPayload;
  const stream = streamDeepSeekNative(
    createModel(DEEPSEEK_CHAT_COMPLETIONS_API),
    { messages: [message] },
    {
      apiKey: "sk-test",
      workdir: "/workspace",
      onPayload(payload) {
        hookPayload = payload;
      },
      async fetch(_url, options) {
        fetchPayload = JSON.parse(options.body);
        return new Response(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "inlined" }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      },
    },
  );

  for await (const _event of stream) {
    // Drain the stream so serialization and fetch complete.
  }
  const result = await stream.result();

  assert.match(hookPayload.messages[0].content, /native stream pasted body/);
  assert.match(fetchPayload.messages[0].content, /native stream pasted body/);
  assert.doesNotMatch(JSON.stringify(fetchPayload), /\[Pasted text|input_file|file_data/);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content[0].text, "inlined");
});
