import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const { resolveTodoItems, shouldRenderTodoInline } = loader.loadModule(
  "src/pages/chat/TodoListView.tsx",
);

const todos = [
  { content: "Inspect", status: "completed", activeForm: "Inspecting" },
  { content: "Fix", status: "in_progress", activeForm: "Fixing" },
];

function item({ name = "TodoWrite", result } = {}) {
  return {
    toolCall: { type: "toolCall", id: "todo-1", name, arguments: { todos } },
    ...(result ? { toolResult: result } : {}),
  };
}

test("TodoWrite renders inline while streaming and after success", () => {
  assert.equal(shouldRenderTodoInline(item()), true);
  assert.equal(
    shouldRenderTodoInline(
      item({ result: { isError: false, details: { kind: "todo_write", todos } } }),
    ),
    true,
  );
});

test("failed TodoWrite and other tools keep the regular tool card", () => {
  assert.equal(shouldRenderTodoInline(item({ result: { isError: true } })), false);
  assert.equal(shouldRenderTodoInline(item({ name: "Read" })), false);
});

test("settled result todos take precedence over streaming arguments", () => {
  const settled = [{ content: "Done", status: "completed", activeForm: "Doing" }];
  assert.deepEqual(
    resolveTodoItems(
      item({ result: { isError: false, details: { kind: "todo_write", todos: settled } } }),
    ),
    settled,
  );
});
