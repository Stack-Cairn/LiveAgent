import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const locale = { locale: "en-US", t: (key) => key };
const icons = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? false : () => null) });
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": icons,
    "../../components/IconSet": icons,
  },
});
const nav = env.loadModule("@liveagent/ui/lib/navigation/navigationHistory.ts");
const { buildCommandPaletteActions } = env.loadModule(
  "@liveagent/ui/lib/chat/commandPaletteActions.ts",
);
const { NavigationHistoryButtons } = env.loadModule(
  "@liveagent/ui/components/chat/NavigationHistoryButtons.tsx",
);

const record = (locations, limit) =>
  locations.reduce((history, location) => nav.recordNavigation(history, location, limit), nav.EMPTY_NAVIGATION_HISTORY);

test("visits are recorded once, branch like a browser and stay capped", () => {
  const history = record(["a", "a", "b", "b", "c"]);
  assert.deepEqual(history, { entries: ["a", "b", "c"], index: 2 }, "consecutive repeats collapse");
  assert.equal(nav.recordNavigation(history, "c"), history, "revisiting the current entry is a no-op");

  const back = nav.stepNavigation(history, -1);
  assert.equal(back.location, "b");
  assert.deepEqual(nav.recordNavigation(back.history, "d"), { entries: ["a", "b", "d"], index: 2 }, "a new visit drops the forward branch");

  const long = record(Array.from({ length: 60 }, (_, i) => `l${i}`));
  assert.equal(nav.NAVIGATION_HISTORY_LIMIT, 50);
  assert.equal(long.entries.length, 50);
  assert.equal(long.entries[0], "l10", "the oldest entries go first");
  assert.equal(long.index, 49);
});

test("steps skip locations that can no longer be opened", () => {
  const history = record(["a", "gone", "a", "b"]);
  assert.equal(nav.stepNavigation(history, 1), null, "nothing ahead");
  const back = nav.stepNavigation(history, -1, (location) => location !== "gone");
  assert.equal(back.location, "a");
  assert.deepEqual(back.history, { entries: ["a", "b"], index: 0 }, "a dead entry and the repeat it left behind are removed");
  assert.equal(nav.stepNavigation(back.history, -1), null);
  assert.equal(nav.stepNavigation(nav.EMPTY_NAVIGATION_HISTORY, -1), null);
});

test("workbench locations: saved conversations and visible hubs only", () => {
  const at = (activeView, conversationId, isDraft = false) =>
    nav.workbenchNavigationLocation({ activeView, conversationId, isDraft });
  assert.equal(at("chat", "c1"), "conversation:c1");
  assert.equal(at("chat", "c1", true), null, "drafts are not recorded");
  assert.equal(at("chat", ""), null);
  assert.equal(at("skills-hub", "c1"), "view:skills-hub", "a hub wins over the conversation behind it");

  assert.deepEqual(nav.parseNavigationLocation("conversation:c1"), { kind: "conversation", conversationId: "c1" });
  assert.deepEqual(nav.parseNavigationLocation("view:image-studio-hub"), { kind: "view", view: "image-studio-hub" });
  assert.equal(nav.parseNavigationLocation("view:unknown-hub"), null);
  assert.equal(nav.parseNavigationLocation("settings"), null);

  const openable = (location) =>
    nav.isWorkbenchNavigationLocationOpenable(location, {
      hasConversation: (id) => id === "c1",
      visibleHubs: { skills: true, mcp: false, cron: true, planning: true, "image-studio": true, memory: true },
    });
  assert.equal(openable("conversation:c1"), true);
  assert.equal(openable("conversation:deleted"), false);
  assert.equal(openable("view:skills-hub"), true);
  assert.equal(openable("view:mcp-hub"), false, "hubs hidden from the sidebar are skipped");
});

function HistoryProbe({ location, onReady, navigate, isValid }) {
  const controls = nav.useNavigationHistory({ location, navigate, isValid });
  onReady(controls);
  return env.React.createElement(NavigationHistoryButtons, { history: controls });
}

