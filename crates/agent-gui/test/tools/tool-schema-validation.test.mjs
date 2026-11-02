import assert from "node:assert/strict";
import test from "node:test";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("built-in tool schemas validate with TypeBox metadata", () => {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  const { createTerminalTools } = loader.loadModule("src/lib/tools/terminalTools.ts");
  const bundle = createTerminalTools({ workdir: "/tmp/liveagent-tool-schema-test" });
  const tool = bundle.tools.find((candidate) => candidate.name === "ReadTerminal");

  assert.ok(tool);
  const args = loader.validateToolArguments(tool, {
    type: "toolCall",
    id: "call-terminal",
    name: "ReadTerminal",
    arguments: {
      terminal_id: "terminal-1",
      max_bytes: 8192,
    },
  });

  assert.deepEqual(args, {
    terminal_id: "terminal-1",
    max_bytes: 8192,
  });
});
