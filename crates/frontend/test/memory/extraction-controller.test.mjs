import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);

const loader = createTsModuleLoader();
const controllerModule = loader.loadModule(coreSrc("chat/memory/extractionController.ts"));
const { memoryExtraction, __setMemoryExtractionEngineForTests } = controllerModule;

let conversationSeq = 0;
function newConversationId() {
  conversationSeq += 1;
  return `conv-controller-${conversationSeq}`;
}

function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}

function baseRequest(conversationId, text = "请记住我以后都用中文写提交信息") {
  return {
    primary: { providerId: "openai", model: "test-model", runtime: { baseUrl: "x", apiKey: "y" } },
    sessionId: "session-1",
    conversationId,
    workdir: "/tmp/project",
    messages: [userMessage(text)],
  };
}

function okResult(overrides = {}) {
  return {
    ok: true,
    acceptedCount: 1,
    rejectedCount: 0,
    writtenSlugs: [],
    emittedMessages: [],
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("atomic claim: two synchronous requests → one run + one coalesce", async () => {
  const conversationId = newConversationId();
  const gate = deferred();
  const calls = [];
  __setMemoryExtractionEngineForTests(async (params) => {
    calls.push(params);
    await gate.promise;
    return okResult();
  });
  try {
    const first = memoryExtraction.requestExtraction(baseRequest(conversationId));
    const second = memoryExtraction.requestExtraction(baseRequest(conversationId));
    const secondResult = await second;
    assert.equal(secondResult.skipped, "coalesced-into-running-extraction");
    gate.resolve();
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    // give the queued (coalesced) run a tick to start and finish
    await new Promise((r) => setTimeout(r, 10));
    // the coalesced request re-entered gating; same user message key → skipped
    assert.equal(calls.length, 1);
  } finally {
    __setMemoryExtractionEngineForTests(null);
    memoryExtraction.dispose(conversationId);
  }
});

test("coalesced request with NEW user content runs after the in-flight one", async () => {
  const conversationId = newConversationId();
  const gate = deferred();
  const seenTexts = [];
  __setMemoryExtractionEngineForTests(async (params) => {
    seenTexts.push(params.messages[params.messages.length - 1].content);
    if (seenTexts.length === 1) await gate.promise;
    return okResult();
  });
  try {
    const first = memoryExtraction.requestExtraction(baseRequest(conversationId, "第一条要记的偏好内容"));
    const request2 = baseRequest(conversationId, "第二条完全不同的偏好内容");
    request2.messages = [userMessage("第一条要记的偏好内容"), userMessage("第二条完全不同的偏好内容")];
    void memoryExtraction.requestExtraction(request2);
    gate.resolve();
    await first;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(seenTexts.length, 2);
    assert.ok(String(seenTexts[1]).includes("第二条"));
  } finally {
    __setMemoryExtractionEngineForTests(null);
    memoryExtraction.dispose(conversationId);
  }
});

test("new turn boundary does NOT abort an in-flight run; dispose does", async () => {
  const conversationId = newConversationId();
  const gate = deferred();
  let observedSignal;
  __setMemoryExtractionEngineForTests(async (params) => {
    observedSignal = params.signal;
    await gate.promise;
    return okResult();
  });
  try {
    const run = memoryExtraction.requestExtraction(baseRequest(conversationId));
    await new Promise((r) => setTimeout(r, 5));
    memoryExtraction.noteTurnBoundary(conversationId);
    assert.equal(observedSignal.aborted, false, "turn boundary must not abort");
    memoryExtraction.dispose(conversationId);
    assert.equal(observedSignal.aborted, true, "dispose must abort");
    gate.resolve();
    await run;
  } finally {
    __setMemoryExtractionEngineForTests(null);
  }
});

test("parent cancellation aborts an in-flight extraction run", async () => {
  const conversationId = newConversationId();
  const parent = new AbortController();
  const gate = deferred();
  let observedSignal;
  __setMemoryExtractionEngineForTests(async (params) => {
    observedSignal = params.signal;
    await gate.promise;
    return okResult();
  });
  try {
    const request = baseRequest(conversationId);
    request.signal = parent.signal;
    const run = memoryExtraction.requestExtraction(request);
    await new Promise((resolve) => setTimeout(resolve, 5));

    parent.abort();
    assert.equal(observedSignal.aborted, true);

    gate.resolve();
    await run;
  } finally {
    __setMemoryExtractionEngineForTests(null);
    memoryExtraction.dispose(conversationId);
  }
});

test("gating skips run entirely for trivial messages", async () => {
  const conversationId = newConversationId();
  let engineCalls = 0;
  __setMemoryExtractionEngineForTests(async () => {
    engineCalls += 1;
    return okResult();
  });
  try {
    const result = await memoryExtraction.requestExtraction(
      baseRequest(conversationId, "谢谢啦老铁们"),
    );
    assert.equal(result.skipped, "acknowledgement-thanks");
    assert.equal(engineCalls, 0);
  } finally {
    __setMemoryExtractionEngineForTests(null);
    memoryExtraction.dispose(conversationId);
  }
});

test("short confirmation claims the run with deferral flag set", async () => {
  const conversationId = newConversationId();
  let deferralFlag;
  __setMemoryExtractionEngineForTests(async (params) => {
    deferralFlag = params.confirmationDeferralOnly;
    return okResult();
  });
  try {
    const result = await memoryExtraction.requestExtraction(baseRequest(conversationId, "是的"));
    assert.equal(result.ok, true);
    assert.equal(deferralFlag, true);
  } finally {
    __setMemoryExtractionEngineForTests(null);
    memoryExtraction.dispose(conversationId);
  }
});

test("written slugs accumulate in a ring and reset on turn boundary", async () => {
  const conversationId = newConversationId();
  const observed = [];
  let call = 0;
  __setMemoryExtractionEngineForTests(async (params) => {
    observed.push([...params.alreadyWrittenSlugs]);
    call += 1;
    return okResult({ writtenSlugs: [`slug-${call}`] });
  });
  try {
    const first = baseRequest(conversationId, "第一条要记的偏好内容");
    await memoryExtraction.requestExtraction(first);
    // second request: new user message, throttle cleared via turn boundary
    memoryExtraction.noteTurnBoundary(conversationId);
    const second = baseRequest(conversationId, "第二条完全不同的偏好内容");
    second.messages = [userMessage("a"), userMessage("第二条完全不同的偏好内容")];
    await memoryExtraction.requestExtraction(second);
    assert.deepEqual(observed[0], []);
    // turn boundary cleared slug tracking before the second run
    assert.deepEqual(observed[1], []);
  } finally {
    __setMemoryExtractionEngineForTests(null);
    memoryExtraction.dispose(conversationId);
  }
});

test("same user message is not re-extracted (no-new-user-message)", async () => {
  const conversationId = newConversationId();
  let engineCalls = 0;
  __setMemoryExtractionEngineForTests(async () => {
    engineCalls += 1;
    return okResult();
  });
  try {
    const request = baseRequest(conversationId);
    await memoryExtraction.requestExtraction(request);
    memoryExtraction.noteTurnBoundary(conversationId); // clears throttle, keeps user key
    const repeat = await memoryExtraction.requestExtraction(baseRequest(conversationId));
    assert.equal(engineCalls, 1);
    assert.equal(repeat.skipped, "no-new-user-message");
  } finally {
    __setMemoryExtractionEngineForTests(null);
    memoryExtraction.dispose(conversationId);
  }
});
