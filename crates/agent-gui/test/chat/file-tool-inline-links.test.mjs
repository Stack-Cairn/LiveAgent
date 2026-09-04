import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { getFileOperationDisplay } = loader.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);

function item(name, args, details) {
  const toolCall = { type: "toolCall", id: `call-${name}`, name, arguments: args };
  return details === undefined
    ? { toolCall }
    : {
        toolCall,
        toolResult: {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: name,
          content: [],
          details,
          isError: false,
        },
      };
}

test("file operation summaries prefer resolved IDE paths and preserve read locations", () => {
  assert.deepEqual(
    getFileOperationDisplay(
      item(
        "Read",
        { path: "src/pages/chat/ChatPage.tsx", start_line: 42 },
        {
          displayPath: "src/pages/chat/ChatPage.tsx",
          relativePath: "src/pages/chat/ChatPage.tsx",
          absolutePath: "/workspace/src/pages/chat/ChatPage.tsx",
        },
      ),
    ),
    {
      kind: "read",
      path: "src/pages/chat/ChatPage.tsx",
      fileName: "ChatPage.tsx",
      link: {
        path: "/workspace/src/pages/chat/ChatPage.tsx",
        line: 42,
        source: "absolute",
      },
    },
  );
});

test("file operation summaries distinguish create, overwrite, edit, and delete", () => {
  assert.equal(
    getFileOperationDisplay(item("Write", { path: "new.ts" }, { existedBefore: false, path: "new.ts" }))
      .kind,
    "create",
  );
  assert.equal(
    getFileOperationDisplay(item("Write", { path: "old.ts" }, { existedBefore: true, path: "old.ts" }))
      .kind,
    "edit",
  );
  assert.equal(getFileOperationDisplay(item("Edit", { path: "edit.ts" })).kind, "edit");
  assert.equal(getFileOperationDisplay(item("Delete", { path: "gone.ts" })).kind, "delete");
});

test("only exact path-based file tools become concise file rows", () => {
  assert.equal(getFileOperationDisplay(item("Image", { path: "shot.png" })), null);
  assert.equal(getFileOperationDisplay(item("SkillsManager", { path: "skill://demo/SKILL.md" })), null);
  assert.equal(getFileOperationDisplay(item("Read", {})), null);
});
