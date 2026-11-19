import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { create, fromBinary, toBinary } = require("@bufbuild/protobuf");
const loader = createWebModuleLoader();
const {
  prepareTextSaveTransfer,
  MAX_TEXT_SAVE_BYTES,
  MAX_TEXT_SAVE_FRAME_BYTES,
  encodeRequestFrame,
  decodeServerFrame,
} = loader.loadModule("src/lib/gatewaySocketV2/adapters.ts");
const { WebClientFrameSchema, WebServerFrameSchema } = loader.loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");
const { AgentEnvelopeSchema, GatewayEnvelopeSchema, FsReadEditableTextResponseSchema } = loader.loadModule("src/lib/proto/gen/proto/v2/gateway_pb.ts");
const decode = (bytes) => fromBinary(WebClientFrameSchema, bytes);

for (const kind of ["fs.write_text", "sftp.write_text"]) {
  const metadata = kind === "fs.write_text"
    ? { workdir: "/work", path: "file", mode: "overwrite", expected_mtime_ms: 17, expected_content_hash: "hash" }
    : { session_id: "session", remote_path: "/file", expected_mtime: 17, expected_size_bytes: 23, expected_content_hash: "hash", create_parent_dirs: true };
  const requestValue = (frame) => frame.payload.value.request.payload.value;

  test(`${kind}: small saves use the compatible ordinary request`, () => {
    for (const content of ["", "猫\n\u0000\\\"", "x".repeat(256 * 1024)]) {
      const transfer = prepareTextSaveTransfer("save", kind, { ...metadata, content }, "agent");
      const frames = [...transfer.frames];
      assert.equal(frames.length, 1);
      assert.equal(transfer.cancel, undefined);
      const frame = decode(frames[0]);
      assert.equal(frame.payload.case, "agentRequest");
      assert.equal(frame.payload.value.payload.value.content, content);
      assert.ok(frames[0].byteLength <= MAX_TEXT_SAVE_FRAME_BYTES);
    }
  });

  test(`${kind}: multibyte and escaped content reconstructs with unchanged conflict metadata`, () => {
    const content = "猫\u0000\\\"\n".repeat(300_000);
    const transfer = prepareTextSaveTransfer("save", kind, { ...metadata, content }, "agent");
    const chunks = [...transfer.frames].map((bytes) => {
      assert.ok(bytes.byteLength <= MAX_TEXT_SAVE_FRAME_BYTES);
      return decode(bytes);
    });
    assert.ok(chunks.length > 1);
    const first = chunks[0];
    const expected = decode(encodeRequestFrame("save", kind, { ...metadata, content: "" }, "agent"));
    assert.deepEqual(toBinary(GatewayEnvelopeSchema, first.payload.value.request), toBinary(GatewayEnvelopeSchema, expected.payload.value));
    assert.equal(requestValue(first).content, "");
    assert.equal(requestValue(first).expectedContentHash, "hash");
    let offset = 0;
    for (const [index, frame] of chunks.entries()) {
      assert.equal(frame.requestId, "save");
      assert.equal(frame.agentId, "agent");
      assert.equal(frame.payload.case, "agentRequestChunk");
      const chunk = frame.payload.value;
      assert.equal(chunk.offset, BigInt(offset));
      assert.equal(chunk.totalBytes, BigInt(Buffer.byteLength(content)));
      if (index > 0) assert.equal(chunk.request, undefined);
      offset += chunk.data.byteLength;
    }
    assert.equal(Buffer.concat(chunks.map((frame) => Buffer.from(frame.payload.value.data))).toString("utf8"), content);
    const cancel = decode(transfer.cancel);
    assert.equal(cancel.requestId, "save");
    assert.equal(cancel.agentId, "agent");
    assert.equal(cancel.payload.value.cancel, true);
    assert.equal(cancel.payload.value.data.byteLength, 0);
    assert.equal(cancel.payload.value.request, undefined);
  });

  test(`${kind}: exact content and frame boundaries remain bounded`, () => {
    // Content alone fits 1 MiB but the ordinary envelope does not.
    const boundary = prepareTextSaveTransfer("save", kind, { ...metadata, content: "x".repeat(MAX_TEXT_SAVE_FRAME_BYTES) }, "agent");
    assert.equal(decode([...boundary.frames][0]).payload.case, "agentRequestChunk");
    const exact = prepareTextSaveTransfer("save", kind, { ...metadata, content: "x".repeat(MAX_TEXT_SAVE_BYTES) }, "agent");
    let length = 0;
    for (const bytes of exact.frames) {
      assert.ok(bytes.byteLength <= MAX_TEXT_SAVE_FRAME_BYTES);
      length += decode(bytes).payload.value.data.byteLength;
    }
    assert.equal(length, MAX_TEXT_SAVE_BYTES);
    assert.throws(() => prepareTextSaveTransfer("save", kind, { ...metadata, content: "x".repeat(MAX_TEXT_SAVE_BYTES + 1) }, "agent"), /16 MiB/);
    // JS character count alone is insufficient to enforce the byte bound.
    assert.throws(() => prepareTextSaveTransfer("save", kind, { ...metadata, content: "猫".repeat(Math.floor(MAX_TEXT_SAVE_BYTES / 3) + 1) }, "agent"), /16 MiB/);
    const pathKey = kind === "fs.write_text" ? "path" : "remote_path";
    assert.throws(() => prepareTextSaveTransfer("save", kind, { ...metadata, [pathKey]: "x".repeat(64 * 1024), content: "a" }, "agent"), /metadata/);
  });
}

test("preview offsets retain optional presence and decode to camelCase numbers", () => {
  for (const offset of [undefined, 0, 1024 * 1024]) {
    const frame = decode(encodeRequestFrame("read", "fs.read_editable_text", {
      workdir: "/work", path: "file", preview_offset: offset,
    }, "agent"));
    assert.equal(frame.payload.value.payload.value.previewOffset, offset === undefined ? undefined : BigInt(offset));
    const response = create(WebServerFrameSchema, {
      requestId: "read",
      agentId: "agent",
      payload: {
        case: "agentResponse",
        value: create(AgentEnvelopeSchema, {
          payload: {
            case: "fsReadEditableTextResp",
            value: create(FsReadEditableTextResponseSchema, {
              path: "file", content: "猫", sizeBytes: 10n,
              previewOffset: offset === undefined ? undefined : BigInt(offset),
              previewNextOffset: offset === undefined ? undefined : BigInt(offset + 3),
            }),
          },
        }),
      },
    });
    const decoded = decodeServerFrame(response);
    assert.equal(decoded.payload.previewOffset, offset);
    assert.equal(decoded.payload.previewNextOffset, offset === undefined ? undefined : offset + 3);
    assert.equal(Object.hasOwn(decoded.payload, "previewOffset"), offset !== undefined);
  }
});
