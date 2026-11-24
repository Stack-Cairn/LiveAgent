// The Gemini provider editor has an "API Platform" selector next to the API
// key: Google AI Studio and Vertex AI fill their base URL (full URL off), any
// other address shows as Custom. Nothing new is persisted. The selector is
// locked while editing a provider with a saved key or custom headers, so a
// relay's credential is never pointed at a Google host. Vertex AI Express Mode
// has no model list endpoint; that discovery failure is explained instead of
// "The provider returned an error". A saved xhigh reasoning level is kept.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const shared = (name) =>
  fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iconSetMock = new Proxy({}, { get: () => () => null });

const AI_STUDIO = "https://generativelanguage.googleapis.com/v1beta";
const VERTEX = "https://aiplatform.googleapis.com/v1/publishers/google";

const calls = [];
let discoveryFailure = null;
let vm;

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": iconSetMock,
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]:
      iconSetMock,
    [shared("ProviderModalView.tsx")]: {
      ProviderModalView: ({ viewModel }) => {
        vm = viewModel;
        return null;
      },
    },
    "@liveagent/adapters/providerSettings": {
      providerCredentialsRedacted: true,
      revealStoredProviderApiKey: async () => null,
      discoverProviderModels: async (request) => {
        calls.push(request);
        if (discoveryFailure) throw discoveryFailure();
        return [];
      },
    },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/app/lib/providers/usageQuery": { testProviderUsage: async () => null },
    "@liveagent/ui/lib/models/thinkingLive": { loadThinkingLiveSupplement: async () => {} },
    "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
    "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
  },
});
const { ProviderModal } = env.loadModule("@liveagent/ui/pages/settings/ProviderModal.tsx");
const { ProviderCredentialRow } = env.loadModule(
  "@liveagent/ui/pages/settings/ProviderCredentialRow.tsx",
);
const { detectGeminiApiPlatform } = env.loadModule(
  "@liveagent/ui/pages/settings/geminiApiPlatform.ts",
);

async function open(initialData, saved = []) {
  calls.length = 0;
  discoveryFailure = null;
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  await env.act(async () =>
    root.render(
      env.React.createElement(ProviderModal, {
        providerType: "gemini",
        initialData,
        onSave: (next) => saved.push(next),
        onClose: () => {},
      }),
    ),
  );
  return {
    settle: async () => {
      await env.act(async () => sleep(1000));
      await env.act(async () => {});
    },
    close: () => env.act(async () => root.unmount()),
  };
}

const geminiProvider = (overrides = {}) => ({
  id: "gemini-1",
  name: "Gemini",
  type: "gemini",
  baseUrl: AI_STUDIO,
  isFullUrl: false,
  apiKey: "",
  apiKeyConfigured: false,
  customHeaders: [],
  models: [],
  activeModels: [],
  ...overrides,
});

test("the platform is derived from the base URL", () => {
  assert.equal(detectGeminiApiPlatform(AI_STUDIO, false), "ai-studio");
  assert.equal(detectGeminiApiPlatform(` ${AI_STUDIO}/ `, false), "ai-studio");
  assert.equal(detectGeminiApiPlatform(VERTEX, false), "vertex");
  assert.equal(detectGeminiApiPlatform(`${VERTEX}/`, false), "vertex");
  assert.equal(detectGeminiApiPlatform(VERTEX, true), "custom", "a full URL is not the preset");
  assert.equal(detectGeminiApiPlatform("", false), "custom");
  assert.equal(detectGeminiApiPlatform("https://relay.example.com/v1beta", false), "custom");
  assert.equal(
    detectGeminiApiPlatform(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google",
      false,
    ),
    "custom",
    "a regional Vertex endpoint is custom",
  );
});

test("picking a preset fills its base URL and turns full URL off", async () => {
  const view = await open(undefined);
  try {
    assert.equal(vm.geminiApiPlatform, "custom");
    assert.equal(vm.geminiApiPlatformIsLocked, false, "a new provider can pick any platform");
    await env.act(async () => vm.setIsFullUrl(true));
    await env.act(async () => vm.selectGeminiApiPlatform("vertex"));
    assert.equal(vm.baseUrl, VERTEX);
    assert.equal(vm.isFullUrl, false);
    assert.equal(vm.geminiApiPlatform, "vertex");
    await env.act(async () => vm.selectGeminiApiPlatform("ai-studio"));
    assert.equal(vm.baseUrl, AI_STUDIO);
    assert.equal(vm.geminiApiPlatform, "ai-studio");
    await env.act(async () => vm.setBaseUrl("https://relay.example.com/v1beta"));
    assert.equal(vm.geminiApiPlatform, "custom");
  } finally {
    await view.close();
  }
});

