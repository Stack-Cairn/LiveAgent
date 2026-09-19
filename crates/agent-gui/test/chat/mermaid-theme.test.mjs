import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as streamdown from "../../node_modules/streamdown/dist/index.js";
import remarkBreaks from "../../node_modules/remark-breaks/index.js";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const renders = [];
let deferRenders = false;
const mermaid = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid(config) {
    return {
      render(id, chart) {
        const theme = config?.theme ?? "default";
        const result = {
          svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" data-theme="${theme}"><text>${theme}</text></svg>`,
        };
        const job = { id, chart, theme };
        renders.push(job);
        return deferRenders
          ? new Promise((resolve) => { job.complete = () => resolve(result); })
          : Promise.resolve(result);
      },
    };
  },
};

const env = await createDomTestEnv({ mocks: {
  streamdown,
  "remark-breaks": { __esModule: true, default: remarkBreaks },
  "@streamdown/mermaid": { mermaid },
  "@streamdown/code": { code: undefined },
  "@streamdown/math": { math: undefined },
  "@streamdown/cjk": { cjk: undefined },
  "@liveagent/app/shims/tauriOpener": { openUrl() {} },
  "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
} });
const { React, act, createRoot } = env;
const { Markdown } = env.loadModule("@liveagent/ui/components/Markdown.tsx");
const { MermaidFullscreenButton } = env.loadModule("@liveagent/ui/components/MarkdownMermaidFullscreen.tsx");
const previousParser = globalThis.DOMParser;
const previousIntersectionObserver = globalThis.IntersectionObserver;
globalThis.DOMParser = window.DOMParser;
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.callback([{ target, isIntersecting: true }]); }
  takeRecords() { return []; }
  disconnect() {}
};
after(() => {
  globalThis.DOMParser = previousParser;
  globalThis.IntersectionObserver = previousIntersectionObserver;
  env.cleanup();
});

async function mount(component) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(React.StrictMode, null, component)));
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  assert.ok(predicate(), "Expected Mermaid render to complete");
}

async function setDark(dark) {
  await act(async () => { document.documentElement.classList.toggle("dark", dark); });
}

const chart = "flowchart LR\n  A[Input] --> B{Validate}\n  B --> C[Done]";
const inlineSvg = () => document.querySelector('[data-streamdown="mermaid"] svg[data-theme]');
const fullscreen = () => document.querySelector('[data-liveagent-mermaid-fullscreen]');

for (const props of [{ renderMode: "static" }, { renderMode: "streaming" }, { readOnly: true }]) {
  test(`mounted Markdown follows the effective html theme: ${JSON.stringify(props)}`, async () => {
    await setDark(true);
    const cleanup = await mount(React.createElement(Markdown, {
      content: `Stable paragraph\n\n\`\`\`mermaid\n${chart}\n\`\`\``,
      ...props,
    }));
    try {
      await eventually(() => inlineSvg()?.dataset.theme === "dark");
      const paragraph = document.querySelector("p");
      const darkSvg = inlineSvg();
      await setDark(false);
      await eventually(() => inlineSvg()?.dataset.theme === "default");
      assert.notEqual(inlineSvg(), darkSvg);
      assert.equal(document.querySelector("p"), paragraph, "Other Markdown must not remount");
      await setDark(true);
      await eventually(() => inlineSvg()?.dataset.theme === "dark");
      const count = renders.length;
      await act(async () => { document.documentElement.classList.toggle("unrelated-class"); });
      assert.equal(renders.length, count, "Unrelated html classes must not redraw diagrams");
    } finally { await cleanup(); }
  });
}

test("theme changes preserve expanded code blocks and an open fullscreen dialog", async () => {
  await setDark(false);
  const longCode = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
  const cleanup = await mount(React.createElement(Markdown, {
    content: `\`\`\`text\n${longCode}\n\`\`\`\n\n\`\`\`mermaid\n${chart}\n\`\`\``,
  }));
  try {
    await eventually(() => inlineSvg()?.dataset.theme === "default");
    await act(async () => [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("chat.markdown.expandCode")).click());
    assert.equal(document.querySelector('[data-liveagent-code-preview="collapsed"]'), null);
    await act(async () => document.querySelector('[aria-label="chat.imageViewer.fullscreen"]').click());
    await eventually(() => fullscreen()?.querySelector("svg[data-theme]")?.dataset.theme === "default");
    const dialog = fullscreen();
    await setDark(true);
    await eventually(() => inlineSvg()?.dataset.theme === "dark" &&
      fullscreen()?.querySelector("svg[data-theme]")?.dataset.theme === "dark");
    assert.equal(fullscreen(), dialog);
    assert.equal(document.querySelector('[data-liveagent-code-preview="collapsed"]'), null);
    await setDark(false);
    await eventually(() => inlineSvg()?.dataset.theme === "default" &&
      fullscreen()?.querySelector("svg[data-theme]")?.dataset.theme === "default");
  } finally { await cleanup(); }
});

test("fullscreen initializes its theme even before any inline diagram renders", async () => {
  await setDark(true);
  const cleanup = await mount(React.createElement(MermaidFullscreenButton, { chart }));
  try {
    await act(async () => document.querySelector("button").click());
    await eventually(() => fullscreen()?.querySelector("svg[data-theme]")?.dataset.theme === "dark");
    assert.equal(inlineSvg(), null);
  } finally { await cleanup(); }
});

test("late old-theme renders cannot replace the new inline or fullscreen SVG", async () => {
  await setDark(false);
  renders.length = 0;
  deferRenders = true;
  const cleanup = await mount(React.createElement(Markdown, {
    content: `\`\`\`mermaid\n${chart}\n\`\`\``,
  }));
  try {
    await eventually(() => renders.some((job) => !job.id.includes("fullscreen")));
    await act(async () => document.querySelector('[aria-label="chat.imageViewer.fullscreen"]').click());
    await eventually(() => renders.some((job) => job.id.includes("fullscreen")));
    const oldJobs = [...renders];
    await setDark(true);
    await eventually(() => renders.some((job) => job.theme === "dark" && !job.id.includes("fullscreen")));
    await act(async () => { for (const job of renders.filter((job) => job.theme === "dark")) job.complete(); });
    await eventually(() => inlineSvg()?.dataset.theme === "dark" &&
      fullscreen()?.querySelector("svg[data-theme]")?.dataset.theme === "dark");
    await act(async () => { for (const job of oldJobs) job.complete(); });
    assert.equal(inlineSvg().dataset.theme, "dark");
    assert.equal(fullscreen().querySelector("svg[data-theme]").dataset.theme, "dark");
  } finally {
    deferRenders = false;
    await cleanup();
  }
});
