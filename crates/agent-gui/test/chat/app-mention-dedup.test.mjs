import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const {
  APP_MENTION_NAME_ATTR,
  collectAppMentionKeys,
  createAppMentionChip,
  enforceUniqueAppMentionsInEditor,
  sanitizeAppMentionSegments,
} = env.loadModule("@liveagent/ui/components/chat/MentionComposerInternals.tsx");

function app(name, path, bundleId) {
  return { name, path, ...(bundleId ? { bundleId } : {}) };
}

function segment(value) {
  return { type: "appMention", app: value };
}

test("draft and paste segments retain only the first stable app identity", () => {
  const editor = document.createElement("div");
  editor.appendChild(createAppMentionChip(app("Music", "/Applications/Music.app", "com.apple.Music")));

  const fresh = segment(app("Notes", "/Applications/Notes.app", "com.apple.Notes"));
  const result = sanitizeAppMentionSegments(editor, [
    segment(app("Renamed Music", "/tmp/other.app", "com.apple.Music")),
    fresh,
    segment(app("Notes Copy", "/tmp/notes.app", "com.apple.Notes")),
  ]);

  assert.deepEqual(result, [fresh]);
});

test("draft restore dedupes within the incoming batch when the editor is cleared", () => {
  const editor = document.createElement("div");
  const first = segment(app("Tool", "/Applications/Tool.app"));
  const result = sanitizeAppMentionSegments(
    editor,
    [first, segment(app("Tool renamed", "/Applications/Tool.app"))],
    { includeExistingChips: false },
  );

  assert.deepEqual(result, [first]);
});

test("native DOM paste removes duplicate and malformed chips", () => {
  const editor = document.createElement("div");
  editor.append(
    createAppMentionChip(app("Tool", "/Applications/Tool.app")),
    createAppMentionChip(app("Tool", "/Applications/Tool.app")),
  );
  const malformed = document.createElement("span");
  malformed.setAttribute(APP_MENTION_NAME_ATTR, "");
  editor.appendChild(malformed);

  enforceUniqueAppMentionsInEditor(editor);

  assert.equal(editor.children.length, 1);
  assert.equal(collectAppMentionKeys(editor).length, 1);
});

test.after(() => env.cleanup());
