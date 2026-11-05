import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const uiDir = path.resolve(rootDir, "../agent-ui/src");
const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
const jsxRuntime = requireFromRoot("react/jsx-runtime");
const { renderToStaticMarkup } = requireFromRoot("react-dom/server");

function Marker(name) {
  return function MockComponent() {
    return jsxRuntime.jsx("div", { [`data-mock-${name}`]: "" });
  };
}
function NullIcon() {
  return null;
}

const loader = createTsModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    [path.join(uiDir, "i18n/index.ts")]: { useLocale: () => ({ t: (key) => key }) },
    [path.join(uiDir, "components/IconSet.tsx")]: { Activity: NullIcon, ChevronRight: NullIcon, Goal: NullIcon },
    "@liveagent/ui/components/chat/EditableUserMessageBubble": { EditableUserMessageBubble: Marker("editor") },
    "@liveagent/ui/components/chat/UserMessageBubbleBody": { UserMessageBubbleBody: Marker("bubble") },
    "../../../agent-ui-adapters/composerImagePreview": { loadComposerUploadedImagePreview: () => null },
    "./RowActions": { UserRowFooter: Marker("footer") },
  },
});
const { BackgroundNoticeMessage, parseGoalRoundNotice, splitBackgroundNotice } = loader.loadModule(
  "@liveagent/ui/components/chat/BackgroundNoticeMessage.tsx",
);
const { UserMessageRow } = loader.loadModule("src/pages/chat/transcript/UserMessageRow.tsx");

const notice = "[wait w1 done] condition met (ran every 2s):\n$ cat build.log\n\nBUILD-READY";

test("a backend notice splits into its headline and folded output", () => {
  assert.deepEqual(splitBackgroundNotice(notice), {
    headline: "[wait w1 done] condition met (ran every 2s):",
    detail: "$ cat build.log\n\nBUILD-READY",
  });
  assert.deepEqual(splitBackgroundNotice("  [subagent s1 done] audit  "), {
    headline: "[subagent s1 done] audit",
    detail: "",
  });
});

test("a backend notice renders as a folded system line", () => {
  const html = renderToStaticMarkup(jsxRuntime.jsx(BackgroundNoticeMessage, { text: notice }));
  assert.match(html, /data-background-notice/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /\[wait w1 done\] condition met/);
  assert.doesNotMatch(html, /BUILD-READY/, "the output stays folded until expanded");
});

test("a goal continuation round is labelled with its round and shows the goal", () => {
  assert.deepEqual(parseGoalRoundNotice("[goal 10/100] Draft the v1.3 release notes"), {
    round: 10,
    maxRounds: 100,
    goal: "Draft the v1.3 release notes",
  });
  assert.equal(parseGoalRoundNotice("[wait w1 done] condition met"), null);
  assert.equal(parseGoalRoundNotice("[goal 0/3] start"), null);
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(BackgroundNoticeMessage, {
      text: "[goal 10/100] Draft the v1.3 release notes\nGroup the changes by area.",
    }),
  );
  assert.match(html, /data-background-notice/);
  assert.match(html, /data-goal-round/);
  // The test locale returns keys; the label is chat.goal.continuing with the round filled in.
  assert.match(html, />chat\.goal\.continuing</);
  assert.match(html, />Draft the v1\.3 release notes</);
  assert.doesNotMatch(html, /\[goal 10\/100\]/, "the header becomes the label");
  assert.doesNotMatch(html, /Group the changes/, "further goal lines stay folded");
  const plain = renderToStaticMarkup(jsxRuntime.jsx(BackgroundNoticeMessage, { text: notice }));
  assert.doesNotMatch(plain, /data-goal-round/);
  assert.match(plain, />chat\.backgroundNotice</);
});

test("a wrapped runtime reminder shows its text, not the tag", () => {
  const reminder =
    "<system-reminder>\nYour previous response was cut off because it reached the output token limit. Continue exactly where it stopped.\n</system-reminder>";
  assert.deepEqual(splitBackgroundNotice(reminder), {
    headline:
      "Your previous response was cut off because it reached the output token limit. Continue exactly where it stopped.",
    detail: "",
  });
});

function userRow(item) {
  return {
    kind: "user",
    key: item.key,
    estimate: 24,
    renderCost: 1,
    gapAfter: 24,
    anchorUserKey: item.key,
    item: {
      kind: "user",
      segmentIndex: 0,
      attachments: [],
      referencedConversations: [],
      timestamp: 1000,
      isFromCompactedSegment: false,
      messageRef: { segmentIndex: 0, segmentId: "s", messageIndex: 0, messageId: item.key, role: "user", contentHash: "h" },
      ...item,
    },
  };
}

test("the desktop transcript shows a notice instead of a user bubble with edit actions", () => {
  const props = {
    isEditing: false,
    loadCommitDetails: async () => null,
    onStartEdit: () => {},
    onCancelEdit: () => {},
    onResendFromEdit: () => {},
  };
  const noticeHtml = renderToStaticMarkup(
    jsxRuntime.jsx(UserMessageRow, { ...props, row: userRow({ key: "u-2", text: notice, backgroundNotice: true }) }),
  );
  assert.match(noticeHtml, /data-background-notice/);
  assert.doesNotMatch(noticeHtml, /data-user-bubble-wrap/);
  // Even while "editing" (a stale editing key), a notice never opens the editor.
  const editingHtml = renderToStaticMarkup(
    jsxRuntime.jsx(UserMessageRow, { ...props, isEditing: true, row: userRow({ key: "u-2", text: notice, backgroundNotice: true }) }),
  );
  assert.match(editingHtml, /data-background-notice/);
  assert.doesNotMatch(editingHtml, /data-mock-editor/);
  const userHtml = renderToStaticMarkup(
    jsxRuntime.jsx(UserMessageRow, { ...props, row: userRow({ key: "u-1", text: "build it" }) }),
  );
  assert.match(userHtml, /data-user-bubble-wrap/);
  assert.doesNotMatch(userHtml, /data-background-notice/);
});
