import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);

test("built-in tool schemas use pi-compatible typebox metadata", () => {
  const loader = createTsModuleLoader({
    mocks: {
      typebox,
    },
  });
  const { createTerminalTools } = loader.loadModule(coreSrc("tools/terminalTools.ts"));
  const bundle = createTerminalTools({ workdir: "/tmp/liveagent-tool-schema-test" });
  const tool = bundle.tools.find((candidate) => candidate.name === "ReadTerminal");

  assert.ok(tool);
  const args = validateToolArguments(tool, {
    type: "toolCall",
    id: "call-terminal",
    name: "ReadTerminal",
    arguments: {
      terminal_id: "terminal-1",
      max_bytes: "8192",
    },
  });

  assert.deepEqual(args, {
    terminal_id: "terminal-1",
    max_bytes: 8192,
  });
});
