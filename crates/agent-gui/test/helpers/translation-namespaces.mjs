import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Feature translation namespaces (crates/agent-ui/src/i18n/namespaces). The apps
// load each one with the feature that renders its messages; tests that need the
// complete tables load all of them into the loader's host translations.
export const translationNamespaceDirectory = fileURLToPath(
  new URL("../../../agent-ui/src/i18n/namespaces/", import.meta.url),
);

export function translationNamespaceFiles() {
  return readdirSync(translationNamespaceDirectory)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Namespace name of a module file: `settingsZhCN.ts` belongs to `settings`. */
export function translationNamespaceOf(fileName) {
  return fileName.replace(/\.ts$/, "").replace(/(ZhCN|EnUS)$/, "");
}

export function loadTranslationNamespaces(loader) {
  for (const fileName of translationNamespaceFiles()) {
    loader.loadModule(`@liveagent/ui/i18n/namespaces/${fileName}`);
  }
}

/**
 * The complete shared tables (core plus every namespace, no host overrides) as
 * the apps see them once every feature has loaded.
 */
export function completeSharedTranslations(loader) {
  loadTranslationNamespaces(loader);
  return loader
    .loadModule("@liveagent/ui/i18n/hostTranslations.ts")
    .createHostTranslations({ "zh-CN": {}, "en-US": {} }).translations;
}
