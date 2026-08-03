import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");

function user(content, timestamp, extra = {}) {
  return { role: "user", content, timestamp, ...extra };
}

function assistant(text, timestamp, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
    ...extra,
  };
}

function checkpoint(text, timestamp, responseId) {
  return assistant(text, timestamp, {
    api: "liveagent-compaction",
    provider: "liveagent",
    model: "summary",
    responseId,
    promptVersion: "summary-v2",
  });
}

function toolCallAssistant(callId, timestamp, name = "Bash") {
  return assistant("", timestamp, {
    content: [{ type: "toolCall", id: callId, name, arguments: { command: "ls" } }],
    stopReason: "toolUse",
  });
}

function toolResultMessage(callId, timestamp, text = "ok") {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "Bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function storedSegment(segmentIndex, segmentId, messages, extra = {}) {
  const createdAt = messages[0]?.timestamp ?? segmentIndex * 1_000 + 1;
  const updatedAt = messages.at(-1)?.timestamp ?? createdAt;
  return {
    segmentIndex,
    segmentId,
    messages,
    messageCount: messages.length,
    createdAt,
    updatedAt,
    ...extra,
  };
}

function transcriptSlice(segment, startMessageIndex, endMessageIndex = segment.messages.length) {
  return {
    segmentIndex: segment.segmentIndex,
    segmentId: segment.segmentId,
    summary: segment.summary,
    messages: segment.messages.slice(startMessageIndex, endMessageIndex),
    startMessageIndex,
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt,
  };
}

function createProjection(
  segments,
  activeSegmentIndex,
  {
    oldestMessageOffset = 0,
    hasMoreBefore = false,
    revision = null,
  } = {},
) {
  return conversationState.createTranscriptProjection({
    segments,
    activeSegmentIndex,
    oldestMessageOffset,
    hasMoreBefore,
    revision,
  });
}

function timeline(state) {
  return state.transcript.items;
}

function fullRuntimeTimeline(state) {
  return conversationState.normalizeConversationState({
    meta: {
      systemPrompt: state.meta.systemPrompt,
      tools: state.meta.tools,
      totalSegmentCount: state.meta.totalSegmentCount,
      totalMessageCount: state.meta.totalMessageCount,
    },
    segments: state.segments,
  }).transcript.items;
}

function assertMatchesFullRuntimeTimeline(state) {
  assert.deepEqual(timeline(state), fullRuntimeTimeline(state));
}

function textBlocks(item) {
  if (item.kind !== "assistant") return [];
  return item.rounds.flatMap((round) =>
    round.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text),
  );
}

