import assert from "node:assert/strict";
import test from "node:test";
import { readStyleSource } from "../../../agent-ui/test-support/style-values.mjs";
import { readTerminalAppearance, readTerminalTheme } from "../../../agent-ui/src/lib/terminal/theme.ts";

const source = readStyleSource(new URL("../../../agent-ui/src/styles/tokens.css", import.meta.url));
const values = new Map([...source.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
const style = { getPropertyValue: (key) => values.get(key) ?? "" };

// xterm's fallback color parser can turn transparent into an opaque white ruler.
// Check the values sent to xterm, after resolving the shared CSS tokens.
test("xterm receives concrete colors for both themes", () => {
  for (const theme of ["light", "dark"]) {
    const palette = readTerminalTheme(theme, style);
    assert.equal(Object.keys(palette).length, 26);
    for (const [key, color] of Object.entries(palette)) {
      assert.ok(color.length > 0, `${theme}.${key} is defined`);
      assert.equal(color.includes("var("), false, `${theme}.${key} is resolved`);
      assert.notEqual(color, "transparent");
    }
  }
  assert.equal(readTerminalTheme("dark", style).background, "#0b0f14");
  assert.equal(readTerminalTheme("light", style).background, "#fcfcfd");
});

test("overview ruler stays transparent via 8-digit hex", () => {
  for (const theme of ["light", "dark"]) {
    assert.equal(readTerminalTheme(theme, style).overviewRulerBorder, "#00000000");
  }
});

test("terminal font and ruler dimensions preserve their original values", () => {
  const appearance = readTerminalAppearance("dark", style);
  assert.equal(appearance.fontSize, 13);
  assert.equal(appearance.lineHeight, 1.3);
  assert.equal(appearance.overviewRulerWidth, 8);
});
