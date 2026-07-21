import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const uiMessages = loader.loadModule("src/lib/chat/messages/uiMessages.ts");
const hostedSearch = loader.loadModule("src/lib/chat/messages/hostedSearch.ts");
const seedToolCalls = loader.loadModule("src/lib/chat/runner/seedToolCalls.ts");
const chatHelpers = loader.loadModule("src/lib/chat/page/chatPageHelpers.ts");
const gatewayToolPreview = loader.loadModule("src/pages/chat/turns/gatewayToolPreview.ts");
const toolPreview = loader.loadModule("src/lib/chat/messages/toolPreview.ts");

const fileA = {
  relativePath: "src/App.tsx",
  absolutePath: "/workspace/src/App.tsx",
  fileName: "App.tsx",
  kind: "text",
  sizeBytes: 2048,
};
const fileB = {
  relativePath: "assets/diagram.png",
  fileName: "diagram.png",
  kind: "image",
  sizeBytes: 3 * 1024 * 1024,
};
const fileC = {
  relativePath: "uploads/report.docx",
  fileName: "report.docx",
  kind: "word",
  sizeBytes: 4096,
};

test("gateway tool preview keeps Write payloads small while preserving full metrics", () => {
  const content = Array.from({ length: 700 }, (_, index) =>
    `line-${index.toString().padStart(3, "0")} ${"x".repeat(24)}`,
  ).join("\n");

  const args = gatewayToolPreview.buildGatewayToolCallPreviewArguments({
    name: "Write",
    arguments: {
      path: "src/generated.txt",
      content,
    },
  });
  const metadata = args[toolPreview.LIVE_TOOL_PREVIEW_META_KEY];
  const contentMetrics = metadata.fields.content;

  assert.equal(args.path, "src/generated.txt");
  assert.notEqual(args.content, content);
  assert.ok(args.content.length <= 4000, `preview length ${args.content.length} should be capped`);
  assert.equal(metadata.v, 2);
  assert.equal(metadata.progress, content.length);
  assert.equal(contentMetrics.chars, content.length);
  assert.equal(contentMetrics.lines, 700);
  assert.equal(contentMetrics.truncated, true);

  const preview = toolPreview.deriveFileToolPreview({
    name: "Write",
    arguments: args,
  });
  assert.equal(preview.kind, "write");
  assert.equal(preview.content.chars, content.length);
  assert.equal(preview.content.lines, 700);
  assert.equal(preview.content.truncated, true);
  assert.equal(preview.content.text, args.content);
});

test("gateway tool preview handles empty and short Write content without false truncation", () => {
  const partialPreview = toolPreview.deriveFileToolPreview({
    name: "Write",
    arguments: {},
  });
  assert.equal(partialPreview.content.has, false);
  assert.equal(partialPreview.content.chars, 0);
  assert.equal(partialPreview.content.lines, 0);
  assert.equal(partialPreview.content.truncated, false);

  const args = gatewayToolPreview.buildGatewayToolCallPreviewArguments({
    name: "Write",
    arguments: {
      path: "src/small.txt",
      content: "hello\nworld",
    },
  });
  const metadata = args[toolPreview.LIVE_TOOL_PREVIEW_META_KEY];
  assert.equal(args.content, "hello\nworld");
  assert.equal(metadata.progress, 11);
  assert.equal(metadata.fields.content.chars, 11);
  assert.equal(metadata.fields.content.lines, 2);
  assert.equal(metadata.fields.content.truncated, false);

  const preview = toolPreview.deriveFileToolPreview({
    name: "Write",
    arguments: args,
  });
  assert.equal(preview.content.has, true);
  assert.equal(preview.content.text, "hello\nworld");
  assert.equal(preview.content.lines, 2);
});

test("gateway tool preview keeps Edit old/new payloads small with independent metrics", () => {
  const oldString = Array.from({ length: 520 }, (_, index) => `old-${index} ${"a".repeat(20)}`).join(
    "\n",
  );
  const newString = Array.from({ length: 480 }, (_, index) => `new-${index} ${"b".repeat(22)}`).join(
    "\n",
  );

  const args = gatewayToolPreview.buildGatewayToolCallPreviewArguments({
    name: "Edit",
    arguments: {
      path: "src/app.ts",
      old_string: oldString,
      new_string: newString,
      expected_replacements: 1,
    },
  });
  const metadata = args[toolPreview.LIVE_TOOL_PREVIEW_META_KEY];

  assert.notEqual(args.old_string, oldString);
  assert.notEqual(args.new_string, newString);
  assert.ok(args.old_string.length <= 4000);
  assert.ok(args.new_string.length <= 4000);
  assert.equal(metadata.progress, oldString.length + newString.length);
  assert.equal(metadata.fields.old_string.chars, oldString.length);
  assert.equal(metadata.fields.old_string.lines, 520);
  assert.equal(metadata.fields.new_string.chars, newString.length);
  assert.equal(metadata.fields.new_string.lines, 480);

  const preview = toolPreview.deriveFileToolPreview({
    name: "Edit",
    arguments: args,
  });
  assert.equal(preview.kind, "edit");
  assert.equal(preview.oldString.chars, oldString.length);
  assert.equal(preview.oldString.lines, 520);
  assert.equal(preview.newString.chars, newString.length);
  assert.equal(preview.newString.lines, 480);
  assert.equal(preview.expectedReplacements, 1);
});

test("gateway tool preview covers NotebookEdit new_source", () => {
  const newSource = Array.from({ length: 400 }, (_, index) => `cell-${index} ${"c".repeat(20)}`).join(
    "\n",
  );
  const args = gatewayToolPreview.buildGatewayToolCallPreviewArguments({
    name: "NotebookEdit",
    arguments: {
      notebook_path: "notebooks/analysis.ipynb",
      new_source: newSource,
    },
  });
  const metadata = args[toolPreview.LIVE_TOOL_PREVIEW_META_KEY];
  assert.ok(args.new_source.length <= 4000);
  assert.equal(metadata.progress, newSource.length);
  assert.equal(metadata.fields.new_source.chars, newSource.length);

  const preview = toolPreview.deriveFileToolPreview({
    name: "NotebookEdit",
    arguments: args,
  });
  assert.equal(preview.kind, "write");
  assert.equal(preview.field, "new_source");
  assert.equal(preview.path, "notebooks/analysis.ipynb");
  assert.equal(preview.content.chars, newSource.length);
});

test("tool args progress is monotonic across streaming prefixes and representations", () => {
  const fullContent = "x".repeat(9000);
  const prefixArgs = gatewayToolPreview.buildGatewayToolCallPreviewArguments({
    name: "Write",
    arguments: { path: "a.txt", content: fullContent.slice(0, 4500) },
  });
  const fullArgs = gatewayToolPreview.buildGatewayToolCallPreviewArguments({
    name: "Write",
    arguments: { path: "a.txt", content: fullContent },
  });

  const prefixProgress = toolPreview.toolArgsProgress("Write", prefixArgs);
  const fullProgress = toolPreview.toolArgsProgress("Write", fullArgs);
  const rawProgress = toolPreview.toolArgsProgress("Write", {
    path: "a.txt",
    content: fullContent,
  });

  assert.equal(prefixProgress, 4500);
  assert.equal(fullProgress, 9000);
  // Raw full args (no meta) must compare equal to the built preview so the
  // merge guard composes across snapshot and delta representations.
  assert.equal(rawProgress, fullProgress);
  assert.ok(prefixProgress < fullProgress);
  // Untracked tools stay outside the guard.
  assert.equal(toolPreview.toolArgsProgress("Bash", { command: "ls" }), undefined);
});

test("uploaded file helpers preserve display text and strip model-hidden metadata", () => {
  const merged = uploadedFiles.mergePendingUploadedFiles([fileA], [{ ...fileA, sizeBytes: 4096 }, fileB]);
  assert.deepEqual(merged.map((file) => [file.relativePath, file.sizeBytes]), [
    ["src/App.tsx", 4096],
    ["assets/diagram.png", 3 * 1024 * 1024],
  ]);

  const message = uploadedFiles.createUserMessageWithUploads(" Please review ", [fileA], 1234);
  assert.ok(message);
  assert.equal(message.role, "user");
  assert.equal(message.timestamp, 1234);
  assert.equal(uploadedFiles.getUserMessageDisplayText(message), "Please review");
  assert.deepEqual(uploadedFiles.getUserMessageAttachments(message), [fileA]);
  assert.match(message.content, /The user attached the files below/);
  assert.match(message.content, /Use Read with these exact paths/);

  const stripped = uploadedFiles.stripUploadedFilesMessageMetadata(message);
  assert.equal(uploadedFiles.getUserMessageDisplayText(stripped), message.content);
  assert.deepEqual(uploadedFiles.getUserMessageAttachments(stripped), []);
});

