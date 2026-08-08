import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

function Loader2(props) {
  return { type: "Loader2", props };
}

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
  mocks: {
    "@liveagent/app/components/icons": { Loader2 },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
  },
});

const { AssistantStatus } = loader.loadModule("@liveagent/ui/components/chat/AssistantStatus");

test("assistant running status keeps its spinner animated", () => {
  const status = AssistantStatus({ children: "Vibing" });
  const icon = status.props.children[0];
  const text = status.props.children[1];

  assert.equal(icon.type, Loader2);
  assert.match(icon.props.className, /(?:^|\s)animate-spin(?:\s|$)/);
  assert.doesNotMatch(icon.props.className, /(?:^|\s)motion-reduce:animate-none(?:\s|$)/);
  assert.match(status.props.className, /(?:^|\s)min-w-0(?:\s|$)/);
  assert.match(status.props.className, /(?:^|\s)max-w-full(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)truncate(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)whitespace-nowrap(?:\s|$)/);
});
