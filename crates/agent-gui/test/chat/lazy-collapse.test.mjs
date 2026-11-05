import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

test("collapse animates in both directions and releases settled content afterward", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderCollapse(root, { open: false, retainWhileClosed: true });
  assert.equal(container.querySelector("[data-heavy-body]"), null);

  renderCollapse(root, { open: true });
  assert.match(container.firstElementChild.className, /\bh-min\b/);
  assert.notEqual(container.querySelector("[data-lazy-collapse-content]"), null);
  assert.notEqual(container.querySelector("[data-heavy-body]"), null);

  renderCollapse(root, { open: false });
  assert.match(container.firstElementChild.className, /pointer-events-none/);
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

function renderBody(root, { open, retainWhileClosed = true, text, onShellRender }) {
  act(() => {
    root.render(
      React.createElement(LazyCollapse, { open, retainWhileClosed }, () => {
        return React.createElement("div", { "data-heavy-body": "" }, text);
      }),
    );
  });
  onShellRender?.();
}

test("an open body takes new children without re-rendering the motion shell", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const presenceContexts = new Set();
  const uiRequire = createRequire(new URL("../../../agent-ui/package.json", import.meta.url));
  const { PresenceContext } = env.loadModule(uiRequire.resolve("motion/react"));
  function Probe() {
    presenceContexts.add(React.useContext(PresenceContext));
    return null;
  }
  const renderWithProbe = (text) =>
    act(() => {
      root.render(
        React.createElement(LazyCollapse, { open: true }, () =>
          React.createElement(
            "div",
            { "data-heavy-body": "" },
            text,
            React.createElement(Probe),
          ),
        ),
      );
    });

  renderWithProbe("first");
  renderWithProbe("second");
  renderWithProbe("third");
  assert.equal(container.querySelector("[data-heavy-body]").textContent, "third");
  // A re-rendered presence child (and LazyMotion) hands its context a new
  // object, which makes React walk the whole body subtree for consumers on
  // every parent render.
  assert.equal(presenceContexts.size, 1, "the motion context value must stay the same object");
  act(() => root.unmount());
});

test("a closed retained body stays frozen and shows fresh children on reopen", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  renderBody(root, { open: true, text: "live 1" });
  renderBody(root, { open: false, text: "live 2" });
  await waitForCollapseAnimation();
  assert.equal(container.querySelector("[data-heavy-body]").textContent, "live 1");
  renderBody(root, { open: true, text: "live 3" });
  assert.equal(container.querySelector("[data-heavy-body]").textContent, "live 3");
  renderBody(root, { open: true, text: "live 4" });
  assert.equal(container.querySelector("[data-heavy-body]").textContent, "live 4");
  act(() => root.unmount());
});
