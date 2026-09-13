import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildGatewayPublicBaseUrl } = loader.loadModule(
  "@liveagent/ui/lib/shared/gatewayPublicUrl.ts",
);
const { composePublicUrl } = loader.loadModule("@liveagent/ui/lib/tunnels/constants.ts");

for (const [name, address, port, expected] of [
  ["Docker published port", "http://127.0.0.1", 3000, "http://127.0.0.1:3000"],
  ["custom TLS port", "https://gateway.example", 8443, "https://gateway.example:8443"],
  ["default HTTP port", "http://gateway.example", 80, "http://gateway.example"],
  ["default HTTPS port", "https://gateway.example", 443, "https://gateway.example"],
  ["separate port wins", "http://127.0.0.1:8080", 3000, "http://127.0.0.1:3000"],
  ["unspecified port", "http://127.0.0.1:3000/", undefined, "http://127.0.0.1:3000"],
  ["zero port matches native fallback", "http://127.0.0.1:3000/", 0, "http://127.0.0.1:3000"],
  ["IPv6", "http://[::1]", 3000, "http://[::1]:3000"],
  ["proxy path", " https://gateway.example/agent/?q=1#old ", 8443, "https://gateway.example:8443/agent"],
  ["WebSocket scheme", "wss://gateway.example/agent/", 443, "https://gateway.example/agent"],
]) {
  test(`public tunnel URL preserves ${name}`, () => {
    const base = buildGatewayPublicBaseUrl(address, port);
    assert.equal(base, expected);
    assert.equal(composePublicUrl(base, "/t/abc/"), `${expected}/t/abc/`);
  });
}

test("invalid configuration cannot produce a clickable tunnel URL", () => {
  for (const [address, port] of [["", 3000], ["not a URL", 3000], ["file:///tmp", 3000],
    ["http://localhost", -1], ["http://localhost", 65536], ["http://localhost", 1.5]]) {
    assert.equal(composePublicUrl(buildGatewayPublicBaseUrl(address, port), "/t/abc/"), "");
  }
});