test("request context can preserve uploaded file metadata for native provider adapters", () => {
  const message = uploadedFiles.createUserMessageWithUploads(" Please review ", [fileA], 1234);
  const state = {
    meta: { systemPrompt: undefined, tools: [], totalMessageCount: 1 },
    segments: [
      {
        segmentIndex: 0,
        storageVersion: 3,
        messages: [message],
      },
    ],
    activeSegmentIndex: 0,
    historyRenderItems: [],
  };

  const strippedContext = conversationState.buildRequestContext(state);
  assert.deepEqual(uploadedFiles.getUserMessageAttachments(strippedContext.messages[0]), []);

  const nativeContext = conversationState.buildRequestContext(state, {
    includeUploadedFilesMetadata: true,
  });
  assert.deepEqual(uploadedFiles.getUserMessageAttachments(nativeContext.messages[0]), [fileA]);
});

test("uploaded file helpers preserve office and archive attachment kinds", () => {
  const message = uploadedFiles.createUserMessageWithUploads("Inspect attachments", [
    fileC,
    {
      relativePath: "uploads/workbook.xlsx",
      fileName: "workbook.xlsx",
      kind: "spreadsheet",
      sizeBytes: 8192,
    },
    {
      relativePath: "uploads/assets.zip",
      fileName: "assets.zip",
      kind: "archive",
      sizeBytes: 16384,
    },
  ]);
  assert.ok(message);
  assert.match(message.content, /uploads\/report\.docx \(word\)/);
  assert.match(message.content, /uploads\/workbook\.xlsx \(spreadsheet\)/);
  assert.match(message.content, /uploads\/assets\.zip \(archive\)/);
  assert.deepEqual(
    uploadedFiles.getUserMessageAttachments(message).map((file) => file.kind),
    ["word", "spreadsheet", "archive"],
  );
});

test("attachment-only messages instruct the model to inspect selected files first", () => {
  const message = uploadedFiles.createUserMessageWithUploads("", [fileB], 10);
  assert.ok(message);
  assert.match(message.content, /^Please inspect the selected files first\./);
  assert.equal(uploadedFiles.getUserMessageDisplayText(message), "");
  assert.equal(uploadedFiles.formatUploadedFileSize(fileB.sizeBytes), "3.0 MB");
  assert.equal(uploadedFiles.formatUploadedFileSize(2048), "2 KB");
  assert.equal(uploadedFiles.formatUploadedFileSize(12), "12 B");
});

test("pasted text uploads preserve display metadata and parse display references", () => {
  const pastedFile = uploadedFiles.withPastedTextDisplayMetadata(
    {
      relativePath: "uploads/pasted-text-1.txt",
      fileName: "pasted-text-1.txt",
      kind: "text",
      sizeBytes: 12345,
    },
    {
      label: "Pasted text 1",
      charCount: 12345,
      lineCount: 321,
    },
  );
  const message = uploadedFiles.createUserMessageWithUploads(
    "Compare [Pasted text 1: uploads/pasted-text-1.txt] with @src/App.tsx",
    [pastedFile],
    20,
  );
  assert.ok(message);
  assert.equal(
    uploadedFiles.getUserMessageDisplayText(message),
    "Compare [Pasted text 1: uploads/pasted-text-1.txt] with @src/App.tsx",
  );
  assert.deepEqual(uploadedFiles.getUserMessageAttachments(message), [pastedFile]);

  const references = uploadedFiles.parsePastedTextDisplayReferences(
    uploadedFiles.getUserMessageDisplayText(message),
  );
  assert.deepEqual(references.map((reference) => ({
    label: reference.label,
    relativePath: reference.relativePath,
    raw: reference.raw,
  })), [
    {
      label: "Pasted text 1",
      relativePath: "uploads/pasted-text-1.txt",
      raw: "[Pasted text 1: uploads/pasted-text-1.txt]",
    },
  ]);
});

test("UI message builder groups assistant rounds and attaches matching tool results", () => {
  const messages = [
    { role: "user", content: "start", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "checking" },
        { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "src/App.tsx" } },
      ],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "stop",
      usage: { totalTokens: 42 },
      timestamp: 4,
    },
  ];

  const ui = uiMessages.buildUiMessages(messages);
  assert.equal(ui.length, 2);
  assert.equal(ui[0].role, "user");
  assert.equal(ui[1].role, "assistant");
  assert.equal(ui[1].text, "done");
  assert.equal(ui[1].rounds.length, 2);
  assert.equal(uiMessages.getRoundThinkingText(ui[1].rounds[0]), "checking");
  assert.equal(uiMessages.getRoundToolTrace(ui[1].rounds[0])[0].toolResult.content[0].text, "file contents");
  assert.equal(ui[1].rounds[1].meta.usageTotalTokens, 42);
});

test("UI message builder preserves provider hosted search blocks", () => {
  const messages = [
    { role: "user", content: "search", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "hostedSearch",
          id: "search-1",
          provider: "codex",
          status: "completed",
          queries: ["LiveAgent web search"],
          sources: [
            {
              url: "https://example.com/result",
              title: "Result",
              sourceType: "citation",
            },
          ],
        },
        { type: "text", text: "found it" },
      ],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "stop",
      timestamp: 2,
    },
  ];

  const ui = uiMessages.buildUiMessages(messages);
  assert.equal(ui.length, 2);
  assert.equal(ui[1].rounds.length, 1);
  assert.deepEqual(
    ui[1].rounds[0].blocks.map((block) => block.kind),
    ["hostedSearch", "text"],
  );
  assert.deepEqual(uiMessages.getRoundHostedSearches(ui[1].rounds[0]), [
    {
      type: "hostedSearch",
      id: "search-1",
      provider: "codex",
      status: "completed",
      queries: ["LiveAgent web search"],
      sources: [
        {
          url: "https://example.com/result",
          title: "Result",
          sourceType: "citation",
        },
      ],
    },
  ]);
  assert.equal(ui[1].text, "found it");
});

test("UI message builder hides provider-native web_search tool traces when hosted search exists", () => {
  const webSearchCall = {
    type: "toolCall",
    id: "dsml-tool-call-search-1",
    name: "web_search",
    arguments: { query: "LiveAgent DeepSeek search" },
  };
  const messages = [
    { role: "user", content: "search", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "searching" },
        {
          type: "hostedSearch",
          id: "search-1",
          provider: "claude_code",
          status: "completed",
          queries: ["LiveAgent DeepSeek search"],
          sources: [{ url: "https://example.com/result", title: "Result" }],
        },
        webSearchCall,
      ],
      provider: "claude_code",
      model: "deepseek-v4-flash",
      api: "anthropic-messages",
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: webSearchCall.id,
      toolName: webSearchCall.name,
      content: [{ type: "text", text: "Tool web_search not found" }],
      details: {},
      isError: true,
      timestamp: 3,
    },
  ];

  const ui = uiMessages.buildUiMessages(messages);
  const round = ui[1].rounds[0];

  assert.equal(round.blocks.some((block) => block.kind === "tool"), false);
  assert.equal(uiMessages.getRoundHostedSearches(round).length, 1);
  assert.equal(uiMessages.getRoundToolTrace(round).length, 0);
});

