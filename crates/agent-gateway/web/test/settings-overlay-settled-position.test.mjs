import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Tailwind v4 writes translate-y-* to the CSS `translate` property, not
// `transform`. The settings overlay enters from translate-y-24px; settling it
// with transform-none! left `translate: 0 24px`, so the overlay sat 24px low
// and the chat header showed through, clipped, above it.

const webStyleClassesSource = readFileSync(
  new URL("../src/lib/webStyleClasses.ts", import.meta.url),
  "utf8",
);
const appViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);

const overlayClass =
  webStyleClassesSource.match(/GATEWAY_SETTINGS_OVERLAY_CLASS =\s*"([^"]+)"/)?.[1] ?? "";
const openClass = appViewSource.match(/overlay === "open" \? "([^"]+)"/)?.[1] ?? "";

test("the open settings overlay clears the translate it enters with", () => {
  assert.ok(overlayClass, "GATEWAY_SETTINGS_OVERLAY_CLASS is found");
  assert.ok(openClass, "the open-state class is found");
  if (/(^|\s)translate-y-/.test(overlayClass)) {
    assert.match(
      openClass,
      /(^|\s)translate-(none|y-0)!/,
      "transform-none! does not reset Tailwind v4's translate property",
    );
  }
});

test("the overlay transition animates the property it moves", () => {
  const transition = overlayClass.match(/transition-\[([^\]]+)\]/)?.[1] ?? "";
  if (/(^|\s)translate-y-/.test(overlayClass)) {
    assert.match(transition, /(^|,)translate(,|$)/);
  }
});
