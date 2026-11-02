import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-4: with the Gateway hosted on this computer (managedLocal, the default) the desktop
// keeps its token in localGatewayToken and leaves remote.token empty. The mirror check only
// looked at gatewayUrl + token, so a run started on the desktop never reached the Gateway
// and a WebUI could neither watch it nor answer its approval.

const loader = createTsModuleLoader();
const { mirrorsLocalRunsToGateway } = loader.loadModule("src/pages/chat/gateway/gatewayRuntimeStatusModel.ts");

const hosted = { enabled: true, managedLocal: true, localGatewayPort: 50052, localGatewayToken: "local-token", gatewayUrl: "", token: "" };
const external = { enabled: true, managedLocal: false, localGatewayPort: 50052, localGatewayToken: "", gatewayUrl: "wss://gw.example", token: "tok" };

test("desktop runs are mirrored to a Gateway hosted on this computer", () => {
  assert.equal(mirrorsLocalRunsToGateway(hosted, true), true);
});

test("an external Gateway with URL and token is still mirrored", () => {
  assert.equal(mirrorsLocalRunsToGateway(external, true), true);
});

test("nothing is mirrored when remote access is off, unconfigured, or the host cannot mirror", () => {
  assert.equal(mirrorsLocalRunsToGateway({ ...hosted, enabled: false }, true), false);
  assert.equal(mirrorsLocalRunsToGateway({ ...hosted, localGatewayToken: " " }, true), false);
  assert.equal(mirrorsLocalRunsToGateway({ ...external, token: "" }, true), false);
  assert.equal(mirrorsLocalRunsToGateway(hosted, false), false);
});

test("the send path uses the shared check, not its own URL + token test", () => {
  const source = readFileSync(new URL("../../src/pages/chat/runtime/useSendChatTurn.ts", import.meta.url), "utf8");
  assert.match(source, /mirrorsLocalRunsToGateway\(\s*settings\.remote,\s*capabilities\.gatewayMirror,?\s*\)/);
  assert.doesNotMatch(source, /settings\.remote\.token\.trim\(\) !== ""/);
});

test("the tray shows the Gateway status for a hosted Gateway", () => {
  const source = readFileSync(new URL("../../src/lib/tray/trayMenu.ts", import.meta.url), "utf8");
  assert.match(source, /isRemoteSettingsConfigured\(input\.remote\)/);
});