test("hosted search finalization preserves streaming block order", () => {
  const searchA = {
    type: "hostedSearch",
    id: "search-a",
    provider: "codex",
    status: "completed",
    queries: ["first query"],
    sources: [{ url: "https://example.com/a", title: "A" }],
  };
  const searchB = {
    type: "hostedSearch",
    id: "search-b",
    provider: "codex",
    status: "completed",
    queries: ["second query"],
    sources: [{ url: "https://example.com/b", title: "B" }],
  };

  const assistant = hostedSearch.appendHostedSearchBlocksToAssistant(
    {
      role: "assistant",
      content: [{ type: "text", text: "First answer. Second answer." }],
    },
    [searchA, searchB],
    {
      orderedBlocks: [
        { kind: "hostedSearch", item: { ...searchA, status: "searching" } },
        { kind: "text", text: "First answer. " },
        { kind: "hostedSearch", item: { ...searchB, status: "searching" } },
        { kind: "text", text: "Second answer." },
      ],
    },
  );

  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["hostedSearch", "text", "hostedSearch", "text"],
  );
  assert.equal(assistant.content[0].id, "search-a");
  assert.equal(assistant.content[0].status, "completed");
  assert.equal(assistant.content[1].text, "First answer. ");
  assert.equal(assistant.content[2].id, "search-b");
  assert.equal(assistant.content[2].status, "completed");
  assert.equal(assistant.content[3].text, "Second answer.");
});

test("hosted search finalization keeps delayed tail search after preceding text", () => {
  const search = {
    type: "hostedSearch",
    id: "search-delayed",
    provider: "codex",
    status: "completed",
    queries: ["delayed query"],
    sources: [{ url: "https://example.com/delayed", title: "Delayed" }],
  };

  const assistant = hostedSearch.appendHostedSearchBlocksToAssistant(
    {
      role: "assistant",
      content: [{ type: "text", text: "Answer that arrived before metadata." }],
    },
    [search],
    {
      orderedBlocks: [
        { kind: "text", text: "Answer that arrived before metadata." },
        { kind: "hostedSearch", item: search },
      ],
    },
  );

  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["text", "hostedSearch"],
  );
  assert.equal(assistant.content[0].text, "Answer that arrived before metadata.");
  assert.equal(assistant.content[1].id, "search-delayed");
});

test("hosted search finalization infers sources from assistant text when provider omits citations", () => {
  const search = {
    type: "hostedSearch",
    id: "search-empty-metadata",
    provider: "codex",
    status: "completed",
    queries: [],
    sources: [],
  };
  const answerText = [
    "来源：",
    "- Dell 官方 iDRAC 页面：https://www.dell.com/en-us/lp/dt/open-manage-idrac",
    "- Dell iDRAC9 用户指南：https://www.dell.com/support/manuals/en-us/idrac9-lifecycle-controller-v7.x-series/idrac9_7.xx_ug/overview-of-idrac",
  ].join("\n");

  const assistant = hostedSearch.appendHostedSearchBlocksToAssistant(
    {
      role: "assistant",
      content: [{ type: "text", text: answerText }],
    },
    [search],
    {
      orderedBlocks: [
        { kind: "hostedSearch", item: search },
        { kind: "text", text: answerText },
      ],
    },
  );

  assert.equal(assistant.content[0].type, "hostedSearch");
  assert.deepEqual(
    assistant.content[0].sources.map((source) => [source.title, source.url]),
    [
      [
        "Dell 官方 iDRAC 页面",
        "https://www.dell.com/en-us/lp/dt/open-manage-idrac",
      ],
      [
        "Dell iDRAC9 用户指南",
        "https://www.dell.com/support/manuals/en-us/idrac9-lifecycle-controller-v7.x-series/idrac9_7.xx_ug/overview-of-idrac",
      ],
    ],
  );
});

test("hosted search finalization anchors delayed metadata near the search sentence", () => {
  const search = {
    type: "hostedSearch",
    id: "search-pattern",
    provider: "codex",
    status: "completed",
    queries: ["设计模式定义"],
    sources: [{ url: "https://example.com/pattern", title: "设计模式" }],
  };
  const fullText = "任务1完成：当前项目已经检查。现在按顺序进行联网检索设计模式定义。任务2完成：设计模式是软件工程里的可复用方案。来源：维基百科。";

  const assistant = hostedSearch.appendHostedSearchBlocksToAssistant(
    {
      role: "assistant",
      content: [{ type: "text", text: fullText }],
    },
    [search],
    {
      orderedBlocks: [
        { kind: "text", text: fullText },
        { kind: "hostedSearch", item: search },
      ],
    },
  );

  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["text", "hostedSearch", "text"],
  );
  assert.equal(
    assistant.content[0].text,
    "任务1完成：当前项目已经检查。现在按顺序进行联网检索设计模式定义。",
  );
  assert.equal(assistant.content[1].id, "search-pattern");
  assert.equal(
    assistant.content[2].text,
    "任务2完成：设计模式是软件工程里的可复用方案。来源：维基百科。",
  );
});

test("hosted search finalization does not split a sentence at the stream event offset", () => {
  const search = {
    type: "hostedSearch",
    id: "search-sentence",
    provider: "codex",
    status: "completed",
    queries: ["AI companion app revenue 2025 users pay loneliness"],
    sources: [{ url: "https://example.com/market", title: "Market" }],
  };
  const beforeSearch = "对，我前面犯的是工程师病：先造东西，再硬想怎么卖。现在反过来，我先看“谁";
  const afterSearch = "为什么会掏钱”。然后再分析产品。";

  const assistant = hostedSearch.appendHostedSearchBlocksToAssistant(
    {
      role: "assistant",
      content: [{ type: "text", text: beforeSearch + afterSearch }],
    },
    [search],
    {
      orderedBlocks: [
        { kind: "text", text: beforeSearch },
        { kind: "hostedSearch", item: search },
        { kind: "text", text: afterSearch },
      ],
    },
  );

  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["text", "hostedSearch", "text"],
  );
  assert.equal(
    assistant.content[0].text,
    `${beforeSearch}为什么会掏钱”。`,
  );
  assert.equal(assistant.content[1].id, "search-sentence");
  assert.equal(assistant.content[2].text, "然后再分析产品。");
});

test("hosted search finalization preserves protocol blocks around reordered text", () => {
  const search = {
    type: "hostedSearch",
    id: "search-1",
    provider: "codex",
    status: "completed",
    queries: ["query"],
    sources: [],
  };
  const assistant = hostedSearch.appendHostedSearchBlocksToAssistant(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private", thinkingSignature: "sig" },
        { type: "text", text: "answer" },
      ],
    },
    [search],
    {
      orderedBlocks: [
        { kind: "hostedSearch", item: search },
        { kind: "text", text: "answer" },
      ],
    },
  );

  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["thinking", "hostedSearch", "text"],
  );
  assert.equal(assistant.content[0].thinkingSignature, "sig");
  assert.equal(assistant.content[1].id, "search-1");
  assert.equal(assistant.content[2].text, "answer");
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
  const assistant = hostedSearch.appendHostedSearchBlocksToAssistant(
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
      ],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "stop",
      timestamp: 2,
    },
    [search],
    {
      orderedBlocks: [
        { kind: "text", text: "任务1完成。" },
        { kind: "hostedSearch", item: search },
        { kind: "text", text: "任务2继续输出。" },
      ],
    },
  );

  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["text", "hostedSearch", "toolCall", "text"],
  );
  assert.equal(assistant.content[1].id, "search-mid");

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

test("live hosted search card moves after the current sentence when more text arrives", () => {
  const initialRound = {
    round: 1,
    blocks: [],
    key: "live-search-sentence",
    runningToolCallIds: [],
    thinkingOpen: false,
  };
  const search = {
    type: "hostedSearch",
    id: "search-live-sentence",
    provider: "codex",
    status: "searching",
    queries: ["AI companion app revenue"],
    sources: [],
  };
  const beforeSearch = "现在反过来，我先看“谁";

  const withText = uiMessages.appendTextDeltaToRound(initialRound, beforeSearch);
  const withSearch = uiMessages.upsertHostedSearchToRound(withText, search);
  const withMoreText = uiMessages.appendTextDeltaToRound(
    withSearch,
    "为什么会掏钱”。然后再看市场。",
  );

  assert.deepEqual(
    withMoreText.blocks.map((block) => block.kind),
    ["text", "hostedSearch", "text"],
  );
  assert.equal(withMoreText.blocks[0].text, `${beforeSearch}为什么会掏钱”。`);
  assert.equal(withMoreText.blocks[1].item.id, "search-live-sentence");
  assert.equal(withMoreText.blocks[2].text, "然后再看市场。");
});

