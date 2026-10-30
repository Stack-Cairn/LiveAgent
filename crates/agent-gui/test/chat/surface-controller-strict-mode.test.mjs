// Review regression: ChatPage creates the focused surface controller in useMemo and disposes
// it in an effect cleanup. React.StrictMode (dev builds) replays effects as mount → cleanup →
// mount, so dispose() runs while the page keeps rendering that same controller. Its
// subscribe() then did nothing: the approval bar only appeared, and only went away after
// "Allow", when some unrelated update re-rendered the page (seconds later, or at run end).
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createConversationRuntimeRegistry } = loader.loadModule(
  "src/pages/chat/conversations/createConversationRuntimeRegistry.ts",
);
const { createConversationSurfaceController } = loader.loadModule(
  "src/pages/chat/conversations/createConversationSurfaceController.ts",
);
const { answerToolApproval, requestToolApproval } = loader.loadModule(
  "src/lib/tools/toolApproval.ts",
);

const noop = async () => undefined;

test("a controller disposed by a StrictMode effect replay still pushes approval changes", async () => {
  const registry = createConversationRuntimeRegistry();
  const controller = createConversationSurfaceController({
    conversationId: "strict-a",
    project: { projectId: "p", projectPathKey: "/workspace/p" },
    registry,
    actions: { hydrate: noop, send: noop, stop() {}, compact: noop, retry: noop },
  });

  // StrictMode: subscribe and retain on mount, run every cleanup (dispose included), mount again.
  const firstUnsubscribe = controller.subscribe(() => undefined);
  const firstRelease = controller.retainView();
  firstUnsubscribe();
  firstRelease();
  controller.dispose();
  const pushes = [];
  controller.subscribe(() => pushes.push(controller.getSnapshot().approvals.length));
  controller.retainView();
  assert.equal(registry.getViewCount("strict-a"), 1, "the remounted view is retained");

  const settlement = requestToolApproval({
    toolCallId: "strict-call",
    toolName: "Bash",
    conversationId: "strict-a",
    timeoutMs: 10_000,
  });
  assert.deepEqual(pushes, [1], "the approval bar is pushed when the approval starts");
  assert.equal(answerToolApproval("strict-call", "approve", { conversationId: "strict-a" }).ok, true);
  await settlement;
  assert.deepEqual(pushes, [1, 0], "and pushed away as soon as it is answered");
});
