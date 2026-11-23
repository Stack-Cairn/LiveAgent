// KaTeX is a lazy chunk: Markdown without a formula never loads it, and a reply
// with one shows the source until the chunk is in, then renders the formula in
// place (history replies are static and never re-render on their own).
import assert from "node:assert/strict";
import test from "node:test";
import { math } from "@streamdown/math";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

let mathLoads = 0;
const env = await createDomTestEnv({
  mocks: {
    "@streamdown/math": {
      __esModule: true,
      get math() {
        mathLoads += 1;
        return math;
      },
    },
    "../lib/markdownCodeHighlight": { throttledCodePlugin: undefined },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "./markdown/MarkdownMermaidBlock": { MarkdownMermaidBlock: () => null },
  },
});
const { React, act, createRoot } = env;
const { Markdown } = env.loadModule("@liveagent/ui/components/Markdown.tsx");
const { hasMarkdownMath } = env.loadModule("@liveagent/ui/lib/markdownMath.ts");
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function mount(content, renderMode = "static") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(React.createElement(Markdown, { content, renderMode })));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test("only content with a formula asks for math", async () => {
  assert.equal(hasMarkdownMath("plain *text* and `code`"), false);
  assert.equal(hasMarkdownMath("$$E = mc^2$$"), true);
  const view = mount("plain *text*");
  await settle();
  assert.equal(mathLoads, 0);
  view.unmount();
});

test("a formula shown before math loaded renders once it is in", async () => {
  const view = mount("Energy: $$E = mc^2$$");
  try {
    assert.equal(view.container.querySelector(".katex"), null);
    assert.match(view.container.textContent, /E = mc\^2/, "the source stays readable meanwhile");
    for (let attempt = 0; attempt < 50 && !view.container.querySelector(".katex"); attempt += 1) {
      await settle();
    }
    assert.equal(mathLoads, 1);
    assert.ok(view.container.querySelector(".katex"), "the same mounted reply now shows the formula");
  } finally {
    view.unmount();
  }
});

test("a reply that gains a formula while streaming renders it", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (content) =>
    act(() => root.render(React.createElement(Markdown, { content, renderMode: "streaming" })));
  try {
    render("Energy is ");
    render("Energy is $$E = mc^2$$ for a body at rest.");
    await settle();
    assert.ok(container.querySelector(".katex"));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
