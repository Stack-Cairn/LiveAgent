import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { LazyCollapse } = env.loadModule("@liveagent/ui/components/chat/LazyCollapse.tsx");

function renderCollapse(root, { open, retainWhileClosed = false }) {
  act(() => {
    root.render(
      React.createElement(
        LazyCollapse,
        { open, retainWhileClosed },
        () => React.createElement("div", { "data-heavy-body": "" }, "Heavy body"),
      ),
    );
  });
}

async function waitForCollapseAnimation() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 240));
  });
}

test("collapse animates in both directions and releases settled content afterward", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderCollapse(root, { open: false, retainWhileClosed: true });
  assert.equal(container.querySelector("[data-heavy-body]"), null);

  renderCollapse(root, { open: true });
  assert.match(container.firstElementChild.className, /grid-rows-\[1fr\]/);
  assert.match(container.firstElementChild.className, /\bh-min\b/);
  assert.match(container.firstElementChild.className, /\bcontent-start\b/);
  assert.match(
    container.querySelector("[data-lazy-collapse-content]").className,
    /opacity-100/,
  );

  renderCollapse(root, { open: false });
  assert.match(container.firstElementChild.className, /grid-rows-\[0fr\]/);
  assert.match(
    container.querySelector("[data-lazy-collapse-content]").className,
    /opacity-0/,
  );
  assert.notEqual(container.querySelector("[data-heavy-body]"), null);

  await waitForCollapseAnimation();
  assert.equal(container.querySelector("[data-heavy-body]"), null);

  act(() => root.unmount());
});

test("active content remains mounted after the close animation", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderCollapse(root, { open: true, retainWhileClosed: true });
  renderCollapse(root, { open: false, retainWhileClosed: true });
  await waitForCollapseAnimation();
  assert.notEqual(container.querySelector("[data-heavy-body]"), null);

  renderCollapse(root, { open: false, retainWhileClosed: false });
  await waitForCollapseAnimation();
  assert.equal(container.querySelector("[data-heavy-body]"), null);

  act(() => root.unmount());
});

test.after(() => env.cleanup());
