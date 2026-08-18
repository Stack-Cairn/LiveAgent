import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
const jsxRuntime = requireFromRoot("react/jsx-runtime");
const { renderToStaticMarkup } = requireFromRoot("react-dom/server");

const loader = createWebModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/lib/chat/changedFiles": {
      collectChangedFiles() {
        return null;
      },
    },
    "./AssistantAvatar": {
      AssistantAvatar() {
        return null;
      },
    },
    "./assistant-bubble/RoundContent": {
      RoundContent({ round }) {
        const toolNames = round.blocks.flatMap((block) =>
          block.kind === "tool" ? [block.item.toolCall.name] : [],
        );
        return jsxRuntime.jsx("div", {
          "data-round": round.round,
          children: toolNames.join(","),
        });
      },
    },
    "./ChangedFilesCard": {
      ChangedFilesCard() {
        return null;
      },
    },
  },
});

const { AssistantBubble } = loader.loadModule(
  "@liveagent/ui/components/chat/AssistantBubble.tsx",
);
const { buildTurnRows } = loader.loadModule("src/lib/chat/transcript/rows.ts");
const { createTurn, applyEventToTurn } = loader.loadModule(
  "src/lib/chat/transcript/turnReducer.ts",
);

function shellResult(id, name, status, cursor) {
  return {
    type: "tool_result",
    id,
    name,
    content: [{ type: "text", text: `${name}:${status}\n` }],
    details: {
      status,
      session_id: "session-1",
      cursor,
      output: [{ stream: "stdout", text: `${name}:${status}\n` }],
      output_truncated: false,
      has_more: false,
      exit_code: status === "completed" ? 0 : null,
      duration_ms: cursor * 1000,
      shell: "bash",
    },
    isError: status === "failed" || status === "timed_out",
  };
}

test("WebUI keeps Bash, ProcessWait, and ProcessStop visible in event order", () => {
  let turn = createTurn({ key: "shell-session", runId: "run-shell", phase: "settled" });
  const events = [
    {
      type: "tool_call",
      id: "bash-1",
      name: "Bash",
      arguments: { command: "pnpm build" },
      round: 1,
    },
    { ...shellResult("bash-1", "Bash", "running", 10), round: 1 },
    {
      type: "tool_call",
      id: "wait-1",
      name: "ProcessWait",
      arguments: { session_id: "session-1", cursor: 10 },
      round: 2,
    },
    { ...shellResult("wait-1", "ProcessWait", "running", 20), round: 2 },
    {
      type: "tool_call",
      id: "stop-1",
      name: "ProcessStop",
      arguments: { session_id: "session-1", cursor: 20 },
      round: 3,
    },
    { ...shellResult("stop-1", "ProcessStop", "cancelled", 21), round: 3 },
  ];

  for (const event of events) {
    turn = applyEventToTurn(turn, event);
  }

  const row = buildTurnRows(turn).find((candidate) => candidate.kind === "assistant");
  assert.ok(row);
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(AssistantBubble, {
      rounds: row.rounds,
      isLive: false,
      isStreaming: false,
    }),
  );

  assert.match(html, /Bash/);
  assert.match(html, /ProcessWait/);
  assert.match(html, /ProcessStop/);
  assert.ok(html.indexOf("Bash") < html.indexOf("ProcessWait"));
  assert.ok(html.indexOf("ProcessWait") < html.indexOf("ProcessStop"));
});