test("live hosted searches stay grouped when text streams between events", () => {
  const initialRound = {
    round: 1,
    blocks: [],
    key: "live-search-group",
    runningToolCallIds: [],
    thinkingOpen: false,
  };
  const searchA = {
    type: "hostedSearch",
    id: "search-a",
    provider: "codex",
    status: "completed",
    queries: ["first query"],
    sources: [{ url: "https://example.com/a", title: "A" }],
  };
  const searchB = {
    type: "hostedSearch",
    id: "search-b",
    provider: "codex",
    status: "completed",
    queries: ["second query"],
    sources: [{ url: "https://example.com/b", title: "B" }],
  };

  const withText = uiMessages.appendTextDeltaToRound(initialRound, "先查第一组资料。");
  const withSearchA = uiMessages.upsertHostedSearchToRound(withText, searchA);
  const withMiddleText = uiMessages.appendTextDeltaToRound(
    withSearchA,
    "继续说明中间过程。",
  );
  const withSearchB = uiMessages.upsertHostedSearchToRound(withMiddleText, searchB);

  assert.deepEqual(
    withSearchB.blocks.map((block) => block.kind),
    ["text", "hostedSearch", "hostedSearch", "text"],
  );
  assert.deepEqual(
    withSearchB.blocks
      .filter((block) => block.kind === "hostedSearch")
      .map((block) => block.item.id),
    ["search-a", "search-b"],
  );
});

test("UI message builder keeps hosted search after text when persisted at tail", () => {
  const messages = [
    { role: "user", content: "search", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        {
          type: "hostedSearch",
          id: "search-tail",
          provider: "codex",
          status: "completed",
          queries: ["tail query"],
          sources: [],
        },
      ],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "stop",
      timestamp: 2,
    },
  ];

  const ui = uiMessages.buildUiMessages(messages);
  assert.deepEqual(
    ui[1].rounds[0].blocks.map((block) => block.kind),
    ["text", "hostedSearch"],
  );
  assert.equal(ui[1].text, "answer");
});

test("UI message builder hydrates persisted hosted search sources from nearby answer links", () => {
  const messages = [
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
  ];

  const ui = uiMessages.buildUiMessages(messages);
  const searches = uiMessages.getRoundHostedSearches(ui[1].rounds[0]);
  assert.deepEqual(searches[0].sources, [
    {
      url: "https://www.dell.com/en-us/lp/dt/open-manage-idrac",
      title: "Dell 官方 iDRAC 页面",
      sourceType: "citation",
    },
  ]);
});

test("UI message builder keeps inferred sources scoped to each persisted search block", () => {
  const messages = [
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
  ];

  const ui = uiMessages.buildUiMessages(messages);
  const searches = uiMessages.getRoundHostedSearches(ui[1].rounds[0]);
  assert.deepEqual(
    searches.map((search) => search.sources.map((source) => source.url)),
    [["https://example.com/a"], ["https://example.com/b"]],
  );
});

test("UI message builder anchors delayed hosted search inside the text run", () => {
  const messages = [
    { role: "user", content: "search", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "任务1完成。现在按顺序进行联网检索设计模式定义。任务2完成：设计模式是可复用方案。" },
        {
          type: "hostedSearch",
          id: "search-pattern",
          provider: "codex",
          status: "completed",
          queries: ["设计模式定义"],
          sources: [],
        },
      ],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "stop",
      timestamp: 2,
    },
  ];

  const ui = uiMessages.buildUiMessages(messages);
  const blocks = ui[1].rounds[0].blocks;
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["text", "hostedSearch", "text"],
  );
  assert.equal(blocks[0].text, "任务1完成。现在按顺序进行联网检索设计模式定义。");
  assert.equal(blocks[2].text, "任务2完成：设计模式是可复用方案。");
});

test("UI message builder expands subagent batch results without showing the parent aggregate card", () => {
  const parentToolCall = {
    type: "toolCall",
    id: "call-agent",
    name: "Agent",
    arguments: {
      agents: [
        { id: "a", prompt: "Inspect A." },
        { id: "b", prompt: "Inspect B." },
      ],
      concurrency: 2,
    },
  };
  const parentToolResult = {
    role: "toolResult",
    toolCallId: "call-agent",
    toolName: "Agent",
    content: [{ type: "text", text: "aggregate result for model protocol" }],
    isError: false,
    timestamp: 3,
    details: {
      kind: "subagent_batch",
      status: "ok",
      agentCount: 2,
      concurrency: 2,
      totalDurationMs: 50,
      mode: "worktree",
      agents: [
        {
          id: "a",
          runId: "call-agent:agent:1:a:uuid",
          name: "Agent A",
          prompt: "Inspect A.",
          mode: "worktree",
          status: "completed",
          summary: "A done",
          applyStatus: "failed",
          applyError: "A patch conflict",
          durationMs: 20,
          rounds: 1,
          toolCalls: 2,
        },
        {
          id: "b",
          runId: "call-agent:agent:2:b:uuid",
          name: "Agent B",
          prompt: "Inspect B.",
          mode: "worktree",
          status: "failed",
          summary: "",
          error: "B failed",
          durationMs: 30,
          rounds: 1,
          toolCalls: 1,
        },
      ],
    },
  };

  const ui = uiMessages.buildUiMessages([
    { role: "user", content: "delegate", timestamp: 1 },
    {
      role: "assistant",
      content: [parentToolCall],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "toolUse",
      timestamp: 2,
    },
    parentToolResult,
  ]);

  const trace = uiMessages.getRoundToolTrace(ui[1].rounds[0]);
  assert.equal(trace.length, 2);
  assert.deepEqual(
    trace.map((item) => item.toolCall.id),
    ["call-agent:agent:1", "call-agent:agent:2"],
  );
  assert.ok(trace.every((item) => item.toolCall.name === "Agent"));
  assert.ok(trace.every((item) => item.toolCall.arguments.subagent_card === true));
  assert.deepEqual(
    trace.map((item) => item.toolCall.arguments.index),
    [1, 2],
  );
  assert.deepEqual(
    trace.map((item) => item.toolCall.arguments.total),
    [2, 2],
  );
  assert.deepEqual(
    trace.map((item) => item.toolResult.details.kind),
    ["subagent_card", "subagent_card"],
  );
  assert.deepEqual(
    trace.map((item) => item.toolResult.details.parentToolCallId),
    ["call-agent", "call-agent"],
  );
  assert.deepEqual(
    trace.map((item) => item.toolResult.details.agent.id),
    ["a", "b"],
  );
  assert.deepEqual(
    trace.map((item) => item.toolResult.isError),
    [false, true],
  );
  assert.equal(trace[0].toolResult.content[0].text, "A patch conflict");
  assert.equal(trace[1].toolResult.content[0].text, "B failed");

  const liveRound = {
    round: 1,
    blocks: [],
    key: "live-1",
    runningToolCallIds: [],
    thinkingOpen: false,
  };
  assert.equal(
    uiMessages.getRoundToolTrace(
      uiMessages.upsertToolCallToRound(liveRound, parentToolCall),
    ).length,
    0,
  );
});

test("subagent placeholders are built from complete structured agents before results arrive", () => {
  const parentToolCall = {
    type: "toolCall",
    id: "call-agent",
    name: "Agent",
    arguments: {
      agents: [
        { id: "a", name: "狼人玩家 1", prompt: "你是玩家 1，请继续发言。", mode: "readonly" },
        { id: "b", name: "狼人玩家 2", prompt: "你是玩家 2，请继续发言。" },
      ],
      concurrency: 2,
    },
  };

  const placeholders = uiMessages.buildSubagentPlaceholderToolCalls(parentToolCall);
  assert.equal(placeholders.length, 2);
  assert.deepEqual(
    placeholders.map((item) => item.id),
    ["call-agent:agent:1", "call-agent:agent:2"],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.subagent_card),
    [true, true],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.id),
    ["a", "b"],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.name),
    ["狼人玩家 1", "狼人玩家 2"],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.mode),
    ["readonly", undefined],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.parent_tool_call_id),
    ["call-agent", "call-agent"],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.index),
    [1, 2],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.total),
    [2, 2],
  );
  assert.deepEqual(
    placeholders.map((item) => item.arguments.concurrency),
    [2, 2],
  );

  const liveRound = {
    round: 1,
    blocks: [],
    key: "live-1",
    runningToolCallIds: [],
    thinkingOpen: false,
  };
  const withPlaceholders = placeholders.reduce(
    (round, toolCall) => uiMessages.upsertToolCallToRound(round, toolCall),
    liveRound,
  );
  assert.deepEqual(
    uiMessages.getRoundToolTrace(withPlaceholders).map((item) => item.toolCall.id),
    ["call-agent:agent:1", "call-agent:agent:2"],
  );

  const updated = uiMessages.upsertToolCallToRound(withPlaceholders, {
    ...placeholders[0],
    arguments: {
      ...placeholders[0].arguments,
      name: "稳定玩家 1",
    },
  });
  const updatedTrace = uiMessages.getRoundToolTrace(updated);
  assert.equal(updatedTrace.length, 2);
  assert.equal(updatedTrace[0].toolCall.arguments.name, "稳定玩家 1");
});

