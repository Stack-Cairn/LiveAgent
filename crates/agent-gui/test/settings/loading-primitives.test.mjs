import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("loading surfaces preserve the host div, children, attributes, ref and event handlers", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { Skeleton } = env.loadModule("@liveagent/ui/components/ui/skeleton.tsx");
  const { LoadingSurface, LoadingTrack } = env.loadModule("@liveagent/ui/components/hub/HubLoading.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const [Component, variant] of [[Skeleton, "shimmer"], [Skeleton, "pulse"], [LoadingSurface, "hero"], [LoadingSurface, "skeleton"], [LoadingTrack, undefined]]) {
      const ref = React.createRef();
      let clicks = 0;
      await act(async () => root.render(React.createElement(Component, {
        variant, ref, className: "h-24 opacity-70", role: "status", "aria-busy": true,
        "data-owner": "loading-test", style: { minHeight: 42 }, onClick: () => clicks++,
      }, React.createElement("span", null, "Loading"))));
      const node = container.firstElementChild;
      assert.equal(container.children.length, 1);
      assert.equal(node.tagName, "DIV");
      assert.equal(ref.current, node);
      assert.equal(node.getAttribute("role"), "status");
      assert.equal(node.getAttribute("aria-busy"), "true");
      assert.equal(node.dataset.owner, "loading-test");
      assert.equal(node.style.minHeight, "42px");
      assert.equal(node.children.length, 1);
      assert.equal(node.firstElementChild.tagName, "SPAN");
      assert.equal(node.textContent, "Loading");
      assert.equal(node.hasAttribute("variant"), false);
      assert.ok(node.classList.contains("h-24"));
      assert.ok(node.classList.contains("opacity-70"));
      await act(async () => node.click());
      assert.equal(clicks, 1);
    }
  } finally {
    await act(async () => root.unmount());
    env.cleanup();
  }
});
