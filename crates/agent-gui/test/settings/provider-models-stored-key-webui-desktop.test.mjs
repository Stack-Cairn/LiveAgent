// Review regression: ProviderModal now discovers models automatically with the
// stored key (apiKey "" + providerId) as soon as an existing provider is opened.
// In the WebUI, a desktop agent answers that request in
// gateway_bridge::handle_provider_models. Its empty-key branch used to resolve the
// key, base URL and proxy from the legacy config.sqlite `provider_settings` table,
// which K-brain mode no longer writes. The bridge now forwards the draft so K-brain
// resolves the key by provider ID; that side is covered by the Rust unit tests
// stored_key_discovery_forwards_the_draft_for_kbrain_to_resolve_by_id and
// discovery_without_a_key_needs_a_provider_to_resolve_it.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const shared = (name) =>
  fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const calls = [];

const env = await createDomTestEnv({
  mocks: {
    [shared("ProviderModalView.tsx")]: { ProviderModalView: () => null },
    // Same shape as crates/agent-gateway/web/src/agent-ui-adapters/providerSettings.tsx.
    "@liveagent/adapters/providerSettings": {
      providerCredentialsRedacted: true,
      revealStoredProviderApiKey: async () => null,
      discoverProviderModels: async (request) => {
        calls.push(request);
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

test("opening a stored-key provider in the WebUI asks the host to resolve the key by provider ID", async () => {
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await env.act(async () =>
      root.render(
        env.React.createElement(ProviderModal, {
          providerType: "codex",
          initialData: {
            id: "kbrain-only",
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
    assert.equal(calls.length, 1, "no user action: the request is sent on open");
    assert.equal(calls[0].apiKey, "");
    assert.equal(calls[0].providerId, "kbrain-only");
  } finally {
    await env.act(async () => root.unmount());
  }
});