test("subagent placeholders skip partial streaming agents while keeping raw array indexes", () => {
  // Streaming JSON yields partial elements: [1] has no prompt yet and the
  // trailing element only started streaming its id.
  const midStream = uiMessages.buildSubagentPlaceholderToolCalls({
    type: "toolCall",
    id: "call-agent-live",
    name: "Agent",
    arguments: {
      agents: [
        { id: "seer", name: "预言家", prompt: "请选择一个玩家并给出查验理由。" },
        { id: "wolf", name: "狼人" },
        { id: "witch", prompt: "继续进行夜间策略讨论。" },
        { id: "hun" },
      ],
      concurrency: 8,
    },
  });

  assert.equal(midStream.length, 2);
  assert.deepEqual(
    midStream.map((item) => item.arguments.id),
    ["seer", "witch"],
  );
  // Ids and indexes follow the raw array positions, so a placeholder never
  // has to change identity once the skipped element finishes streaming.
  assert.deepEqual(
    midStream.map((item) => item.id),
    ["call-agent-live:agent:1", "call-agent-live:agent:3"],
  );
  assert.deepEqual(
    midStream.map((item) => item.arguments.index),
    [1, 3],
  );
  assert.deepEqual(
    midStream.map((item) => item.arguments.total),
    [4, 4],
  );
  // concurrency caps to the raw agent count.
  assert.deepEqual(
    midStream.map((item) => item.arguments.concurrency),
    [4, 4],
  );
});

test("subagent placeholders are only produced for parseable parent Agent calls", () => {
  assert.deepEqual(
    uiMessages.buildSubagentPlaceholderToolCalls({
      type: "toolCall",
      id: "call-other",
      name: "Read",
      arguments: { agents: [{ id: "a", prompt: "p" }] },
    }),
    [],
  );
  // A synthetic card call is not a parent call.
  assert.deepEqual(
    uiMessages.buildSubagentPlaceholderToolCalls({
      type: "toolCall",
      id: "call-agent:agent:1",
      name: "Agent",
      arguments: { subagent_card: true, id: "a", prompt: "p" },
    }),
    [],
  );
  // No agents yet / not an array yet while streaming.
  assert.deepEqual(
    uiMessages.buildSubagentPlaceholderToolCalls({
      type: "toolCall",
      id: "call-agent",
      name: "Agent",
      arguments: { agents: "@agent id=a" },
    }),
    [],
  );
  // Oversized arrays render nothing rather than a wall of cards.
  assert.deepEqual(
    uiMessages.buildSubagentPlaceholderToolCalls({
      type: "toolCall",
      id: "call-agent",
      name: "Agent",
      arguments: {
        agents: Array.from({ length: 9 }, (_, index) => ({ id: `a${index}`, prompt: "p" })),
      },
    }),
    [],
  );
});

test("rejected subagent batches keep the parent Agent call visible", () => {
  const parentToolCall = {
    type: "toolCall",
    id: "call-agent",
    name: "Agent",
    arguments: {
      agents: [
        { id: "dup", prompt: "one" },
        { id: "DUP", prompt: "two" },
      ],
    },
  };
  const rejectedResult = {
    role: "toolResult",
    toolCallId: "call-agent",
    toolName: "Agent",
    content: [{ type: "text", text: "Agent rejected this call. No subagents were started." }],
    isError: true,
    timestamp: 3,
    details: {
      kind: "subagent_batch",
      status: "rejected",
      agentCount: 0,
      concurrency: 0,
      totalDurationMs: 0,
      mode: "readonly",
      agents: [],
      issues: [{ agentId: "DUP", code: "duplicate_agent_id", message: "Duplicate agent id" }],
      roster: [],
      templates: [],
    },
  };

  const ui = uiMessages.buildUiMessages([
    { role: "user", content: "delegate", timestamp: 1 },
    {
      role: "assistant",
      content: [parentToolCall],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "toolUse",
      timestamp: 2,
    },
    rejectedResult,
  ]);

  const trace = uiMessages.getRoundToolTrace(ui[1].rounds[0]);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].toolCall.id, "call-agent");
  assert.equal(trace[0].toolResult.isError, true);
  assert.equal(trace[0].toolResult.details.status, "rejected");

  // The same parent stays hidden when the result is not an error.
  const liveRound = {
    round: 1,
    blocks: [],
    key: "live-1",
    runningToolCallIds: [],
    thinkingOpen: false,
  };
  const suppressed = uiMessages.attachToolResultToRound(liveRound, parentToolCall, {
    ...rejectedResult,
    isError: false,
  });
  assert.equal(uiMessages.getRoundToolTrace(suppressed).length, 0);
  const visible = uiMessages.attachToolResultToRound(liveRound, parentToolCall, rejectedResult);
  assert.deepEqual(
    uiMessages.getRoundToolTrace(visible).map((item) => item.toolCall.id),
    ["call-agent"],
  );
});

test("UI message builder uses the stable Agent name supplied by card results", () => {
  const firstToolCall = {
    type: "toolCall",
    id: "call-agent-first",
    name: "Agent",
    arguments: {
      agents: [
        {
          id: "agent-1",
          name: "哲学家 - 苏格拉底",
          prompt: "哲学视角探讨生命的意义",
        },
      ],
    },
  };
  const secondToolCall = {
    type: "toolCall",
    id: "call-agent-second",
    name: "Agent",
    arguments: {
      agents: [{ id: "agent-1", prompt: "哲学家继续回应" }],
    },
  };
  const firstToolResult = {
    role: "toolResult",
    toolCallId: "call-agent-first",
    toolName: "Agent",
    content: [{ type: "text", text: "first aggregate" }],
    isError: false,
    timestamp: 3,
    details: {
      kind: "subagent_batch",
      status: "ok",
      agentCount: 1,
      concurrency: 1,
      totalDurationMs: 10,
      mode: "readonly",
      agents: [
        {
          id: "agent-1",
          runId: "call-agent-first:agent:1:agent-1:uuid",
          name: "哲学家 - 苏格拉底",
          prompt: "哲学视角探讨生命的意义",
          mode: "readonly",
          status: "completed",
          summary: "first",
          durationMs: 10,
          rounds: 1,
          toolCalls: 0,
        },
      ],
    },
  };
  const secondToolResult = {
    ...firstToolResult,
    toolCallId: "call-agent-second",
    timestamp: 6,
    details: {
      ...firstToolResult.details,
      agents: [
        {
          ...firstToolResult.details.agents[0],
          runId: "call-agent-second:agent:1:agent-1:uuid",
          name: "哲学家 - 苏格拉底",
          role: "哲学视角",
          prompt: "哲学家继续回应",
          summary: "second",
        },
      ],
    },
  };

  const ui = uiMessages.buildUiMessages([
    { role: "user", content: "start", timestamp: 1 },
    {
      role: "assistant",
      content: [firstToolCall],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "toolUse",
      timestamp: 2,
    },
    firstToolResult,
    { role: "user", content: "continue", timestamp: 4 },
    {
      role: "assistant",
      content: [secondToolCall],
      provider: "codex",
      model: "gpt-5",
      api: "openai-responses",
      stopReason: "toolUse",
      timestamp: 5,
    },
    secondToolResult,
  ]);

  const firstTrace = uiMessages.getRoundToolTrace(ui[1].rounds[0]);
  const secondTrace = uiMessages.getRoundToolTrace(ui[3].rounds[0]);
  assert.equal(firstTrace[0].toolResult.details.agent.name, "哲学家 - 苏格拉底");
  assert.equal(secondTrace[0].toolCall.arguments.name, "哲学家 - 苏格拉底");
  assert.equal(secondTrace[0].toolResult.details.agent.name, "哲学家 - 苏格拉底");
  assert.equal(secondTrace[0].toolCall.arguments.role, "哲学视角");
  assert.equal(secondTrace[0].toolResult.details.agent.role, "哲学视角");
});

