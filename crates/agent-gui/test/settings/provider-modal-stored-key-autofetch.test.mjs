// K-brain keeps provider API keys server-side, so the editor only shows a
// placeholder for a stored key. Model discovery must still run automatically
// with that stored key (K-brain resolves it by provider ID), as it did when
// the key was plain text, including after an address change: saving keeps the
// stored key for a new address, so discovery does too. Only an older K-brain
// that drops the stored key for a new address is answered with a key prompt.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const shared = (name) =>
  fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// ProviderModal debounces discovery by 900ms.
const DEBOUNCE_MS = 1000;

const calls = [];
let vm;
let discoveryFailure = null;

const env = await createDomTestEnv({
  mocks: {
    [shared("ProviderModalView.tsx")]: {
      ProviderModalView: ({ viewModel }) => {
        vm = viewModel;
        return null;
      },
    },
    "@liveagent/adapters/providerSettings": {
      providerCredentialsRedacted: true,
      revealStoredProviderApiKey: async () => "",
      discoverProviderModels: async (request) => {
        calls.push(request);
        if (discoveryFailure) throw new Error(discoveryFailure(request) ?? "unexpected");
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

const storedProvider = {
  id: "relay-1",
  name: "Relay",
  type: "codex",
  baseUrl: "https://relay.example.com/v1",
  apiKey: "",
  apiKeyConfigured: true,
  models: [],
  activeModels: [],
};

async function open() {
  calls.length = 0;
  discoveryFailure = null;
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  await env.act(async () =>
    root.render(
      env.React.createElement(ProviderModal, {
        providerType: "codex",
        initialData: structuredClone(storedProvider),
        onSave: () => {},
        onClose: () => {},
      }),
    ),
  );
  return {
    settle: async () => {
      await env.act(async () => sleep(DEBOUNCE_MS));
      await env.act(async () => {});
    },
    close: () => env.act(async () => root.unmount()),
  };
}

test("an existing provider with a stored key fetches its models on open", async () => {
  const view = await open();
  try {
    await view.settle();
    assert.equal(calls.length, 1, "the stored key no longer blocks automatic discovery");
    assert.equal(calls[0].providerId, "relay-1");
    assert.equal(calls[0].apiKey, "", "the stored key stays server-side");
    assert.equal(vm.fetchError, null);
  } finally {
    await view.close();
  }
});

test("editing a field other than the address fetches again with the stored key", async () => {
  const view = await open();
  try {
    await view.settle();
    await env.act(async () => vm.setIsFullUrl(true));
    await view.settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].isFullUrl, true);
    assert.equal(calls[1].apiKey, "");
  } finally {
    await view.close();
  }
});

test("changing the address keeps discovering with the stored key", async () => {
  const view = await open();
  try {
    await view.settle();
    await env.act(async () => vm.setBaseUrl("https://other.example.com/v1"));
    await view.settle();
    assert.equal(calls.length, 2, "an address change does not require typing the key again");
    assert.equal(calls[1].apiKey, "");
    assert.equal(calls[1].providerId, "relay-1");
    assert.equal(calls[1].baseUrl, "https://other.example.com/v1");
    assert.equal(vm.fetchError, null);
  } finally {
    await view.close();
  }
});

test("an older K-brain that drops the stored key for a new address prompts for the key", async () => {
  const view = await open();
  try {
    await view.settle();
    // Wording of K-brain before the fix, as relayed by the desktop or the Gateway.
    discoveryFailure = (request) =>
      request.apiKey === "" && request.baseUrl !== "https://relay.example.com/v1"
        ? "kbrain settings request: 400 Bad Request: provider credentials or endpoint are not configured"
        : null;
    await env.act(async () => vm.setBaseUrl("https://other.example.com/v1"));
    await view.settle();
    assert.equal(vm.fetchError, "settings.providerModelsNeedApiKey");

    discoveryFailure = null;
    await env.act(async () => vm.setApiKey("sk-new-key"));
    await view.settle();
    assert.equal(calls.at(-1).apiKey, "sk-new-key");
    assert.equal(vm.fetchError, null);
  } finally {
    await view.close();
  }
});

test("other discovery failures keep their own message", async () => {
  const view = await open();
  try {
    discoveryFailure = () => "model discovery failed (HTTP 502)";
    await env.act(async () => vm.setBaseUrl("https://other.example.com/v1"));
    await view.settle();
    assert.equal(vm.fetchError, "model discovery failed (HTTP 502)");
  } finally {
    await view.close();
  }
});
