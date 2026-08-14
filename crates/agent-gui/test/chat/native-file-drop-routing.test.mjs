import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const routing = loader.loadModule("src/pages/chat/hooks/nativeFileDropRouting.ts");

test("native drop positions convert from physical to logical pixels", () => {
  assert.deepEqual(routing.logicalDropPoint({ x: 480, y: 300 }, 2), { x: 240, y: 150 });
  assert.deepEqual(routing.logicalDropPoint({ x: 90, y: 60 }, 0), { x: 90, y: 60 });
});

test("native drop scaling follows Wry platform coordinate semantics", () => {
  assert.equal(routing.nativeDropPositionScaleFactor("Macintosh; Intel Mac OS X", 2), 1);
  assert.equal(routing.nativeDropPositionScaleFactor("X11; Linux x86_64", 1.5), 1);
  assert.equal(routing.nativeDropPositionScaleFactor("Windows NT 10.0; Win64; x64", 2), 2);
  assert.equal(routing.nativeDropPositionScaleFactor("Windows NT 10.0", 0), 1);
});

test("macOS Retina coordinates hit the workspace without a second scale conversion", () => {
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === routing.FILE_UPLOAD_DROP_ZONE_SELECTOR) return [];
      return [
        {
          getBoundingClientRect() {
            return { left: 100, top: 200, right: 180, bottom: 280 };
          },
        },
      ];
    },
  };
  const scaleFactor = routing.nativeDropPositionScaleFactor("Macintosh; Intel Mac OS X", 2);

  assert.equal(
    routing.resolveNativeFileDropTarget(
      { x: 120, y: 240 },
      { scaleFactor, document: fakeDocument },
    ),
    "workspace",
  );
});

test("workspace drop routing hit-tests the marked sidebar zone", () => {
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === routing.FILE_UPLOAD_DROP_ZONE_SELECTOR) return [];
      return [
        {
          getBoundingClientRect() {
            return { left: 100, top: 80, right: 280, bottom: 180 };
          },
        },
      ];
    },
  };

  assert.equal(
    routing.isWorkspaceFolderDropTarget(
      { x: 400, y: 240 },
      { scaleFactor: 2, document: fakeDocument },
    ),
    true,
  );
});

test("native drop routing ignores unmarked application surfaces", () => {
  const fakeDocument = {
    querySelectorAll: () => [],
  };

  assert.equal(
    routing.resolveNativeFileDropTarget(
      { x: 10, y: 20 },
      { scaleFactor: 1, document: fakeDocument },
    ),
    null,
  );
});

test("native drop routing accepts uploads only inside the marked chat zone", () => {
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === routing.WORKSPACE_FOLDER_DROP_ZONE_SELECTOR) return [];
      return [
        {
          getBoundingClientRect() {
            return { left: 300, top: 120, right: 760, bottom: 240 };
          },
        },
      ];
    },
  };

  assert.equal(
    routing.resolveNativeFileDropTarget(
      { x: 320, y: 180 },
      { scaleFactor: 1, document: fakeDocument },
    ),
    "upload",
  );
});

test("workspace drop routing falls back to stable zone rectangles", () => {
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === routing.FILE_UPLOAD_DROP_ZONE_SELECTOR) return [];
      assert.equal(selector, routing.WORKSPACE_FOLDER_DROP_ZONE_SELECTOR);
      return [
        {
          getBoundingClientRect() {
            return { left: 12, top: 80, right: 280, bottom: 360 };
          },
        },
      ];
    },
  };

  assert.equal(
    routing.resolveNativeFileDropTarget(
      { x: 400, y: 400 },
      { scaleFactor: 2, document: fakeDocument },
    ),
    "workspace",
  );
  assert.equal(
    routing.resolveNativeFileDropTarget(
      { x: 700, y: 400 },
      { scaleFactor: 2, document: fakeDocument },
    ),
    null,
  );
});

test("workspace rectangle fallback joins the header and project list into one drop box", () => {
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === routing.FILE_UPLOAD_DROP_ZONE_SELECTOR) return [];
      return [
        {
          getBoundingClientRect() {
            return { left: 12, top: 80, right: 280, bottom: 120 };
          },
        },
        {
          getBoundingClientRect() {
            return { left: 12, top: 128, right: 280, bottom: 360 };
          },
        },
      ];
    },
  };

  assert.equal(
    routing.resolveNativeFileDropTarget(
      { x: 100, y: 124 },
      { scaleFactor: 1, document: fakeDocument },
    ),
    "workspace",
  );
});

test("upload rectangle fallback does not widen beyond the chat zone", () => {
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === routing.WORKSPACE_FOLDER_DROP_ZONE_SELECTOR) return [];
      assert.equal(selector, routing.FILE_UPLOAD_DROP_ZONE_SELECTOR);
      return [
        {
          getBoundingClientRect() {
            return { left: 300, top: 60, right: 900, bottom: 700 };
          },
        },
      ];
    },
  };

  assert.equal(
    routing.resolveNativeFileDropTarget(
      { x: 299, y: 100 },
      { scaleFactor: 1, document: fakeDocument },
    ),
    null,
  );
  assert.equal(
    routing.resolveNativeFileDropTarget(
      { x: 300, y: 100 },
      { scaleFactor: 0.5, document: fakeDocument },
    ),
    "upload",
  );
});

test("native upload marker covers the desktop chat panel instead of only the composer", () => {
  const chatPage = readFileSync("src/pages/ChatPage.tsx", "utf8");
  const composer = readFileSync("../agent-ui/src/pages/chat/ChatComposerBar.tsx", "utf8");

  assert.match(chatPage, /data-file-upload-drop-zone/);
  assert.doesNotMatch(composer, /data-file-upload-drop-zone/);
});
