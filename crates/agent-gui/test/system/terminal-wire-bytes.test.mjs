import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Terminal output crosses the webview IPC as base64 instead of a JSON number array. These tests
// drive the desktop client exactly as the host does (event payloads and attach snapshots as the
// Rust side serializes them) and check bytes, order and UTF-8 sequences split across chunks.

const host = { streamListener: null, attachBytes: "" };
const loader = createTsModuleLoader({
  mocks: {
    "@liveagent/app/shims/tauriCore": {
      invoke: async (command) => {
        if (command === "terminal_stream_attach") {
          return {
            session: { id: "terminal-1", project_path_key: "/workspace", kind: "local", running: true },
            bytes: host.attachBytes,
            truncated: false,
            outputStartOffset: 0,
            outputEndOffset: Buffer.from(host.attachBytes, "base64").length,
          };
        }
        throw new Error(`unexpected invoke ${command}`);
      },
    },
    "@liveagent/app/shims/tauriEvent": {
      listen: async (name, listener) => {
        if (name === "terminal:stream") host.streamListener = listener;
        return () => {};
      },
    },
  },
});
const { tauriTerminalClient } = loader.loadModule("src/lib/terminal/tauriTerminalClient.ts");
const normalization = loader.loadModule("../agent-ui/src/lib/terminal/normalization.ts");

// Mirrors `wire_bytes::serialize` on the Rust side.
function hostPayload(offset, bytes) {
  return {
    kind: "output",
    sessionId: "terminal-1",
    projectPathKey: "/workspace",
    startOffset: offset,
    endOffset: offset + bytes.length,
    bytes: Buffer.from(bytes).toString("base64"),
  };
}

test("stream chunks split inside multibyte characters arrive intact and in order", async () => {
  host.attachBytes = Buffer.from("prompt € ").toString("base64");
  const session = { id: "terminal-1", projectPathKey: "/workspace" };
  const handle = await tauriTerminalClient.stream.attach(session, {});
  assert.equal(new TextDecoder().decode(handle.snapshot.bytes), "prompt € ");

  const text = "héllo €uro 𝄞 目录\r\n".repeat(300);
  const bytes = Buffer.from(text);
  const received = [];
  handle.subscribeOutput((chunk) => received.push(chunk));
  const sizes = [1, 2, 3, 5, 7, 11, 4096, 8191, 8192];
  let offset = 0;
  for (let index = 0; offset < bytes.length; index++) {
    const end = Math.min(bytes.length, offset + sizes[index % sizes.length]);
    // The IPC hands the listener a parsed JSON payload.
    host.streamListener({ payload: JSON.parse(JSON.stringify(hostPayload(offset, bytes.subarray(offset, end)))) });
    offset = end;
  }

  let expectedOffset = 0;
  const decoder = new TextDecoder();
  let decoded = "";
  for (const chunk of received) {
    assert.ok(chunk.bytes instanceof Uint8Array);
    assert.equal(chunk.startOffset, expectedOffset, "chunks keep their order");
    assert.equal(chunk.endOffset, chunk.startOffset + chunk.bytes.byteLength);
    expectedOffset = chunk.endOffset;
    decoded += decoder.decode(chunk.bytes, { stream: true });
  }
  decoded += decoder.decode();
  assert.equal(expectedOffset, bytes.length);
  assert.equal(decoded, text);
  assert.ok(!decoded.includes("�"));
  handle.dispose();
});

test("a lone continuation byte or an invalid sequence is passed through untouched", () => {
  for (const raw of [[0x82], [0xe2, 0x82], [0xff, 0x00, 0xc0], []]) {
    const encoded = Buffer.from(raw).toString("base64");
    assert.deepEqual([...normalization.decodeBase64Bytes(encoded)], raw);
  }
});

test("both decoders (native and atob) agree on every byte value and padding", () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const native = Uint8Array.fromBase64;
  try {
    for (const useNative of [true, false]) {
      if (!useNative) Uint8Array.fromBase64 = undefined;
      const { decodeBase64Bytes } = createTsModuleLoader().loadModule("../agent-ui/src/lib/terminal/normalization.ts");
      for (let length = 0; length <= all.length; length += 1) {
        const part = all.subarray(0, length);
        assert.deepEqual(Buffer.from(decodeBase64Bytes(part.toString("base64"))), part);
      }
    }
  } finally {
    Uint8Array.fromBase64 = native;
  }
});

test("older number-array payloads still decode", () => {
  const bytes = normalization.normalizeTerminalByteContainer([0xe2, 0x82, 0xac, 256 + 65], normalization.decodeBase64Bytes);
  assert.deepEqual([...bytes], [0xe2, 0x82, 0xac, 65]);
});
