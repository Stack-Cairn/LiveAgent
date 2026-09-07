import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  buildOmittedToolResultImagesNotice,
  modelAcceptsImageInput,
  omitToolResultImages,
  omitToolResultImagesForTextOnlyModel,
} = loader.loadModule("src/lib/providers/runtime/toolResultImageFallback.ts");

const JPEG_BASE64 = "A".repeat(1024 * 4); // ~3 KB once decoded

function textOnlyModel(overrides = {}) {
  return {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: "deepseek-responses",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function screenshotToolResult(overrides = {}) {
  return {
    role: "toolResult",
    toolCallId: "call_1|browser-1",
    toolName: "Browser",
    content: [
      {
        type: "text",
        text: "Page: http://127.0.0.1:8899/file-a.txt\nScreenshot captured (see image below).",
      },
      { type: "image", data: JPEG_BASE64, mimeType: "image/jpeg" },
    ],
    details: { kind: "browser", action: "screenshot", hasScreenshot: true },
    isError: false,
    timestamp: 3,
    ...overrides,
  };
}

function buildContext(messages) {
  return { systemPrompt: "You are precise.", messages };
}

test("modelAcceptsImageInput reads the declared input modalities", () => {
  assert.equal(modelAcceptsImageInput({ input: ["text"] }), false);
  assert.equal(modelAcceptsImageInput({ input: ["text", "image"] }), true);
  assert.equal(modelAcceptsImageInput({ input: undefined }), false);
});

test("omitToolResultImages replaces image blocks with a notice and keeps the tool text", () => {
  const original = screenshotToolResult();
  const context = buildContext([
    { role: "user", content: "take a screenshot", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1|browser-1", name: "Browser", arguments: {} }],
      api: "deepseek-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    original,
  ]);

  const next = omitToolResultImages(context, "deepseek-v4-flash");

  assert.notEqual(next, context, "a changed context must be a new object");
  assert.equal(next.systemPrompt, context.systemPrompt);
  assert.equal(next.messages.length, 3);
  assert.equal(next.messages[0], context.messages[0], "untouched messages keep identity");
  assert.equal(next.messages[1], context.messages[1], "untouched messages keep identity");

  const toolResult = next.messages[2];
  assert.deepEqual(
    toolResult.content.map((block) => block.type),
    ["text", "text"],
  );
  assert.equal(toolResult.content[0].text, original.content[0].text);
  assert.match(toolResult.content[1].text, /1 image omitted from this tool result/);
  assert.match(toolResult.content[1].text, /image\/jpeg \(~3\.0 KB\)/);
  assert.match(toolResult.content[1].text, /deepseek-v4-flash.*does not accept image input/);
  assert.match(toolResult.content[1].text, /switch to a vision-capable model/);
  assert.ok(!JSON.stringify(toolResult).includes(JPEG_BASE64), "image bytes must not leak");
  assert.equal(toolResult.toolCallId, original.toolCallId);
  assert.equal(toolResult.toolName, original.toolName);
  assert.deepEqual(toolResult.details, original.details, "UI details are preserved");

  // The persisted message must not be mutated: the UI still renders the image.
  assert.equal(original.content.length, 2);
  assert.equal(original.content[1].type, "image");
});

test("omitToolResultImages returns the same context when no tool result carries images", () => {
  const context = buildContext([
    { role: "user", content: "hello", timestamp: 1 },
    screenshotToolResult({
      content: [{ type: "text", text: "Page snapshot (a11y tree): ..." }],
    }),
  ]);
  assert.equal(omitToolResultImages(context, "any-model"), context);
});

test("omitToolResultImages leaves user image blocks alone", () => {
  const userImage = {
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
    timestamp: 1,
  };
  const context = buildContext([userImage]);
  assert.equal(omitToolResultImages(context, "any-model"), context);
});

test("image-only tool results still yield a text notice", () => {
  const context = buildContext([
    screenshotToolResult({
      toolName: "Read",
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "BBBB", mimeType: "image/webp" },
      ],
    }),
  ]);
  const [toolResult] = omitToolResultImages(context, "m").messages;
  assert.equal(toolResult.content.length, 1);
  assert.equal(toolResult.content[0].type, "text");
  assert.match(toolResult.content[0].text, /2 images omitted/);
  assert.match(toolResult.content[0].text, /1\. image\/png/);
  assert.match(toolResult.content[0].text, /2\. image\/webp/);
});

test("omitToolResultImagesForTextOnlyModel is gated on model.input", () => {
  const context = buildContext([screenshotToolResult()]);

  const vision = textOnlyModel({ input: ["text", "image"] });
  assert.equal(omitToolResultImagesForTextOnlyModel(context, vision), context);

  const textOnly = textOnlyModel();
  const degraded = omitToolResultImagesForTextOnlyModel(context, textOnly);
  assert.notEqual(degraded, context);
  assert.ok(degraded.messages[0].content.every((block) => block.type === "text"));
});

test("notice formats byte sizes from base64 length", () => {
  const notice = buildOmittedToolResultImagesNotice(
    [
      { type: "image", data: "QUJD", mimeType: "image/png" }, // "ABC" -> 3 B
      { type: "image", data: "A".repeat(2_000_000), mimeType: "image/jpeg" },
      { type: "image", data: "", mimeType: "" },
    ],
    "model-x",
  );
  assert.match(notice, /1\. image\/png \(~3 B\)/);
  assert.match(notice, /2\. image\/jpeg \(~1\.4 MB\)/);
  assert.match(notice, /3\. image$/m);
});