test("round update helpers append deltas, upsert tools, and collapse completed thinking", () => {
  const initialRound = {
    round: 1,
    blocks: [],
    key: "live-1",
    runningToolCallIds: [],
    thinkingOpen: true,
  };

  const withThinking = uiMessages.appendThinkingDeltaToRound(initialRound, "plan");
  const withText = uiMessages.appendTextDeltaToRound(withThinking, "answer");
  const withHostedSearch = uiMessages.upsertHostedSearchToRound(withText, {
    type: "hostedSearch",
    id: "search-live",
    provider: "codex",
    status: "searching",
    queries: ["live query"],
    sources: [],
  });
  const withHiddenProviderSearch = uiMessages.upsertToolCallToRound(withHostedSearch, {
    type: "toolCall",
    id: "dsml-tool-call-live-search",
    name: "builtin_web_search",
    arguments: { additionalContext: "live query" },
  });
  const toolCall = { type: "toolCall", id: "call-1", name: "Edit", arguments: { path: "a.txt" } };
  const withTool = uiMessages.upsertToolCallToRound(withHiddenProviderSearch, toolCall);
  const finalToolCall = {
    ...toolCall,
    arguments: { path: "a.txt", old_string: "old", new_string: "new" },
  };
  const withPartialTool = uiMessages.upsertToolCallToRound(withTool, finalToolCall);
  const withToolResult = uiMessages.attachToolResultToRound(withPartialTool, finalToolCall, {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "Edit",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 2,
  });

  assert.equal(uiMessages.getRoundText(withToolResult), "answer");
  assert.equal(uiMessages.getRoundThinkingText(withToolResult), "plan");
  assert.deepEqual(
    withHostedSearch.blocks.map((block) => block.kind),
    ["thinking", "text", "hostedSearch"],
  );
  assert.deepEqual(
    withHiddenProviderSearch.blocks.map((block) => block.kind),
    ["thinking", "text", "hostedSearch"],
  );
  assert.equal(uiMessages.getRoundHostedSearches(withToolResult).length, 1);
  assert.equal(uiMessages.getRoundToolTrace(withToolResult).length, 1);
  assert.deepEqual(uiMessages.getRoundToolTrace(withPartialTool)[0].toolCall.arguments, {
    path: "a.txt",
    old_string: "old",
    new_string: "new",
  });
  assert.equal(uiMessages.collapseThinking(withToolResult).thinkingOpen, false);

  const updated = uiMessages.updateLiveRound([initialRound, withText], 1, (round) =>
    uiMessages.appendTextDeltaToRound(round, "!"),
  );
  assert.equal(uiMessages.getRoundText(updated[1]), "answer!");
});

test("tool call summaries and argument display avoid dumping large payloads", () => {
  const editCall = {
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
  };

  assert.equal(
    uiMessages.summarizeToolCall(editCall),
    "Edit path=src/App.tsx expected=1 replaceAll=true",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "write-1",
      name: "Write",
      arguments: { path: "src/App.tsx", content: "line-1\nline-2" },
    }),
    "Write path=src/App.tsx mode=rewrite",
  );
  assert.deepEqual(uiMessages.toolCallArgsForDisplay(editCall), {
    path: "src/App.tsx",
    expected_replacements: 1,
    replace_all: true,
    oldChars: 20,
    newChars: 35,
  });
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "image-1",
      name: "Image",
      arguments: { path: "uploads/001.jpg" },
    }),
    "Image path=uploads/001.jpg",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "image-skills",
      name: "Image",
      arguments: { path: "skill://demo/assets/logo.png" },
    }),
    "Image path=skill://demo/assets/logo.png",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "image-2",
      name: "Image",
      arguments: { paths: ["uploads/001.jpg", "uploads/002.png"] },
    }),
    "Image paths=2 first=uploads/001.jpg",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "image-3",
      name: "Image",
      arguments: { url: "https://example.com/photo.png" },
    }),
    "Image url=https://example.com/photo.png",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "image-4",
      name: "Image",
      arguments: { base64: "data:image/png;base64," + "a".repeat(20) },
    }),
    "Image base64Chars=42",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "bash-skill",
      name: "Bash",
      arguments: {
        cwd: "skill://metaphysics-steward/scripts",
        command: "python3 steward.py",
        timeout_ms: 1000,
      },
    }),
    "Bash cwd=skill://metaphysics-steward/scripts timeout_ms=1000 command=python3 steward.py",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "agent-card",
      name: "Agent",
      arguments: {
        subagent_card: true,
        id: "philosopher",
        name: "Philosophy Agent",
        prompt: "从哲学角度探讨生命的意义",
        mode: "worktree",
        concurrency: 4,
      },
    }),
    "Agent agent=philosopher name=Philosophy Agent prompt=从哲学角度探讨生命的意义 mode=worktree concurrency=4",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "agent-parent",
      name: "Agent",
      arguments: {
        agents: [
          { id: "a", prompt: "one" },
          { id: "b", prompt: "two" },
        ],
        concurrency: 2,
      },
    }),
    "Agent agents=2 concurrency=2",
  );
  assert.deepEqual(
    uiMessages.toolCallArgsForDisplay({
      type: "toolCall",
      id: "agent-card",
      name: "Agent",
      arguments: {
        name: "Philosophy Agent",
        prompt: "Long delegated prompt",
        mode: "worktree",
      },
    }),
    {
      id: undefined,
      name: "Philosophy Agent",
      role: undefined,
      prompt: "Long delegated prompt",
      mode: "worktree",
      identityChars: undefined,
      promptChars: 21,
      agentCount: undefined,
      concurrency: undefined,
    },
  );
  assert.deepEqual(
    uiMessages.toolCallArgsForDisplay({
      type: "toolCall",
      id: "agent-parent",
      name: "Agent",
      arguments: {
        agents: [
          { id: "a", prompt: "one" },
          { id: "b", prompt: "two", template: "reviewer" },
        ],
        concurrency: 2,
      },
    }),
    {
      id: undefined,
      name: undefined,
      role: undefined,
      prompt: undefined,
      mode: undefined,
      identityChars: undefined,
      promptChars: undefined,
      agentCount: 2,
      concurrency: 2,
    },
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "send-message",
      name: "SendMessage",
      arguments: {
        to: "parent",
        channel: "question",
        subject: "Scope",
        message: "Should we keep Markdown-only bus?",
      },
    }),
    "SendMessage to=parent channel=question subject=Scope messageChars=33",
  );
  assert.deepEqual(
    uiMessages.toolCallArgsForDisplay({
      type: "toolCall",
      id: "send-message",
      name: "SendMessage",
      arguments: {
        to: "parent",
        channel: "question",
        subject: "Scope",
        message: "Should we keep Markdown-only bus?",
      },
    }),
    {
      to: "parent",
      channel: "question",
      subject: "Scope",
      messageChars: 33,
    },
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "skill-install",
      name: "SkillsManager",
      arguments: {
        action: "install",
        source: "https://github.com/example/repo/tree/main/skills/demo",
        name: "demo-skill",
        conflict: "backup",
      },
    }),
    "SkillsManager action=install source=https://github.com/example/repo/tree/main/skills/demo name=demo-skill conflict=backup",
  );
  assert.equal(
    uiMessages.summarizeToolCall({
      type: "toolCall",
      id: "skill-create",
      name: "SkillsManager",
      arguments: {
        action: "create",
        name: "workflow-skill",
        conflict: "fail",
      },
    }),
    "SkillsManager action=create name=workflow-skill conflict=fail",
  );
  assert.deepEqual(
    uiMessages.toolCallArgsForDisplay({
      type: "toolCall",
      id: "image-5",
      name: "Image",
      arguments: {
        source: "data:image/png;base64," + "a".repeat(20),
        base64: "b".repeat(900),
      },
    }),
    {
      source: "dataUrlChars=42",
      base64: "base64Chars=900",
    },
  );
  assert.match(uiMessages.previewText("x".repeat(1300)), /len=1300/);
});

