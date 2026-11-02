import { createRequire } from "node:module";
import { createWebModuleLoader } from "./load-web-module.mjs";

const requireFromWeb = createRequire(new URL("../../web/package.json", import.meta.url));

export async function createWebDomTestEnv(options = {}) {
  const { JSDOM } = requireFromWeb("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  dom.window.scrollTo = () => {};
  const { window } = dom;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    CustomEvent: window.CustomEvent,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent ?? window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    SVGElement: window.SVGElement,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }

  const React = requireFromWeb("react");
  const ReactDOMClient = requireFromWeb("react-dom/client");
  const loader = createWebModuleLoader({
    ...options,
    mocks: {
      react: React,
      "react/jsx-runtime": requireFromWeb("react/jsx-runtime"),
      "react-dom": requireFromWeb("react-dom"),
      "react-dom/client": ReactDOMClient,
      ...(options.mocks ?? {}),
    },
  });
  return {
    dom,
    React,
    act: React.act,
    createRoot: ReactDOMClient.createRoot,
    loadModule: loader.loadModule,
    cleanup() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      window.close();
    },
  };
}
