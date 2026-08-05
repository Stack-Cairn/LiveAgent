import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createLoader(invoke) {
  return createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke },
    },
  });
}

test("OpenAI Responses native attachment adapter adds input_image and input_file", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    if (args.kind === "image") {
      return { mimeType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
    }
    return { mimeType: "application/pdf", data: "cGRm", sizeBytes: 3 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect these", [
    {
      relativePath: "uploads/1/screenshot.png",
      absolutePath: "/workspace/uploads/1/screenshot.png",
      fileName: "screenshot.png",
      kind: "image",
      sizeBytes: 5,
    },
    {
      relativePath: "uploads/1/report.pdf",
      absolutePath: "/workspace/uploads/1/report.pdf",
      fileName: "report.pdf",
      kind: "pdf",
      sizeBytes: 3,
    },
  ]);

  const payload = {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      },
    ],
  };
  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToResponsesPayload({
      payload,
      context: { messages: [message] },
      model: { api: "openai-responses", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.command), [
    "system_read_uploaded_native_attachment",
    "system_read_uploaded_native_attachment",
  ]);
  assert.equal(result.input[0].content[0].type, "input_text");
  assert.match(
    result.input[0].content[0].text,
    /Analyze the native attachments directly first/,
  );
  assert.equal(result.input[0].content[1].type, "input_image");
  assert.equal(result.input[0].content[1].image_url, "data:image/png;base64,aW1hZ2U=");
  assert.equal(result.input[0].content[2].type, "input_file");
  assert.equal(result.input[0].content[2].filename, "report.pdf");
  assert.equal(result.input[0].content[2].file_data, "data:application/pdf;base64,cGRm");
});

