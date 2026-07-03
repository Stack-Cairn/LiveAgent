import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const uiMessagesLoader = createWebModuleLoader({ rootDir });
const uiMessages = uiMessagesLoader.loadModule("src/lib/chat/uiMessages.ts");
const toolPreview = uiMessagesLoader.loadModule("src/lib/chat/toolPreview.ts");
const fileChangeStats = uiMessagesLoader.loadModule("src/lib/chat/fileChangeStats.ts");
const hostedSearch = uiMessagesLoader.loadModule("src/lib/chat/hostedSearch.ts");
const uploadedImagePreview = uiMessagesLoader.loadModule("src/lib/chat/uploadedImagePreview.ts");
const loader = createWebModuleLoader({
  rootDir,
  mocks: {
    "@/lib/chat/chatPageHelpers": {
      isAbortLikeError() {
        return false;
      },
    },
    "@/lib/chat/uploadedFiles": {
      getUserMessageAttachments() {
        return [];
      },
      getUserMessageDisplayText(message) {
        if (typeof message.content === "string") return message.content;
        if (!Array.isArray(message.content)) return "";
        return message.content
          .filter((block) => block?.type === "text")
          .map((block) => block.text ?? "")
          .join("");
      },
    },
    "@/lib/chat/uiMessages": uiMessages,
    "@/lib/chat/hostedSearch": hostedSearch,
  },
});

const { createTurn, applyEventToTurn, rebuildTurnFromSnapshot } = loader.loadModule(
  "src/lib/chat/transcript/turnReducer.ts",
);
const { buildRowsFromEntries } = loader.loadModule("src/lib/chat/transcript/rows.ts");

function newTurn() {
  return createTurn({ key: "req:test", runId: "run-test" });
}

function withMockObjectUrl(run) {
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (file) => `blob:local-preview/${file.name}/${file.size}`,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => {},
  });
  try {
    return run();
  } finally {
    if (createDescriptor) {
      Object.defineProperty(URL, "createObjectURL", createDescriptor);
    } else {
      delete URL.createObjectURL;
    }
    if (revokeDescriptor) {
      Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    } else {
      delete URL.revokeObjectURL;
    }
  }
}

test("uploaded image previews use local object URLs before files.preview", async () => {
  await withMockObjectUrl(async () => {
    const uploadedFile = {
      relativePath: "uploads/batch/photo.png",
      absolutePath: "/workspace/uploads/batch/photo.png",
      fileName: "photo.png",
      kind: "image",
      sizeBytes: 128_000,
    };

    uploadedImagePreview.registerLocalUploadedImagePreviews({
      workspaceRoot: "/workspace",
      uploadedFiles: [uploadedFile],
      sourceFiles: [{ name: "photo.png", size: 128_000, type: "image/png" }],
    });

    assert.equal(
      uploadedImagePreview.readUploadedImagePreviewCache("/workspace", uploadedFile),
      "blob:local-preview/photo.png/128000",
    );

    let remotePreviewCalls = 0;
    const preview = await uploadedImagePreview.loadUploadedImagePreview({
      workspaceRoot: "/workspace",
      file: uploadedFile,
      loader: async () => {
        remotePreviewCalls += 1;
        return { mimeType: "image/png", data: "remote" };
      },
    });

    assert.equal(preview, "blob:local-preview/photo.png/128000");
    assert.equal(remotePreviewCalls, 0);
  });
});

test("uploaded image previews fall back to files.preview when no local object URL exists", async () => {
  const uploadedFile = {
    relativePath: "uploads/batch/remote.png",
    absolutePath: "/workspace/uploads/batch/remote.png",
    fileName: "remote.png",
    kind: "image",
    sizeBytes: 256_000,
  };
  const preview = await uploadedImagePreview.loadUploadedImagePreview({
    workspaceRoot: "/workspace",
    file: uploadedFile,
    loader: async () => ({ mimeType: "image/png", data: "cmVtb3Rl" }),
  });

  assert.equal(preview, "data:image/png;base64,cmVtb3Rl");
  assert.equal(
    uploadedImagePreview.readUploadedImagePreviewCache("/workspace", uploadedFile),
    "data:image/png;base64,cmVtb3Rl",
  );
});

function createDelegateAgent(id, prompt, summary) {
  return {
    id,
    prompt,
    mode: "readonly",
    status: "completed",
    summary,
    durationMs: 1200,
    rounds: 2,
    toolCalls: 3,
  };
}

