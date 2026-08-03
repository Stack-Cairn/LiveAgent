import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom() {
  const window = new Window({ url: "http://localhost" });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return () => {
    window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  };
}

function icon(props) {
  return React.createElement("svg", props);
}

const iconNames = [
  "BookOpen",
  "Brain",
  "Copy",
  "Folder",
  "Globe",
  "Key",
  "Layers",
  "ListChecks",
  "Lock",
  "MessageSquare",
  "Plug",
  "Plus",
  "Search",
  "Server",
  "Shield",
  "SkillIcon",
  "Sparkles",
  "Trash2",
  "Wrench",
  "X",
  "Zap",
];
const icons = Object.fromEntries(iconNames.map((name) => [name, icon]));

function createManager() {
  const loader = createTsModuleLoader({
    mocks: {
      "react/jsx-runtime": jsxRuntime,
      "react-dom": { createPortal: (children) => children },
      "../../i18n": { useLocale: () => ({ t: (key) => key }) },
      "../../lib/settings": { DEFAULT_SKILL_PRESET_ID: "default" },
      "../../lib/shared/utils": {
        cn: (...values) => values.filter(Boolean).join(" "),
      },
      "../../lib/skills": { isUserSelectableSkill: () => true },
      "../../lib/skills/clawHubCategories": {
        CLAWHUB_CATEGORY_SLUGS: ["integrations", "development", "productivity"],
        classifyClawHubSkill: ({ slug }) =>
          slug.startsWith("dev-")
            ? ["development"]
            : slug.startsWith("integration-")
              ? ["integrations"]
              : ["productivity"],
      },
      "../icons": icons,
      "../ui/confirm-action-popover": {
        ConfirmActionPopover: ({ children }) => children(() => {}),
      },
    },
  });
  return loader.loadModule("src/components/skills/SkillPresetManager.tsx").SkillPresetManager;
}

function findButton(root, text) {
  return [...root.querySelectorAll("button")].find((button) => button.textContent.includes(text));
}

test("Skill preset drawer filters, toggles, saves, and unmounts after closing", async () => {
  const restoreDom = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const SkillPresetManager = createManager();
  const updates = [];

  try {
    await act(async () => {
      root.render(
        React.createElement(SkillPresetManager, {
          presets: [
            { id: "default", name: "Default", description: "", skillNames: [] },
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Work",
              description: "Work preset",
              skillNames: ["integration-mail"],
            },
          ],
          skills: [
            {
              name: "integration-mail",
              description: "Connect mail services",
              baseDir: "/skills/integration-mail",
            },
            {
              name: "dev-review",
              description: "Review source code and tests",
              baseDir: "/skills/dev-review",
            },
          ],
          onCreate: () => {},
          onUpdate: (...args) => updates.push(args),
          onDuplicate: () => {},
          onDelete: () => {},
          onGoInstalled: () => {},
        }),
      );
    });

    await act(async () => findButton(container, "Work").click());
    let dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);

    await act(async () =>
      findButton(dialog, "settings.skillsStoreCategoryDevelopment").click(),
    );
    dialog = document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /Review source code and tests/);
    assert.doesNotMatch(dialog.textContent, /Connect mail services/);

    const skillSwitch = dialog.querySelector('[role="switch"]');
    assert.equal(skillSwitch.getAttribute("aria-checked"), "false");
    await act(async () => skillSwitch.click());
    assert.equal(skillSwitch.getAttribute("aria-checked"), "true");

    await act(async () => findButton(dialog, "settings.save").click());
    assert.equal(updates.length, 1);
    assert.deepEqual(new Set(updates[0][1].skillNames), new Set(["integration-mail", "dev-review"]));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    restoreDom();
  }
});

test("Skill discovery never prunes preset membership from settings", async () => {
  const restoreDom = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let settingsWrites = 0;
  const loader = createTsModuleLoader({
    mocks: {
      "../../../lib/skills": {
        discoverSkills: async () => ({
          rootDir: "/skills",
          skills: [
            {
              name: "available-skill",
              description: "Available now",
              baseDir: "/skills/available-skill",
            },
          ],
        }),
        subscribeSkillsDiscoveryUpdated: () => () => {},
      },
    },
  });
  const { useChatSkills } = loader.loadModule("src/pages/chat/hooks/useChatSkills.ts");

  function Harness() {
    const state = useChatSkills({
      skillsEnabled: true,
      selectedSkillNames: ["temporarily-missing-skill"],
      setSettings: () => {
        settingsWrites += 1;
      },
    });
    return React.createElement("span", null, state.availableSkills.map((skill) => skill.name).join());
  }

  try {
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(container.textContent, "available-skill");
    assert.equal(settingsWrites, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    restoreDom();
  }
});
