import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The settings failure list says why K-brain refused a conflicting import, in both languages.

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
const jsxRuntime = requireFromRoot("react/jsx-runtime");
const { renderToStaticMarkup } = requireFromRoot("react-dom/server");

const { GUI_TRANSLATION_OVERRIDES } = createTsModuleLoader({ rootDir }).loadModule("src/i18n/config.ts");
const locale = { current: "en-US" };
const loader = createTsModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/i18n": { useLocale: () => ({ t: (key) => GUI_TRANSLATION_OVERRIDES[locale.current][key] ?? key }) },
    "@liveagent/ui/components/ui/button": { Button: () => null },
    "@liveagent/ui/pages/settings/shared": { SettingsGroup: () => null, SettingsRow: () => null },
    "../host": { isTauriHost: () => true },
  },
});
const { HistoryMigrationFailureList } = loader.loadModule("src/lib/kbrain/LegacyHistoryImportSettings.tsx");

const record = (sourceId, extra) => ({ sourceId, title: `Conversation ${sourceId}`, fingerprint: "f", kind: "conflict", message: "409", failedAt: 1, ...extra });
const records = [
  record("aaaaaaaa1", { reason: "diverged" }),
  record("bbbbbbbb2", { reason: "modified_after_import" }),
  record("cccccccc3", { reason: "something_new" }),
  record("dddddddd4", {}),
];
const reasons = (html) => [...html.matchAll(/data-testid="history-migration-conflict-reason">([^<]*)</g)].map((match) => match[1]);

test("conflict reasons are shown in English and Chinese; an old backend's conflict has none", () => {
  const list = () => renderToStaticMarkup(jsxRuntime.jsx(HistoryMigrationFailureList, { records }));
  locale.current = "en-US";
  const english = reasons(list());
  assert.deepEqual(english, [
    "Reason: the messages differ partway through, so the new ones cannot be appended.",
    "Reason: the conversation was continued in K-brain after import, so it is not overwritten.",
    "Reason code: something_new",
  ]);
  locale.current = "zh-CN";
  const chinese = reasons(list());
  assert.equal(chinese.length, 3);
  for (const text of chinese) assert.match(text, /^原因/);
  for (const reason of ["different_source", "diverged", "modified_after_import", "no_new_messages", "fingerprint_unchanged"]) {
    for (const language of ["en-US", "zh-CN"]) {
      assert.ok(GUI_TRANSLATION_OVERRIDES[language][`historyImport.conflictReason.${reason}`], `${language} ${reason}`);
    }
  }
  assert.ok(GUI_TRANSLATION_OVERRIDES["zh-CN"]["historyImport.deferred"]);
  assert.ok(GUI_TRANSLATION_OVERRIDES["en-US"]["historyImport.deferred"]);
});
