import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function Loader2(props) {
  return { type: "Loader2", props };
}

const loader = createTsModuleLoader({
  rootDir: fileURLToPath(new URL("../../", import.meta.url)),
  mocks: {
    "@liveagent/ui/components/IconSet": { Loader2 },
  },
});

const { AssistantStatus } = loader.loadModule("@liveagent/ui/components/chat/AssistantStatus");

test("assistant running status respects reduced motion on desktop", () => {
  const status = AssistantStatus({ children: "Vibing" });
  const icon = status.props.children[0];
  const text = status.props.children[1];

  assert.equal(icon.type, Loader2);
  assert.match(icon.props.className, /(?:^|\s)animate-spin(?:\s|$)/);
  assert.match(icon.props.className, /(?:^|\s)motion-reduce:animate-none(?:\s|$)/);
  assert.match(status.props.className, /(?:^|\s)min-w-0(?:\s|$)/);
  assert.match(status.props.className, /(?:^|\s)max-w-full(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)truncate(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)whitespace-nowrap(?:\s|$)/);
});
