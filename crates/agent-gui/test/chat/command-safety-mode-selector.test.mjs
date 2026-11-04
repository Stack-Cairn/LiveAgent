// Renders the real shared permission-mode selector. Each mode needs its own
// icon, and auto review must say when no reviewer model is configured: K-brain
// otherwise asks for every action and withholds all tool output.
import assert from "node:assert/strict";
import test from "node:test";
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

let loadConfig = async () => null;
// The backend's capabilities.run_sandbox as the adapter reports it; null while unknown.
let sandboxCapability = null;
// The models K-brain can route to; a reviewer outside this list is unusable.
const models = [
  { provider: "p", id: "m" },
  { provider: "deepseek", id: "deepseek-chat" },
];
const state = (aiApproval) => ({ aiApproval, models });
let loadCalls = 0;

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": new Proxy(
      {},
      { get: (_target, name) => (name === "__esModule" ? true : iconComponent(String(name))) },
    ),
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/adapters/sandboxCapability": { useSandboxCapability: () => sandboxCapability },
    "@liveagent/adapters/aiApprovalReadiness": {
      loadAIApprovalState: () => {
        loadCalls += 1;
        return loadConfig();
      },
    },
  },
});
ReactRef = env.React;
window.HTMLElement.prototype.getAnimations ??= () => [];
const { CommandSafetyModeSelector } = env.loadModule(
  "@liveagent/ui/components/chat/CommandSafetyModeSelector.tsx",
);

async function mount(props) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  const calls = { change: [], configure: 0 };
  await env.act(async () =>
    root.render(
      env.React.createElement(CommandSafetyModeSelector, {
        onChange: (mode) => calls.change.push(mode),
        onConfigureAutoReview: () => {
          calls.configure += 1;
        },
        ...props,
      }),
    ),
  );
  const trigger = () => container.querySelector("button");
  const open = async () => {
    await env.act(async () => trigger().click());
    await env.act(async () => {});
  };
  const items = () => [...document.querySelectorAll('[role="menuitem"]')];
  const close = async () => {
    await env.act(async () => root.unmount());
    container.remove();
  };
  return { trigger, open, items, calls, close };
}

test("every permission mode has its own icon and full access is no longer offered", async () => {
  loadConfig = async () => state({ mode: "auto", provider: "p", model: "m" });
  const view = await mount({ value: "ask" });
  try {
    await view.open();
    const icons = view.items().map((item) => item.querySelector("svg")?.getAttribute("data-icon"));
    assert.deepEqual(icons, [
      "Hand",
      "SquarePen",
      "ShieldCheck",
      "Shield",
      "ShieldOff",
      "ShieldAlert",
    ]);
    assert.equal(new Set(icons).size, icons.length);
    const labels = view.items().map((item) => item.querySelector("span span")?.textContent);
    // Plan mode lives in the plus menu; full access is retired.
    assert.deepEqual(labels, [
      "chat.safety.ask",
      "chat.safety.autoEdit",
      "chat.safety.autoReview",
      "chat.safety.sandbox",
      "chat.safety.sandboxOffline",
      "chat.safety.always",
    ]);
  } finally {
    await view.close();
  }
});

