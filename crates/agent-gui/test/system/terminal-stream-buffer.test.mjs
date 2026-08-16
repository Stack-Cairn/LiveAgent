import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { TerminalStreamBuffer } = loader.loadModule(
  "@liveagent/ui/lib/terminal/streamBuffer.ts",
);

function snapshot() {
  return {
    session: {
      id: "terminal-1",
      projectPathKey: "/workspace",
      cwd: "/workspace",
      shell: "zsh",
      title: "Terminal",
      kind: "local",
      cols: 80,
      rows: 24,
      createdAt: 1,
      updatedAt: 1,
      running: true,
    },
    bytes: new Uint8Array(),
    truncated: false,
    outputStartOffset: 0,
    outputEndOffset: 0,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("terminal stream buffer batches input, clamps resize, and replays queued output", async () => {
  const inputBatches = [];
  const resizes = [];
  const buffer = new TerminalStreamBuffer(snapshot(), {
    initialTransportReady: true,
    async sendInput(bytes) {
      inputBatches.push([...bytes]);
    },
    async sendResize(resize) {
      resizes.push(resize);
    },
  });

  buffer.accept({
    sessionId: "terminal-1",
    projectPathKey: "/workspace",
    bytes: Uint8Array.from([9]),
    startOffset: 0,
    endOffset: 1,
  });
  const output = [];
  const unsubscribe = buffer.subscribeOutput((chunk) => output.push([...chunk.bytes]));
  assert.deepEqual(output, [[9]]);

  assert.equal(buffer.write(Uint8Array.from([1, 2])), true);
  assert.equal(buffer.write(Uint8Array.from([3])), true);
  buffer.resize(2, 900);
  await delay(30);

  assert.deepEqual(inputBatches, [[1, 2, 3]]);
  assert.deepEqual(resizes, [{ cols: 20, rows: 200 }]);
  unsubscribe();
  buffer.dispose();
});

test("terminal stream buffer preserves queued input across an offline transport", async () => {
  const inputBatches = [];
  const states = [];
  const buffer = new TerminalStreamBuffer(snapshot(), {
    initialTransportReady: false,
    offlineInputRetryMs: 25,
    async sendInput(bytes) {
      inputBatches.push([...bytes]);
    },
    async sendResize() {},
  });
  const unsubscribe = buffer.subscribeInputState((state) => states.push(state));

  assert.equal(buffer.write(Uint8Array.from([4, 5])), true);
  await delay(15);
  assert.equal(inputBatches.length, 0);
  assert.equal(states.at(-1).paused, true);
  assert.equal(states.at(-1).reason, "offline");
  assert.equal(states.at(-1).queuedBytes, 2);

  buffer.markTransportReady();
  await delay(0);
  assert.deepEqual(inputBatches, [[4, 5]]);
  assert.equal(states.at(-1).paused, false);
  assert.equal(states.at(-1).queuedBytes, 0);

  unsubscribe();
  buffer.dispose();
});

test("terminal stream buffer restores failed input for a later reconnect", async () => {
  let attempts = 0;
  const delivered = [];
  const buffer = new TerminalStreamBuffer(snapshot(), {
    initialTransportReady: true,
    offlineInputRetryMs: 25,
    async sendInput(bytes) {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      delivered.push([...bytes]);
    },
    async sendResize() {},
    onInputSendError(_error, bytes, current) {
      current.markTransportDown();
      current.restoreInput(bytes);
    },
  });

  assert.equal(buffer.write(Uint8Array.from([6, 7, 8])), true);
  await delay(15);
  assert.equal(attempts, 1);
  assert.deepEqual(delivered, []);

  buffer.markTransportReady();
  await delay(0);
  assert.equal(attempts, 2);
  assert.deepEqual(delivered, [[6, 7, 8]]);
  buffer.dispose();
});