test("seed tool call recovery converts XML-like markup into structured tool calls", () => {
  const assistant = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "deepseek-chat",
    content: [
      {
        type: "text",
        text: `Before
<seed:tool_call>
  <function name="Write">
    <parameter name="path">notes.txt</parameter>
    <parameter name="content" string="true">&lt;hello&gt;</parameter>
    <parameter name="replace_all">true</parameter>
    <parameter name="count">3</parameter>
  </function>
</seed:tool_call>
After`,
      },
    ],
    timestamp: 1,
  };

  const recovered = seedToolCalls.recoverAssistantSeedToolCalls(assistant);
  assert.ok(recovered);
  assert.equal(recovered.toolCalls.length, 1);
  assert.equal(recovered.toolCalls[0].name, "Write");
  assert.deepEqual(recovered.toolCalls[0].arguments, {
    path: "notes.txt",
    content: "<hello>",
    replace_all: true,
    count: 3,
  });
  assert.equal(recovered.assistant.content[0].text, "Before\n\nAfter");
  assert.equal(seedToolCalls.stripSeedToolCallMarkup(assistant.content[0].text), "Before\n\nAfter");
});

test("seed tool call recovery converts flattened DeepSeek tool request text", () => {
  const assistant = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "deepseek-chat",
    content: [
      {
        type: "text",
        text: `Before

Previous assistant tool request:
tool_call_id: call_00_recovered
tool_name: Read
arguments:
{
  "path": "src/App.tsx",
  "line": 12,
  "flags": {
    "raw": true
  }
}

After`,
      },
    ],
    timestamp: 1,
  };

  const recovered = seedToolCalls.recoverAssistantSeedToolCalls(assistant);
  assert.ok(recovered);
  assert.equal(recovered.toolCalls.length, 1);
  assert.equal(recovered.toolCalls[0].id, "call_00_recovered");
  assert.equal(recovered.toolCalls[0].name, "Read");
  assert.deepEqual(recovered.toolCalls[0].arguments, {
    path: "src/App.tsx",
    line: 12,
    flags: { raw: true },
  });
  assert.equal(recovered.assistant.content[0].text, "Before\n\nAfter");
  assert.equal(
    seedToolCalls.stripSeedToolCallMarkup(assistant.content[0].text, {
      recoverFlattenedText: true,
    }),
    "Before\n\nAfter",
  );
});

test("streaming Write and Edit tool previews expose bounded live argument previews", () => {
  const missingWrite = toolPreview.deriveFileToolPreview({
    type: "toolCall",
    id: "write-missing",
    name: "Write",
    arguments: { path: "report.md" },
  });
  assert.equal(missingWrite.path, "report.md");
  assert.equal(missingWrite.content.has, false);
  assert.equal(missingWrite.content.chars, 0);
  assert.equal(missingWrite.content.lines, 0);

  const longContent = `line 1\n${"x".repeat(4100)}`;
  const writePreview = toolPreview.deriveFileToolPreview({
    type: "toolCall",
    id: "write-live",
    name: "Write",
    arguments: { path: "report.md", content: longContent },
  });
  assert.equal(writePreview.content.has, true);
  assert.equal(writePreview.content.chars, longContent.length);
  assert.equal(writePreview.content.lines, 2);
  assert.equal(writePreview.content.truncated, true);
  assert.match(writePreview.content.text, /truncated/);
  assert.ok(writePreview.content.text.length <= 4100);

  const editPreview = toolPreview.deriveFileToolPreview({
    type: "toolCall",
    id: "edit-live",
    name: "Edit",
    arguments: {
      path: "src/App.tsx",
      old_string: "const oldValue = true;",
      new_string: "",
      expected_replacements: 1,
      replace_all: true,
    },
  });
  assert.equal(editPreview.path, "src/App.tsx");
  assert.equal(editPreview.oldString.has, true);
  assert.equal(editPreview.oldString.chars, 22);
  assert.equal(editPreview.newString.has, true);
  assert.equal(editPreview.newString.chars, 0);
  assert.equal(editPreview.expectedReplacements, 1);
  assert.equal(editPreview.replaceAll, true);
});

test("live tool call upserts snapshot mutable streaming arguments", () => {
  const round = {
    round: 1,
    blocks: [],
    runningToolCallIds: [],
    thinkingOpen: false,
  };
  const streamingToolCall = {
    type: "toolCall",
    id: "write-live",
    name: "Write",
    arguments: { path: "report.md", content: "first" },
  };

  const first = uiMessages.upsertToolCallToRound(round, streamingToolCall);
  streamingToolCall.arguments.content = "first\nsecond";
  const second = uiMessages.upsertToolCallToRound(first, streamingToolCall);

  const firstToolCall = uiMessages.getRoundToolTrace(first)[0].toolCall;
  const secondToolCall = uiMessages.getRoundToolTrace(second)[0].toolCall;
  assert.equal(firstToolCall.arguments.content, "first");
  assert.equal(secondToolCall.arguments.content, "first\nsecond");
  assert.notEqual(firstToolCall, secondToolCall);
  assert.notEqual(firstToolCall.arguments, secondToolCall.arguments);
});

test("visible live tool calls are marked running as soon as their cards appear", () => {
  const round = {
    round: 1,
    blocks: [],
    key: "live-tools-running",
    runningToolCallIds: [],
    thinkingOpen: false,
  };
  const toolCalls = [
    {
      type: "toolCall",
      id: "call-write-live",
      name: "Write",
      arguments: { path: "report.md", content: "partial content" },
    },
    {
      type: "toolCall",
      id: "call-edit-live",
      name: "Edit",
      arguments: { path: "report.md", old_string: "before", new_string: "after" },
    },
    {
      type: "toolCall",
      id: "call-bash-live",
      name: "Bash",
      arguments: { command: "pnpm test" },
    },
    {
      type: "toolCall",
      id: "call-agent:agent:1",
      name: "Agent",
      arguments: {
        subagent_card: true,
        parent_tool_call_id: "call-agent",
        index: 1,
        total: 1,
        id: "reviewer",
        name: "Reviewer",
        prompt: "Review the change.",
      },
    },
  ];

  let running = round;
  for (const toolCall of toolCalls) {
    running = uiMessages.upsertToolCallToRound(running, toolCall);
    running = uiMessages.markToolCallRunningInRound(running, toolCall);
  }
  const repeated = uiMessages.markToolCallRunningInRound(running, toolCalls[0]);

  assert.deepEqual(running.runningToolCallIds, [
    "call-write-live",
    "call-edit-live",
    "call-bash-live",
    "call-agent:agent:1",
  ]);
  assert.strictEqual(repeated, running);

  const hiddenParentAgent = {
    type: "toolCall",
    id: "call-agent",
    name: "Agent",
    arguments: {
      agents: [{ id: "reviewer", prompt: "Review the change." }],
    },
  };
  const parentOnly = uiMessages.markToolCallRunningInRound(
    uiMessages.upsertToolCallToRound(round, hiddenParentAgent),
    hiddenParentAgent,
  );
  assert.deepEqual(parentOnly.runningToolCallIds, []);
});

test("seed tool call recovery strips repeated historical tool call text without duplicating native calls", () => {
  const assistant = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "deepseek-chat",
    content: [
      {
        type: "text",
        text: `Before

Historical tool call (read-only, not repeating):
tool_name: Grep
arguments: {"pattern": "express", "file_pattern": "**/*.js", "ignore_case": true}

After`,
      },
      {
        type: "toolCall",
        id: "call_00_native_grep",
        name: "Grep",
        arguments: {
          pattern: "express",
          file_pattern: "**/*.js",
          ignore_case: true,
        },
      },
    ],
    timestamp: 1,
  };

  const recovered = seedToolCalls.recoverAssistantSeedToolCalls(assistant);
  assert.ok(recovered);
  assert.equal(recovered.toolCalls.length, 0);
  assert.equal(recovered.assistant.content.length, 2);
  assert.equal(recovered.assistant.content[0].text, "Before\n\nAfter");
  assert.equal(recovered.assistant.content[1].id, "call_00_native_grep");
  assert.equal(
    seedToolCalls.stripSeedToolCallMarkup(assistant.content[0].text, {
      recoverFlattenedText: true,
    }),
    "Before\n\nAfter",
  );
});