test("the hook records visits, navigates back and forward, and owns mouse side buttons", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  let controls;
  let location = null;
  const navigated = [];
  const render = () =>
    env.act(async () =>
      root.render(
        env.React.createElement(HistoryProbe, {
          location,
          onReady: (value) => {
            controls = value;
          },
          navigate: (target) => {
            navigated.push(target);
            location = target;
          },
          isValid: (target) => target !== "conversation:deleted",
        }),
      ),
    );
  const visit = async (next) => {
    location = next;
    await render();
  };
  const button = (key) => host.querySelector(`[data-navigation-history-button="${key}"]`);
  const mouse = (buttonId, target = window) =>
    env.act(async () => {
      const event = new window.MouseEvent("mouseup", { button: buttonId, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    });
  try {
    await render();
    assert.equal(controls.canGoBack, false);
    assert.equal(button("back").getAttribute("aria-disabled"), "true");

    await visit("conversation:a");
    await visit(null); // a draft in between is not a stop
    await visit("view:skills-hub");
    await visit("conversation:deleted");
    await visit("conversation:b");
    assert.equal(controls.canGoBack, true);
    assert.equal(controls.canGoForward, false);
    assert.equal(button("back").getAttribute("aria-disabled"), "false");
    assert.equal(button("back").getAttribute("aria-label"), "shortcuts.command.navigateBack");

    await env.act(async () => button("back").click());
    assert.deepEqual(navigated, ["view:skills-hub"], "the deleted conversation is skipped");
    await render(); // the host lands on the target; that is not a new visit
    assert.equal(controls.canGoForward, true);

    const forward = await mouse(4);
    assert.equal(forward.defaultPrevented, true);
    assert.deepEqual(navigated, ["view:skills-hub", "conversation:b"]);
    await render();

    const atEnd = await mouse(4);
    assert.equal(atEnd.defaultPrevented, false, "nothing ahead: the event is left alone");

    const dialog = document.body.appendChild(document.createElement("div"));
    dialog.setAttribute("role", "dialog");
    await mouse(3, dialog);
    assert.equal(navigated.length, 2, "a dialog keeps the workbench in place");
    dialog.remove();

    await env.act(async () => controls.goBack());
    await render();
    await env.act(async () => controls.goBack());
    await render();
    assert.deepEqual(navigated, ["view:skills-hub", "conversation:b", "view:skills-hub", "conversation:a"]);
    assert.equal(controls.canGoBack, false);

    await visit("conversation:c");
    assert.equal(controls.canGoForward, false, "a new visit drops the forward branch");
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
  }
});

test("palette lists back / forward only while they can move", () => {
  const ids = (history) =>
    buildCommandPaletteActions({ t: (key) => key, isMac: true, history })
      .map((action) => action.id)
      .filter((id) => id.startsWith("navigate-"));
  const noop = () => true;
  assert.deepEqual(ids(undefined), []);
  assert.deepEqual(ids({ canGoBack: true, canGoForward: false, goBack: noop, goForward: noop }), ["navigate-back"]);
  const both = buildCommandPaletteActions({
    t: (key) => key,
    isMac: true,
    history: { canGoBack: true, canGoForward: true, goBack: noop, goForward: noop },
  }).filter((action) => action.id.startsWith("navigate-"));
  assert.deepEqual(both.map((action) => [action.id, action.shortcut]), [
    ["navigate-back", "⌘["],
    ["navigate-forward", "⌘]"],
  ]);
});

test("both hosts wire the history into the header, the palette and the shortcuts", () => {
  for (const file of [
    new URL("../../src/pages/ChatPage.tsx", import.meta.url),
    new URL("../../../agent-gateway/web/src/app/GatewayAppView.tsx", import.meta.url),
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /useNavigationHistory\(/);
    assert.match(source, /history=\{navigationHistory\}/, "header buttons");
    assert.match(source, /history: navigationHistory,/, "palette actions");
  }
  const sidebar = fs.readFileSync(
    new URL("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(sidebar, /"navigateBack",\n\s+"navigateForward",/, "the sidebar dispatches the chords");
});
