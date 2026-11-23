// A failed model discovery explains itself: K-brain answers 502 with errorCode
// (invalid_api_key, not_found, rate_limited, unreachable, upstream_error), plus
// upstreamStatus and upstreamMessage when the provider answered. The desktop
// client keeps those on the thrown Error, and the provider editor and the
// onboarding test show "API key was rejected (401): <provider message>"
// instead of "model discovery failed". Older backends (only `error`) keep the
// plain message.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");
const { describeModelDiscoveryError } = loader.loadModule(
  "../agent-ui/src/pages/settings/modelDiscoveryError.ts",
);
const { SETTINGS_EN_US } = loader.loadModule("../agent-ui/src/i18n/namespaces/settingsEnUS.ts");
const { SETTINGS_ZH_CN } = loader.loadModule("../agent-ui/src/i18n/namespaces/settingsZhCN.ts");
const en = (key) => SETTINGS_EN_US[key] ?? key;
const zh = (key) => SETTINGS_ZH_CN[key] ?? key;

const REJECTED = {
  error: "model discovery failed",
  errorCode: "invalid_api_key",
  upstreamStatus: 401,
  upstreamMessage: "Incorrect API key provided: sk-bad***.",
  version: "kbrain.agent.v1",
};

async function discoveryError(body) {
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
  });
  return client
    .discoverProviderModels("p", { type: "codex", baseUrl: "https://models.example/v1", apiKey: "sk-bad" })
    .then(
      () => assert.fail("discovery must fail"),
      (error) => error,
    );
}

test("the desktop client keeps a failed discovery's reason on the error", async () => {
  const error = await discoveryError(REJECTED);
  assert.equal(error.message, "model discovery failed");
  assert.equal(error.status, 502);
  assert.equal(error.errorCode, "invalid_api_key");
  assert.equal(error.upstreamStatus, 401);
  assert.equal(error.upstreamMessage, "Incorrect API key provided: sk-bad***.");

  const old = await discoveryError({ error: "model discovery failed", version: "kbrain.agent.v1" });
  assert.equal(old.message, "model discovery failed");
  assert.equal(old.errorCode, undefined);
  assert.equal(old.upstreamStatus, undefined);
});

test("a failed discovery reads as its reason, status and provider message", async () => {
  const error = await discoveryError(REJECTED);
  assert.equal(
    describeModelDiscoveryError(error, en),
    "API key was rejected (401): Incorrect API key provided: sk-bad***.",
  );
  assert.equal(
    describeModelDiscoveryError(error, zh),
    "API 密钥被拒绝（401）：Incorrect API key provided: sk-bad***.",
  );
  const reason = (fields) =>
    describeModelDiscoveryError(Object.assign(new Error("model discovery failed"), fields), en);
  assert.equal(
    reason({ errorCode: "unreachable" }),
    "Could not reach the provider. Check the Base URL and your network.",
  );
  assert.equal(reason({ errorCode: "not_found", upstreamStatus: 404 }), "No model list at this address (404)");
  assert.equal(
    reason({ errorCode: "rate_limited", upstreamStatus: 429 }),
    "The provider is rate limiting requests (429)",
  );
  assert.equal(
    reason({ errorCode: "upstream_error", upstreamStatus: 500, upstreamMessage: "overloaded" }),
    "The provider returned an error (500): overloaded",
  );
  // Older backends and unknown codes keep the backend's message.
  assert.equal(reason({}), "model discovery failed");
  assert.equal(reason({ errorCode: "something_new" }), "model discovery failed");
  assert.equal(describeModelDiscoveryError("plain failure", en), "plain failure");
});

const shared = (name) =>
  fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let viewProps = null;
const env = await createDomTestEnv({
  mocks: {
    [shared("ProviderModalView.tsx")]: {
      ProviderModalView: (props) => {
        viewProps = props;
        return null;
      },
    },
    "@liveagent/adapters/providerSettings": {
      providerCredentialsRedacted: true,
      revealStoredProviderApiKey: async () => null,
      discoverProviderModels: async () => {
        throw Object.assign(new Error("model discovery failed"), {
          errorCode: "invalid_api_key",
          upstreamStatus: 401,
          upstreamMessage: "Incorrect API key provided: sk-bad***.",
        });
      },
    },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: en }) },
    "@liveagent/app/lib/providers/usageQuery": { testProviderUsage: async () => null },
    "@liveagent/ui/lib/models/thinkingLive": { loadThinkingLiveSupplement: async () => {} },
    "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
    "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
  },
});
const { ProviderModal } = env.loadModule("@liveagent/ui/pages/settings/ProviderModal.tsx");

test("the provider editor shows why discovery failed", async () => {
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await env.act(async () =>
      root.render(
        env.React.createElement(ProviderModal, {
          providerType: "codex",
          initialData: {
            id: "stored",
            name: "Relay",
            type: "codex",
            baseUrl: "https://relay.example.com/v1",
            apiKey: "",
            apiKeyConfigured: true,
            models: [],
            activeModels: [],
          },
          onSave: () => {},
          onClose: () => {},
        }),
      ),
    );
    await env.act(async () => sleep(1000));
    assert.equal(
      viewProps?.viewModel?.fetchError,
      "API key was rejected (401): Incorrect API key provided: sk-bad***.",
    );
  } finally {
    await env.act(async () => root.unmount());
  }
});