test("seed tool call recovery strips bare tool_name text without duplicating native calls", () => {
  const assistant = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "deepseek-chat",
    content: [
      {
        type: "text",
        text: `Before

tool_name: Grep
arguments:
{
"pattern": "express|route|api",
"file_pattern": "*.js",
"output_mode": "content",
"ignore_case": true
}

After`,
      },
      {
        type: "toolCall",
        id: "call_00_native_route_grep",
        name: "Grep",
        arguments: {
          pattern: "express|route|api",
          file_pattern: "*.js",
          output_mode: "content",
          ignore_case: true,
        },
      },
    ],
    timestamp: 1,
  };

  const recovered = seedToolCalls.recoverAssistantSeedToolCalls(assistant);
  assert.ok(recovered);
  assert.equal(recovered.toolCalls.length, 0);
  assert.equal(recovered.assistant.content.length, 2);
  assert.equal(recovered.assistant.content[0].text, "Before\n\nAfter");
  assert.equal(recovered.assistant.content[1].id, "call_00_native_route_grep");
  assert.equal(
    seedToolCalls.stripSeedToolCallMarkup(assistant.content[0].text, {
      recoverFlattenedText: true,
    }),
    "Before\n\nAfter",
  );
});

test("seed tool call recovery strips malformed labeled DeepSeek historical tool text", () => {
  const assistant = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "deepseek-v4-flash",
    content: [
      {
        type: "text",
        text: `**Edit / Write 正常。** 继续测试 **Bash、MemoryManager 和管道类工具**：



Historical assistant tool request (read-only context; do not repeat):
tool_call_id: call_00_malformed_bash
tool_name: Bash
arguments:
{
  "command": "echo 'Node: $(node --version 2>/dev/null || echo "未安装")'"
}
`,
      },
      {
        type: "toolCall",
        id: "call_01_native_bash",
        name: "Bash",
        arguments: {
          command: "ls -la tool-test/",
          cwd: ".",
        },
      },
    ],
    timestamp: 1,
  };

  const recovered = seedToolCalls.recoverAssistantSeedToolCalls(assistant);
  assert.ok(recovered);
  assert.equal(recovered.toolCalls.length, 0);
  assert.equal(recovered.assistant.content.length, 2);
  assert.equal(recovered.assistant.content[0].text.includes("Historical assistant"), false);
  assert.equal(recovered.assistant.content[0].text.includes("tool_name: Bash"), false);
  assert.equal(
    recovered.assistant.content[0].text,
    "**Edit / Write 正常。** 继续测试 **Bash、MemoryManager 和管道类工具**：",
  );
  assert.equal(recovered.assistant.content[1].id, "call_01_native_bash");
});

test("seed tool call recovery strips DeepSeek orphan DSML close text after native calls", () => {
  const dsml = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
  const assistant = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "deepseek-v4-pro",
    content: [
      {
        type: "text",
        text: "Bash 正常。继续：\n\n## 五、Edit — 精确字符串替换\n\n",
      },
      {
        type: "toolCall",
        id: "call_00_native_edit",
        name: "Edit",
        arguments: {
          path: "README.md",
          old_string: "old",
          new_string: "new",
        },
      },
      {
        type: "text",
        text: `\n</${dsml}parameter>\n</${dsml}invoke>\n</${dsml}tool_calls>`,
      },
    ],
    timestamp: 1,
  };

  const recovered = seedToolCalls.recoverAssistantSeedToolCalls(assistant);
  assert.ok(recovered);
  assert.equal(recovered.toolCalls.length, 0);
  assert.deepEqual(
    recovered.assistant.content.map((block) => block.type),
    ["text", "toolCall"],
  );
  assert.equal(recovered.assistant.content[0].text.includes("DSML"), false);
  assert.equal(recovered.assistant.content[1].id, "call_00_native_edit");
});

test("seed tool call recovery preserves non-DeepSeek flattened tool text", () => {
  const assistant = {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    content: [
      {
        type: "text",
        text: `Before

tool_name: Grep
arguments:
{
"pattern": "express|route|api",
"file_pattern": "*.js",
"output_mode": "content",
"ignore_case": true
}

After`,
      },
    ],
    timestamp: 1,
  };

  const recovered = seedToolCalls.recoverAssistantSeedToolCalls(assistant);
  assert.equal(recovered, null);
  assert.equal(
    seedToolCalls.stripSeedToolCallMarkup(assistant.content[0].text),
    assistant.content[0].text,
  );
});

test("seed tool call recovery preserves non-json DeepSeek tool_name prose", () => {
  const assistant = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "deepseek-chat",
    content: [
      {
        type: "text",
        text: `Before

tool_name: is just a field name in this explanation
arguments: are described in prose, not JSON

After`,
      },
    ],
    timestamp: 1,
  };

  const recovered = seedToolCalls.recoverAssistantSeedToolCalls(assistant);
  assert.equal(recovered, null);
  assert.equal(
    seedToolCalls.stripSeedToolCallMarkup(assistant.content[0].text, {
      recoverFlattenedText: true,
    }),
    assistant.content[0].text,
  );
});

test("chat page helpers keep model options stable and normalize status/title edge cases", () => {
  const appSettings = {
    customProviders: [
      { id: "p1", name: "P1", type: "codex", activeModels: ["a", "b"] },
      { id: "p2", name: "P2", type: "claude_code", activeModels: ["c"] },
    ],
    selectedModel: { customProviderId: "p1", model: "b" },
  };

  assert.deepEqual(
    chatHelpers.buildModelOptions(appSettings).map((option) => option.value),
    ["p1::b", "p1::a", "p2::c"],
  );
  assert.equal(chatHelpers.normalizeConversationTitle("  one two \n three  "), "one two three");
  assert.equal(chatHelpers.normalizeConversationTitle("one two three four five six seven eight nine ten eleven"), "one two three four five six seven eight nine ten");
  assert.equal(chatHelpers.buildFallbackConversationTitle("x".repeat(60)), `${"x".repeat(48)}...`);
  assert.equal(chatHelpers.normalizeLiveToolStatus("第 2 轮：模型生成中..."), chatHelpers.VIBING_STATUS);
  assert.equal(chatHelpers.normalizeLiveToolStatus("Running"), "Running");
  assert.equal(chatHelpers.isAbortLikeError(new Error("AbortError: aborted")), true);
  assert.equal(chatHelpers.isAbortLikeError("network failed"), false);
});

test("chat page helpers keep same-name provider instances in separate model groups", () => {
  const modelOptions = chatHelpers.buildModelOptions({
    customProviders: [
      {
        id: "same-api-a",
        name: "Shared",
        type: "codex",
        activeModels: ["shared-model", "model-a"],
      },
      { id: "same-api-b", name: "Shared", type: "codex", activeModels: ["shared-model"] },
      { id: "different-api", name: "Shared", type: "claude_code", activeModels: ["model-c"] },
    ],
    selectedModel: { customProviderId: "same-api-b", model: "shared-model" },
  });

  const groups = chatHelpers.groupModelOptionsByProvider(modelOptions);

  assert.deepEqual(
    groups.map((group) => ({
      id: group.id,
      name: group.name,
      type: group.providerType,
      options: group.opts.map((option) => ({ value: option.value, model: option.model })),
    })),
    [
      {
        id: "same-api-b",
        name: "Shared",
        type: "codex",
        options: [{ value: "same-api-b::shared-model", model: "shared-model" }],
      },
      {
        id: "same-api-a",
        name: "Shared",
        type: "codex",
        options: [
          { value: "same-api-a::shared-model", model: "shared-model" },
          { value: "same-api-a::model-a", model: "model-a" },
        ],
      },
      {
        id: "different-api",
        name: "Shared",
        type: "claude_code",
        options: [{ value: "different-api::model-c", model: "model-c" }],
      },
    ],
  );
});
