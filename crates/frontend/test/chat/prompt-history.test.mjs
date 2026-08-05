import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const promptHistory = loader.loadModule("src/components/chat/promptHistory.ts");

const { normalizePromptHistoryEntries, stepPromptHistory, collectPromptLineText } = promptHistory;

function makeStash(html = "<b>draft</b>") {
  return { html, pastes: [] };
}

function step(overrides) {
  return stepPromptHistory({
    direction: "prev",
    session: null,
    caretOnFirstLine: true,
    caretOnLastLine: true,
    loadEntries: () => [],
    makeStash: () => makeStash(),
    ...overrides,
  });
}

test("normalize drops blanks, dedupes keeping the newest occurrence, keeps order", () => {
  assert.deepEqual(normalizePromptHistoryEntries(["a", "", "  ", "b", "a", "c"]), ["b", "a", "c"]);
});

test("normalize caps at the newest entries", () => {
  const raw = Array.from({ length: 250 }, (_, i) => `p${i}`);
  const normalized = normalizePromptHistoryEntries(raw);
  assert.equal(normalized.length, promptHistory.PROMPT_HISTORY_MAX_ENTRIES);
  assert.equal(normalized[0], "p50");
  assert.equal(normalized.at(-1), "p249");
});

test("↑ with no history passes through", () => {
  assert.deepEqual(step({ loadEntries: () => [] }), { type: "pass" });
});

test("↑ off the first line passes through (caret movement wins)", () => {
  assert.deepEqual(
    step({ caretOnFirstLine: false, loadEntries: () => ["a"] }),
    { type: "pass" },
  );
});

test("↑ enters recall at the newest entry and stashes the draft", () => {
  const result = step({ loadEntries: () => ["old", "new"] });
  assert.equal(result.type, "apply");
  assert.equal(result.text, "new");
  assert.equal(result.session.cursor, 1);
  assert.deepEqual(result.session.entries, ["old", "new"]);
  assert.equal(result.session.stash.html, "<b>draft</b>");
});

test("↑ then ↑ walks older; at the oldest it consumes without changes", () => {
  const first = step({ loadEntries: () => ["old", "new"] });
  const second = step({ session: first.session });
  assert.equal(second.type, "apply");
  assert.equal(second.text, "old");
  assert.equal(second.session.cursor, 0);
  const third = step({ session: second.session });
  assert.deepEqual(third, { type: "consume" });
});

test("↓ without a session passes through", () => {
  assert.deepEqual(step({ direction: "next" }), { type: "pass" });
});

test("↓ off the last line passes through while a session is active", () => {
  const entered = step({ loadEntries: () => ["a", "b"] });
  assert.deepEqual(
    step({ direction: "next", session: entered.session, caretOnLastLine: false }),
    { type: "pass" },
  );
});

test("↓ walks newer and restores the stashed draft past the newest entry", () => {
  const entered = step({ loadEntries: () => ["a", "b"] });
  const older = step({ session: entered.session });
  const newer = step({ direction: "next", session: older.session });
  assert.equal(newer.type, "apply");
  assert.equal(newer.text, "b");
  const restored = step({ direction: "next", session: newer.session });
  assert.equal(restored.type, "restore");
  assert.equal(restored.stash.html, "<b>draft</b>");
});

test("entry snapshot is loaded lazily only on session entry", () => {
  let loads = 0;
  const entered = step({
    loadEntries: () => {
      loads += 1;
      return ["a", "b"];
    },
  });
  step({
    session: entered.session,
    loadEntries: () => {
      throw new Error("must not reload during an active session");
    },
  });
  assert.equal(loads, 1);
});

function textNode(data) {
  return { nodeType: 3, data };
}

function br() {
  return element("BR");
}

function element(tagName, children = [], attrs = {}) {
  const el = {
    nodeType: 1,
    tagName,
    getAttribute: (name) => attrs[name] ?? null,
    firstChild: null,
  };
  linkChildren(el, children);
  return el;
}

function fragment(children) {
  const frag = { nodeType: 11, firstChild: null };
  linkChildren(frag, children);
  return frag;
}

function linkChildren(parent, children) {
  for (let i = 0; i < children.length; i += 1) {
    children[i].nextSibling = children[i + 1] ?? null;
  }
  parent.firstChild = children[0] ?? null;
}

test("collectPromptLineText maps <br> to newline and treats chips as opaque", () => {
  const frag = fragment([
    textNode("line one "),
    element("SPAN", [textNode("chip\nlabel")], { contenteditable: "false" }),
    br(),
    textNode("line two"),
  ]);
  assert.equal(collectPromptLineText(frag), "line one \nline two");
});

test("collectPromptLineText descends editable elements", () => {
  const frag = fragment([element("SPAN", [textNode("a"), br(), textNode("b")])]);
  assert.equal(collectPromptLineText(frag), "a\nb");
});
