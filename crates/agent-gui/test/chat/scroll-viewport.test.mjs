import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const modulePath = path.join(rootDir, "src/pages/chat/chatScrollViewport.ts");
const {
  CHAT_SCROLL_VIEWPORT_SELECTOR,
  resolveNearestScrollViewport,
  resolveScrollViewport,
} = createTsModuleLoader({ rootDir }).loadModule(modulePath);

test("chat scroll viewport resolver targets the Base UI viewport marker first", () => {
  assert.match(CHAT_SCROLL_VIEWPORT_SELECTOR, /\[data-scroll-viewport\]/);

  const viewport = { id: "base-ui-viewport" };
  const root = {
    querySelector(selector) {
      assert.equal(selector, CHAT_SCROLL_VIEWPORT_SELECTOR);
      return viewport;
    },
  };

  assert.equal(resolveScrollViewport(root), viewport);
});

test("chat scroll viewport resolver keeps the previous Radix marker as fallback", () => {
  assert.match(CHAT_SCROLL_VIEWPORT_SELECTOR, /\[data-radix-scroll-area-viewport\]/);

  const viewport = { id: "radix-viewport" };
  const element = {
    closest(selector) {
      assert.equal(selector, CHAT_SCROLL_VIEWPORT_SELECTOR);
      return viewport;
    },
  };

  assert.equal(resolveNearestScrollViewport(element), viewport);
});