test("web uiMessages summarizes SendMessage calls", () => {
  const toolCall = {
    type: "toolCall",
    id: "send-message",
    name: "SendMessage",
    arguments: {
      to: "parent",
      channel: "question",
      subject: "Scope",
      message: "Should we keep Markdown-only bus?",
    },
  };

  assert.equal(
    uiMessages.summarizeToolCall(toolCall),
    "SendMessage to=parent channel=question subject=Scope messageChars=33",
  );
  assert.deepEqual(uiMessages.toolCallArgsForDisplay(toolCall), {
    to: "parent",
    channel: "question",
    subject: "Scope",
    messageChars: 33,
  });
});

test("web uiMessages keeps char counts out of Write/Edit summaries", () => {
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "write-1",
      name: "Write",
      arguments: { path: "src/App.tsx", content: "line-1\nline-2" },
    }),
    "Write path=src/App.tsx mode=rewrite",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "edit-1",
      name: "Edit",
      arguments: {
        path: "src/App.tsx",
        old_string: "a".repeat(20),
        new_string: "b".repeat(35),
        expected_replacements: 1,
        replace_all: true,
      },
    }),
    "Edit path=src/App.tsx expected=1 replaceAll=true",
  );
});

test("deriveFileChangeStats derives collapsed-bar line counts", () => {
  const oldLines = Array.from({ length: 50 }, (_, index) => `line-${index}`);
  const newLines = oldLines.slice();
  newLines[25] = "line-25-changed";
  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats({
      type: "toolCall",
      id: "edit-1",
      name: "Edit",
      arguments: { old_string: oldLines.join("\n"), new_string: newLines.join("\n") },
    }),
    { added: 1, removed: 1 },
  );

  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats({
      type: "toolCall",
      id: "edit-2",
      name: "Edit",
      arguments: {
        old_string: "o".repeat(4000),
        new_string: "n".repeat(4000),
        __liveagent_stream_preview: {
          v: 2,
          progress: 17_000,
          fields: {
            old_string: { chars: 9000, lines: 300, truncated: true },
            new_string: { chars: 8000, lines: 280, truncated: false },
          },
        },
      },
    }),
    { added: 280, removed: 300 },
  );

  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats({
      type: "toolCall",
      id: "edit-3",
      name: "Edit",
      arguments: { old_string: "a\nb\nc" },
    }),
    { added: undefined, removed: 3 },
  );

  assert.deepEqual(
    fileChangeStats.deriveFileChangeStats({
      type: "toolCall",
      id: "write-1",
      name: "Write",
      arguments: {
        content: "preview…",
        __liveagent_stream_preview: {
          v: 2,
          progress: 12_000,
          fields: { content: { chars: 12_000, lines: 800, truncated: true } },
        },
      },
    }),
    { added: 800 },
  );

  assert.equal(
    fileChangeStats.deriveFileChangeStats({
      type: "toolCall",
      id: "bash-1",
      name: "Bash",
      arguments: { command: "ls" },
    }),
    undefined,
  );
});

test("buildRowsFromEntries emits user rows keyed by entry id", () => {
  const rows = buildRowsFromEntries(
    [
      {
        id: "user-1",
        kind: "user",
        text: "first",
        attachments: [],
      },
      {
        id: "assistant-1",
        kind: "assistant",
        text: "reply",
        round: 1,
      },
      {
        id: "user-2",
        kind: "user",
        text: "second",
        attachments: [],
      },
      {
        id: "checkpoint-1",
        kind: "checkpoint",
        content: "summary",
        summaryId: "summary-1",
        coveredMessageCount: 2,
        generatedBy: {
          providerId: "codex",
          model: "test-model",
        },
      },
      {
        id: "user-3",
        kind: "user",
        text: "third",
        attachments: [],
      },
    ],
    "history",
  );

  assert.deepEqual(
    rows.map((row) => row.kind),
    ["user", "assistant", "user", "checkpoint", "user"],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "user").map((row) => row.key),
    ["user-1", "user-2", "user-3"],
  );
});

test("applyEventToTurn ignores empty start tokens without creating a blank assistant", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "",
    round: 0,
    conversation_id: "conversation-1",
  });
  assert.deepEqual(turn.entries, []);

  turn = applyEventToTurn(turn, {
    type: "token",
    text: "answer",
    round: 1,
    conversation_id: "conversation-1",
  });
  assert.equal(turn.entries.length, 1);
  assert.equal(turn.entries[0].kind, "assistant");
  assert.equal(turn.entries[0].text, "answer");
});

