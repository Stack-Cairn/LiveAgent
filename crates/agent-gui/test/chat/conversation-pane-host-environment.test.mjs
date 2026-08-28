import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createConversationPaneHostEnvironment } = loader.loadModule(
  "src/pages/chat/surfaces/ConversationPaneHostEnvironment.tsx",
);

function registration(overrides = {}) {
  const conversationId = overrides.conversationId ?? "conversation-a";
  return {
    identity: {
      paneId: overrides.paneId ?? "pane-a",
      conversationId,
      project: overrides.project ?? {
        projectId: "project-a",
        projectPathKey: "/workspace/a",
      },
    },
    binding: {
      controller: { conversationId: overrides.controllerConversationId ?? conversationId },
    },
  };
}

test("pane host environment resolves the authoritative registration by pane id", () => {
  const current = registration();
  const environment = createConversationPaneHostEnvironment([current]);

  assert.equal(environment.resolvePane(" pane-a "), current);
  assert.equal(environment.resolvePane("removed-pane"), null);
});

test("pane host environment still rejects invalid registration identities", () => {
  assert.throws(
    () => createConversationPaneHostEnvironment([registration({ paneId: " " })]),
    /stable pane id/,
  );
  assert.throws(
    () =>
      createConversationPaneHostEnvironment([
        registration({ paneId: "pane-a" }),
        registration({ paneId: "pane-a", conversationId: "conversation-b" }),
      ]),
    /Duplicate conversation pane registration/,
  );
  assert.throws(
    () =>
      createConversationPaneHostEnvironment([
        registration({ controllerConversationId: "conversation-b" }),
      ]),
    /controller identity mismatch/,
  );
});
