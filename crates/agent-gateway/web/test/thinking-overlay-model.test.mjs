import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({ rootDir: fileURLToPath(new URL("../", import.meta.url)) });
const { resolveThinkingOverlayPlacement } = loader.loadModule(
  "@liveagent/ui/lib/chat/thinkingOverlayModel.ts",
);
const componentSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/chat/ThinkingActivity.tsx", import.meta.url),
  "utf8",
);

test("thinking overlay placement is upward and narrow-safe", () => {
  const above = resolveThinkingOverlayPlacement(
    { left: 200, right: 700, top: 500, bottom: 532, width: 500, height: 32 },
    { width: 1200, height: 800 },
  );
  assert.equal(above.side, "above");
  const narrow = resolveThinkingOverlayPlacement(
    { left: 8, right: 312, top: 60, bottom: 92, width: 304, height: 32 },
    { width: 320, height: 480 },
  );
  assert.equal(narrow.width, 296);
});

test("keeps a renderable overlay inside an extremely narrow viewport", () => {
  const placement = resolveThinkingOverlayPlacement(
    { left: 0, right: 8, top: 60, bottom: 92, width: 8, height: 32 },
    { width: 8, height: 480 },
  );
  assert.equal(placement.left, 3.5);
  assert.equal(placement.width, 1);
  assert.ok(placement.left + placement.width <= 8);
});

test("thinking details use a portal overlay instead of inline collapse", () => {
  assert.match(componentSource, /createPortal/);
  assert.match(componentSource, /role="dialog"/);
  assert.match(componentSource, /className="fixed/);
  assert.doesNotMatch(componentSource, /LazyCollapse/);
});
