import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { loadTranslationNamespaces } from "../helpers/translation-namespaces.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const baseLoader = createTsModuleLoader({ rootDir });
const i18n = baseLoader.loadModule("src/i18n/config.ts");
loadTranslationNamespaces(baseLoader);
const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
const jsxRuntime = requireFromRoot("react/jsx-runtime");
const { renderToStaticMarkup } = requireFromRoot("react-dom/server");

function loadPreview(locale) {
  const loader = createTsModuleLoader({
    rootDir,
    mocks: {
      "react/jsx-runtime": jsxRuntime,
      "@liveagent/ui/i18n/index": {
        useLocale: () => ({ locale, t: (key) => i18n.t(key, locale) }),
      },
    },
  });
  return loader.loadModule(
    "@liveagent/ui/components/chat/assistant-bubble/TruncatedPreviewText.tsx",
  );
}

test("text previews report what they leave out instead of baking a marker into the text", () => {
  const { truncateTextPreview } = baseLoader.loadModule("@liveagent/ui/lib/chat/textPreview.ts");
  assert.deepEqual(truncateTextPreview("short", 10), {
    text: "short",
    truncated: false,
    totalChars: 5,
  });
  assert.deepEqual(truncateTextPreview("x".repeat(1300), 1200), {
    text: "x".repeat(1200),
    truncated: true,
    totalChars: 1300,
  });
});

test("the truncation note follows the UI locale", () => {
  const long = "y".repeat(18892);
  const render = (locale) => {
    const { TruncatedPreviewText } = loadPreview(locale);
    return renderToStaticMarkup(
      jsxRuntime.jsx("pre", {
        children: jsxRuntime.jsx(TruncatedPreviewText, { text: long, maxChars: 6000 }),
      }),
    );
  };
  const en = render("en-US");
  assert.match(en, /data-preview-truncated/);
  assert.match(en, /Showing the first 6,000 of 18,892 characters/);
  assert.doesNotMatch(en, /[㐀-鿿]/u, "the English UI carries no Chinese marker");
  assert.match(render("zh-CN"), /仅显示前 6,000 个字符，共 18,892 个/);

  const { TruncatedPreviewText } = loadPreview("en-US");
  const short = renderToStaticMarkup(
    jsxRuntime.jsx(TruncatedPreviewText, { text: "fits", maxChars: 6000 }),
  );
  assert.equal(short, "fits");
});

test("zh settings navigation translates Remote and the toast region has a label", () => {
  assert.equal(i18n.t("settings.navRemote", "zh-CN"), "远程");
  assert.equal(i18n.t("toast.regionLabel", "en-US"), "Notifications");
  assert.equal(i18n.t("toast.regionLabel", "zh-CN"), "通知");
});
