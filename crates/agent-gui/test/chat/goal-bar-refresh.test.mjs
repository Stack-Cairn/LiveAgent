import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

for (const liveUpdate of [false, true]) {
  test(`opening goal read ${liveUpdate ? "keeps a newer live update" : "restores the saved snapshot"}`, async () => {
    let resolveRead;
    let visible;
    const env = await createDomTestEnv({
      mocks: {
        "../../../lib/kbrain/client": {
          createKBrainClient: () => ({
            getGoal: () =>
              new Promise((resolve) => {
                resolveRead = resolve;
              }),
          }),
        },
        "../../../lib/kbrain/mapping": { getKBrainSessionId: () => "session" },
        "@liveagent/ui/components/chat/ComposerGoalBar": {
          ComposerGoalBar: ({ state }) => {
            visible = state;
            return null;
          },
        },
        "@liveagent/ui/components/ui/toast-manager": { toast: {} },
      },
    });
    const { KBrainGoalBarHost } = env.loadModule("src/pages/chat/composer/KBrainGoalBarHost.tsx");
    const { publishGoalState } = env.loadModule("src/lib/kbrain/goalStore.ts");
    const goal = {
      version: "kbrain.agent.v1",
      conversation_id: "session",
      goal: "finish the task",
      status: "active",
      round: 1,
      max_rounds: 10,
    };
    const root = env.createRoot(document.createElement("div"));
    try {
      await env.act(async () =>
        root.render(
          env.React.createElement(KBrainGoalBarHost, { conversationId: "chat", enabled: true }),
        ),
      );
      if (liveUpdate)
        await env.act(async () =>
          publishGoalState("chat", { ...goal, status: "paused", reason: "user" }),
        );
      await env.act(async () => resolveRead(goal));
      assert.equal(visible.status, liveUpdate ? "paused" : "active");
    } finally {
      await env.act(async () => root.unmount());
      env.cleanup();
    }
  });
}