test("applyEventToTurn and buildRowsFromEntries preserve hosted search events", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-1",
    provider: "gemini",
    status: "searching",
    queries: ["current docs"],
    sources: [],
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-1",
    provider: "gemini",
    status: "completed",
    queries: ["current docs"],
    sources: [{ url: "https://example.com/docs", title: "Docs" }],
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "done",
    round: 1,
  });

  const entries = turn.entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "hosted_search");
  assert.equal(entries[0].hostedSearch.status, "completed");
  assert.equal(entries[0].hostedSearch.sources[0].url, "https://example.com/docs");

  const items = buildRowsFromEntries(entries, "stream");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  assert.deepEqual(
    items[0].rounds[0].blocks.map((block) => block.kind),
    ["hostedSearch", "text"],
  );
});

test("buildRowsFromEntries keeps delayed hosted search after streamed text", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "answer before metadata",
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-delayed",
    provider: "codex",
    status: "completed",
    queries: ["delayed query"],
    sources: [{ url: "https://example.com/delayed", title: "Delayed" }],
    round: 1,
  });

  const items = buildRowsFromEntries(turn.entries, "stream");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  assert.deepEqual(
    items[0].rounds[0].blocks.map((block) => block.kind),
    ["text", "hostedSearch"],
  );
  assert.equal(items[0].rounds[0].blocks[0].text, "answer before metadata");
});

test("buildRowsFromEntries anchors delayed hosted search inside the streamed text", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "任务1完成。现在按顺序进行联网检索设计模式定义。任务2完成：设计模式是可复用方案。",
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-pattern",
    provider: "codex",
    status: "completed",
    queries: ["设计模式定义"],
    sources: [{ url: "https://example.com/pattern", title: "设计模式" }],
    round: 1,
  });

  const items = buildRowsFromEntries(turn.entries, "stream");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  const blocks = items[0].rounds[0].blocks;
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["text", "hostedSearch", "text"],
  );
  assert.equal(blocks[0].text, "任务1完成。现在按顺序进行联网检索设计模式定义。");
  assert.equal(blocks[2].text, "任务2完成：设计模式是可复用方案。");
});

test("applyEventToTurn keeps streamed text after hosted search in event order", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "任务1完成。现在开始联网搜索。",
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-live-order",
    provider: "codex",
    status: "searching",
    queries: ["LiveAgent web search"],
    sources: [],
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "任务2继续输出，应该出现在搜索卡片之后。",
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-live-order",
    provider: "codex",
    status: "completed",
    queries: ["LiveAgent web search"],
    sources: [{ url: "https://example.com/live-order", title: "Live order" }],
    round: 1,
  });

  const entries = turn.entries;
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["assistant", "hosted_search", "assistant"],
  );
  assert.equal(entries[1].hostedSearch.status, "completed");
  assert.equal(entries[1].hostedSearch.sources[0].url, "https://example.com/live-order");

  const items = buildRowsFromEntries(entries, "stream");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  const blocks = items[0].rounds[0].blocks;
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["text", "hostedSearch", "text"],
  );
  assert.equal(blocks[0].text, "任务1完成。现在开始联网搜索。");
  assert.equal(blocks[2].text, "任务2继续输出，应该出现在搜索卡片之后。");
});

test("buildRowsFromEntries groups live hosted searches separated by streamed text", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "先查第一组资料。",
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-a",
    provider: "codex",
    status: "completed",
    queries: ["first query"],
    sources: [{ url: "https://example.com/a", title: "A" }],
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "继续说明中间过程。",
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-b",
    provider: "codex",
    status: "completed",
    queries: ["second query"],
    sources: [{ url: "https://example.com/b", title: "B" }],
    round: 1,
  });

  const items = buildRowsFromEntries(turn.entries, "stream");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  const blocks = items[0].rounds[0].blocks;
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["text", "hostedSearch", "hostedSearch", "text"],
  );
  assert.deepEqual(
    blocks
      .filter((block) => block.kind === "hostedSearch")
      .map((block) => block.item.id),
    ["search-a", "search-b"],
  );
});

