import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv({ mocks: {
  "../../i18n": { useLocale: () => ({ t: key => key }) },
  "@liveagent/ui/components/IconSet": { ArrowLeft: () => null, Search: () => null, X: () => null },
} });
after(() => env.cleanup());
const { React, act, createRoot, loadModule } = env;
const { SettingsShell } = loadModule("@liveagent/ui/pages/settings/SettingsShell.tsx");
const { ZoneFontScaleContext } = loadModule("@liveagent/ui/components/ui/zone-font-scale.tsx");
const { normalizeFontScaleSettings } = loadModule("src/lib/settings/index.ts");

test("settings dialogs inherit scale and explicit overrides take precedence", async () => {
  const { Dialog, DialogContent, DialogTitle } = loadModule("@liveagent/ui/components/ui/dialog.tsx");
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    for (const override of [undefined, 0.9]) {
      await act(async () => root.render(React.createElement(ZoneFontScaleContext.Provider,
        { value: 1.2 }, React.createElement(Dialog, { open: true },
          React.createElement(DialogContent,
            { style: override ? { "--zone-font-scale": override } : undefined },
            React.createElement(DialogTitle, null, "Settings preview"))))));
      assert.equal(document.querySelector("[data-slot=dialog-content]").style.getPropertyValue("--zone-font-scale"), String(override ?? 1.2));
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("settings font scale survives normalization and older preferences default to standard", () => {
  assert.equal(normalizeFontScaleSettings({ settings: 1.2 }).settings, 1.2);
  assert.equal(normalizeFontScaleSettings({ chat: 1.1 }).settings, 1);
  assert.equal(normalizeFontScaleSettings({ settings: 100 }).settings, 1.4);
});

test("real settings shell applies its font scale and publishes it across React portals", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let scale;
  function Content() {
    scale = React.useContext(ZoneFontScaleContext);
    return React.createElement("p", { className: "text-sm" }, "Font size preview");
  }
  const registry = { surface: "desktop", services: {}, slots: {}, settingsSections: [{
    id: "system", groupKey: "settings", groupOrder: 1, order: 1,
    labelKey: "settings.system", render: () => React.createElement(Content),
  }] };
  try {
    for (const value of [1, 1.2, 0.9]) {
      await act(async () => root.render(React.createElement(SettingsShell, {
        registry, context: undefined, saveState: { status: "idle" }, onBack() {}, fontScale: value,
      })));
      const zone = container.querySelector(".zone-font-scale");
      assert.ok(zone, "the settings shell must declare a font scale zone");
      assert.equal(zone.style.getPropertyValue("--zone-font-scale"), String(value));
      assert.equal(scale, value, "popup descendants receive the current settings scale");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
