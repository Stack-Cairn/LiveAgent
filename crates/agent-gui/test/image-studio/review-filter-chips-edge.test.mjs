import assert from "node:assert/strict";
import test, { before } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { edgeMeasureSkip as skip, measureInEdge } from "../helpers/edge-measure.mjs";

// Real geometry (headless Edge + built CSS): at xl the history column is 17rem (19rem from 2xl) and
// now holds five equal filter chips instead of four. jsdom has no layout engine, so the real
// ResultGallery aside markup is rendered in jsdom and measured in Edge inside a box of the grid
// track width. The grid-template arbitrary values are not in the prebuilt dist CSS, so the track
// width is applied as an inline style; every other class on the aside is the real one.
const target = { id: "m", name: "Studio Model", enabled: true, parameters: [],
  capabilities: { operations: ["generate"], maxCount: 4, maxInputs: 3, supportsCancel: true } };
const failed = { id: "f", projectId: "archive", revision: 1, lastEventSeq: 0, status: "failed",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  request: { projectId: "archive", targetId: "m", prompt: "Prompt f", operation: "generate", count: 1, parameters: {}, inputs: [] },
  targetSnapshot: target, assetIds: [], items: [], usage: null };

async function historyMarkup(locale) {
  const env = await createDomTestEnv({ mocks: {
    "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    "../../components/AppErrorBoundary": { AppErrorBoundary: ({ children }) => children },
    "./AssetLightbox": { AssetLightbox: () => null },
  } });
  const { LocaleContext, useLocaleContextValue } = env.loadModule("@liveagent/ui/i18n");
  const { ImageStudioPage } = env.loadModule("@liveagent/ui/features/image-studio/ImageStudioPage");
  const client = {
    capabilities: async () => ({ supported: true }), listTargets: async () => [target],
    listProjects: async () => ({ items: [{ id: "archive", title: "archive", revision: 1 }] }),
    listJobs: async () => ({ items: [failed] }), getJob: async () => failed,
    subscribe: async () => new Promise(() => {}), readAsset: async () => new Blob(["x"]),
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const Provider = ({ children }) => env.React.createElement(LocaleContext.Provider, { value: useLocaleContextValue(locale) }, children);
  await env.act(async () => root.render(env.React.createElement(Provider, null,
    env.React.createElement(ImageStudioPage, { client, ownerId: "o", backendId: "b", exportDestinations: ["download"] }))));
  for (let i = 0; i < 5; i++) await env.act(() => new Promise((r) => setTimeout(r, 0)));
  const aside = host.querySelector("aside");
  const fieldset = aside.querySelector("fieldset");
  const chips = [...fieldset.querySelectorAll("button")].map((b) => b.textContent);
  const full = aside.outerHTML;
  [...fieldset.querySelectorAll("button")].find((b) => b.getAttribute("aria-pressed") && b.textContent === (locale === "en-US" ? "Verify" : "待核对")).remove();
  const baseline = aside.outerHTML; // the previous four-chip filter row
  await env.act(async () => root.unmount()); host.remove(); env.cleanup();
  return { full, baseline, chips };
}

const MEASURE = `(() => {
  const aside = document.querySelector("aside"), set = aside.querySelector("fieldset");
  const last = [...set.querySelectorAll("button")].at(-1);
  return { fieldsetOverflow: set.scrollWidth - set.clientWidth,
    lastChipClippedPx: Math.max(0, last.getBoundingClientRect().right - aside.getBoundingClientRect().right),
    asideWidth: aside.getBoundingClientRect().width };
})()`;
const CASES = [["zh-CN", 272], ["en-US", 272], ["zh-CN", 304], ["en-US", 304]];
let results = new Map();
const markup = {};
before(async () => {
  if (skip) return;
  for (const locale of ["zh-CN", "en-US"]) markup[locale] = await historyMarkup(locale);
  const pages = CASES.flatMap(([locale, width]) => ["full", "baseline"].map((variant) => ({
    key: `${locale}|${width}|${variant}`, surface: "desktop", width: 1280,
    html: `<div style="width:${width}px;display:flex;flex-direction:column;height:600px">${markup[locale][variant]}</div>` })));
  results = await measureInEdge(pages, MEASURE);
  if (process.env.REVIEW_DEBUG) console.log([...results].map(([k, v]) => `${k} ${JSON.stringify(v)}`).join("\n"), JSON.stringify(Object.fromEntries(Object.entries(markup).map(([k, v]) => [k, v.chips]))));
});

test("five history filter chips fit the 17rem / 19rem history column", { skip }, () => {
  for (const [locale, width] of CASES) {
    const m = results.get(`${locale}|${width}|full`);
    const old = results.get(`${locale}|${width}|baseline`);
    assert.ok(m.fieldsetOverflow <= 0.5 && m.lastChipClippedPx <= 0.5,
      `${locale} @${width}px: five chips ${JSON.stringify(m)} (previous four-chip row: ${JSON.stringify(old)})`);
  }
});