test("applyEventToTurn does not split a sentence when hosted search arrives mid sentence", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "现在反过来，我先看“谁",
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-sentence",
    provider: "codex",
    status: "searching",
    queries: ["AI companion app revenue"],
    sources: [],
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "为什么会掏钱”。然后再看市场。",
    round: 1,
  });

  const items = buildRowsFromEntries(turn.entries, "stream");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  const blocks = items[0].rounds[0].blocks;
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["text", "hostedSearch", "text"],
  );
  assert.equal(blocks[0].text, "现在反过来，我先看“谁为什么会掏钱”。");
  assert.equal(blocks[1].item.id, "search-sentence");
  assert.equal(blocks[2].text, "然后再看市场。");
});

test("hosted search finalization keeps stream order across non-text blocks", () => {
  const search = {
    type: "hostedSearch",
    id: "search-mid",
    provider: "codex",
    status: "completed",
    queries: ["middle query"],
    sources: [{ url: "https://example.com/middle", title: "Middle" }],
  };
  const assistant = hostedSearch.applyHostedSearchOrderToAssistant(
    {
      role: "assistant",
      content: [
        { type: "text", text: "任务1完成。" },
        {
          type: "toolCall",
          id: "call-read",
          name: "Read",
          arguments: { path: "README.md" },
        },
        { type: "text", text: "任务2继续输出。" },
        search,
      ],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "stop",
      timestamp: 2,
    },
    [
      { kind: "text", text: "任务1完成。" },
      { kind: "hostedSearch", item: search },
      { kind: "text", text: "任务2继续输出。" },
    ],
  );

  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["text", "hostedSearch", "toolCall", "text"],
  );

  const ui = uiMessages.buildUiMessages([
    { role: "user", content: "search", timestamp: 1 },
    assistant,
  ]);
  assert.deepEqual(
    ui[1].rounds[0].blocks.map((block) => block.kind),
    ["text", "hostedSearch", "tool", "text"],
  );
  assert.equal(ui[1].rounds[0].blocks[1].item.id, "search-mid");
});

test("web UI hydrates persisted hosted search sources from answer links", () => {
  const ui = uiMessages.buildUiMessages([
    { role: "user", content: "请联网搜索 iDRAC 是什么", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "hostedSearch",
          id: "search-persisted-empty",
          provider: "codex",
          status: "completed",
          queries: [],
          sources: [],
        },
        {
          type: "text",
          text: "参考：\n- Dell 官方 iDRAC 页面：https://www.dell.com/en-us/lp/dt/open-manage-idrac",
        },
      ],
      provider: "codex",
      model: "gpt-5.5",
      api: "openai-responses",
      stopReason: "stop",
      timestamp: 2,
    },
  ]);

  const searchBlock = ui[1].rounds[0].blocks.find((block) => block.kind === "hostedSearch");
  assert.deepEqual(searchBlock.item.sources, [
    {
      url: "https://www.dell.com/en-us/lp/dt/open-manage-idrac",
      title: "Dell 官方 iDRAC 页面",
      sourceType: "citation",
    },
  ]);
});

test("applyEventToTurn hydrates live hosted search sources from streamed answer links", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "hosted_search",
    id: "search-live-empty",
    provider: "codex",
    status: "completed",
    queries: ["iDRAC 是什么"],
    sources: [],
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "参考：Dell 官方 iDRAC 页面：https://www.dell.com/en-us/lp/dt/open-manage-idrac",
    round: 1,
  });

  assert.equal(turn.entries[0].kind, "hosted_search");
  assert.deepEqual(turn.entries[0].hostedSearch.sources, [
    {
      url: "https://www.dell.com/en-us/lp/dt/open-manage-idrac",
      title: "参考：Dell 官方 iDRAC 页面",
      sourceType: "citation",
    },
  ]);
});

test("web UI keeps inferred sources scoped to each persisted search block", () => {
  const ui = uiMessages.buildUiMessages([
    { role: "user", content: "search twice", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "hostedSearch",
          id: "search-a",
          provider: "codex",
          status: "completed",
          queries: [],
          sources: [],
        },
        { type: "text", text: "A 来源：https://example.com/a\n" },
        {
          type: "hostedSearch",
          id: "search-b",
          provider: "codex",
          status: "completed",
          queries: [],
          sources: [],
        },
        { type: "text", text: "B 来源：https://example.com/b" },
      ],
      provider: "codex",
      model: "gpt-5.5",
      api: "openai-responses",
      stopReason: "stop",
      timestamp: 2,
    },
  ]);

  const searches = ui[1].rounds[0].blocks
    .filter((block) => block.kind === "hostedSearch")
    .map((block) => block.item);
  assert.deepEqual(
    searches.map((search) => search.sources.map((source) => source.url)),
    [["https://example.com/a"], ["https://example.com/b"]],
  );
});

