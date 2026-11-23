import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// The find bar floats over the top of the transcript. A match behind it is not on
// screen: the transcript scrolls it into the part of the viewport below the bar.

const VIEWPORT = { top: 0, bottom: 600 };
const BAR = { top: 8, bottom: 44 };

function rect({ top, bottom }) {
  return { top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top };
}

async function scrollAfterFind(matchTop) {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/i18n/index": {
        useLocale: () => ({ t: (key) => key, locale: "en" }),
      },
    },
  });
  const { React, act, createRoot } = env;
  const { useTranscriptFind } = env.loadModule(
    "@liveagent/ui/lib/transcript-find/useTranscriptFind.ts",
  );
  const { createTranscriptFindSource } = env.loadModule(
    "@liveagent/ui/lib/transcript-find/transcriptFindSource.ts",
  );
  const { TranscriptFindBar } = env.loadModule("@liveagent/ui/components/chat/TranscriptFindBar.tsx");

  const source = createTranscriptFindSource();
  source.publish(() => [{ rowKey: "r1", text: "the needle is here" }]);
  let scrollTop = 1000;
  let viewportElement = null;
  const elementRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === viewportElement) return rect(VIEWPORT);
    if (this.matches("[data-transcript-find]")) return rect(BAR);
    return rect({ top: 0, bottom: 0 });
  };
  window.Range.prototype.getBoundingClientRect = () => rect({ top: matchTop, bottom: matchTop + 16 });

  let openFind = null;
  function Harness() {
    const [root, setRoot] = React.useState(null);
    const [viewport, setViewport] = React.useState(null);
    const find = useTranscriptFind({
      root,
      scrollViewport: viewport,
      source,
      scrollToRowKey: () => {},
      isMac: false,
    });
    openFind = find.openFind;
    const viewportRef = React.useCallback((element) => {
      viewportElement = element;
      if (element) {
        Object.defineProperty(element, "scrollTop", {
          configurable: true,
          get: () => scrollTop,
          set: (value) => {
            scrollTop = value;
          },
        });
      }
      setViewport(element);
    }, []);
    return React.createElement(
      "div",
      { ref: setRoot },
      React.createElement(
        "div",
        { ref: viewportRef },
        React.createElement("div", { "data-row-key": "r1" }, "the needle is here"),
      ),
      React.createElement(TranscriptFindBar, { find }),
    );
  }

  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => openFind());
    const input = document.querySelector("[data-transcript-find] input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "needle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    return scrollTop;
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.HTMLElement.prototype.getBoundingClientRect = elementRect;
    delete window.Range.prototype.getBoundingClientRect;
    env.cleanup();
  }
}

test("a match behind the find bar scrolls into the area below it", async () => {
  const after = await scrollAfterFind(20);
  assert.notEqual(after, 1000, "the hidden match is not treated as on screen");
  // The match lands a third of the way down the area the bar leaves visible.
  const visibleTop = BAR.bottom;
  const expectedTop = visibleTop + (VIEWPORT.bottom - visibleTop) / 3;
  assert.equal(Math.round(after), Math.round(1000 + 20 - expectedTop));
});

test("a match below the find bar stays where it is", async () => {
  assert.equal(await scrollAfterFind(200), 1000);
});
