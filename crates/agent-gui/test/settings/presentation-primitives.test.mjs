import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("presentation primitives keep native elements, props, refs and events", async () => {
  const env = await createDomTestEnv(),
    { React, act, createRoot } = env;
  const { EmptyState } = env.loadModule("@liveagent/ui/components/ui/empty-state.tsx"),
    { StepMarker } = env.loadModule("@liveagent/ui/components/settings/StepMarker.tsx"),
    { ChoiceCard } = env.loadModule("@liveagent/ui/components/settings/ChoiceCard.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const [Component, tag, variant] of [
      [EmptyState, "DIV", "workspace"],
      [EmptyState, "DIV", "settings"],
      [StepMarker, "DIV"],
      [ChoiceCard, "BUTTON"],
    ]) {
      let clicks = 0;
      const ref = React.createRef();
      await act(async () =>
        root.render(
          React.createElement(
            Component,
            {
              ref,
              variant,
              className: "p-2",
              type: tag === "BUTTON" ? "button" : undefined,
              "aria-label": "example",
              onClick: () => clicks++,
            },
            "Content",
          ),
        ),
      );
      const node = container.firstElementChild;
      assert.equal(node.tagName, tag);
      assert.equal(ref.current, node);
      assert.equal(node.textContent, "Content");
      assert.equal(node.getAttribute("aria-label"), "example");
      assert.equal(node.hasAttribute("variant"), false);
      assert.ok(node.classList.contains("p-2"));
      await act(async () => node.click());
      assert.equal(clicks, 1);
      if (tag === "BUTTON") {
        await act(async () =>
          root.render(
            React.createElement(
              Component,
              { disabled: true, type: "button", onClick: () => clicks++ },
              "Disabled",
            ),
          ),
        );
        container.firstElementChild.click();
        assert.equal(clicks, 1);
      }
    }
  } finally {
    await act(async () => root.unmount());
    env.cleanup();
  }
});

test("filter tabs preserve selection, disabled behavior and count badge dimensions", async () => {
  const env = await createDomTestEnv(),
    { React, act, createRoot } = env;
  const { Tabs, TabsList, TabsTrigger } = env.loadModule("@liveagent/ui/components/ui/tabs.tsx"),
    { Badge } = env.loadModule("@liveagent/ui/components/ui/badge.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changes = [];
  try {
    await act(async () =>
      root.render(
        React.createElement(
          Tabs,
          { defaultValue: "a", onValueChange: (v) => changes.push(v) },
          React.createElement(
            TabsList,
            { variant: "filter", "aria-label": "Sources" },
            ...["a", "b", "c"].map((value) =>
              React.createElement(
                TabsTrigger,
                { key: value, value, disabled: value === "c" },
                value,
                React.createElement(Badge, { variant: "muted", size: "filter-count" }, "2"),
              ),
            ),
          ),
        ),
      ),
    );
    const tabs = container.querySelectorAll('[role="tab"]');
    assert.equal(tabs[0].getAttribute("aria-selected"), "true");
    await act(async () => tabs[1].click());
    assert.equal(tabs[1].getAttribute("aria-selected"), "true");
    assert.deepEqual(changes, ["b"]);
    await act(async () => tabs[2].click());
    assert.deepEqual(changes, ["b"]);
    assert.equal(tabs[2].getAttribute("aria-disabled"), "true");
    const list = container.querySelector('[role="tablist"]');
    assert.equal(list.hasAttribute("variant"), false);
    assert.ok(list.classList.contains("overflow-x-auto"));
    const badge = tabs[0].querySelector("span");
    assert.ok(badge.classList.contains("h-4"));
    assert.ok(badge.classList.contains("min-w-4"));
    assert.ok(badge.classList.contains("rounded-full"));
    assert.equal(badge.hasAttribute("size"), false);
  } finally {
    await act(async () => root.unmount());
    env.cleanup();
  }
});

test("compact badges retain icon content, tooltip and native span contract", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { Badge } = env.loadModule("@liveagent/ui/components/ui/badge.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const variant of ["success", "destructive", "muted"]) {
      const ref = React.createRef();
      await act(async () => root.render(React.createElement(Badge,
        { ref, size: "compact", variant, title: "Full status detail" },
        React.createElement("svg", { "aria-hidden": true }), "Status")));
      const badge = container.firstElementChild;
      assert.equal(badge.tagName, "SPAN");
      assert.equal(ref.current, badge);
      assert.equal(badge.title, "Full status detail");
      assert.equal(badge.textContent, "Status");
      assert.ok(badge.querySelector("svg"));
      assert.equal(badge.hasAttribute("size"), false);
      assert.equal(badge.hasAttribute("variant"), false);
      assert.equal(badge.hasAttribute("role"), false);
      assert.ok(badge.classList.contains("text-tiny"));
      assert.equal(badge.classList.contains("text-xs"), false);
      assert.ok(badge.classList.contains("border-0"));
      assert.ok(badge.classList.contains("leading-none"));
    }
    await act(async () => root.render(React.createElement(Badge, { variant: "success" }, "Default")));
    assert.ok(container.firstElementChild.classList.contains("text-xs"));
    assert.ok(container.firstElementChild.classList.contains("border"));
    assert.equal(container.firstElementChild.classList.contains("border-0"), false);
  } finally {
    await act(async () => root.unmount());
    env.cleanup();
  }
});

test("compact settings empty states preserve consumer layout and leave other defaults unchanged", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { EmptyState } = env.loadModule("@liveagent/ui/components/ui/empty-state.tsx");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    for (const className of [undefined, "block"]) {
      await act(async () => root.render(React.createElement(EmptyState,
        { variant: "settings", size: "compact", className },
        React.createElement("p", null, "No items"))));
      const node = host.firstElementChild;
      assert.equal(node.tagName, "DIV");
      assert.equal(node.hasAttribute("size"), false);
      assert.equal(node.hasAttribute("role"), false);
      assert.equal(node.textContent, "No items");
      assert.ok(node.classList.contains("py-8"));
      assert.equal(node.classList.contains("py-10"), false);
      assert.ok(node.classList.contains("gap-3"));
      assert.equal(node.classList.contains("flex"), !className);
    }
    await act(async () => root.render(React.createElement(EmptyState, { variant: "settings" })));
    assert.ok(host.firstElementChild.classList.contains("py-10"));
    assert.ok(host.firstElementChild.classList.contains("gap-4"));
    await act(async () => root.render(React.createElement(EmptyState, { variant: "workspace", size: "compact" })));
    assert.ok(host.firstElementChild.classList.contains("p-6"));
    assert.equal(host.firstElementChild.classList.contains("py-8"), false);
  } finally {
    await act(async () => root.unmount());
    env.cleanup();
  }
});