test("hosted search finalization does not split a sentence at the stream event offset", () => {
  const search = {
    type: "hostedSearch",
    id: "search-final-sentence",
    provider: "codex",
    status: "completed",
    queries: ["AI companion app revenue 2025 users pay loneliness"],
    sources: [{ url: "https://example.com/market", title: "Market" }],
  };
  const beforeSearch = "对，我前面犯的是工程师病：先造东西，再硬想怎么卖。现在反过来，我先看“谁";
  const afterSearch = "为什么会掏钱”。然后再分析产品。";
  const assistant = hostedSearch.applyHostedSearchOrderToAssistant(
    {
      role: "assistant",
      content: [
        { type: "text", text: beforeSearch + afterSearch },
        search,
      ],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "stop",
      timestamp: 2,
    },
    [
      { kind: "text", text: beforeSearch },
      { kind: "hostedSearch", item: search },
      { kind: "text", text: afterSearch },
    ],
  );

  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["text", "hostedSearch", "text"],
  );
  assert.equal(assistant.content[0].text, `${beforeSearch}为什么会掏钱”。`);
  assert.equal(assistant.content[1].id, "search-final-sentence");
  assert.equal(assistant.content[2].text, "然后再分析产品。");
});

test("applyEventToTurn keeps streamed text after tool calls in event order", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "先说明工具调用前的内容。",
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "tool_call",
    id: "call-1",
    name: "Read",
    arguments: { path: "README.md" },
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "token",
    text: "工具调用后的正文应该留在工具卡之后。",
    round: 1,
  });

  assert.deepEqual(
    turn.entries.map((entry) => entry.kind),
    ["assistant", "tool_call", "assistant"],
  );

  const items = buildRowsFromEntries(turn.entries, "stream");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  const blocks = items[0].rounds[0].blocks;
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["text", "tool", "text"],
  );
  assert.equal(blocks[0].text, "先说明工具调用前的内容。");
  assert.equal(blocks[2].text, "工具调用后的正文应该留在工具卡之后。");
});

test("applyEventToTurn merges streamed Write deltas with final call and result", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "tool_call_delta",
    id: "call-write",
    name: "Write",
    arguments: { path: "src/app.ts", content: "con" },
    round: 1,
  });
  turn = applyEventToTurn(turn, {
    type: "tool_call_delta",
    id: "call-write",
    name: "Write",
    arguments: { path: "src/app.ts", content: "console.log(1);\n" },
    round: 1,
  });

  assert.equal(turn.entries.length, 1);
  assert.equal(turn.entries[0].kind, "tool_call");
  assert.equal(turn.entries[0].toolCall.arguments.content, "console.log(1);\n");

  turn = applyEventToTurn(turn, {
    type: "tool_call",
    id: "call-write",
    name: "Write",
    arguments: { path: "src/app.ts", content: "console.log(1);\n" },
    round: 1,
  });

  assert.equal(turn.entries.length, 1);
  assert.equal(turn.entries[0].toolCall.arguments.content, "console.log(1);\n");

  turn = applyEventToTurn(turn, {
    type: "tool_result",
    id: "call-write",
    name: "Write",
    arguments: { path: "src/app.ts", content: "console.log(1);\n" },
    content: [{ type: "text", text: "Wrote src/app.ts" }],
    details: { kind: "write", path: "src/app.ts", bytes: 16, lines: 1 },
    isError: false,
    round: 1,
  });

  assert.equal(turn.entries.length, 2);
  assert.deepEqual(
    turn.entries.map((entry) => entry.kind),
    ["tool_call", "tool_result"],
  );

  const items = buildRowsFromEntries(turn.entries, "stream");
  assert.equal(items.length, 1);
  const toolBlocks = items[0].rounds[0].blocks.filter((block) => block.kind === "tool");
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].item.toolCall.id, "call-write");
  assert.equal(toolBlocks[0].item.toolCall.arguments.content, "console.log(1);\n");
  assert.equal(toolBlocks[0].item.toolResult.toolCallId, "call-write");
  assert.deepEqual(items[0].rounds[0].runningToolCallIds, []);
});

