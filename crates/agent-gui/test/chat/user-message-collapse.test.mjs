import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Mocks are matched on resolved paths, so relative imports inside agent-ui hit them.
const ui = (file) => fileURLToPath(new URL(`../../../agent-ui/src/${file}`, import.meta.url));

const iconProxy = () =>
  new Proxy({}, { get: (_target, name) => (name === "__esModule" ? false : () => null) });

const LABELS = { "chat.userMessage.expand": "Show more", "chat.userMessage.collapse": "Show less" };
const LONG_TEXT = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");

async function createEnv() {
  const env = await createDomTestEnv({
    mocks: {
      [ui("components/IconSet.tsx")]: iconProxy(),
      // Attachments are not under test.
      [ui("components/chat/UserAttachmentCards.tsx")]: { UserAttachmentCards: () => null },
      [ui("i18n/index.ts")]: {
        useLocale: () => ({ t: (key) => LABELS[key] ?? key, locale: "en-US" }),
      },
    },
  });
  // jsdom has no layout: a message's natural height follows its line count
  // (the computed line height is "normal", so the 22.75px fallback applies).
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return (this.textContent ?? "").split("\n").length * 22.75;
    },
  });
  return env;
}

async function render(env, props) {
  const { UserMessageBubbleBody } = env.loadModule(
    "@liveagent/ui/components/chat/UserMessageBubbleBody.tsx",
  );
  const host = document.createElement("div");
  host.setAttribute("data-row-key", props.messageKey ?? "row");
  document.body.append(host);
  const root = env.createRoot(host);
  await env.act(async () =>
    root.render(env.React.createElement(UserMessageBubbleBody, { attachments: [], ...props })),
  );
  return { host, root };
}

test("clamp threshold leaves short messages alone and hides at least three lines", async () => {
  const env = await createEnv();
  try {
    const { shouldClampUserMessage, userMessageClampHeight, USER_MESSAGE_CLAMP_LINES } =
      env.loadModule("@liveagent/ui/components/chat/UserMessageBubbleBody.tsx");
    assert.equal(USER_MESSAGE_CLAMP_LINES, 10);
    assert.equal(shouldClampUserMessage(20 * 12, 20), false, "two hidden lines are not worth it");
    assert.equal(shouldClampUserMessage(20 * 14, 20), true);
    assert.equal(userMessageClampHeight(22.75), 228);
  } finally {
    env.cleanup();
  }
});

test("long user messages collapse with a toggle and keep their full text in the DOM", async () => {
  const env = await createEnv();
  try {
    const short = await render(env, { messageKey: "short", text: "hello\nworld" });
    assert.equal(short.host.querySelector("button"), null, "short messages have no toggle");
    assert.equal(short.host.querySelector("[data-transcript-collapsed]"), null);

    const { host, root } = await render(env, { messageKey: "long", text: LONG_TEXT });
    const viewport = host.querySelector("[data-transcript-collapsed]");
    assert.ok(viewport, "a long message is collapsed");
    assert.equal(viewport.style.maxHeight, "228px");
    assert.match(host.textContent, /line 40/, "hidden lines stay in the DOM for find and copy");
    const toggle = host.querySelector("button");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-controls"), viewport.id);
    assert.match(toggle.textContent, /Show more/);

    await env.act(async () => toggle.click());
    assert.equal(host.querySelector("[data-transcript-collapsed]"), null);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.match(toggle.textContent, /Show less/);

    // A virtual-list remount of the same message keeps it expanded.
    await env.act(async () => root.unmount());
    const again = await render(env, { messageKey: "long", text: LONG_TEXT });
    assert.equal(again.host.querySelector("[data-transcript-collapsed]"), null);
    assert.equal(again.host.querySelector("button").getAttribute("aria-expanded"), "true");

    await env.act(async () => again.host.querySelector("button").click());
    assert.ok(again.host.querySelector("[data-transcript-collapsed]"), "Show less collapses again");
  } finally {
    env.cleanup();
  }
});

test("find reveals a match inside a collapsed message and skips the toggle text", async () => {
  const env = await createEnv();
  try {
    const { findTextRangesInElement, revealCollapsedTranscriptRange } = env.loadModule(
      "@liveagent/ui/lib/transcript-find/transcriptFindDom.ts",
    );
    const { host } = await render(env, { messageKey: "find", text: LONG_TEXT });
    assert.deepEqual(
      findTextRangesInElement(host, "show more").length,
      0,
      "toggle label is row chrome, not message text",
    );
    const [range] = findTextRangesInElement(host, "line 39");
    assert.ok(range, "the hidden line is found in the DOM");
    let revealed;
    await env.act(async () => {
      revealed = revealCollapsedTranscriptRange(range);
    });
    assert.equal(revealed, true);
    assert.equal(host.querySelector("[data-transcript-collapsed]"), null, "the bubble expanded");

    const [visibleRange] = findTextRangesInElement(host, "line 39");
    assert.equal(revealCollapsedTranscriptRange(visibleRange), false, "nothing left to reveal");
  } finally {
    env.cleanup();
  }
});
