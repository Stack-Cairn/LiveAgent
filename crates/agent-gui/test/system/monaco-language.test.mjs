import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { resolveMonacoLanguageForPath } = loader.loadModule(
  "@liveagent/ui/lib/monacoLanguage.ts",
);

const registrations = [
  { id: "dockerfile", filenames: ["Dockerfile"] },
  { id: "hcl", extensions: [".tf", ".hcl"] },
  { id: "javascript", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
  { id: "protobuf", extensions: [".proto"] },
  { id: "shell", extensions: [".sh", ".bash"] },
  { id: "typescript", extensions: [".ts", ".tsx", ".cts", ".mts"] },
];

test("resolves Monaco language metadata instead of a hand-maintained extension switch", () => {
  assert.equal(resolveMonacoLanguageForPath("src/main.mjs", registrations), "javascript");
  assert.equal(resolveMonacoLanguageForPath("types/api.d.ts", registrations), "typescript");
  assert.equal(resolveMonacoLanguageForPath("infra/main.tf", registrations), "hcl");
  assert.equal(resolveMonacoLanguageForPath("proto/agent.proto", registrations), "protobuf");
  assert.equal(resolveMonacoLanguageForPath("containers/Dockerfile", registrations), "dockerfile");
});

test("keeps LiveAgent aliases that Monaco does not declare", () => {
  assert.equal(resolveMonacoLanguageForPath("settings.jsonc", registrations), "json");
  assert.equal(resolveMonacoLanguageForPath("styles/theme.sass", registrations), "scss");
  assert.equal(resolveMonacoLanguageForPath("Cargo.lock", registrations), "toml");
  assert.equal(resolveMonacoLanguageForPath("Makefile", registrations), "makefile");
  assert.equal(resolveMonacoLanguageForPath("scripts/setup.zsh", registrations), "shell");
  assert.equal(resolveMonacoLanguageForPath("README.unknown", registrations), "plaintext");
});
