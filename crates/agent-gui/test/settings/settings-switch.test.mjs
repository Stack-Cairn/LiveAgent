import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("settings switches preserve controlled values, locked Skills and provider hit area", async () => {
  let env;
  const icons = Object.fromEntries([
    "AlertTriangle", "BookOpen", "Check", "FileText", "Lock", "MessageSquare", "RefreshCw", "Search", "Sparkles",
    "ClaudeIcon", "DeepseekIcon", "GeminiIcon", "GrokIcon", "Info", "OpenaiChatgptIcon",
  ].map(name => [name, props => env.React.createElement("svg", props)]));
  env = await createDomTestEnv({mocks: {
    "@liveagent/ui/components/IconSet": icons,
    "@liveagent/ui/i18n/index": {useLocale: () => ({t: key => key})},
    "@liveagent/ui/lib/skills/index": {
      discoverSkills: async () => ({skills: []}),
      notifySkillsDiscoveryUpdated: () => {},
      mergeAlwaysEnabledSkillNames: names => names,
      isUserSelectableSkill: () => true,
      isAlwaysEnabledSkillName: () => false,
    },
    "@liveagent/app/lib/settings/index": {
      updateSkills: (prev, patch) => ({...prev, skills: {...prev.skills, ...patch}}),
    },
  }});
  const {React, act, createRoot} = env;
  const {DialogSwitch} = env.loadModule("@liveagent/ui/pages/settings/ProviderPresentation.tsx");
  const {SkillsSettingsForm} = env.loadModule("@liveagent/ui/pages/settings/SkillsSettingsForm.tsx");
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

    let settings={system:{executionMode:"agent"},skills:{enabled:false,selected:["keep-me"]}};
    const updates=[];
    const renderSkills=async () => act(async () => root.render(React.createElement(SkillsSettingsForm, {
      settings, setSettings: updater => {settings=updater(settings);updates.push(settings.skills.enabled);},
    })));
    await renderSkills();
    button=host.querySelector('button[role="switch"]');
    await act(async () => button.click());
    assert.deepEqual(updates,[true]);
    assert.deepEqual(settings.skills.selected,["keep-me"]);
    await renderSkills();
    assert.equal(button.getAttribute("aria-checked"),"true");
    await act(async () => button.click());
    assert.deepEqual(updates,[true,false]);
    settings={...settings,system:{executionMode:"text"}};
    await renderSkills();
    button=host.querySelector('button[role="switch"]');
    assert.equal(button.disabled,true);
    await act(async () => button.click());
    assert.deepEqual(updates,[true,false]);
  } finally {
    await act(async () => root.unmount());host.remove();env.cleanup();
  }
});
