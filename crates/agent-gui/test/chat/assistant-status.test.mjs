import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  rootDir: fileURLToPath(new URL("../../", import.meta.url)),
});

const { AssistantStatus } = loader.loadModule("@liveagent/ui/components/chat/AssistantStatus");

test("assistant running status renders one text-only label", () => {
  const status = AssistantStatus({ children: "Vibing" });
  const text = status.props.children;

  assert.equal(text.type, "span");
  assert.equal(text.props.children, "Vibing");
  assert.match(status.props.className, /(?:^|\s)min-w-0(?:\s|$)/);
  assert.match(status.props.className, /(?:^|\s)max-w-full(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)truncate(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)whitespace-nowrap(?:\s|$)/);
});
