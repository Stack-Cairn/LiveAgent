import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const fontFamily = loader.loadModule("@liveagent/ui/lib/shared/fontFamily.ts");

async function withNavigator(value, task) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    value,
  });
  try {
    return await task();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "navigator", previous);
    } else {
      delete globalThis.navigator;
    }
  }
}

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
  assert.equal(fontFamily.normalizeFontFamily("微软雅黑"), "微软雅黑");
  assert.equal(
    fontFamily.normalizeFontFamily('苹方-简, "Microsoft YaHei", sans-serif'),
    '苹方-简, "Microsoft YaHei", sans-serif',
  );
  assert.equal(fontFamily.normalizeFontFamily("맑은 고딕"), "맑은 고딕");
  assert.equal(fontFamily.normalizeFontFamily("My_Custom_Font"), "My_Custom_Font");
  assert.equal(fontFamily.normalizeFontFamily('Inter; background: red'), "");
  assert.equal(fontFamily.normalizeFontFamily("微软雅黑; color: red"), "");
  assert.equal(fontFamily.normalizeFontFamily("url(微软雅黑)"), "");
  assert.equal(fontFamily.normalizeFontFamily("url(https://evil.example/font.woff2)"), "");
  assert.equal(fontFamily.normalizeFontFamily("x".repeat(201)), "");
});

test("font family resolvers preserve the established defaults", () => {
  assert.equal(
    fontFamily.resolveFontFamily("", fontFamily.DEFAULT_INTERFACE_FONT_FAMILY),
    fontFamily.DEFAULT_INTERFACE_FONT_FAMILY,
  );
  assert.equal(fontFamily.resolveCodeFontFamily(""), fontFamily.DEFAULT_CODE_FONT_FAMILY);
  assert.equal(fontFamily.resolveCodeFontFamily("Menlo"), "Menlo");
  assert.equal(fontFamily.quoteFontFamilyName("PingFang SC"), '"PingFang SC"');
  assert.equal(fontFamily.quoteFontFamilyName("Inter"), "Inter");
});

test("font family select helpers map default/custom sentinels and build options", () => {
  const options = fontFamily.buildFontFamilySelectOptions(["PingFang SC", "Inter"]);
  assert.equal(
    fontFamily.toFontFamilySelectValue("", options),
    fontFamily.FONT_FAMILY_DEFAULT_SELECT_VALUE,
  );
  assert.equal(fontFamily.toFontFamilySelectValue("Inter", options), "Inter");
  assert.equal(
    fontFamily.toFontFamilySelectValue("Maple Mono", options),
    fontFamily.FONT_FAMILY_CUSTOM_SELECT_VALUE,
  );
  assert.equal(
    fontFamily.toFontFamilySelectValue("", options, true),
    fontFamily.FONT_FAMILY_CUSTOM_SELECT_VALUE,
  );
  assert.equal(
    fontFamily.fromFontFamilySelectValue(fontFamily.FONT_FAMILY_DEFAULT_SELECT_VALUE),
    "",
  );
  assert.equal(
    fontFamily.fromFontFamilySelectValue(fontFamily.FONT_FAMILY_CUSTOM_SELECT_VALUE),
    "",
  );
  assert.equal(fontFamily.fromFontFamilySelectValue("Menlo"), "Menlo");
  assert.equal(fontFamily.isKnownFontFamilySelectValue("Inter", options), true);
  assert.equal(fontFamily.isKnownFontFamilySelectValue("Maple Mono", options), false);

  assert.deepEqual(
    options.map((option) => option.value),
    [
      "Arial",
      '"Cascadia Code"',
      "Consolas",
      '"Fira Code"',
      "Georgia",
      '"Helvetica Neue"',
      '"Hiragino Sans GB"',
      '"IBM Plex Mono"',
      "Inter",
      '"JetBrains Mono"',
      "Menlo",
      '"Microsoft YaHei"',
      "Monaco",
      '"Noto Sans SC"',
      '"PingFang SC"',
      '"SF Mono"',
      '"SF Pro Text"',
      '"Songti SC"',
      '"Source Code Pro"',
      '"Source Han Sans SC"',
      "STSong",
      '"Times New Roman"',
    ],
  );
  assert.equal(options.find((option) => option.value === '"PingFang SC"')?.label, "PingFang SC");
});

test("applying font families updates CSS variables and only emits code changes", () => {
  const previousWindow = globalThis.window;
  const windowTarget = new EventTarget();
  globalThis.window = windowTarget;
  const values = new Map();
  const root = {
    style: {
      getPropertyValue: (name) => values.get(name) ?? "",
      setProperty: (name, value) => values.set(name, value),
    },
  };
  const codeFonts = [];
  windowTarget.addEventListener(fontFamily.CODE_FONT_FAMILY_CHANGE_EVENT, (event) => {
    codeFonts.push(event.detail);
  });
  try {
    fontFamily.applyFontFamilies(
      { interfaceFontFamily: "Inter", chatFontFamily: "Charter", codeFontFamily: "Menlo" },
      root,
    );
    fontFamily.applyFontFamilies(
      { interfaceFontFamily: "Inter", chatFontFamily: "Charter", codeFontFamily: "Menlo" },
      root,
    );
    fontFamily.applyFontFamilies(
      { interfaceFontFamily: "Inter", chatFontFamily: "Charter", codeFontFamily: "Monaco" },
      root,
    );
    assert.equal(values.get("--app-font-family"), "Inter");
    assert.equal(values.get("--chat-font-family"), "Charter");
    assert.equal(values.get("--code-font-family"), "Monaco");
    assert.deepEqual(codeFonts, ["Menlo", "Monaco"]);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("listLocalFontFamilies does not trigger a local-fonts permission prompt", async () => {
  const previous = globalThis.queryLocalFonts;
  let queryCount = 0;
  globalThis.queryLocalFonts = async () => {
    queryCount += 1;
    return [{ family: "Inter" }];
  };
  try {
    await withNavigator(
      {
        permissions: {
          query: async (descriptor) => {
            assert.deepEqual(descriptor, { name: "local-fonts" });
            return { state: "prompt" };
          },
        },
      },
      async () => {
        assert.deepEqual(await fontFamily.listLocalFontFamilies(), []);
      },
    );
    assert.equal(queryCount, 0);
  } finally {
    if (previous === undefined) {
      delete globalThis.queryLocalFonts;
    } else {
      globalThis.queryLocalFonts = previous;
    }
  }
});

test("listLocalFontFamilies uses queryLocalFonts when permission is already granted", async () => {
  const previous = globalThis.queryLocalFonts;
  globalThis.queryLocalFonts = async () => [
    { family: "Inter" },
    { family: "PingFang SC" },
    { family: "Inter" },
    { family: "  " },
  ];
  try {
    await withNavigator(
      {
        permissions: {
          query: async () => ({ state: "granted" }),
        },
      },
      async () => {
        assert.deepEqual(await fontFamily.listLocalFontFamilies(), ["Inter", "PingFang SC"]);
      },
    );
  } finally {
    if (previous === undefined) {
      delete globalThis.queryLocalFonts;
    } else {
      globalThis.queryLocalFonts = previous;
    }
  }
});
