import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("settings surfaces preserve native nodes, props, refs and existing class sets", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { SettingsPanel, SettingsHint } = env.loadModule("@liveagent/ui/components/settings/SettingsPanel.tsx");
  const { SettingsNotice } = env.loadModule("@liveagent/ui/components/settings/SettingsNotice.tsx");
  const { ChoiceCard } = env.loadModule("@liveagent/ui/components/settings/ChoiceCard.tsx");
  const cases = [
    [SettingsPanel, {variant: "collapsible"}, "div", "overflow-hidden rounded-xl border border-border/60 bg-muted/20"],
    [SettingsPanel, {variant: "configuration"}, "div", "space-y-3 rounded-xl border border-border/70 bg-muted/35 p-4"],
    [SettingsHint, {}, "p", "rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground"],
    [SettingsNotice, {variant: "validation"}, "div", "flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3 py-2.5 text-xs text-destructive"],
    [SettingsNotice, {variant: "warning"}, "div", "rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300"],
    [SettingsNotice, {variant: "installation-warning"}, "div", "rounded-xl border border-amber-500/30 bg-amber-500/[0.05] p-3.5"],
    [SettingsNotice, {variant: "inline-error"}, "div", "flex items-center gap-1.5 text-xs text-destructive"],
  ];
  for (const [kind, color] of [["command", "blue"], ["http", "emerald"], ["prompt", "violet"]]) {
    for (const selected of [false, true]) {
      cases.push([ChoiceCard, {kind, selected}, "button",
        "group relative flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-all " +
        (selected ? `border-${color}-500/50 bg-${color}-500/5 shadow-sm shadow-${color}-500/10` : "border-border/60 bg-background hover:border-border hover:bg-muted/20")]);
    }
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const [Component, variantProps, tag, classes] of cases) {
      let clicks = 0;
      const ref = React.createRef();
      await act(async () => root.render(React.createElement(Component,
        {...variantProps, ref, id: "surface", "aria-label": "Example", className: "mt-3", onClick: () => clicks++, ...(tag === "button" ? {type: "button"} : {})},
        React.createElement("span", null, "Content"))));
      const node = container.firstElementChild;
      assert.equal(node.localName, tag);
      assert.equal(ref.current, node);
      assert.equal(node.id, "surface");
      assert.equal(node.getAttribute("aria-label"), "Example");
      assert.equal(node.childElementCount, 1);
      assert.equal(node.textContent, "Content");
      assert.deepEqual([...node.classList].sort(), [...new Set((classes + " mt-3").split(" "))].sort());
      for (const prop of ["variant", "kind", "selected"]) assert.equal(node.hasAttribute(prop), false);
      await act(async () => node.click());
      assert.equal(clicks, 1);
      if (tag === "button") {
        await act(async () => root.render(React.createElement(Component, {...variantProps, disabled: true, onClick: () => clicks++}, "Disabled")));
        container.firstElementChild.click();
        assert.equal(clicks, 1);
      }
    }
  } finally {
    await act(async () => root.unmount());
    env.cleanup();
  }
});