test("applyEventToTurn preserves streaming preview metadata for Write metrics", () => {
  const metadataKey = toolPreview.LIVE_TOOL_PREVIEW_META_KEY;
  const previewContent = "head\n...[truncated 9000 chars]...\ntail";
  const previewArgs = {
    path: "src/large.ts",
    content: previewContent,
    [metadataKey]: {
      v: 2,
      progress: 12000,
      fields: {
        content: {
          chars: 12000,
          lines: 800,
          truncated: true,
        },
      },
    },
  };

  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "tool_call_delta",
    id: "call-large-write",
    name: "Write",
    arguments: previewArgs,
    round: 1,
  });

  assert.equal(turn.entries.length, 1);
  assert.equal(turn.entries[0].toolCall.arguments.content, previewContent);
  const deltaPreview = toolPreview.deriveFileToolPreview(turn.entries[0].toolCall);
  assert.equal(deltaPreview.content.chars, 12000);
  assert.equal(deltaPreview.content.lines, 800);
  assert.equal(deltaPreview.content.truncated, true);

  turn = applyEventToTurn(turn, {
    type: "tool_call",
    id: "call-large-write",
    name: "Write",
    arguments: previewArgs,
    round: 1,
  });

  assert.equal(turn.entries.length, 1);
  const finalPreview = toolPreview.deriveFileToolPreview(turn.entries[0].toolCall);
  assert.equal(finalPreview.content.text, previewContent);
  assert.equal(finalPreview.content.chars, 12000);
  assert.equal(finalPreview.content.lines, 800);
});

function writePreviewArgs(chars, content) {
  return {
    path: "src/large.ts",
    content,
    [toolPreview.LIVE_TOOL_PREVIEW_META_KEY]: {
      v: 2,
      progress: chars,
      fields: { content: { chars, lines: 1, truncated: true } },
    },
  };
}

test("applyEventToTurn never rolls a streaming Write back to lower progress", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "tool_call_delta",
    id: "call-write",
    name: "Write",
    arguments: writePreviewArgs(6000, "newer preview"),
    round: 1,
  });

  // A stale writer (late delta replay / lagging snapshot echo) must lose.
  turn = applyEventToTurn(turn, {
    type: "tool_call_delta",
    id: "call-write",
    name: "Write",
    arguments: writePreviewArgs(4000, "older preview"),
    round: 1,
  });
  assert.equal(turn.entries.length, 1);
  assert.equal(
    toolPreview.deriveFileToolPreview(turn.entries[0].toolCall).content.chars,
    6000,
  );

  // A newer writer still advances.
  turn = applyEventToTurn(turn, {
    type: "tool_call_delta",
    id: "call-write",
    name: "Write",
    arguments: writePreviewArgs(7000, "newest preview"),
    round: 1,
  });
  assert.equal(
    toolPreview.deriveFileToolPreview(turn.entries[0].toolCall).content.chars,
    7000,
  );
});

test("rebuildTurnFromSnapshot keeps newer delta-built tool args over a lagging snapshot", () => {
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "tool_call_delta",
    id: "call-write",
    name: "Write",
    arguments: writePreviewArgs(6000, "delta preview"),
    round: 1,
  });

  const rebuilt = rebuildTurnFromSnapshot(turn, [
    {
      id: "runtime-live-0-tool-call-1-call-write-0",
      kind: "tool_call",
      round: 1,
      toolCall: {
        type: "toolCall",
        id: "call-write",
        name: "Write",
        // Raw snapshot content at an earlier stream position (no meta):
        // progress falls back to the raw length and must not win.
        arguments: { path: "src/large.ts", content: "x".repeat(4500) },
      },
      summary: "Write",
      text: "{}",
    },
  ]);

  const entry = rebuilt.entries.find((candidate) => candidate.kind === "tool_call");
  assert.ok(entry, "expected the snapshot tool_call entry");
  assert.equal(toolPreview.deriveFileToolPreview(entry.toolCall).content.chars, 6000);
  assert.equal(entry.toolCall.arguments.content, "delta preview");

  // A snapshot that is ahead of the deltas replaces the args.
  const advanced = rebuildTurnFromSnapshot(turn, [
    {
      id: "runtime-live-0-tool-call-1-call-write-0",
      kind: "tool_call",
      round: 1,
      toolCall: {
        type: "toolCall",
        id: "call-write",
        name: "Write",
        arguments: { path: "src/large.ts", content: "y".repeat(8000) },
      },
      summary: "Write",
      text: "{}",
    },
  ]);
  const advancedEntry = advanced.entries.find((candidate) => candidate.kind === "tool_call");
  assert.equal(toolPreview.deriveFileToolPreview(advancedEntry.toolCall).content.chars, 8000);
});

