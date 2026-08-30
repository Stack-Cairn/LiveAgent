// crates/agent-gui/test/chat/clarify-protocol.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);
const loader = createTsModuleLoader({ mocks: {} });
const protocol = loader.loadModule(
  abs("../agent-ui/src/components/chat/clarify/clarifyProtocol.ts"),
);

test("question marker parses", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_QUESTION]\n要做什么功能？");
  assert.equal(r.kind, "question");
  assert.equal(r.text, "要做什么功能？");
});

test("final marker parses", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_FINAL]\n优化后的提示词正文");
  assert.equal(r.kind, "final");
  assert.equal(r.text, "优化后的提示词正文");
});

test("no marker falls back to question", () => {
  const r = protocol.parseClarifyTurn("直接一句没有标记的话");
  assert.equal(r.kind, "question");
  assert.equal(r.text, "直接一句没有标记的话");
});

test("marker after body text still recognized", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_FINAL]\n\n  带空行的终稿  ");
  assert.equal(r.kind, "final");
  assert.equal(r.text, "带空行的终稿");
});

test("stripLeadingMarker hides complete and partial markers during streaming", () => {
  assert.equal(protocol.stripLeadingMarker("[CLARIFY_QUE"), "");
  assert.equal(protocol.stripLeadingMarker("[CLARIFY_QUESTION]\n问题正文"), "问题正文");
  assert.equal(protocol.stripLeadingMarker("普通文本"), "普通文本");
});

test("system prompt contains workspace context and rules", () => {
  const p = protocol.buildClarifySystemPrompt({ workdir: "/repo/x", gitBranch: "main" });
  assert.match(p, /\/repo\/x/);
  assert.match(p, /main/);
  assert.match(p, /一次只问一个问题/);
  const bare = protocol.buildClarifySystemPrompt();
  assert.doesNotMatch(bare, /workdir/i);
});

test("buildClarifyMessages prepends system", () => {
  const msgs = protocol.buildClarifyMessages(
    [{ role: "user", content: "hi" }],
    { workdir: "/w" },
  );
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs.length, 2);
});
