import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const fontFamily = loader.loadModule("src/lib/shared/fontFamily.ts");

test("font family normalizer keeps freeform stacks and rejects unsafe values", () => {
  assert.equal(fontFamily.normalizeFontFamily(""), "");
  assert.equal(fontFamily.normalizeFontFamily("system"), "system");
  assert.equal(fontFamily.normalizeFontFamily("  Inter  "), "Inter");
  assert.equal(
    fontFamily.normalizeFontFamily('Inter, "PingFang SC", sans-serif'),
    'Inter, "PingFang SC", sans-serif',
  );
  assert.equal(fontFamily.normalizeFontFamily("rounded"), "rounded");
  assert.equal(fontFamily.normalizeFontFamily("serif"), "serif");
  assert.equal(fontFamily.normalizeFontFamily('Inter; background: red'), "");
  assert.equal(fontFamily.normalizeFontFamily("url(https://evil.example/font.woff2)"), "");
  assert.equal(fontFamily.normalizeFontFamily("x".repeat(201)), "");
});

test("font family resolvers retain the established default stacks", () => {
  assert.equal(fontFamily.resolveAppFontFamily(""), fontFamily.DEFAULT_APP_FONT_FAMILY);
  assert.equal(fontFamily.resolveChatFontFamily(""), fontFamily.DEFAULT_CHAT_FONT_FAMILY);
  assert.equal(fontFamily.resolveCodeFontFamily(""), fontFamily.DEFAULT_CODE_FONT_FAMILY);
  assert.equal(fontFamily.resolveCodeFontFamily("Menlo"), "Menlo");
  assert.equal(fontFamily.quoteFontFamilyName("PingFang SC"), '"PingFang SC"');
  assert.equal(fontFamily.quoteFontFamilyName("Inter"), "Inter");
});

test("applying font families updates all CSS variables and only emits code changes", () => {
  const eventTarget = new EventTarget();
  const values = new Map();
  const root = {
    style: {
      getPropertyValue: (name) => values.get(name) ?? "",
      setProperty: (name, value) => values.set(name, value),
    },
    ownerDocument: { defaultView: eventTarget },
  };
  const codeFonts = [];
  eventTarget.addEventListener(fontFamily.CODE_FONT_FAMILY_CHANGE_EVENT, (event) => {
    codeFonts.push(event.detail);
  });

  fontFamily.applyFontFamilies(
    { interfaceFontFamily: "Inter", chatFontFamily: "Noto Sans", codeFontFamily: "Menlo" },
    root,
  );
  fontFamily.applyFontFamilies(
    { interfaceFontFamily: "Inter", chatFontFamily: "Noto Sans", codeFontFamily: "Menlo" },
    root,
  );
  fontFamily.applyFontFamilies(
    { interfaceFontFamily: "Inter", chatFontFamily: "Noto Sans", codeFontFamily: "Monaco" },
    root,
  );

  assert.equal(values.get("--app-font-family"), "Inter");
  assert.equal(values.get("--chat-font-family"), "Noto Sans");
  assert.equal(values.get("--code-font-family"), "Monaco");
  assert.deepEqual(codeFonts, ["Menlo", "Monaco"]);
});

test("listLocalFontFamilies uses queryLocalFonts when available", async () => {
  const previous = globalThis.queryLocalFonts;
  globalThis.queryLocalFonts = async () => [
    { family: "Inter" },
    { family: "PingFang SC" },
    { family: "Inter" },
    { family: "  " },
  ];
  try {
    assert.deepEqual(await fontFamily.listLocalFontFamilies(), ["Inter", "PingFang SC"]);
  } finally {
    if (previous === undefined) {
      delete globalThis.queryLocalFonts;
    } else {
      globalThis.queryLocalFonts = previous;
    }
  }
});