test("applyEventToTurn snapshots mutable streamed Write arguments", () => {
  const args = { path: "src/app.ts", content: "first" };
  let turn = newTurn();
  turn = applyEventToTurn(turn, {
    type: "tool_call_delta",
    id: "call-write-mutable",
    name: "Write",
    arguments: args,
    round: 1,
  });

  args.content = "first\nsecond";
  assert.equal(turn.entries[0].toolCall.arguments.content, "first");

  turn = applyEventToTurn(turn, {
    type: "tool_call_delta",
    id: "call-write-mutable",
    name: "Write",
    arguments: args,
    round: 1,
  });
  assert.equal(turn.entries[0].toolCall.arguments.content, "first\nsecond");
});

test("buildRowsFromEntries expands parent Agent aggregate results into Agent cards", () => {
  const entries = [
    {
      id: "assistant-tool-call",
      kind: "tool_call",
      round: 1,
      toolCall: {
        type: "toolCall",
        id: "call-agent",
        name: "Agent",
        arguments: {
          agents: [
            { id: "a", description: "Agent A", prompt: "Inspect A." },
            { id: "b", description: "Agent B", prompt: "Inspect B." },
          ],
        },
      },
      summary: "Agent",
      text: "{}",
    },
    {
      id: "agent-aggregate-result",
      kind: "tool_result",
      round: 1,
      toolResult: {
        role: "toolResult",
        toolCallId: "call-agent",
        toolName: "Agent",
        content: [{ type: "text", text: "aggregate" }],
        details: {
          kind: "delegate_agent",
          agentCount: 2,
          concurrency: 2,
          totalDurationMs: 2400,
          readOnly: true,
          mode: "readonly",
          agents: [
            createDelegateAgent("a", "Agent A", "A done"),
            createDelegateAgent("b", "Agent B", "B done"),
          ],
        },
        isError: false,
        timestamp: 123,
      },
      summary: "Agent result",
      text: "aggregate",
    },
  ];

  const items = buildRowsFromEntries(entries, "history");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  assert.equal(items[0].rounds.length, 1);

  const toolBlocks = items[0].rounds[0].blocks.filter((block) => block.kind === "tool");
  assert.equal(toolBlocks.length, 2);
  assert.deepEqual(
    toolBlocks.map((block) => block.item.toolCall.arguments.delegate_agent_card),
    [true, true],
  );
  assert.deepEqual(
    toolBlocks.map((block) => block.item.toolResult.details.kind),
    ["delegate_agent_item", "delegate_agent_item"],
  );
  assert.deepEqual(
    toolBlocks.map((block) => block.item.toolResult.details.agent.summary),
    ["A done", "B done"],
  );
  assert.deepEqual(items[0].rounds[0].runningToolCallIds, []);
});

test("buildDelegateAgentPlaceholderToolCalls parses agent_spec into stable Agent cards", () => {
  const placeholders = uiMessages.buildDelegateAgentPlaceholderToolCalls({
    type: "toolCall",
    id: "call-agent",
    name: "Agent",
    arguments: {
      concurrency: 8,
      agent_spec: [
        "@agent id=player1 mode=readonly",
        "name: 一号玩家",
        "role: 发言者",
        "prompt: 第一轮请给出观点",
        "---",
        "@agent id=player2 mode=readonly",
        "name: 二号玩家",
        "prompt: 第二轮请反驳",
      ].join("\n"),
    },
  });

  assert.equal(placeholders.length, 2);
  assert.deepEqual(
    placeholders.map((item) => item.id),
    ["call-agent:agent:1", "call-agent:agent:2"],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.name),
    ["一号玩家", "二号玩家"],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.prompt),
    ["第一轮请给出观点", "第二轮请反驳"],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.delegate_agent_card),
    [true, true],
  );
});

