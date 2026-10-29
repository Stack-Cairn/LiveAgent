import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Source of truth: every fixed English error the local Gateway supervisor can
// return. connection.rs::prepare_local_gateway propagates start_with_epoch /
// stop errors unchanged into GatewayStatusSnapshot.last_error, which the shared
// RemoteSection shows in three places.
const loader = createTsModuleLoader();
const { localizeLocalGatewayError } = loader.loadModule(
  "@liveagent/ui/lib/settings/localGatewayError.ts",
);
const { t } = loader.loadModule("src/i18n/config.ts");

function supervisorErrors() {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../src-tauri/src/services/local_gateway.rs", import.meta.url),
    ),
    "utf8",
  );
  const production = source.slice(0, source.indexOf("#[cfg(test)]"));
  const literals = new Set();
  for (const match of production.matchAll(/"([^"]*[Ll]ocal Gateway[^"]*)"/g)) {
    // Fill format! placeholders the way the runtime would.
    literals.add(match[1].replace("{status}", "exit code: 1").replace("{}", "50052"));
  }
  return [...literals].sort();
}

test("every fixed local Gateway supervisor error is shown in Chinese for a zh-CN interface", () => {
  const errors = supervisorErrors();
  assert.ok(errors.length >= 11, `found ${errors.length} supervisor errors`);
  const untranslated = errors.filter(
    (message) => !/[一-鿿]/.test(localizeLocalGatewayError(message, (key) => t(key, "zh-CN"))),
  );
  assert.deepEqual(untranslated, [], "supervisor errors still shown in English");
});
