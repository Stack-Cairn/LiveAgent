import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
const history = loader.loadModule("src/lib/kbrain/history.ts");
const uploadedFiles = loader.loadModule("@liveagent/ui/lib/chat/uploadedFiles.ts");
const conversationState = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const DEFAULT_KBRAIN_URL = "http://127.0.0.1:47321";
const runtimeConnection = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

const WORKSPACE = "/tmp/project";
const STAGING = "/home/me/.liveagent/uploads";
const IMAGE = {
  relativePath: "uploads/1791367333797/08-34-44.png",
  absolutePath: `${STAGING}/1791367333797/08-34-44.png`,
  fileName: "08-34-44.png",
  kind: "image",
  sizeBytes: 257 * 1024,
};
const DOC = {
  relativePath: "docs/spec.pdf",
  absolutePath: `${WORKSPACE}/docs/spec.pdf`,
  fileName: "spec.pdf",
  kind: "pdf",
  sizeBytes: 4096,
};

function installStorage() {
  const values = new Map();
  globalThis.localStorage = {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
  return values;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, value, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function withHttpFixture(handler, callback) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  runtimeConnection.setKBrainRuntimeConnection({ baseUrl: DEFAULT_KBRAIN_URL, token: "", protocolVersion: "kbrain.agent.v1" });
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin === DEFAULT_KBRAIN_URL) {
      url.protocol = "http:";
      url.host = new URL(fixtureUrl).host;
    }
    return originalFetch(url, init);
  };
  try {
    return await callback(fixtureUrl);
  } finally {
    globalThis.fetch = originalFetch;
    runtimeConnection.clearKBrainRuntimeConnection();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function attachmentSession() {
  const content = uploadedFiles.buildUserMessageContentWithUploads("告诉我截图里面有什么", [IMAGE, DOC]);
  return {
    id: "remote-session",
    title: "Attachments",
    cwd: WORKSPACE,
    model: { provider: "fixture", model: "fixture-model" },
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:01:00Z",
    message_count: 2,
    messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: content }], created_at: "2026-09-28T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "看起来是一张截图" }],
        provider: "fixture",
        model: "fixture-model",
        created_at: "2026-09-28T00:00:02Z",
      },
    ],
    last_seq: 2,
    revision: "rev-1",
  };
}

function historyResponse(session) {
  return {
    session,
    revision: session.revision,
    oldest_offset: 0,
    has_more_before: false,
    total_message_count: session.messages.length,
    active_messages: session.messages,
  };
}

test("reopened conversations rebuild attachment display text and metadata from stored content", async () => {
  installStorage();
  const session = attachmentSession();
  await withHttpFixture(async (_request, response) => {
    sendJson(response, historyResponse(session));
  }, async () => {
    mapping.setKBrainSessionId("attachments-local", session.id);

    const window = await history.getKBrainHistoryWindow("attachments-local");
    const user = window.segments[0].messages.find((message) => message.role === "user");

    // 正文只剩用户自己写的内容，不再包含附件指令。
    assert.equal(uploadedFiles.getUserMessageDisplayText(user), "告诉我截图里面有什么");
    assert.deepEqual(
      uploadedFiles.getUserMessageAttachments(user).map((file) => file.relativePath),
      ["uploads/1791367333797/08-34-44.png", "docs/spec.pdf"],
    );
    assert.deepEqual(
      uploadedFiles.getUserMessageAttachments(user).map((file) => file.kind),
      ["image", "pdf"],
    );
    // 给模型的 content 原样保留，模型仍能看到完整指令。
    assert.match(user.content, /attached the files below/);
    assert.match(user.content, /08-34-44\.png \(image, 257 KB\)/);
    // 粘贴引用按 relativePath 配对，暂存区路径必须还原成 uploads/... 形式。
    const split = uploadedFiles.splitUserAttachmentsForDisplay(
      uploadedFiles.getUserMessageAttachments(user),
      uploadedFiles.getUserMessageDisplayText(user),
    );
    assert.equal(split.visibleFiles.length, 2);
    assert.equal(split.pastedTextFiles.length, 0);
  });
});

test("attachment messages reused for image preview keep a resolvable absolute path", async () => {
  installStorage();
  const session = attachmentSession();
  await withHttpFixture(async (_request, response) => {
    sendJson(response, historyResponse(session));
  }, async () => {
    mapping.setKBrainSessionId("attachments-preview", session.id);

    const window = await history.getKBrainHistoryWindow("attachments-preview");
    const user = window.segments[0].messages.find((message) => message.role === "user");
    const [image] = uploadedFiles.getUserMessageAttachments(user);

    // 缩略图按会话 workdir + 绝对路径读图，重建的附件必须带上这两个值。
    assert.equal(image.absolutePath, IMAGE.absolutePath);
    assert.equal(image.fileName, "08-34-44.png");
    assert.equal(image.sizeBytes, 257 * 1024);
  });
});

test("history content hash stays self-consistent so edit-resend and branch refs validate", async () => {
  installStorage();
  const session = attachmentSession();
  const requests = [];
  await withHttpFixture(async (request, response) => {
    requests.push({ method: request.method, url: new URL(request.url, "http://fixture") });
    if (request.url.startsWith("/v1/sessions/remote-session/history")) {
      sendJson(response, historyResponse(session));
      return;
    }
    if (request.url.startsWith("/v1/sessions/remote-session") && request.method === "GET") {
      sendJson(response, session);
      return;
    }
    if (request.url.endsWith("/branch")) {
      const body = await readBody(request);
      requests.at(-1).body = body;
      sendJson(response, { ...session, id: "branched-session" });
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  }, async () => {
    mapping.setKBrainSessionId("attachments-hash", session.id);

    const window = await history.getKBrainHistoryWindow("attachments-hash");
    const ref = {
      segmentIndex: window.segments[0].segmentIndex,
      messageIndex: window.segments[0].startMessageIndex,
      segmentId: window.segments[0].segmentId,
      messageId: "u1",
      role: "user",
      contentHash: conversationState.getHistoryMessageContentHash(
        window.segments[0].messages.find((message) => message.role === "user"),
      ),
    };

    // 同一投影里再取一次窗口，哈希必须稳定（否则旧会话的分支/编辑会报 stale ref）。
    const again = await history.getKBrainHistoryWindow("attachments-hash");
    assert.equal(
      conversationState.getHistoryMessageContentHash(
        again.segments[0].messages.find((message) => message.role === "user"),
      ),
      ref.contentHash,
    );

    const branch = await history.branchKBrainHistory("attachments-hash", ref);
    assert.equal(branch.sessionId, "branched-session");
    assert.deepEqual(requests.at(-1).body.message_ref.content_hash, ref.contentHash);
  });
});
