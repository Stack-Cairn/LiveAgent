// Shared by the composer-queue-* tests: render the real ChatComposerBar
// (queue panel + optional goal bar) through jsdom and return its markup.
import React0 from "react";
import { createDomTestEnv } from "./dom-test-env.mjs";

const svgIcons = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "__esModule"
        ? true
        : (props) => React0.createElement("svg", { className: props?.className }),
  },
);

const noop = () => {};

const DEFAULT_QUEUE = [
  { id: "q1", previewText: "Refactor the settings page and add tests", fileCount: 3 },
  { id: "q2", previewText: "Summarize the diff for review", fileCount: 0 },
];
const DEFAULT_GOAL = { goal: "Ship the queue panel fix", status: "active", round: 2, maxRounds: 10 };

export async function renderComposerQueue({
  surface = "web",
  lang = "en-US",
  withGoal = false,
  goalState = DEFAULT_GOAL,
  queuedTurns = DEFAULT_QUEUE,
  queuePaused = true,
  goalEditing = false,
} = {}) {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": svgIcons,
      "@liveagent/ui/components/chat/fileTypeIcons": svgIcons,
      "@liveagent/ui/components/chat/MentionComposer": { MentionComposer: () => null },
    },
  });
  try {
    const { React, act, createRoot } = env;
    const doc = env.dom.window.document;
    const { ChatComposerBar } = env.loadModule("@liveagent/ui/pages/chat/ChatComposerBar.tsx");
    const { ComposerGoalBar } = env.loadModule("@liveagent/ui/components/chat/ComposerGoalBar.tsx");
    const { LocaleContext } = env.loadModule("@liveagent/ui/i18n/LocaleContext.tsx");
    const { t: translate } = env.loadModule("@liveagent/app/i18n/config.ts");
    const goalBar = withGoal
      ? React.createElement(ComposerGoalBar, {
          state: goalState,
          actions: { onPause: noop, onResume: noop, onUpdate: noop, onClear: noop },
        })
      : // Production always passes a goal-bar host element; without a goal it renders nothing.
        React.createElement(() => null);
    const props = {
      surface,
      conversationId: "c1",
      composerRef: { current: null },
      isSending: false,
      isUploadingFiles: false,
      isInputDisabled: false,
      inputPlaceholder: "Ask",
      workdir: "/w",
      enabledSkills: [],
      executionMode: "tools",
      hasModels: true,
      currentModelLabel: "m",
      modelOptions: [],
      chatRuntimeControls: {},
      reasoningOptions: [],
      thinkingAlwaysOn: false,
      onSend: noop,
      onStop: noop,
      onComposerBusyChange: noop,
      onSelectModel: noop,
      onSelectExecutionMode: noop,
      onChatRuntimeControlsChange: noop,
      onPickReadableFiles: noop,
      onPickWorkspaceFolder: noop,
      onPasteFiles: noop,
      pendingUploadedFiles: [],
      onRemovePendingUpload: noop,
      goalBar,
      queuedTurns,
      queuePaused,
      onQueuePausedChange: noop,
      onRunQueuedTurnNow: noop,
      onMoveQueuedTurnUp: noop,
      onEditQueuedTurn: noop,
      onRemoveQueuedTurn: noop,
    };
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          LocaleContext.Provider,
          { value: { locale: lang, t: (key) => translate(key, lang) } },
          React.createElement(ChatComposerBar, props),
        ),
      );
    });
    if (goalEditing) {
      const edit = container.querySelector(
        `[data-composer-goal-bar] button[aria-label="${translate("chat.goalBar.edit", lang)}"]`,
      );
      await act(async () => edit.click());
    }
    const html = container.innerHTML;
    const panel = container.querySelector("ul.chat-queue-scroll")?.closest(".border-b-0");
    const goal = container.querySelector("[data-composer-goal-bar]");
    const info = {
      html,
      panelClasses: panel ? [...panel.classList] : null,
      goalClasses: goal ? [...goal.classList] : null,
      containerClasses: panel?.parentElement ? [...panel.parentElement.classList] : null,
      goalButtonLabels: goal
        ? [...goal.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))
        : [],
      queueItemButtonLabels: [...(panel?.querySelector("li")?.querySelectorAll("button") ?? [])].map(
        (button) => button.getAttribute("aria-label"),
      ),
      label: (key) => translate(key, lang),
      panelHasPreviousSibling: Boolean(panel?.previousElementSibling),
      goalIsPreviousSiblingOfPanel: Boolean(goal && panel && panel.previousElementSibling === goal),
    };
    await act(async () => root.unmount());
    container.remove();
    return info;
  } finally {
    env.cleanup();
  }
}
