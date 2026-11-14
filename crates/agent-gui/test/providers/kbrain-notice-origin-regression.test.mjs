import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { convertMessages } = loader.loadModule("src/lib/kbrain/history.ts");
const notice = "[subagent sub-1 cancelled] Review history\n\ncontext canceled";
const content = [{ type: "text", text: notice }];

test("an authored user may quote an internal notice twice with distinct identities", () => {
  const messages = convertMessages([
    { id: "user-first", role: "user", content },
    { id: "user-second", role: "user", content },
    { id: "notice-third", role: "user", origin: "background", content },
  ]);
  assert.deepEqual(messages.map((message) => message.id), ["user-first", "user-second", "notice-third"]);
  assert.equal(messages[0].liveAgentBackgroundNotice, undefined);
  assert.equal(messages[1].liveAgentBackgroundNotice, undefined);
  assert.equal(messages[2].liveAgentBackgroundNotice, true);
  assert.deepEqual(messages.map((message) => message.content), [notice, notice, notice]);
});

test("shared subagent projection retains a notice without turning it into a user bubble", () => {
  const { subagentTranscriptItems } = loader.loadModule("src/lib/subagents/kbrainSubagentTranscript.ts");
  const rows = subagentTranscriptItems([
    { id: "notice", role: "user", origin: "background", content },
    { id: "quote", role: "user", content },
  ], false);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].backgroundNotice, true);
  assert.equal(rows[1].backgroundNotice, undefined);
  assert.equal(rows[0].text, notice);
  assert.equal(rows[1].text, notice);
});

test("legacy identity-less cancelled reports remain notices; explicit other origins win", () => {
  const messages = convertMessages([
    { role: "user", content },
    { role: "user", origin: "user", content },
    { role: "user", authored: true, content },
  ]);
  assert.equal(messages[0].liveAgentBackgroundNotice, true);
  assert.equal(messages[1].liveAgentBackgroundNotice, undefined);
  assert.equal(messages[2].liveAgentBackgroundNotice, undefined);
});
