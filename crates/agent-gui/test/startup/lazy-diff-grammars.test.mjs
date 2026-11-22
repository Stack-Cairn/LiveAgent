import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Both release bundles (desktop and WebUI) keep the diff engine's highlight.js grammars out of
// the startup bundle. The transform depends on the exact shape of a dependency file, so check
// it against the installed version.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const { lazyDiffHighlightGrammars, DIFF_HIGHLIGHT_GRAMMARS_KEY } = createTsModuleLoader().loadModule(
  "../agent-ui/build/lazyDiffGrammars.ts",
);

function installedDiffLowlight() {
  const store = path.join(repoRoot, "node_modules/.pnpm");
  const dir = readdirSync(store).find((name) => name.startsWith("@git-diff-view+lowlight@"));
  assert.ok(dir, "@git-diff-view/lowlight is installed");
  const id = path.join(store, dir, "node_modules/@git-diff-view/lowlight/dist/esm/index.mjs");
  return { id, code: readFileSync(id, "utf8") };
}

test("the transform starts the diff highlighter without grammars and exposes a loader", async () => {
  const { id, code } = installedDiffLowlight();
  const warnings = [];
  const context = {
    resolve: async (source, importer) => ({ id: createRequire(importer).resolve(source) }),
    warn: (message) => warnings.push(message),
  };
  const result = await lazyDiffHighlightGrammars().transform.call(context, code, id);
  assert.deepEqual(warnings, []);
  assert.ok(result, "the installed version still has the expected shape");
  assert.match(result.code, /createLowlight\(\{\}\)/);
  assert.doesNotMatch(result.code, /from 'lowlight'/);
  assert.match(result.code, new RegExp(`Symbol\\.for\\("${DIFF_HIGHLIGHT_GRAMMARS_KEY.replace(/\./g, "\\.")}"\\)`));
  assert.match(result.code, /import\(".*all\.js"\)/);
});

test("the desktop and WebUI builds both register the transform", () => {
  for (const config of ["crates/agent-gui/vite.config.ts", "crates/agent-gateway/web/vite.config.ts"]) {
    const source = readFileSync(path.join(repoRoot, config), "utf8");
    assert.match(source, /plugins:\s*\[[^\]]*lazyDiffHighlightGrammars\(\)/, config);
  }
});
