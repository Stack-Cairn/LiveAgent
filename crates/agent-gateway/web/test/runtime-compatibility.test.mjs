import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const { CHAT_RUNTIME_PROTOCOL_INCOMPATIBLE, isChatRuntimeProtocolIncompatible } =
  loader.loadModule("src/lib/chat/runtimeCompatibility.ts");

test("chat runtime marks only an online incompatible desktop as protocol incompatible", () => {
  assert.equal(CHAT_RUNTIME_PROTOCOL_INCOMPATIBLE, "protocol_incompatible");
  assert.equal(
    isChatRuntimeProtocolIncompatible({ online: true, runtime_state: "protocol_incompatible" }),
    true,
  );
  assert.equal(
    isChatRuntimeProtocolIncompatible({ online: false, runtime_state: "protocol_incompatible" }),
    false,
  );
  assert.equal(isChatRuntimeProtocolIncompatible({ online: true, runtime_state: "ready" }), false);
  assert.equal(isChatRuntimeProtocolIncompatible(null), false);
});
