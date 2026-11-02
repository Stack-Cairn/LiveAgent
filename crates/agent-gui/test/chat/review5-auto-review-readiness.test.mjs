// Review 5: the auto-review "no reviewer model" warning, rendered through the real
// shared selector and the real desktop adapter (only the K-brain HTTP adapter is
// replaced by an in-memory K-brain settings document).
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

let ReactRef = null;
const iconCache = new Map();
function iconComponent(name) {
  if (!iconCache.has(name)) {
    iconCache.set(name, (props) =>
      ReactRef.createElement("svg", { "data-icon": name, className: props?.className }),
    );
  }
  return iconCache.get(name);
}

// K-brain /v1/settings projection (internal/backend/settings.go projectSettings).
let kbrainDocument = null;
let getSettingsCalls = 0;
const kbrainSettingsPath = path.join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "src",
  "agent-ui-adapters",
  "kbrainSettings.ts",
);

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": new Proxy(
      {},
      { get: (_target, name) => (name === "__esModule" ? true : iconComponent(String(name))) },
    ),
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/adapters/sandboxCapability": { useSandboxCapability: () => null },
    [kbrainSettingsPath]: {
      kbrainSettingsAdapter: {
        getSettings: async () => {
          getSettingsCalls += 1;
          return structuredClone(kbrainDocument);
        },
      },
    },
  },
});
ReactRef = env.React;
window.HTMLElement.prototype.getAnimations ??= () => [];
const { CommandSafetyModeSelector } = env.loadModule(
  "@liveagent/ui/components/chat/CommandSafetyModeSelector.tsx",
);

const deepseek = { id: "deepseek", name: "DeepSeek" };
const deepseekChat = { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" };

async function mount(props) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  await env.act(async () =>
    root.render(
      env.React.createElement(CommandSafetyModeSelector, {
        onChange: () => {},
        onConfigureAutoReview: () => {},
        ...props,
      }),
    ),
  );
  await env.act(async () => {});
  const trigger = () => container.querySelector("button");
  const open = async () => {
    await env.act(async () => trigger().click());
    await env.act(async () => {});
  };
  // Close by clicking the trigger again; the closed state is read from
  // aria-expanded because menu items linger in the DOM during the exit animation.
  const toggleClosed = async () => {
    await env.act(async () => trigger().click());
    await env.act(async () => {});
  };
  const close = async () => {
    await env.act(async () => root.unmount());
    container.remove();
  };
  return { trigger, open, toggleClosed, close };
}

// The desktop keeps ChatPage mounted under the settings overlay (App.tsx renders
// SettingsPage as an absolute layer over ChatPage). Clicking "choose a reviewer
// model" opens that overlay; AIApprovalSection then saves and announces
// `kbrain:settings-changed`. The composer behind it must stop warning.
test("saving a reviewer in settings clears the composer warning without reopening the menu", async () => {
  kbrainDocument = {
    providers: [deepseek],
    models: [deepseekChat],
    aiApproval: { mode: "off" },
  };
  const view = await mount({ value: "autoReview" });
  try {
    assert.match(view.trigger().getAttribute("title"), /autoReviewNeedsModel/, "precondition");
    // AIApprovalSection.save(): PUT succeeded, then dispatches the shared event.
    kbrainDocument.aiApproval = { mode: "off", provider: "deepseek", model: "deepseek-chat" };
    await env.act(async () => window.dispatchEvent(new Event("kbrain:settings-changed")));
    await env.act(async () => {});
    assert.doesNotMatch(
      view.trigger().getAttribute("title"),
      /autoReviewNeedsModel/,
      "the trigger still says no reviewer model is selected after one was saved",
    );
    assert.doesNotMatch(view.trigger().querySelector("svg").getAttribute("class"), /amber/);
  } finally {
    await view.close();
  }
});

// The hook documents "re-read ... whenever refreshKey changes (for example each
// time a menu opens)". refreshKey is menuOpen, so with auto review selected the
// menu closing is a second refreshKey change and a second settings read. In the
// WebUI each read is a full settings.get round trip through the Gateway to the
// desktop (SQLite snapshot + K-brain /v1/settings + K-brain MCP settings).
test("closing the menu does not read the reviewer configuration again", async () => {
  kbrainDocument = {
    providers: [deepseek],
    models: [deepseekChat],
    aiApproval: { mode: "off", provider: "deepseek", model: "deepseek-chat" },
  };
  getSettingsCalls = 0;
  const view = await mount({ value: "autoReview" });
  try {
    assert.equal(getSettingsCalls, 1, "auto review reads once on mount");
    await view.open();
    assert.equal(getSettingsCalls, 2, "opening the menu reads again");
    assert.equal(view.trigger().getAttribute("aria-expanded"), "true", "precondition: open");
    await view.toggleClosed();
    assert.equal(view.trigger().getAttribute("aria-expanded"), "false", "precondition: closed");
    assert.equal(getSettingsCalls, 2, "closing the menu issued another settings read");
  } finally {
    await view.close();
  }
});

// K-brain keeps aiApproval.provider/model when the provider is deleted or the model
// is deactivated: applySettings only checks the reviewer when the update itself
// carries aiApproval (internal/backend/settings.go:431), and the reviewer then
// fails to route (internal/routing/route.go:38) -> Unknown -> every action asks and
// tool output is withheld (internal/approval/run.go:80). AIApprovalSection shows
// the same document as "unavailable"; the composer must not call it configured.
test("a reviewer whose provider was deleted still warns in the composer", async () => {
  kbrainDocument = {
    providers: [deepseek],
    models: [deepseekChat],
    // "openai" was deleted after it was chosen as the reviewer.
    aiApproval: { mode: "off", provider: "openai", model: "gpt-4.1-mini" },
  };
  const view = await mount({ value: "autoReview" });
  try {
    assert.match(
      view.trigger().getAttribute("title"),
      /autoReviewNeedsModel/,
      "a reviewer K-brain cannot route is reported as configured",
    );
  } finally {
    await view.close();
  }
});
