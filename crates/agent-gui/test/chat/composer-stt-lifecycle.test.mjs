import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";

function createHarness() {
  let hookCursor = 0;
  const refs = [];
  const state = [];
  const effects = [];
  const layoutEffects = [];
  const react = {
    useCallback(fn) {
      hookCursor += 1;
      return fn;
    },
    useEffect(fn) {
      hookCursor += 1;
      effects.push(fn);
    },
    useLayoutEffect(fn) {
      hookCursor += 1;
      layoutEffects.push(fn);
    },
    useRef(initial) {
      return (refs[hookCursor] ??= { current: initial });
    },
    useState(initial) {
      const index = hookCursor++;
      state[index] ??= initial;
      return [state[index], (next) => {
        state[index] = typeof next === "function" ? next(state[index]) : next;
      }];
    },
    render() {
      hookCursor = 0;
      layoutEffects.length = 0;
    },
    effects,
  };

  const captures = [];
  let deferCaptureStop = false;
  let releaseCaptureStop = null;
  class FakeCapture {
    constructor(options) {
      this.options = options;
      this.events = [];
      captures.push(this);
    }
    async start() {
      this.events.push("capture.start");
    }
    stop() {
      this.events.push("capture.stop");
      if (deferCaptureStop) {
        return new Promise((resolve) => {
          releaseCaptureStop = resolve;
        });
      }
    }
    chunk(sequence, values = [sequence]) {
      this.options.onChunk({ sequence, pcm: new Int16Array(values), durationMs: 100 });
    }
    silence() {
      this.options.onSilenceTimeout?.();
    }
    resetSilenceClock() {
      this.events.push("capture.resetSilenceClock");
    }
  }
  class FakeFifo {
    constructor() {
      this.items = [];
    }
    push(value) {
      this.items.push(value);
      return true;
    }
    drain() {
      return this.items.splice(0);
    }
    clear() {
      this.items = [];
    }
  }

  const loader = createWebModuleLoader({
    rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
    mocks: {
      react,
      "@liveagent/ui/lib/stt/audio": {
        appendTailSilence: () => new Int16Array(6400),
        pcm16ToLittleEndianBytes: (pcm) => new Uint8Array(pcm.buffer),
        STT_CONNECT_TIMEOUT_MS: 10_000,
        STT_SAMPLES_PER_CHUNK: 1600,
        SttAudioCapture: FakeCapture,
        SttPcmFifo: FakeFifo,
      },
    },
  });
  const { useComposerStt } = loader.loadModule("@liveagent/ui/pages/chat/useComposerStt");
  const calls = [];
  const callbacks = [];
  const sessionIds = [];
  const transport = {
    async requestPermission() {
      calls.push("permission");
    },
    async open(options) {
      calls.push("open");
      sessionIds.push(options.sessionId);
      callbacks.push(options.onEvent);
    },
    async sendAudio(sessionId, sequence, bytes) {
      calls.push(["audio", sessionId, sequence, bytes.byteLength]);
    },
    async stop(sessionId) {
      calls.push(["stop", sessionId]);
    },
    async cancel(sessionId) {
      calls.push(["cancel", sessionId]);
    },
    dispose() {
      calls.push("dispose");
    },
  };
  const composerEvents = [];
  const composer = {
    beginTransientText() {
      composerEvents.push("begin");
      return true;
    },
    updateTransientText(text) {
      composerEvents.push(["partial", text]);
    },
    commitTransientText(text) {
      composerEvents.push(["final", text]);
    },
    cancelTransientText(options) {
      composerEvents.push(["cancel", options]);
    },
  };
  const composerRef = { current: composer };
  globalThis.window = {
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  const render = (overrides = {}) => {
    react.render();
    return useComposerStt({
      composerRef,
      provider: "aliyun_dashscope",
      transport,
      disabled: false,
      sessionKey: "conversation-a",
      hidden: false,
      ...overrides,
    });
  };
  return {
    render,
    calls,
    callbacks,
    sessionIds,
    captures,
    composerEvents,
    effects,
    deferCaptureStop() {
      deferCaptureStop = true;
    },
    releaseCaptureStop() {
      releaseCaptureStop?.();
      releaseCaptureStop = null;
      deferCaptureStop = false;
    },
    flushLayoutEffects() {
      for (const effect of [...layoutEffects]) effect();
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("useComposerStt starts permission, capture, then cloud open and drains FIFO in order", async () => {
  const harness = createHarness();
  let result = harness.render();
  await result.toggle();
  await settle();
  assert.deepEqual(harness.calls.slice(0, 2), ["permission", "open"]);
  assert.deepEqual(harness.captures[0].events, ["capture.start"]);

  harness.captures[0].chunk(0, [1]);
  harness.captures[0].chunk(1, [2]);
  assert.deepEqual(harness.calls.filter((call) => Array.isArray(call)), []);
  const sessionId = harness.sessionIds[0];
  harness.callbacks[0]({ type: "ready", sessionId });
  await settle();
  assert.ok(harness.captures[0].events.includes("capture.resetSilenceClock"));
  const audioCalls = harness.calls.filter((call) => Array.isArray(call) && call[0] === "audio");
  assert.deepEqual(audioCalls.map((call) => call[2]), [0, 1]);

  harness.captures[0].chunk(2, [3]);
  await settle();
  assert.deepEqual(
    harness.calls.filter((call) => Array.isArray(call) && call[0] === "audio").map((call) => call[2]),
    [0, 1, 2],
  );
  assert.match(sessionId, /^[0-9a-f-]{16,}$/);
  result = harness.render();
  assert.equal(result.state, "recognizing");
});

test("stop halts capture, sends four 100 ms tail chunks, then finishes transport", async () => {
  const harness = createHarness();
  let result = harness.render();
  await result.toggle();
  await settle();
  harness.callbacks[0]({ type: "ready", sessionId: harness.sessionIds[0] });
  await settle();
  result = harness.render();
  await result.toggle();
  await settle();
  assert.deepEqual(
    harness.captures[0].events.filter((event) => event !== "capture.resetSilenceClock"),
    ["capture.start", "capture.stop"],
  );
  const audio = harness.calls.filter((call) => Array.isArray(call) && call[0] === "audio");
  assert.deepEqual(audio.map((call) => call[2]), [0, 1, 2, 3]);
  assert.deepEqual(harness.calls.filter((call) => Array.isArray(call) && call[0] === "stop").length, 1);
});

test("ready racing with capture stop waits for tail audio before finish", async () => {
  const harness = createHarness();
  let result = harness.render();
  await result.toggle();
  await settle();
  harness.deferCaptureStop();
  result = harness.render();
  const stopping = result.toggle();
  await settle();

  harness.callbacks[0]({ type: "ready", sessionId: harness.sessionIds[0] });
  await settle();
  assert.equal(harness.calls.some((call) => Array.isArray(call) && call[0] === "stop"), false);

  harness.releaseCaptureStop();
  await stopping;
  await settle();
  const audioSequences = harness.calls
    .filter((call) => Array.isArray(call) && call[0] === "audio")
    .map((call) => call[2]);
  assert.deepEqual(audioSequences, [0, 1, 2, 3]);
  assert.equal(harness.calls.filter((call) => Array.isArray(call) && call[0] === "stop").length, 1);
});

test("final accepts only the active session and stale events cannot mutate the composer", async () => {
  const harness = createHarness();
  let result = harness.render();
  await result.toggle();
  await settle();
  harness.callbacks[0]({ type: "partial", sessionId: "old-session", text: "stale" });
  assert.deepEqual(harness.composerEvents, ["begin"]);
  harness.callbacks[0]({ type: "partial", sessionId: harness.sessionIds[0], text: "live" });
  assert.deepEqual(harness.composerEvents.at(-1), ["partial", "live"]);
  harness.callbacks[0]({ type: "final", sessionId: harness.sessionIds[0], text: "done" });
  await settle();
  assert.deepEqual(harness.composerEvents.at(-1), ["cancel", { preserveLastText: true }]);
  assert.ok(harness.composerEvents.some((event) => event[0] === "final" && event[1] === "done"));
});

test("silence during buffering does not finish; ready resets the clock then silence stops", async () => {
  const harness = createHarness();
  let result = harness.render();
  await result.toggle();
  await settle();
  harness.captures[0].silence();
  await settle();
  assert.equal(harness.calls.some((call) => Array.isArray(call) && call[0] === "stop"), false);

  harness.callbacks[0]({ type: "ready", sessionId: harness.sessionIds[0] });
  await settle();
  assert.ok(harness.captures[0].events.includes("capture.resetSilenceClock"));
  harness.captures[0].silence();
  await settle();
  assert.equal(harness.calls.filter((call) => Array.isArray(call) && call[0] === "stop").length, 1);
  result = harness.render();
  assert.equal(result.state, "stopping");
});

test("changing sessionKey or hiding the composer cancels the active session", async () => {
  const harness = createHarness();
  let result = harness.render({ sessionKey: "conversation-a" });
  await result.toggle();
  await settle();
  harness.callbacks[0]({ type: "partial", sessionId: harness.sessionIds[0], text: "keep" });

  harness.render({ sessionKey: "conversation-b" });
  harness.flushLayoutEffects();
  await settle();
  assert.equal(harness.calls.filter((call) => Array.isArray(call) && call[0] === "cancel").length, 1);
  assert.deepEqual(harness.composerEvents.at(-1), ["cancel", { preserveLastText: true }]);

  result = harness.render({ sessionKey: "conversation-b" });
  await result.toggle();
  await settle();
  harness.render({ sessionKey: "conversation-b", hidden: true });
  harness.flushLayoutEffects();
  await settle();
  assert.equal(harness.calls.filter((call) => Array.isArray(call) && call[0] === "cancel").length, 2);
});
