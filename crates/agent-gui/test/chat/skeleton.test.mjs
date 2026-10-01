import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { Skeleton } = env.loadModule("@liveagent/ui/components/ui/skeleton.tsx");

test("skeleton supports inline markup and forwards accessibility attributes and refs", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const ref = React.createRef();
  try {
    await act(async () => root.render(
      React.createElement("p", null, React.createElement(Skeleton, {
        render: React.createElement("span"),
        ref,
        "aria-hidden": true,
        "data-liveagent-markdown-image": "loading",
        className: "inline-block h-4 w-20",
      })),
    ));
    const skeleton = host.querySelector('[data-slot="skeleton"]');
    assert.equal(skeleton.tagName, "SPAN");
    assert.equal(skeleton.parentElement.tagName, "P");
    assert.equal(skeleton.getAttribute("aria-hidden"), "true");
    assert.equal(skeleton.dataset.liveagentMarkdownImage, "loading");
    assert.equal(ref.current, skeleton);
    await act(async () => root.render(React.createElement(Skeleton, { className: "animate-none" })));
    const staticSkeleton = host.querySelector('[data-slot="skeleton"]');
    assert.equal(staticSkeleton.tagName, "DIV");
    assert.equal(staticSkeleton.classList.contains("animate-none"), true);
    assert.equal(staticSkeleton.classList.contains("animate-pulse"), false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