test("buildRowsFromEntries shows Agent placeholders while aggregate result is pending", () => {
  const parentToolCallEntry = {
    id: "assistant-tool-call",
    kind: "tool_call",
    round: 1,
    toolCall: {
      type: "toolCall",
      id: "call-agent",
      name: "Agent",
      arguments: {
        concurrency: 8,
        agent_spec: [
          "@agent id=player1 mode=readonly",
          "name: 一号玩家",
          "prompt: 第一轮请给出观点",
          "---",
          "@agent id=player2 mode=readonly",
          "name: 二号玩家",
          "prompt: 第二轮请反驳",
        ].join("\n"),
      },
    },
    summary: "Agent",
    text: "{}",
  };

  const pendingItems = buildRowsFromEntries([parentToolCallEntry], "history");
  const pendingBlocks = pendingItems[0].rounds[0].blocks.filter(
    (block) => block.kind === "tool",
  );
  assert.deepEqual(
    pendingBlocks.map((block) => block.item.toolCall.id),
    ["call-agent:agent:1", "call-agent:agent:2"],
  );
  assert.deepEqual(
    pendingBlocks.map((block) => block.item.toolCall.arguments.name),
    ["一号玩家", "二号玩家"],
  );
  assert.ok(pendingBlocks.every((block) => !block.item.toolResult));
  assert.deepEqual(pendingItems[0].rounds[0].runningToolCallIds, [
    "call-agent:agent:1",
    "call-agent:agent:2",
  ]);

  const completedItems = buildRowsFromEntries(
    [
      parentToolCallEntry,
      {
        id: "agent-aggregate-result",
        kind: "tool_result",
        round: 1,
        toolResult: {
          role: "toolResult",
          toolCallId: "call-agent",
          toolName: "Agent",
          content: [{ type: "text", text: "aggregate" }],
          details: {
            kind: "delegate_agent",
            agentCount: 2,
            concurrency: 2,
            totalDurationMs: 2400,
            readOnly: true,
            mode: "readonly",
            agents: [
              createDelegateAgent("player1", "第一轮请给出观点", "一号完成"),
              createDelegateAgent("player2", "第二轮请反驳", "二号完成"),
            ],
          },
          isError: false,
          timestamp: 123,
        },
        summary: "Agent result",
        text: "aggregate",
      },
    ],
    "history",
  );
  const completedBlocks = completedItems[0].rounds[0].blocks.filter(
    (block) => block.kind === "tool",
  );
  assert.deepEqual(
    completedBlocks.map((block) => block.item.toolCall.id),
    ["call-agent:agent:1", "call-agent:agent:2"],
  );
  assert.deepEqual(
    completedBlocks.map((block) => block.item.toolResult.details.agent.summary),
    ["一号完成", "二号完成"],
  );
  assert.deepEqual(completedItems[0].rounds[0].runningToolCallIds, []);
});

test("buildRowsFromEntries uses the stable Agent name supplied by item results", () => {
  const firstAgent = {
    ...createDelegateAgent("agent-1", "哲学视角探讨生命的意义", "first"),
    name: "哲学家 - 苏格拉底",
  };
  const secondAgent = {
    ...createDelegateAgent("agent-1", "哲学家继续回应", "second"),
    name: "哲学家 - 苏格拉底",
    role: "哲学视角",
  };
  const entries = [
    {
      id: "first-result",
      kind: "tool_result",
      round: 1,
      toolResult: {
        role: "toolResult",
        toolCallId: "call-agent-first",
        toolName: "Agent",
        content: [{ type: "text", text: "first aggregate" }],
        details: {
          kind: "delegate_agent",
          agentCount: 1,
          concurrency: 1,
          totalDurationMs: 1200,
          readOnly: true,
          mode: "readonly",
          agents: [firstAgent],
        },
        isError: false,
        timestamp: 1,
      },
      summary: "Agent result",
      text: "first aggregate",
    },
    {
      id: "second-result",
      kind: "tool_result",
      round: 2,
      toolResult: {
        role: "toolResult",
        toolCallId: "call-agent-second",
        toolName: "Agent",
        content: [{ type: "text", text: "second aggregate" }],
        details: {
          kind: "delegate_agent",
          agentCount: 1,
          concurrency: 1,
          totalDurationMs: 1200,
          readOnly: true,
          mode: "readonly",
          agents: [secondAgent],
        },
        isError: false,
        timestamp: 2,
      },
      summary: "Agent result",
      text: "second aggregate",
    },
  ];

  const items = buildRowsFromEntries(entries, "history");
  const firstTool = items[0].rounds[0].blocks.find((block) => block.kind === "tool");
  const secondTool = items[0].rounds[1].blocks.find((block) => block.kind === "tool");
  assert.equal(firstTool.item.toolResult.details.agent.name, "哲学家 - 苏格拉底");
  assert.equal(secondTool.item.toolCall.arguments.name, "哲学家 - 苏格拉底");
  assert.equal(secondTool.item.toolResult.details.agent.name, "哲学家 - 苏格拉底");
  assert.equal(secondTool.item.toolCall.arguments.role, "哲学视角");
  assert.equal(secondTool.item.toolResult.details.agent.role, "哲学视角");
});