test("conversation state builds transcript projection and request context", () => {
  const state = conversationState.createConversationStateFromContext({
    systemPrompt: "Base prompt",
    tools: [{ name: "Read" }],
    messages: [user("hello", 1, { id: "u-1" }), assistant("world", 2, { id: "a-1" })],
  });

  assert.equal(state.meta.schemaVersion, 4);
  assert.equal(state.meta.skillPresetId, "default");
  assert.equal(state.meta.skillsDisabled, false);
  assert.equal(state.meta.totalMessageCount, 2);
  assert.equal(state.activeSegmentIndex, 0);
  assert.equal(timeline(state).length, 2);
  assert.deepEqual(state.transcript.segmentWindows, [
    {
      segmentIndex: 0,
      segmentId: state.segments[0].segmentId,
      startMessageIndex: 0,
      endMessageIndex: 2,
    },
  ]);
  assert.equal(state.transcript.oldestMessageOffset, 0);
  assert.equal(state.transcript.hasMoreBefore, false);

  const requestContext = conversationState.buildRequestContext(state);
  assert.equal(requestContext.systemPrompt, "Base prompt");
  assert.deepEqual(requestContext.tools, [{ name: "Read" }]);
  assert.deepEqual(
    requestContext.messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("conversation normalization preserves per-conversation skills metadata", () => {
  const seeded = conversationState.createConversationStateFromContext({ messages: [] });
  const normalized = conversationState.normalizeConversationState({
    meta: {
      systemPrompt: "prompt",
      skillPresetId: "focused",
      skillsDisabled: true,
    },
    segments: seeded.segments,
  });

  assert.equal(normalized.meta.schemaVersion, 4);
  assert.equal(normalized.meta.skillPresetId, "focused");
  assert.equal(normalized.meta.skillsDisabled, true);

  const appended = conversationState.appendMessagesToConversation(normalized, [user("next", 3)]);
  assert.equal(appended.meta.skillPresetId, "focused");
  assert.equal(appended.meta.skillsDisabled, true);
});

test("request context omits silent memory extraction artifacts but transcript keeps them", () => {
  const memoryToolCall = {
    type: "toolCall",
    id: "memory-tool-1",
    name: "MemoryManager",
    arguments: { action: "update", slug: "daily-2026-05-14", mode: "append" },
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [
      user("以后请用陕西腔。", 1),
      assistant("没问题。", 2),
      assistant("", 3, { content: [memoryToolCall], stopReason: "toolUse" }),
      {
        role: "toolResult",
        toolCallId: memoryToolCall.id,
        toolName: "MemoryManager",
        content: [{ type: "text", text: "Updated memory global/daily-2026-05-14" }],
        details: { updated: true, slug: "daily-2026-05-14" },
        isError: false,
        timestamp: 4,
      },
      assistant("记忆整理完成。", 5),
    ],
  });

  assert.equal(state.segments[0].messages.length, 5);
  assert.match(JSON.stringify(timeline(state)), /MemoryManager/);
  assert.match(JSON.stringify(timeline(state)), /记忆整理完成。/);

  const requestContext = conversationState.buildRequestContext(state);
  assert.deepEqual(
    requestContext.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.doesNotMatch(JSON.stringify(requestContext.messages), /MemoryManager/);
  assert.doesNotMatch(JSON.stringify(requestContext.messages), /记忆整理完成。/);
});

test("direct MemoryManager conversations remain in model context", () => {
  const memoryToolCall = {
    type: "toolCall",
    id: "memory-tool-direct",
    name: "MemoryManager",
    arguments: { action: "write", slug: "user-preference", scope: "global" },
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [
      user("请直接整理这条记忆。", 1),
      assistant("", 2, { content: [memoryToolCall], stopReason: "toolUse" }),
      {
        role: "toolResult",
        toolCallId: memoryToolCall.id,
        toolName: "MemoryManager",
        content: [{ type: "text", text: "Created memory global/user-preference" }],
        details: { created: true, slug: "user-preference" },
        isError: false,
        timestamp: 3,
      },
      assistant("记忆整理完成。", 4),
    ],
  });

  const requestContext = conversationState.buildRequestContext(state);
  assert.equal(requestContext.messages.length, 4);
  assert.match(JSON.stringify(requestContext.messages), /MemoryManager/);
  assert.match(JSON.stringify(requestContext.messages), /记忆整理完成。/);
});

test("normalize accepts a direct transcript window without re-homing absolute segments", () => {
  const older = storedSegment(5, "segment-5", [
    user("older question", 51, { id: "u-5" }),
    assistant("older answer", 52, { id: "a-5" }),
  ]);
  const active = storedSegment(7, "segment-7", [
    user("active question", 71, { id: "u-7" }),
    assistant("active answer", 72, { id: "a-7" }),
  ]);
  const projection = createProjection(
    [transcriptSlice(older, 0), transcriptSlice(active, 1)],
    7,
    { oldestMessageOffset: 18, hasMoreBefore: true, revision: "revision-7" },
  );

  const state = conversationState.normalizeConversationState({
    meta: {
      systemPrompt: "windowed",
      activeSegmentIndex: 7,
      totalSegmentCount: 8,
      totalMessageCount: 20,
    },
    segments: [active],
    transcript: projection,
  });

  assert.equal(state.transcript, projection);
  assert.equal(state.activeSegmentIndex, 0, "runtime active index stays array-relative");
  assert.equal(state.segments[0].segmentIndex, 7);
  assert.equal(state.meta.activeSegmentIndex, 7, "metadata keeps the absolute segment index");
  assert.equal(state.meta.totalSegmentCount, 8);
  assert.equal(state.meta.totalMessageCount, 20);
  assert.deepEqual(
    state.transcript.segmentWindows.map((window) => [
      window.segmentIndex,
      window.startMessageIndex,
      window.endMessageIndex,
    ]),
    [
      [5, 0, 2],
      [7, 1, 2],
    ],
  );
  assert.deepEqual(
    timeline(state).map((item) => item.segmentIndex),
    [5, 5, 7],
  );
  assert.match(timeline(state).at(-1).key, /assistant-1-2-/);
  assert.deepEqual(
    conversationState.buildRequestContext(state).messages.map((message) => message.role),
    ["user", "assistant"],
    "request context comes from the complete runtime active segment",
  );
});

test("compaction advances absolute segment indexes and preserves the active visible start", () => {
  const older = storedSegment(5, "segment-5", [
    user("older question", 51, { id: "u-5" }),
    assistant("older answer", 52, { id: "a-5" }),
  ]);
  const active = storedSegment(7, "segment-7", [
    user("hidden active question", 71, { id: "u-7" }),
    assistant("visible active answer", 72, { id: "a-7" }),
  ]);
  const projection = createProjection(
    [transcriptSlice(older, 0), transcriptSlice(active, 1)],
    7,
    { oldestMessageOffset: 18, hasMoreBefore: true, revision: "revision-7" },
  );
  const state = conversationState.normalizeConversationState({
    meta: { activeSegmentIndex: 7, totalSegmentCount: 8, totalMessageCount: 20 },
    segments: [active],
    transcript: projection,
  });

  const compacted = conversationState.applyCompactionCheckpoint(
    state,
    checkpoint("Compressed absolute history", 80, "summary-8"),
  );

  assert.deepEqual(
    compacted.segments.map((segment) => segment.segmentIndex),
    [7, 8],
  );
  assert.equal(compacted.activeSegmentIndex, 1);
  assert.equal(compacted.meta.activeSegmentIndex, 8);
  assert.equal(compacted.meta.totalSegmentCount, 9);
  assert.equal(compacted.meta.totalMessageCount, 20);
  assert.equal(compacted.segments[1].summary.id, "summary-8");
  assert.equal(compacted.segments[1].summary.summaryMeta.coveredMessageCount, 20);
  assert.deepEqual(
    compacted.transcript.segmentWindows.map((window) => [
      window.segmentIndex,
      window.startMessageIndex,
      window.endMessageIndex,
    ]),
    [
      [5, 0, 2],
      [7, 1, 2],
      [8, 0, 0],
    ],
  );
  assert.doesNotMatch(JSON.stringify(timeline(compacted)), /hidden active question/);
  assert.equal(timeline(compacted).at(-1).kind, "summary");
  assert.equal(timeline(compacted).at(-1).segmentIndex, 8);
  for (const item of timeline(compacted).slice(0, -1)) {
    if (item.kind !== "summary") assert.equal(item.isFromCompactedSegment, true);
  }

  const requestContext = conversationState.buildRequestContext(compacted);
  assert.match(requestContext.systemPrompt, /Compressed absolute history/);
  assert.deepEqual(requestContext.messages, []);
});

test("partial assistant append rebuilds only the visible trailing run with absolute offsets", () => {
  const active = storedSegment(4, "segment-4", [
    user("hidden question", 41, { id: "u-4" }),
    assistant("first partial answer", 42, { id: "a-4-1" }),
  ]);
  const projection = createProjection([transcriptSlice(active, 1)], 4, {
    oldestMessageOffset: 1,
    hasMoreBefore: true,
    revision: "revision-partial",
  });
  const state = conversationState.normalizeConversationState({
    meta: { activeSegmentIndex: 4, totalSegmentCount: 5, totalMessageCount: 2 },
    segments: [active],
    transcript: projection,
  });
  const previousAssistant = timeline(state)[0];

  const appended = conversationState.appendMessagesToConversation(state, [
    assistant("second partial answer", 43, { id: "a-4-2" }),
  ]);

  assert.equal(appended.segments[0].messages.length, 3);
  assert.equal(timeline(appended).length, 1);
  assert.notEqual(timeline(appended)[0], previousAssistant);
  assert.equal(timeline(appended)[0].kind, "assistant");
  assert.equal(timeline(appended)[0].rounds.length, 2);
  assert.deepEqual(textBlocks(timeline(appended)[0]), [
    "first partial answer",
    "second partial answer",
  ]);
  assert.match(timeline(appended)[0].key, /assistant-1-3-/);
  assert.deepEqual(appended.transcript.segmentWindows, [
    {
      segmentIndex: 4,
      segmentId: "segment-4",
      startMessageIndex: 1,
      endMessageIndex: 3,
    },
  ]);
  assert.equal(appended.transcript.oldestMessageOffset, 1);
  assert.equal(appended.transcript.hasMoreBefore, true);
  assert.equal(appended.transcript.revision, null);
  assert.doesNotMatch(JSON.stringify(timeline(appended)), /hidden question/);
});

test("a contentless partial assistant run gains visible content without exposing hidden messages", () => {
  const active = storedSegment(4, "segment-4-empty", [
    user("hidden question", 41, { id: "u-hidden" }),
    assistant("", 42, { id: "a-empty", content: [] }),
  ]);
  const state = conversationState.normalizeConversationState({
    meta: { activeSegmentIndex: 4, totalSegmentCount: 5, totalMessageCount: 2 },
    segments: [active],
    transcript: createProjection([transcriptSlice(active, 1)], 4, {
      oldestMessageOffset: 1,
      hasMoreBefore: true,
      revision: "revision-empty",
    }),
  });
  assert.equal(timeline(state).length, 0);

  const appended = conversationState.appendMessagesToConversation(state, [
    assistant("late visible answer", 43, { id: "a-late" }),
  ]);
  assert.equal(timeline(appended).length, 1);
  assert.deepEqual(textBlocks(timeline(appended)[0]), ["late visible answer"]);
  assert.match(timeline(appended)[0].key, /assistant-1-3-/);
  assert.deepEqual(
    appended.transcript.segmentWindows.map((window) => [
      window.startMessageIndex,
      window.endMessageIndex,
    ]),
    [[1, 3]],
  );
  assert.doesNotMatch(JSON.stringify(timeline(appended)), /hidden question/);
});

test("incremental append matches direct normalization and preserves untouched identities", () => {
  const base = conversationState.createConversationStateFromContext({
    messages: [
      user("q1", 1, { id: "u1" }),
      assistant("a1", 2, { id: "a1" }),
      user("q2", 3, { id: "u2" }),
      assistant("a2", 4, { id: "a2" }),
    ],
  });
  const next = conversationState.appendMessagesToConversation(base, [
    user("q3", 5, { id: "u3" }),
  ]);

  assertMatchesFullRuntimeTimeline(next);
  assert.equal(timeline(next).length, timeline(base).length + 1);
  for (let index = 0; index < timeline(base).length; index += 1) {
    assert.equal(timeline(next)[index], timeline(base)[index]);
  }
  assert.equal(timeline(next).at(-1).messageRef.messageIndex, 4);
  assert.equal(next.transcript.segmentWindows[0].endMessageIndex, 5);
});

test("settle batch appends one assistant group and keeps the committed prefix warm", () => {
  const base = conversationState.createConversationStateFromContext({
    messages: [user("q1", 1, { id: "u1" }), assistant("a1", 2, { id: "a1" })],
  });
  const withTwin = conversationState.appendMessagesToConversation(base, [
    user("q2", 3, { id: "u2" }),
  ]);
  const settled = conversationState.appendMessagesToConversation(withTwin, [
    toolCallAssistant("call-1", 4),
    toolResultMessage("call-1", 5),
    assistant("a2", 6, { id: "a2" }),
  ]);

  assertMatchesFullRuntimeTimeline(settled);
  for (let index = 0; index < timeline(withTwin).length; index += 1) {
    assert.equal(timeline(settled)[index], timeline(withTwin)[index]);
  }
  const lastItem = timeline(settled).at(-1);
  assert.equal(lastItem.kind, "assistant");
  assert.equal(lastItem.rounds.length, 2);
  assert.equal(settled.transcript.segmentWindows[0].endMessageIndex, 6);
});

test("aligned prepend preserves warm item identity and keeps later mutations window-aligned", () => {
  const messages = [
    user("q0 hidden", 1, { id: "m0" }),
    assistant("a0 hidden", 2, { id: "m1" }),
    user("q1 page", 3, { id: "m2" }),
    assistant("a1 page", 4, { id: "m3" }),
    user("q2 tail", 5, { id: "m4" }),
    assistant("a2 tail", 6, { id: "m5" }),
  ];
  const active = storedSegment(3, "segment-3", messages);
  const tailProjection = createProjection([transcriptSlice(active, 4)], 3, {
    oldestMessageOffset: 4,
    hasMoreBefore: true,
    revision: "revision-window",
  });
  const state = conversationState.normalizeConversationState({
    meta: { activeSegmentIndex: 3, totalSegmentCount: 4, totalMessageCount: 6 },
    segments: [active],
    transcript: tailProjection,
  });
  const warmTailItems = timeline(state).slice();
  const page = createProjection([transcriptSlice(active, 2, 4)], 3, {
    oldestMessageOffset: 2,
    hasMoreBefore: true,
    revision: "revision-window",
  });

  const prepended = conversationState.prependTranscriptProjection(state, page);
  assert.equal(timeline(prepended).length, 4);
  for (let index = 0; index < warmTailItems.length; index += 1) {
    assert.equal(timeline(prepended)[page.items.length + index], warmTailItems[index]);
  }
  assert.deepEqual(prepended.transcript.segmentWindows, [
    {
      segmentIndex: 3,
      segmentId: "segment-3",
      startMessageIndex: 2,
      endMessageIndex: 6,
    },
  ]);
  assert.equal(prepended.transcript.oldestMessageOffset, 2);
  assert.equal(prepended.transcript.revision, "revision-window");
  assert.equal(timeline(prepended)[0].messageRef.messageIndex, 2);
  assert.equal(timeline(prepended)[2].messageRef.messageIndex, 4);

  const appended = conversationState.appendMessagesToConversation(prepended, [
    user("q3 appended", 7, { id: "m6" }),
  ]);
  assert.deepEqual(
    appended.transcript.segmentWindows.map((window) => [
      window.segmentIndex,
      window.startMessageIndex,
      window.endMessageIndex,
    ]),
    [[3, 2, 7]],
  );
  for (let index = 0; index < timeline(prepended).length; index += 1) {
    assert.equal(timeline(appended)[index], timeline(prepended)[index]);
  }
  assert.equal(timeline(appended).at(-1).messageRef.messageIndex, 6);
  assert.doesNotMatch(JSON.stringify(timeline(appended)), /q0 hidden|a0 hidden/);

  const replacementMessages = [
    ...messages.slice(0, 5),
    assistant("a2 replaced", 60, { id: "m5-replaced" }),
    user("q3 replaced", 70, { id: "m6-replaced" }),
  ];
  const replaced = conversationState.replaceActiveSegmentMessages(
    prepended,
    replacementMessages,
  );
  assert.deepEqual(
    replaced.transcript.segmentWindows.map((window) => [
      window.segmentIndex,
      window.startMessageIndex,
      window.endMessageIndex,
    ]),
    [[3, 2, 7]],
  );
  assert.deepEqual(
    timeline(replaced)
      .filter((item) => item.kind === "user")
      .map((item) => item.messageRef.messageIndex),
    [2, 4, 6],
  );
  assert.match(JSON.stringify(timeline(replaced)), /a2 replaced/);
  assert.doesNotMatch(JSON.stringify(timeline(replaced)), /q0 hidden|a0 hidden/);

  const compacted = conversationState.applyCompactionCheckpoint(
    prepended,
    checkpoint("aligned summary", 80, "summary-4"),
  );
  assert.deepEqual(
    compacted.transcript.segmentWindows.map((window) => [
      window.segmentIndex,
      window.startMessageIndex,
      window.endMessageIndex,
    ]),
    [
      [3, 2, 6],
      [4, 0, 0],
    ],
  );
  assert.equal(timeline(compacted).at(-1).kind, "summary");
  assert.equal(timeline(compacted).at(-1).segmentIndex, 4);
  assert.doesNotMatch(JSON.stringify(timeline(compacted)), /q0 hidden|a0 hidden/);
  assert.equal(compacted.transcript.oldestMessageOffset, 2);
  assert.equal(compacted.transcript.revision, null);
});

test("sequential append produces the same transcript as a one-shot build", () => {
  const messages = [];
  for (let turn = 0; turn < 12; turn += 1) {
    messages.push(user(`q${turn}`, turn * 10 + 1, { id: `u-${turn}` }));
    messages.push(toolCallAssistant(`call-${turn}`, turn * 10 + 2));
    messages.push(toolResultMessage(`call-${turn}`, turn * 10 + 3));
    messages.push(assistant(`a${turn}`, turn * 10 + 4, { id: `a-${turn}` }));
  }

  let sequential = conversationState.createConversationStateFromContext({ messages: [] });
  for (const message of messages) {
    sequential = conversationState.appendMessagesToConversation(sequential, [message]);
  }
  const oneShot = conversationState.createConversationStateFromContext({ messages });

  const withoutSegmentIds = (items) =>
    items.map(({ key, messageRef, ...rest }) => ({
      ...rest,
      messageRef: messageRef ? { ...messageRef, segmentId: "(segment-id)" } : undefined,
    }));
  assert.deepEqual(
    withoutSegmentIds(timeline(sequential)),
    withoutSegmentIds(timeline(oneShot)),
  );
  assertMatchesFullRuntimeTimeline(sequential);
});

test("uploaded file metadata stays in transcript but is stripped from request context", () => {
  const uploadedMessage = {
    role: "user",
    id: "upload-user",
    content: "Please inspect file.txt\n\nSelected files are available...",
    timestamp: 1,
    liveAgentDisplayContent: "Please inspect file.txt",
    liveAgentAttachments: [
      { relativePath: "file.txt", fileName: "file.txt", kind: "text", sizeBytes: 12 },
    ],
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [uploadedMessage],
  });

  assert.equal(timeline(state)[0].text, "Please inspect file.txt");
  assert.equal(timeline(state)[0].attachments[0].relativePath, "file.txt");

  const requestContext = conversationState.buildRequestContext(state);
  assert.equal(requestContext.messages[0].liveAgentDisplayContent, undefined);
  assert.equal(requestContext.messages[0].liveAgentAttachments, undefined);
  assert.equal(requestContext.messages[0].content, uploadedMessage.content);
});

test("display-only Image results retain UI images but omit inline bytes from request context", () => {
  const imageToolResult = {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "Image",
    content: [
      { type: "text", text: "Display images: 2" },
      { type: "image", mimeType: "image/png", data: "png-base64" },
      { type: "image", mimeType: "image/jpeg", data: "jpg-base64" },
    ],
    details: {
      kind: "display_image",
      loadMode: "inline",
      images: [
        {
          path: "uploads/001.png",
          mimeType: "image/png",
          sizeBytes: 1234,
          mtimeMs: 1,
          contentHash: "hash-png",
        },
        {
          path: "skill://demo/assets/logo.jpg",
          scope: "skill",
          relativePath: "demo/assets/logo.jpg",
          displayPath: "skill://demo/assets/logo.jpg",
          pathRef: "skill:demo/assets/logo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 5678,
          mtimeMs: 2,
          contentHash: "hash-jpg",
        },
      ],
    },
    isError: false,
    timestamp: 1,
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [imageToolResult],
  });

  assert.equal(
    state.segments[0].messages[0].content.filter((block) => block.type === "image").length,
    2,
  );
  const requestContext = conversationState.buildRequestContext(state);
  assert.deepEqual(
    requestContext.messages[0].content.map((block) => block.type),
    ["text"],
  );
  assert.match(requestContext.messages[0].content[0].text, /Displayed 2 images/);
  assert.match(requestContext.messages[0].content[0].text, /uploads\/001\.png/);
  assert.match(requestContext.messages[0].content[0].text, /skill:\/\/demo\/assets\/logo\.jpg/);
  assert.match(requestContext.messages[0].content[0].text, /display-only UI tool/);
});

test("model context sanitizer preserves user image content", () => {
  const userImageMessage = {
    role: "user",
    id: "user-image",
    content: [
      { type: "text", text: "Please inspect this image" },
      { type: "image", mimeType: "image/png", data: "user-png-base64" },
    ],
    timestamp: 1,
  };
  const state = conversationState.createConversationStateFromContext({
    messages: [userImageMessage],
  });

  const requestContext = conversationState.buildRequestContext(state);
  assert.deepEqual(requestContext.messages[0].content, userImageMessage.content);
});
