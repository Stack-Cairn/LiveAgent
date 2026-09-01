// crates/agent-gui/test/chat/clarify-panel-scroll.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);
const loader = createTsModuleLoader({ mocks: {} });
const scroll = loader.loadModule(
  abs("../agent-ui/src/components/chat/clarify/clarifyPanelScroll.ts"),
);
const panelSource = readFileSync(
  abs("../agent-ui/src/components/chat/clarify/ClarifyPanel.tsx"),
  "utf8",
);

test("pinClarifyListIfFollowing writes scrollTop to the end while following", () => {
  const box = { scrollTop: 0, clientHeight: 120, scrollHeight: 400 };
  scroll.pinClarifyListIfFollowing(box, true);
  assert.equal(box.scrollTop, 400);
});

test("pinClarifyListIfFollowing leaves a detached reader in place", () => {
  const box = { scrollTop: 24, clientHeight: 120, scrollHeight: 400 };
  scroll.pinClarifyListIfFollowing(box, false);
  assert.equal(box.scrollTop, 24);
});

test("isClarifyListFollowing treats the physical clamp as following", () => {
  assert.equal(
    scroll.isClarifyListFollowing({ scrollTop: 280, clientHeight: 120, scrollHeight: 400 }),
    true,
  );
  assert.equal(
    scroll.isClarifyListFollowing({ scrollTop: 0, clientHeight: 120, scrollHeight: 400 }),
    false,
  );
});

test("clarify panel pins the message list on new turns and streaming growth", () => {
  assert.match(panelSource, /pinClarifyListIfFollowing/);
  assert.match(panelSource, /isClarifyListFollowing/);
  assert.match(panelSource, /useLayoutEffect/);
  assert.match(panelSource, /ResizeObserver/);
  assert.match(panelSource, /firstElementChild/);
  assert.match(panelSource, /overflow-y-auto/);
  assert.match(panelSource, /\[overflow-anchor:none\]/);
  assert.match(panelSource, /data-clarify-messages[\s\S]*min-h-0[\s\S]*overflow-y-auto/);
});
