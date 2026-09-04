import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
  },
});

const { AssistantStatus } = loader.loadModule("@liveagent/ui/components/chat/AssistantStatus");

test("assistant running status renders one compact animated text label", () => {
  const status = AssistantStatus({ children: "Vibing" });
  const text = status.props.children;

  assert.match(status.props.className, /(?:^|\s)min-w-0(?:\s|$)/);
  assert.match(status.props.className, /(?:^|\s)max-w-full(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)shimmer(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)truncate(?:\s|$)/);
  assert.match(text.props.className, /(?:^|\s)whitespace-nowrap(?:\s|$)/);
});