test("OpenAI Chat Completions native attachment adapter adds image_url blocks", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    if (args.kind === "image") {
      return { mimeType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
    }
    return { mimeType: "application/pdf", data: "cGRm", sizeBytes: 3 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect these", [
    {
      relativePath: "uploads/1/screenshot.png",
      absolutePath: "/workspace/uploads/1/screenshot.png",
      fileName: "screenshot.png",
      kind: "image",
      sizeBytes: 5,
    },
    {
      relativePath: "uploads/1/report.pdf",
      absolutePath: "/workspace/uploads/1/report.pdf",
      fileName: "report.pdf",
      kind: "pdf",
      sizeBytes: 3,
    },
  ]);

  const payload = {
    messages: [
      {
        role: "user",
        content: message.content,
      },
    ],
  };
  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToOpenAICompletionsPayload({
      payload,
      context: { messages: [message] },
      model: { api: "openai-completions", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.kind, "image");
  assert.equal(result.messages[0].content[0].type, "text");
  assert.match(
    result.messages[0].content[0].text,
    /OpenAI Chat Completions request as native image inputs/,
  );
  assert.equal(result.messages[0].content[1].type, "image_url");
  assert.deepEqual(result.messages[0].content[1].image_url, {
    url: "data:image/png;base64,aW1hZ2U=",
    detail: "auto",
  });
});

test("OpenAI Responses native attachment adapter preserves Read fallback when native is unavailable", async () => {
  const loader = createLoader(async () => {
    throw new Error("too large");
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect", [
    {
      relativePath: "uploads/1/assets.zip",
      absolutePath: "/workspace/uploads/1/assets.zip",
      fileName: "assets.zip",
      kind: "archive",
      sizeBytes: 3,
    },
  ]);
  const payload = {
    input: [{ role: "user", content: [{ type: "input_text", text: message.content }] }],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToResponsesPayload({
      payload,
      context: { messages: [message] },
      model: { api: "openai-responses", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(result, payload);
  assert.match(payload.input[0].content[0].text, /Use Read with these exact paths/);
});

test("OpenAI Responses native attachment adapter skips tool output turns", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    return { mimeType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const firstMessage = uploadedFiles.createUserMessageWithUploads("Use a tool first", []);
  const uploadMessage = uploadedFiles.createUserMessageWithUploads("Inspect the upload", [
    {
      relativePath: "uploads/1/screenshot.png",
      absolutePath: "/workspace/uploads/1/screenshot.png",
      fileName: "screenshot.png",
      kind: "image",
      sizeBytes: 5,
    },
  ]);
  const toolOutputItem = {
    role: "user",
    content: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
  };
  const payload = {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: firstMessage.content }],
      },
      { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
      toolOutputItem,
      {
        role: "user",
        content: [{ type: "input_text", text: uploadMessage.content }],
      },
    ],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToResponsesPayload({
      payload,
      context: { messages: [firstMessage, uploadMessage] },
      model: { api: "openai-responses", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 1);
  assert.equal(result.input[2], toolOutputItem);
  assert.equal(result.input[3].content[1].type, "input_image");
  assert.equal(result.input[3].content[1].image_url, "data:image/png;base64,aW1hZ2U=");
});

test("Anthropic Messages native attachment adapter adds image and document blocks", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    if (args.kind === "image") {
      return { mimeType: "image/webp", data: "aW1hZ2U=", sizeBytes: 5 };
    }
    return { mimeType: "application/pdf", data: "cGRm", sizeBytes: 3 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect these", [
    {
      relativePath: "uploads/1/screenshot.webp",
      absolutePath: "/workspace/uploads/1/screenshot.webp",
      fileName: "screenshot.webp",
      kind: "image",
      sizeBytes: 5,
    },
    {
      relativePath: "uploads/1/report.pdf",
      absolutePath: "/workspace/uploads/1/report.pdf",
      fileName: "report.pdf",
      kind: "pdf",
      sizeBytes: 3,
    },
  ]);

  const payload = {
    messages: [
      {
        role: "user",
        content: message.content,
      },
    ],
  };
  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToAnthropicPayload({
      payload,
      context: { messages: [message] },
      model: { api: "anthropic-messages", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.command), [
    "system_read_uploaded_native_attachment",
    "system_read_uploaded_native_attachment",
  ]);
  assert.equal(result.messages[0].content[0].type, "text");
  assert.match(
    result.messages[0].content[0].text,
    /Anthropic Messages request as native image\/document inputs/,
  );
  assert.equal(result.messages[0].content[1].type, "image");
  assert.deepEqual(result.messages[0].content[1].source, {
    type: "base64",
    media_type: "image/webp",
    data: "aW1hZ2U=",
  });
  assert.equal(result.messages[0].content[2].type, "document");
  assert.equal(result.messages[0].content[2].title, "report.pdf");
  assert.deepEqual(result.messages[0].content[2].source, {
    type: "base64",
    media_type: "application/pdf",
    data: "cGRm",
  });
});

test("Anthropic Messages native attachment adapter sends text files as text documents", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    return { mimeType: "text/plain", data: "SGVsbG8gQ2xhdWRl", sizeBytes: 12 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Summarize this", [
    {
      relativePath: "uploads/1/notes.txt",
      absolutePath: "/workspace/uploads/1/notes.txt",
      fileName: "notes.txt",
      kind: "text",
      sizeBytes: 12,
    },
  ]);
  const payload = {
    messages: [{ role: "user", content: message.content }],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToAnthropicPayload({
      payload,
      context: { messages: [message] },
      model: { api: "anthropic-messages", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.kind, "text");
  assert.equal(result.messages[0].content[1].type, "document");
  assert.equal(result.messages[0].content[1].title, "notes.txt");
  assert.deepEqual(result.messages[0].content[1].source, {
    type: "text",
    media_type: "text/plain",
    data: "Hello Claude",
  });
});

test("Anthropic Messages native attachment adapter preserves Read fallback for unsupported files", async () => {
  const loader = createLoader(async () => {
    throw new Error("should not read unsupported archive");
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect", [
    {
      relativePath: "uploads/1/assets.zip",
      absolutePath: "/workspace/uploads/1/assets.zip",
      fileName: "assets.zip",
      kind: "archive",
      sizeBytes: 3,
    },
  ]);
  const payload = {
    messages: [{ role: "user", content: message.content }],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToAnthropicPayload({
      payload,
      context: { messages: [message] },
      model: { api: "anthropic-messages", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(result, payload);
  assert.match(payload.messages[0].content, /Use Read with these exact paths/);
});

test("Anthropic Messages native attachment adapter skips tool result turns", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    return { mimeType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const firstMessage = uploadedFiles.createUserMessageWithUploads("Use a tool first", []);
  const uploadMessage = uploadedFiles.createUserMessageWithUploads("Inspect the upload", [
    {
      relativePath: "uploads/1/screenshot.png",
      absolutePath: "/workspace/uploads/1/screenshot.png",
      fileName: "screenshot.png",
      kind: "image",
      sizeBytes: 5,
    },
  ]);
  const toolResultMessage = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
  };
  const payload = {
    messages: [
      { role: "user", content: firstMessage.content },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }],
      },
      toolResultMessage,
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
      { role: "user", content: uploadMessage.content },
    ],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToAnthropicPayload({
      payload,
      context: { messages: [firstMessage, uploadMessage] },
      model: { api: "anthropic-messages", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 1);
  assert.equal(result.messages[2], toolResultMessage);
  assert.equal(result.messages[4].content[1].type, "image");
  assert.deepEqual(result.messages[4].content[1].source, {
    type: "base64",
    media_type: "image/png",
    data: "aW1hZ2U=",
  });
});

test("Gemini native attachment adapter adds inlineData parts", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    if (args.kind === "image") {
      return { mimeType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
    }
    return { mimeType: "application/pdf", data: "cGRm", sizeBytes: 3 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect these", [
    {
      relativePath: "uploads/1/screenshot.png",
      absolutePath: "/workspace/uploads/1/screenshot.png",
      fileName: "screenshot.png",
      kind: "image",
      sizeBytes: 5,
    },
    {
      relativePath: "uploads/1/report.pdf",
      absolutePath: "/workspace/uploads/1/report.pdf",
      fileName: "report.pdf",
      kind: "pdf",
      sizeBytes: 3,
    },
  ]);

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: message.content }],
      },
    ],
  };
  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToGeminiPayload({
      payload,
      context: { messages: [message] },
      model: { api: "google-generative-ai", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.command), [
    "system_read_uploaded_native_attachment",
    "system_read_uploaded_native_attachment",
  ]);
  assert.deepEqual(result.contents[0].parts[0], {
    inlineData: {
      mimeType: "image/png",
      data: "aW1hZ2U=",
    },
  });
  assert.deepEqual(result.contents[0].parts[1], {
    inlineData: {
      mimeType: "application/pdf",
      data: "cGRm",
    },
  });
  assert.match(
    result.contents[0].parts[2].text,
    /Gemini request as native inlineData inputs/,
  );
});

test("Gemini native attachment adapter follows Gemini image MIME support", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    if (args.absolute_path.endsWith(".heic")) {
      return { mimeType: "image/heic", data: "aGVpYw==", sizeBytes: 4 };
    }
    return { mimeType: "image/gif", data: "Z2lm", sizeBytes: 3 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect these", [
    {
      relativePath: "uploads/1/photo.heic",
      absolutePath: "/workspace/uploads/1/photo.heic",
      fileName: "photo.heic",
      kind: "image",
      sizeBytes: 4,
    },
    {
      relativePath: "uploads/1/animation.gif",
      absolutePath: "/workspace/uploads/1/animation.gif",
      fileName: "animation.gif",
      kind: "image",
      sizeBytes: 3,
    },
  ]);
  const payload = {
    contents: [{ role: "user", parts: [{ text: message.content }] }],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToGeminiPayload({
      payload,
      context: { messages: [message] },
      model: { api: "google-generative-ai", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 2);
  assert.deepEqual(result.contents[0].parts[0], {
    inlineData: {
      mimeType: "image/heic",
      data: "aGVpYw==",
    },
  });
  assert.equal(result.contents[0].parts.filter((part) => part.inlineData).length, 1);
  assert.match(result.contents[0].parts.at(-1).text, /uploads\/1\/animation\.gif/);
});

test("Gemini native attachment adapter preserves Read fallback for unsupported files", async () => {
  const loader = createLoader(async () => {
    throw new Error("should not read unsupported archive");
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect", [
    {
      relativePath: "uploads/1/assets.zip",
      absolutePath: "/workspace/uploads/1/assets.zip",
      fileName: "assets.zip",
      kind: "archive",
      sizeBytes: 3,
    },
  ]);
  const payload = {
    contents: [{ role: "user", parts: [{ text: message.content }] }],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToGeminiPayload({
      payload,
      context: { messages: [message] },
      model: { api: "google-generative-ai", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(result, payload);
  assert.match(payload.contents[0].parts[0].text, /Use Read with these exact paths/);
});

test("Gemini native attachment adapter preserves Read fallback when inline data is too large", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    return {
      mimeType: "image/png",
      data: "aW1hZ2U=",
      sizeBytes: 20 * 1024 * 1024 + 1,
    };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect", [
    {
      relativePath: "uploads/1/large.png",
      absolutePath: "/workspace/uploads/1/large.png",
      fileName: "large.png",
      kind: "image",
      sizeBytes: 20 * 1024 * 1024 + 1,
    },
  ]);
  const payload = {
    contents: [{ role: "user", parts: [{ text: message.content }] }],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToGeminiPayload({
      payload,
      context: { messages: [message] },
      model: { api: "google-generative-ai", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 1);
  assert.equal(result, payload);
  assert.match(payload.contents[0].parts[0].text, /Use Read with these exact paths/);
});

test("Gemini native attachment adapter skips synthetic tool image turns", async () => {
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    return { mimeType: "image/png", data: "dXNlci1pbWFnZQ==", sizeBytes: 10 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const firstMessage = uploadedFiles.createUserMessageWithUploads("First turn", []);
  const uploadMessage = uploadedFiles.createUserMessageWithUploads("Inspect the upload", [
    {
      relativePath: "uploads/1/user.png",
      absolutePath: "/workspace/uploads/1/user.png",
      fileName: "user.png",
      kind: "image",
      sizeBytes: 10,
    },
  ]);
  const syntheticToolImageTurn = {
    role: "user",
    parts: [
      { text: "Tool result image:" },
      { inlineData: { mimeType: "image/png", data: "dG9vbC1pbWFnZQ==" } },
    ],
  };
  const payload = {
    contents: [
      { role: "user", parts: [{ text: firstMessage.content }] },
      { role: "model", parts: [{ functionCall: { name: "screenshot", args: {} } }] },
      {
        role: "user",
        parts: [{ functionResponse: { name: "screenshot", response: { output: "ok" } } }],
      },
      syntheticToolImageTurn,
      { role: "user", parts: [{ text: uploadMessage.content }] },
    ],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToGeminiPayload({
      payload,
      context: { messages: [firstMessage, uploadMessage] },
      model: { api: "google-generative-ai", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 1);
  assert.equal(result.contents[3], syntheticToolImageTurn);
  assert.deepEqual(result.contents[4].parts[0], {
    inlineData: {
      mimeType: "image/png",
      data: "dXNlci1pbWFnZQ==",
    },
  });
});

test("Gemini native attachment adapter enforces cumulative inline request budget", async () => {
  const largeInlineData = "a".repeat(11 * 1024 * 1024);
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    return { mimeType: "image/png", data: largeInlineData, sizeBytes: 8 * 1024 * 1024 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const message = uploadedFiles.createUserMessageWithUploads("Inspect these", [
    {
      relativePath: "uploads/1/first.png",
      absolutePath: "/workspace/uploads/1/first.png",
      fileName: "first.png",
      kind: "image",
      sizeBytes: 8 * 1024 * 1024,
    },
    {
      relativePath: "uploads/1/second.png",
      absolutePath: "/workspace/uploads/1/second.png",
      fileName: "second.png",
      kind: "image",
      sizeBytes: 8 * 1024 * 1024,
    },
  ]);
  const payload = {
    contents: [{ role: "user", parts: [{ text: message.content }] }],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToGeminiPayload({
      payload,
      context: { messages: [message] },
      model: { api: "google-generative-ai", input: ["text", "image"] },
      workdir: "/workspace",
    });

  const inlineParts = result.contents[0].parts.filter((part) => part.inlineData);
  assert.equal(calls.length, 2);
  assert.equal(inlineParts.length, 1);
  assert.equal(inlineParts[0].inlineData.data.length, largeInlineData.length);
  assert.match(result.contents[0].parts.at(-1).text, /uploads\/1\/second\.png/);
});

test("Gemini native attachment adapter enforces inline budget across user turns", async () => {
  const largeInlineData = "b".repeat(11 * 1024 * 1024);
  const calls = [];
  const loader = createLoader(async (command, args) => {
    calls.push({ command, args });
    return { mimeType: "image/png", data: largeInlineData, sizeBytes: 8 * 1024 * 1024 };
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const nativeAttachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");

  const firstMessage = uploadedFiles.createUserMessageWithUploads("First", [
    {
      relativePath: "uploads/1/first.png",
      absolutePath: "/workspace/uploads/1/first.png",
      fileName: "first.png",
      kind: "image",
      sizeBytes: 8 * 1024 * 1024,
    },
  ]);
  const secondMessage = uploadedFiles.createUserMessageWithUploads("Second", [
    {
      relativePath: "uploads/2/second.png",
      absolutePath: "/workspace/uploads/2/second.png",
      fileName: "second.png",
      kind: "image",
      sizeBytes: 8 * 1024 * 1024,
    },
  ]);
  const payload = {
    contents: [
      { role: "user", parts: [{ text: firstMessage.content }] },
      { role: "model", parts: [{ text: "ok" }] },
      { role: "user", parts: [{ text: secondMessage.content }] },
    ],
  };

  const result = await nativeAttachments.__nativeResponsesAttachmentsTest
    .applyNativeAttachmentsToGeminiPayload({
      payload,
      context: { messages: [firstMessage, secondMessage] },
      model: { api: "google-generative-ai", input: ["text", "image"] },
      workdir: "/workspace",
    });

  assert.equal(calls.length, 2);
  assert.equal(result.contents[0].parts.filter((part) => part.inlineData).length, 1);
  assert.equal(result.contents[2].parts.filter((part) => part.inlineData).length, 0);
  assert.match(result.contents[2].parts[0].text, /Use Read with these exact paths/);
});

test("text-mode OpenAI Responses stream forwards workdir for native attachments", async () => {
  const attachmentReads = [];
  let capturedPayload = null;
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command === "proxy_get_server_info") {
            return { baseUrl: "http://127.0.0.1:18080", token: "proxy-token" };
          }
          if (
            command === "system_begin_power_activity" ||
            command === "system_end_power_activity"
          ) {
            return null;
          }
          if (command === "system_read_uploaded_native_attachment") {
            attachmentReads.push(args);
            return { mimeType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
          }
          throw new Error(`unexpected invoke: ${command}`);
        },
      },
      "@earendil-works/pi-ai/api/openai-responses": {
        stream(model, context, options) {
          return {
            async *[Symbol.asyncIterator]() {
              capturedPayload = await options.onPayload(
                {
                  input: [
                    {
                      role: "user",
                      content: [{ type: "input_text", text: context.messages[0].content }],
                    },
                  ],
                },
                model,
              );
            },
            async result() {
              return {
                role: "assistant",
                content: [{ type: "text", text: "ok" }],
                timestamp: 1,
                api: "openai-responses",
                provider: "openai",
                model: model.id,
                stopReason: "stop",
              };
            },
          };
        },
      },
    },
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const providers = loader.loadModule("src/lib/providers/llm.ts");
  const message = uploadedFiles.createUserMessageWithUploads("Inspect", [
    {
      relativePath: "uploads/1/screenshot.png",
      absolutePath: "/workspace/uploads/1/screenshot.png",
      fileName: "screenshot.png",
      kind: "image",
      sizeBytes: 5,
    },
  ]);

  await providers.streamAssistantMessage({
    providerId: "codex",
    model: "gpt-test",
    runtime: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      requestFormat: "openai-responses",
    },
    context: { messages: [message] },
    workdir: "/workspace",
    onTextDelta() {},
  });

  assert.equal(attachmentReads.length, 1);
  assert.equal(attachmentReads[0].workdir, "/workspace");
  assert.equal(capturedPayload.input[0].content.at(-1).type, "input_image");
  assert.equal(
    capturedPayload.input[0].content.at(-1).image_url,
    "data:image/png;base64,aW1hZ2U=",
  );
});

test("text-mode OpenAI Chat Completions stream forwards workdir for native image attachments", async () => {
  const attachmentReads = [];
  let capturedPayload = null;
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command === "proxy_get_server_info") {
            return { baseUrl: "http://127.0.0.1:18080", token: "proxy-token" };
          }
          if (
            command === "system_begin_power_activity" ||
            command === "system_end_power_activity"
          ) {
            return null;
          }
          if (command === "system_read_uploaded_native_attachment") {
            attachmentReads.push(args);
            return { mimeType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
          }
          throw new Error(`unexpected invoke: ${command}`);
        },
      },
      "@earendil-works/pi-ai/api/openai-completions": {
        stream(model, context, options) {
          return {
            async *[Symbol.asyncIterator]() {
              capturedPayload = await options.onPayload(
                {
                  messages: [
                    {
                      role: "user",
                      content: context.messages[0].content,
                    },
                  ],
                },
                model,
              );
            },
            async result() {
              return {
                role: "assistant",
                content: [{ type: "text", text: "ok" }],
                timestamp: 1,
                api: "openai-completions",
                provider: "openai",
                model: model.id,
                stopReason: "stop",
              };
            },
          };
        },
      },
    },
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const providers = loader.loadModule("src/lib/providers/llm.ts");
  const message = uploadedFiles.createUserMessageWithUploads("Inspect", [
    {
      relativePath: "uploads/1/screenshot.png",
      absolutePath: "/workspace/uploads/1/screenshot.png",
      fileName: "screenshot.png",
      kind: "image",
      sizeBytes: 5,
    },
  ]);

  await providers.streamAssistantMessage({
    providerId: "codex",
    model: "gpt-5.5",
    runtime: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      requestFormat: "openai-completions",
    },
    context: { messages: [message] },
    workdir: "/workspace",
    onTextDelta() {},
  });

  assert.equal(attachmentReads.length, 1);
  assert.equal(attachmentReads[0].workdir, "/workspace");
  assert.equal(capturedPayload.messages[0].content.at(-1).type, "image_url");
  assert.deepEqual(capturedPayload.messages[0].content.at(-1).image_url, {
    url: "data:image/png;base64,aW1hZ2U=",
    detail: "auto",
  });
});

test("text-mode Anthropic stream forwards workdir for native attachments", async () => {
  const attachmentReads = [];
  let capturedPayload = null;
  const loader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai": {
        getModel() {
          return null;
        },
      },
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command === "proxy_get_server_info") {
            return { baseUrl: "http://127.0.0.1:18080", token: "proxy-token" };
          }
          if (
            command === "system_begin_power_activity" ||
            command === "system_end_power_activity"
          ) {
            return null;
          }
          if (command === "system_read_uploaded_native_attachment") {
            attachmentReads.push(args);
            return { mimeType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
          }
          throw new Error(`unexpected invoke: ${command}`);
        },
      },
      "@earendil-works/pi-ai/api/anthropic-messages": {
        stream(model, context, options) {
          return {
            async *[Symbol.asyncIterator]() {
              capturedPayload = await options.onPayload(
                {
                  messages: [
                    {
                      role: "user",
                      content: context.messages[0].content,
                    },
                  ],
                },
                model,
              );
            },
            async result() {
              return {
                role: "assistant",
                content: [{ type: "text", text: "ok" }],
                timestamp: 1,
                api: "anthropic-messages",
                provider: "anthropic",
                model: model.id,
                stopReason: "stop",
              };
            },
          };
        },
      },
    },
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const providers = loader.loadModule("src/lib/providers/llm.ts");
  const message = uploadedFiles.createUserMessageWithUploads("Inspect", [
    {
      relativePath: "uploads/1/screenshot.png",
      absolutePath: "/workspace/uploads/1/screenshot.png",
      fileName: "screenshot.png",
      kind: "image",
      sizeBytes: 5,
    },
  ]);

  await providers.streamAssistantMessage({
    providerId: "claude_code",
    model: "claude-test",
    runtime: {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test",
      requestFormat: "anthropic-messages",
    },
    context: { messages: [message] },
    workdir: "/workspace",
    onTextDelta() {},
  });

  assert.equal(attachmentReads.length, 1);
  assert.equal(attachmentReads[0].workdir, "/workspace");
  assert.equal(capturedPayload.messages[0].content.at(-1).type, "image");
  assert.deepEqual(capturedPayload.messages[0].content.at(-1).source, {
    type: "base64",
    media_type: "image/png",
    data: "aW1hZ2U=",
  });
});

test("text-mode Gemini stream forwards workdir for native attachments", async () => {
  const attachmentReads = [];
  let capturedPayload = null;
  const loader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai": {
        getModel() {
          return null;
        },
      },
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command === "proxy_get_server_info") {
            return { baseUrl: "http://127.0.0.1:18080", token: "proxy-token" };
          }
          if (
            command === "system_begin_power_activity" ||
            command === "system_end_power_activity"
          ) {
            return null;
          }
          if (command === "system_read_uploaded_native_attachment") {
            attachmentReads.push(args);
            return { mimeType: "image/png", data: "aW1hZ2U=", sizeBytes: 5 };
          }
          throw new Error(`unexpected invoke: ${command}`);
        },
      },
      "@earendil-works/pi-ai/api/google-generative-ai": {
        stream(model, context, options) {
          return {
            async *[Symbol.asyncIterator]() {
              capturedPayload = await options.onPayload(
                {
                  contents: [
                    {
                      role: "user",
                      parts: [{ text: context.messages[0].content }],
                    },
                  ],
                },
                model,
              );
            },
            async result() {
              return {
                role: "assistant",
                content: [{ type: "text", text: "ok" }],
                timestamp: 1,
                api: "google-generative-ai",
                provider: "google",
                model: model.id,
                stopReason: "stop",
              };
            },
          };
        },
      },
    },
  });
  const uploadedFiles = loader.loadModule("src/lib/chat/messages/uploadedFiles.ts");
  const providers = loader.loadModule("src/lib/providers/llm.ts");
  const message = uploadedFiles.createUserMessageWithUploads("Inspect", [
    {
      relativePath: "uploads/1/screenshot.png",
      absolutePath: "/workspace/uploads/1/screenshot.png",
      fileName: "screenshot.png",
      kind: "image",
      sizeBytes: 5,
    },
  ]);

  await providers.streamAssistantMessage({
    providerId: "gemini",
    model: "gemini-test",
    runtime: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-test-key",
    },
    context: { messages: [message] },
    workdir: "/workspace",
    onTextDelta() {},
  });

  assert.equal(attachmentReads.length, 1);
  assert.equal(attachmentReads[0].workdir, "/workspace");
  assert.deepEqual(capturedPayload.contents[0].parts[0], {
    inlineData: {
      mimeType: "image/png",
      data: "aW1hZ2U=",
    },
  });
});
