import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { fromKBrainMcpSettings } = createTsModuleLoader().loadModule("src/lib/kbrain/mcp.ts");

test("backend omitted MCP selection clears legacy selection instead of restricting newly configured servers", () => {
  const fallback = { servers: [{ id: "old", enabled: true }], selected: ["old"] };
  const settings = fromKBrainMcpSettings({ settings: { servers: [{ id: "new", enabled: true }] } }, fallback);
  assert.deepEqual(settings.servers.map(server => server.id), ["new"]);
  assert.deepEqual(settings.selected, []);
});
