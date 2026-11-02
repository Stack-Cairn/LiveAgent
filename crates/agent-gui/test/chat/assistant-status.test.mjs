import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  rootDir: fileURLToPath(new URL("../../", import.meta.url)),
});

const { AssistantStatus } = loader.loadModule("@liveagent/ui/components/chat/AssistantStatus");

test("assistant running status renders a spinning icon before one text label", () => {
  const status = AssistantStatus({ children: "Vibing", iconClassName: "size-3" });
  const [icon, text] = status.props.children;

  assert.match(icon.props.className, /(?:^|\s)animate-spin(?:\s|$)/);
  assert.match(icon.props.className, /(?:^|\s)motion-reduce:animate-none(?:\s|$)/);
  assert.match(icon.props.className, /(?:^|\s)size-3(?:\s|$)/);
  assert.equal(icon.props["aria-hidden"], "true");
  assert.equal(text.type, "span");
  assert.equal(text.props.children, "Vibing");
  assert.match(status.props.className, /(?:^|\s)min-w-0(?:\s|$)/);
  assert.match(status.props.className, /(?:^|\s)max-w-full(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)truncate(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)whitespace-nowrap(?:\s|$)/);
});
