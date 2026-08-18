import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { panMermaidViewBox, zoomMermaidViewBox } = loader.loadModule(
  "@liveagent/ui/lib/mermaidViewBox.ts",
);

test("Mermaid viewBox zoom keeps the center and avoids CSS scaling", () => {
  const source = { x: 10, y: 20, width: 200, height: 100 };

  assert.deepEqual(zoomMermaidViewBox(source, 1), source);
  assert.deepEqual(zoomMermaidViewBox(source, 2), {
    x: 60,
    y: 45,
    width: 100,
    height: 50,
  });
});

test("Mermaid viewBox pan converts screen pixels to SVG units", () => {
  assert.deepEqual(
    panMermaidViewBox(
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 20, y: -10 },
      { width: 200, height: 100 },
    ),
    { x: -10, y: 5, width: 100, height: 50 },
  );
});