test("sandbox entries follow the backend's run sandbox capability", async () => {
  loadConfig = async () => null;
  const disabled = (view, key) =>
    view
      .items()
      .find((item) => item.querySelector("span span")?.textContent === key)
      ?.getAttribute("data-disabled") != null;
  try {
    sandboxCapability = {
      supported: false,
      mechanism: "",
      platform: "",
      network_control: false,
      reason: "update K-brain to a version with run sandboxing",
    };
    let view = await mount({ value: "ask" });
    try {
      await view.open();
      assert.equal(disabled(view, "chat.safety.sandbox"), true);
      assert.equal(disabled(view, "chat.safety.sandboxOffline"), true);
      assert.match(view.items()[3].textContent, /chat\.safety\.sandboxUnavailable: update K-brain/);
    } finally {
      await view.close();
    }

    // Networked sandbox only: the offline entry stays disabled.
    sandboxCapability = {
      supported: true,
      mechanism: "bubblewrap",
      platform: "linux",
      network_control: false,
      read_masking: true,
    };
    view = await mount({ value: "ask" });
    try {
      await view.open();
      assert.equal(disabled(view, "chat.safety.sandbox"), false);
      assert.equal(disabled(view, "chat.safety.sandboxOffline"), true);
      assert.match(view.items()[3].textContent, /chat\.safety\.sandboxDesc$/);
    } finally {
      await view.close();
    }

    // A sandbox that cannot hide credentials must not promise it.
    sandboxCapability = {
      supported: true,
      mechanism: "seatbelt",
      platform: "darwin",
      network_control: true,
      read_masking: false,
    };
    view = await mount({ value: "sandbox" });
    try {
      assert.match(view.trigger().querySelector("svg").getAttribute("class"), /text-emerald-600/);
      await view.open();
      assert.equal(disabled(view, "chat.safety.sandboxOffline"), false);
      assert.match(view.items()[3].textContent, /chat\.safety\.sandboxDescNoReadMask/);
      await env.act(async () => view.items()[4].click());
      assert.deepEqual(view.calls.change, ["sandboxOffline"]);
    } finally {
      await view.close();
    }
  } finally {
    sandboxCapability = null;
  }
});

test("always allow keeps its risk visible on the trigger", async () => {
  loadConfig = async () => null;
  const view = await mount({ value: "always" });
  try {
    assert.match(view.trigger().querySelector("svg").getAttribute("class"), /text-amber-600/);
  } finally {
    await view.close();
  }
});

test("auto review without a reviewer model warns and links to the settings page", async () => {
  loadConfig = async () => state({ mode: "auto" });
  const view = await mount({ value: "autoReview" });
  try {
    assert.match(view.trigger().getAttribute("title"), /chat\.safety\.autoReviewNeedsModel/);
    assert.match(view.trigger().querySelector("svg").getAttribute("class"), /text-amber-600/);
    await view.open();
    const review = view.items().find((item) => item.textContent.includes("chat.safety.autoReview"));
    assert.match(review.textContent, /chat\.safety\.autoReviewNeedsModel/);
    const configure = view
      .items()
      .find((item) => item.textContent.includes("chat.safety.configureReviewer"));
    assert.ok(configure, "the menu offers a way to choose a reviewer model");
    await env.act(async () => configure.click());
    assert.equal(view.calls.configure, 1);
    assert.deepEqual(view.calls.change, [], "opening settings does not change the mode");
  } finally {
    await view.close();
  }
});

test("a configured reviewer, or an unreadable configuration, shows no warning", async () => {
  for (const config of [
    // The desktop-hosted Gateway does not relay aiApproval: absent is unknown, not missing.
    async () => null,
    async () => state({ mode: "auto", provider: "deepseek", model: "deepseek-chat" }),
    async () => {
      throw new Error("K-brain backend connection is not ready");
    },
  ]) {
    loadConfig = config;
    const view = await mount({ value: "autoReview" });
    try {
      assert.doesNotMatch(view.trigger().getAttribute("title"), /autoReviewNeedsModel/);
      await view.open();
      assert.equal(
        view.items().some((item) => item.textContent.includes("chat.safety.configureReviewer")),
        false,
      );
    } finally {
      await view.close();
    }
  }
});

test("the reviewer configuration is read again each time the menu opens", async () => {
  let configured = false;
  loadConfig = async () =>
    state(configured ? { mode: "auto", provider: "p", model: "m" } : { mode: "off" });
  loadCalls = 0;
  const view = await mount({ value: "ask" });
  try {
    assert.equal(loadCalls, 0, "other modes do not read settings until the menu opens");
    await view.open();
    assert.ok(view.items().some((item) => item.textContent.includes("chat.safety.configureReviewer")));
    await env.act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    configured = true;
    await view.open();
    assert.ok(loadCalls >= 2);
    assert.equal(
      view.items().some((item) => item.textContent.includes("chat.safety.configureReviewer")),
      false,
    );
  } finally {
    await view.close();
  }
});
