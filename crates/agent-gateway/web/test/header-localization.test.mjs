import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const configurationSource = readFileSync(
  new URL("../src/app/hooks/useGatewayChatConfiguration.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/app/GatewayApp.tsx", import.meta.url), "utf8");
const userMenuSource = readFileSync(new URL("../src/app/UserMenu.tsx", import.meta.url), "utf8");

test("WebUI header fallbacks follow the selected locale", () => {
  assert.match(configurationSource, /translate\("chat\.selectModel", settings\.locale\)/);
  assert.match(appSource, /translate\("common\.currentUser", settings\.locale\)/);
  assert.match(userMenuSource, /t\("common\.logout"\)/);
  assert.doesNotMatch(configurationSource, /return "选择模型"/);
  assert.doesNotMatch(userMenuSource, />\s*退出登录\s*</);
});
