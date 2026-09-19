import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("provider switch preserves controlled value and hit area", async () => {
  let env;
  const icons = Object.fromEntries([
    "AlertTriangle", "BookOpen", "Check", "FileText", "Lock", "MessageSquare", "RefreshCw", "Search", "Sparkles",
    "ClaudeIcon", "DeepseekIcon", "GeminiIcon", "GrokIcon", "Info", "OpenaiChatgptIcon",
  ].map(name => [name, props => env.React.createElement("svg", props)]));
  env = await createDomTestEnv({mocks: {
    "@liveagent/ui/components/IconSet": icons,
    "@liveagent/ui/i18n/index": {useLocale: () => ({t: key => key})},
  }});
  const {React, act, createRoot} = env;
  const {DialogSwitch} = env.loadModule("@liveagent/ui/pages/settings/ProviderPresentation.tsx");
  const host = document.createElement("div");document.body.append(host);
  const root = createRoot(host);
  try {
    const changes=[];
    await act(async () => root.render(React.createElement(DialogSwitch, {
      checked: false, ariaLabel: "Provider option", onCheckedChange: value => changes.push(value),
    })));
    let button=host.querySelector('button[role="switch"]');
    assert.equal(button.type,"button");
    assert.equal(button.getAttribute("aria-label"),"Provider option");
    assert.ok(button.classList.contains("size-8"));
    assert.ok(button.firstElementChild.classList.contains("w-7"));
    await act(async () => button.click());
    assert.deepEqual(changes,[true]);
    assert.equal(button.getAttribute("aria-checked"),"false");
    await act(async () => root.render(React.createElement(DialogSwitch, {
      checked: true, ariaLabel: "Provider option", onCheckedChange: value => changes.push(value),
    })));
    button=host.querySelector('button[role="switch"]');
    await act(async () => button.click());
    assert.deepEqual(changes,[true,false]);
  } finally {
    await act(async () => root.unmount());host.remove();env.cleanup();
  }
});

test("toggling Skills enabled keeps the user's selected skills", async () => {
  const env = await createDomTestEnv();
  try {
    const {normalizeSettings, updateSkills} = env.loadModule("@liveagent/ui/lib/settings/index.ts");
    const before = normalizeSettings({skills: {enabled: true, selected: ["keep-me"]}});
    assert.ok(before.skills.selected.includes("keep-me"));

    const disabled = updateSkills(before, {enabled: false});
    assert.equal(disabled.skills.enabled, false);
    assert.deepEqual(disabled.skills.selected, before.skills.selected);

    const enabled = updateSkills(disabled, {enabled: true});
    assert.equal(enabled.skills.enabled, true);
    assert.deepEqual(enabled.skills.selected, before.skills.selected);
  } finally {
    env.cleanup();
  }
});
