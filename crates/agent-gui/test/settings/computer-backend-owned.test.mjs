import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("shared settings does not mount Computer Use management or legacy installers", () => {
  const source = readFileSync(new URL("../../../agent-ui/src/pages/settings/SettingsPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /id:\s*"cua"|KBrainComputerSection|CuaDriverSection|settings\.navCua/);
  assert.match(source, /id:\s*"systemTools"/);
  assert.match(source, /ResourceHubSection/);
});
