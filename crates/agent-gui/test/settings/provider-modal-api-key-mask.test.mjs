// A stored provider key is shown as a fixed-length placeholder. Revealing it
// with the eye button and hiding it again must go back to that placeholder
// (the dots must not follow the real key's length), keep the revealed value so
// the next reveal is instant, keep the field select-all on focus, and still save
// as "unchanged" (apiKey "" + apiKeyConfigured) so a ${ENV_VAR} reference is
// never replaced by its resolved value.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const shared = (name) =>
  fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));

// Icons are irrelevant here; the default ~icons mock yields plain objects react-dom cannot render.
const iconSetMock = new Proxy({}, { get: () => () => null });

const STORED_KEY = "test-key-123-0123456789abcdefghij";
const PLACEHOLDER = "••••••••";
const reveals = [];
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
      revealStoredProviderApiKey: async (id) => {
        reveals.push(id);
        return STORED_KEY;
      },
      discoverProviderModels: async () => [],
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

async function open(saved) {
  reveals.length = 0;
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  await env.act(async () =>
    root.render(
      env.React.createElement(ProviderModal, {
        providerType: "codex",
        initialData: {
          id: "relay-1",
          name: "Relay",
          type: "codex",
          baseUrl: "https://relay.example.com/v1",
          apiKey: "",
          apiKeyConfigured: true,
          models: [],
          activeModels: [],
        },
        onSave: (next) => saved.push(next),
        onClose: () => {},
      }),
    ),
  );
  return () => env.act(async () => root.unmount());
}

const toggle = () => env.act(async () => vm.toggleShowApiKey());

test("hiding an unedited revealed key goes back to the fixed-length placeholder", async () => {
  const saved = [];
  const close = await open(saved);
  try {
    assert.equal(vm.apiKey, PLACEHOLDER, "first open shows the placeholder");
    assert.equal(vm.apiKeyIsRedactedDisplay, true);

    await toggle();
    assert.equal(vm.showApiKey, true);
    assert.equal(vm.apiKey, STORED_KEY);
    assert.deepEqual(reveals, ["relay-1"]);

    await toggle();
    assert.equal(vm.showApiKey, false);
    assert.equal(vm.apiKey, PLACEHOLDER, "same mask length as on first open");
    assert.equal(vm.apiKeyIsRedactedDisplay, true, "focus still selects the whole placeholder");

    await toggle();
    assert.equal(vm.showApiKey, true);
    assert.equal(vm.apiKey, STORED_KEY, "the cached plaintext is shown again");
    assert.equal(reveals.length, 1, "no second round trip to the backend");

    await toggle();
    await env.act(async () => vm.handleSave());
    assert.equal(saved.at(-1).apiKey, "", "an unedited key is never sent back");
    assert.equal(saved.at(-1).apiKeyConfigured, true);
  } finally {
    await close();
  }
});

test("saving while the revealed key is shown still keeps the stored reference", async () => {
  const saved = [];
  const close = await open(saved);
  try {
    await toggle();
    await env.act(async () => vm.handleSave());
    assert.equal(saved.at(-1).apiKey, "");
    assert.equal(saved.at(-1).apiKeyConfigured, true);
  } finally {
    await close();
  }
});

test("an edited key keeps its own value (and length) when hidden", async () => {
  const saved = [];
  const close = await open(saved);
  try {
    await toggle();
    await env.act(async () => vm.setApiKey("test-key-456"));
    await toggle();
    assert.equal(vm.showApiKey, false);
    assert.equal(vm.apiKey, "test-key-456");
    assert.equal(vm.apiKeyIsRedactedDisplay, false);
    await env.act(async () => vm.handleSave());
    assert.equal(saved.at(-1).apiKey, "test-key-456");
  } finally {
    await close();
  }
});

test("the API key input selects the placeholder on focus so typing replaces it", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const render = (overrides) =>
    env.act(async () =>
      root.render(
        env.React.createElement(ProviderCredentialRow, {
          viewModel: {
            ...vm,
            providerType: "codex",
            apiKey: PLACEHOLDER,
            apiKeyIsRedactedDisplay: true,
            showApiKey: false,
            ...overrides,
          },
        }),
      ),
    );
  const close = await open([]);
  try {
    await render({});
    const input = host.querySelector("#modal-apikey");
    assert.equal(input.type, "password");
    assert.equal(input.value.length, 8);
    input.setSelectionRange(input.value.length, input.value.length);
    await env.act(async () => input.focus());
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, PLACEHOLDER.length);

    input.blur();
    await render({ apiKey: "test-key-456", apiKeyIsRedactedDisplay: false });
    input.setSelectionRange(3, 3);
    await env.act(async () => input.focus());
    assert.equal(input.selectionStart, 3, "an edited key is not selected on focus");
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    await close();
  }
});