test("editing a provider with a saved credential locks the platform", async () => {
  for (const saved of [
    { apiKeyConfigured: true },
    { customHeaders: [{ key: "X-Relay-Token", value: "test-key-123" }] },
  ]) {
    const view = await open(geminiProvider({ baseUrl: "https://relay.example.com/v1beta", ...saved }));
    try {
      assert.equal(vm.geminiApiPlatform, "custom");
      assert.equal(vm.geminiApiPlatformIsLocked, true, JSON.stringify(saved));
      await env.act(async () => vm.selectGeminiApiPlatform("ai-studio"));
      assert.equal(vm.baseUrl, "https://relay.example.com/v1beta", "the relay address is kept");
    } finally {
      await view.close();
    }
  }
  const view = await open(geminiProvider());
  try {
    assert.equal(vm.geminiApiPlatformIsLocked, false, "nothing saved, nothing to leak");
  } finally {
    await view.close();
  }
});

test("the selector sits next to the API key and lists Custom only for other addresses", async () => {
  const view = await open(geminiProvider({ apiKeyConfigured: true }));
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const render = (overrides) =>
    env.act(async () =>
      root.render(
        env.React.createElement(ProviderCredentialRow, { viewModel: { ...vm, ...overrides } }),
      ),
    );
  try {
    await render({});
    const trigger = host.querySelector('[aria-label="settings.geminiApiPlatform"]');
    assert.ok(trigger, "the Gemini editor has an API Platform selector");
    assert.equal(trigger.textContent, "settings.geminiApiPlatform.aiStudio");
    assert.equal(trigger.disabled, true);
    assert.match(host.textContent, /settings\.geminiApiPlatformLocked/);

    await render({ geminiApiPlatform: "custom", geminiApiPlatformIsLocked: false });
    assert.equal(trigger.textContent, "settings.geminiApiPlatform.custom");
    assert.equal(trigger.disabled, false);
    assert.doesNotMatch(host.textContent, /settings\.geminiApiPlatformLocked/);

    await render({ providerType: "claude_code" });
    assert.equal(host.querySelector('[aria-label="settings.geminiApiPlatform"]'), null);
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    await view.close();
  }
});

const expressFailure = () =>
  Object.assign(new Error("model discovery failed"), { status: 502, errorCode: "upstream_error" });

test("Vertex AI Express model discovery explains that the model list is unavailable", async () => {
  const view = await open(geminiProvider({ baseUrl: VERTEX, apiKeyConfigured: true }));
  try {
    discoveryFailure = expressFailure;
    await view.settle();
    assert.equal(calls.length, 1);
    assert.equal(vm.fetchError, "settings.geminiVertexExpressNoModelList");

    // The WebUI only relays the generic message from the desktop.
    discoveryFailure = () => new Error("model discovery failed (HTTP 502 Bad Gateway)");
    await env.act(async () => vm.handleRefresh());
    await env.act(async () => sleep(0));
    assert.equal(vm.fetchError, "settings.geminiVertexExpressNoModelList");

    // A rejected key is still reported as such.
    discoveryFailure = () =>
      Object.assign(new Error("model discovery failed"), {
        errorCode: "invalid_api_key",
        upstreamStatus: 401,
      });
    await env.act(async () => vm.handleRefresh());
    await env.act(async () => sleep(0));
    assert.equal(vm.fetchError, "settings.modelDiscoveryError.withStatus");
  } finally {
    await view.close();
  }
});

test("other Gemini addresses keep the generic discovery message", async () => {
  for (const overrides of [
    { baseUrl: AI_STUDIO },
    { baseUrl: "https://relay.example.com/v1beta" },
    { baseUrl: VERTEX, isFullUrl: true },
  ]) {
    const view = await open(geminiProvider({ apiKeyConfigured: true, ...overrides }));
    try {
      discoveryFailure = expressFailure;
      await view.settle();
      assert.equal(vm.fetchError, "settings.modelDiscoveryError.upstreamError");
    } finally {
      await view.close();
    }
  }
});

test("a saved xhigh reasoning level survives saving a Gemini provider", async () => {
  const saved = [];
  const view = await open(geminiProvider({ reasoning: "xhigh" }), saved);
  try {
    await env.act(async () => vm.handleSave());
    assert.equal(saved[0].reasoning, "xhigh");
  } finally {
    await view.close();
  }
});

test("the catalog lists xhigh for Gemini 4 models that have it and the runtime clamps the rest", () => {
  const settings = env.loadModule("@liveagent/ui/lib/settings/index.ts");
  const levels = (model) => settings.getKnownModelThinkingLevels("gemini", model);
  assert.ok(levels("gemini-4-hydrogen").includes("xhigh"));
  assert.ok(levels("gemini-4-neon").includes("xhigh"));
  assert.ok(!levels("gemini-4-argon").includes("xhigh"));
  const controls = {
    reasoningByModel: { gemini: { "gemini-4-hydrogen": "xhigh", "gemini-4-argon": "xhigh" } },
  };
  const resolve = (modelId) =>
    settings.normalizeChatRuntimeControlsForProvider(controls, { providerId: "gemini", modelId })
      .reasoning;
  assert.equal(resolve("gemini-4-hydrogen"), "xhigh");
  assert.equal(resolve("gemini-4-argon"), "high");
});
