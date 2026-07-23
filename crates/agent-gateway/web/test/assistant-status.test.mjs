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
    "../../../components/icons": { Loader2 },
    "../../../i18n": { useLocale: () => ({ t: (key) => key }) },
    "../../../lib/chat/chatPageHelpers": { VIBING_STATUS: "Vibing" },
  },
});

const { AssistantStatus } = loader.loadModule(
  "src/pages/chat/assistant-bubble/StatusText.tsx",
);

test("assistant running status keeps its spinner animated", () => {
  const status = AssistantStatus({ children: "Vibing" });
  const icon = status.props.children[0];

  assert.equal(icon.type, Loader2);
  assert.match(icon.props.className, /(?:^|\s)animate-spin(?:\s|$)/);
  assert.doesNotMatch(icon.props.className, /(?:^|\s)motion-reduce:animate-none(?:\s|$)/);
});
