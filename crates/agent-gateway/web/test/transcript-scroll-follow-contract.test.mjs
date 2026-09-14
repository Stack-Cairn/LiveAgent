import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const gatewayAppSource = fs.readFileSync(
  new URL("../src/app/GatewayApp.tsx", import.meta.url),
  "utf8",
);
const paneHostSource = fs.readFileSync(
  new URL("../src/app/workbench/GatewayConversationPaneHost.tsx", import.meta.url),
  "utf8",
);

// Both transcript surfaces attach to the bottom only at the physical clamp.
// The engine's default 192px reattach zone pinned the viewport on the first
// wheel tick that landed inside it: a 231px visible jump measured with
// test/browser/scroll-follow-probe.html, perceived as the page "snapping"
// while scrolling toward the bottom.
test("the primary transcript follow engine runs without a reattach zone", () => {
  const call = gatewayAppSource.match(/useScrollFollow\(\{[\s\S]*?\}\);/);
  assert.ok(call, "GatewayApp wires the transcript follow engine");
  assert.match(call[0], /viewport:\s*transcriptViewport/);
  assert.match(call[0], /reattachZonePx:\s*0\b/);
});

test("background panes share the follow engine instead of a hand-rolled 48px snap", () => {
  assert.match(
    paneHostSource,
    /import \{ useScrollFollow \} from "@liveagent\/ui\/lib\/chat-scroll\/useScrollFollow";/,
  );
  const call = paneHostSource.match(/useScrollFollow\(\{[\s\S]*?\}\);/);
  assert.ok(call, "the pane host wires the shared engine for non-primary panes");
  assert.match(call[0], /reattachZonePx:\s*0\b/);
  // The old implementation re-attached on position alone (gap < 48px) and
  // wrote scrollTop on every row/revision change while "following".
  assert.doesNotMatch(paneHostSource, /scrollTop\s*=/);
  assert.doesNotMatch(paneHostSource, /nearBottom/);
});
