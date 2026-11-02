import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const shared = (name) => fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));

async function loadProviderModal(onViewModel) {
  const env = await createDomTestEnv({
    mocks: {
      [shared("ProviderModalView.tsx")]: {
        ProviderModalView: ({ viewModel }) => {
          onViewModel?.(viewModel);
          return null;
        },
      },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "@liveagent/app/lib/providers/usageQuery": { testProviderUsage: async () => null },
      "@liveagent/ui/lib/models/thinkingLive": { loadThinkingLiveSupplement: async () => {} },
      "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
      "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
    },
  });
  return { env, module: env.loadModule("@liveagent/ui/pages/settings/ProviderModal.tsx") };
}

test("provider base URLs follow K-brain's accepted shape", async () => {
  const { module } = await loadProviderModal();
  for (const ok of ["", "   ", "https://relay.example.com/v1", "http://127.0.0.1:8080", "  https://relay.example.com/v1/  "]) {
    assert.equal(module.isAcceptedProviderBaseUrl(ok), true, ok);
  }
  for (const bad of [
    "relay.example.com/v1",
    "ftp://relay.example.com",
    "https://relay example.com",
    "https://user:pass@relay.example.com",
    "https://relay.example.com/v1#frag",
  ]) {
    assert.equal(module.isAcceptedProviderBaseUrl(bad), false, bad);
  }
});

test("ProviderModal keeps the dialog open and flags a base URL K-brain would reject", async () => {
  let vm;
  const saved = [];
  const { env, module } = await loadProviderModal((viewModel) => {
    vm = viewModel;
  });
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  await env.act(async () =>
    root.render(
      env.React.createElement(module.ProviderModal, {
        providerType: "codex",
        onSave: (next) => saved.push(next),
        onClose: () => {},
      }),
    ),
  );
  try {
    await env.act(async () => vm.setName("Relay"));
    await env.act(async () => vm.setBaseUrl("relay.example.com/v1"));
    assert.equal(vm.baseUrlInvalid, false, "no error while the user is still typing");

    await env.act(async () => vm.handleSave());
    assert.equal(saved.length, 0, "the rejected URL is not sent");
    assert.equal(vm.baseUrlInvalid, true);

    await env.act(async () => vm.setBaseUrl("https://relay.example.com/v1"));
    assert.equal(vm.baseUrlInvalid, false, "editing clears the error");
    await env.act(async () => vm.handleSave());
    assert.equal(saved.length, 1);
    assert.equal(saved[0].baseUrl, "https://relay.example.com/v1");
  } finally {
    await env.act(async () => root.unmount());
  }
});
