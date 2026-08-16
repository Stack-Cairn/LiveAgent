import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "./helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const viewer = loader.loadModule(
  "@liveagent/ui/components/workspace-editor/workspaceImageViewer.ts",
);

const viewport = { width: 800, height: 600 };
const image = { width: 800, height: 450 };

test("image viewer normalizes rotation and clamps zoom scale", () => {
  assert.equal(viewer.normalizeImageViewerRotation(-90), 270);
  assert.equal(viewer.normalizeImageViewerRotation(450), 90);
  assert.equal(viewer.clampImageViewerScale(-1), 0.25);
  assert.equal(viewer.clampImageViewerScale(9), 4);
});

test("image viewer scales proportionally for buttons and wheel input", () => {
  assert.equal(viewer.imageViewerScaleAfterStep(1, 1), 1.05);
  assert.equal(viewer.imageViewerScaleAfterStep(1, -1), 1 / 1.05);
  assert.equal(viewer.imageViewerScaleAfterStep(0.25, -1), 0.25);
  assert.equal(viewer.imageViewerScaleAfterWheelDelta(1, -100, 0), 1.05);
  assert.equal(viewer.imageViewerScaleAfterWheelDelta(1, 100, 0), 1 / 1.05);
  assert.equal(viewer.imageViewerScaleAfterWheelDelta(1, -6.25, 1), 1.05);
});

test("image viewer copies absolute and workspace-relative paths", () => {
  assert.equal(
    viewer.workspaceImageAbsolutePathForCopy("H:\\Codezone\\LiveAgent", "assets/preview.png"),
    "H:\\Codezone\\LiveAgent\\assets\\preview.png",
  );
  assert.equal(
    viewer.workspaceImageAbsolutePathForCopy("/workspace/liveagent", "assets/preview.png"),
    "/workspace/liveagent/assets/preview.png",
  );
  assert.equal(
    viewer.workspaceImageAbsolutePathForCopy("H:\\Codezone\\LiveAgent", "H:\\images\\preview.png"),
    "H:\\images\\preview.png",
  );
  assert.equal(
    viewer.workspaceImageAbsolutePathForCopy("H:\\Codezone\\LiveAgent", "\\\\server\\share\\preview.png"),
    "\\\\server\\share\\preview.png",
  );
  assert.equal(
    viewer.workspaceImageRelativePathForCopy("H:\\Codezone\\LiveAgent", "assets\\preview.png"),
    "assets/preview.png",
  );
  assert.equal(
    viewer.workspaceImageRelativePathForCopy(
      "H:\\Codezone\\LiveAgent",
      "H:\\Codezone\\LiveAgent\\assets\\preview.png",
    ),
    "assets/preview.png",
  );
  assert.equal(
    viewer.workspaceImageRelativePathForCopy("/workspace/liveagent", "/workspace/liveagent/preview.png"),
    "preview.png",
  );
});

test("image viewer retains continuous angles for rotation transitions", () => {
  const rotatedLeft = viewer.clampImageViewerState(
    { scale: 1, rotation: -90, x: 0, y: 0 },
    { imageSize: image, viewportSize: viewport },
  );
  const rotatedAcrossBoundary = viewer.clampImageViewerState(
    { scale: 1, rotation: 360, x: 0, y: 0 },
    { imageSize: image, viewportSize: viewport },
  );

  assert.equal(rotatedLeft.rotation, -90);
  assert.equal(rotatedAcrossBoundary.rotation, 360);
  assert.deepEqual(viewer.rotatedImageViewerSize(image, 360), image);
});

test("image viewer centres dimensions that fit inside the viewport", () => {
  assert.deepEqual(viewer.clampImageViewerPan({ x: 80, y: -80 }, {
    imageSize: image,
    viewportSize: viewport,
    scale: 1,
    rotation: 0,
  }), { x: 0, y: 0 });
});

test("image viewer fits a rotated image inside the viewport", () => {
  assert.deepEqual(viewer.fitImageViewerSize({ width: 1600, height: 900 }, viewport, 90), {
    width: 600,
    height: 337.5,
  });
});

test("image viewer clamps panning against scaled and rotated bounds", () => {
  assert.deepEqual(viewer.clampImageViewerPan({ x: 900, y: -900 }, {
    imageSize: image,
    viewportSize: viewport,
    scale: 2,
    rotation: 0,
  }), { x: 400, y: -150 });

  assert.deepEqual(viewer.clampImageViewerPan({ x: 900, y: -900 }, {
    imageSize: image,
    viewportSize: viewport,
    scale: 2,
    rotation: 90,
  }), { x: 50, y: -500 });
});

test("image viewer keeps the image point beneath the zoom anchor stable", () => {
  const before = { scale: 1, rotation: 90, x: 30, y: -20 };
  const anchor = { x: 120, y: -60 };
  const after = viewer.zoomImageViewerAtPoint(before, 1.5, anchor, {
    imageSize: { width: 1600, height: 900 },
    viewportSize: viewport,
  });

  const beforePoint = {
    x: (anchor.x - before.x) / before.scale,
    y: (anchor.y - before.y) / before.scale,
  };
  const afterPoint = {
    x: (anchor.x - after.x) / after.scale,
    y: (anchor.y - after.y) / after.scale,
  };
  assert.deepEqual(afterPoint, beforePoint);
});

test("image viewer reset restores the default fit state", () => {
  assert.deepEqual(viewer.resetImageViewerState(), {
    scale: 1,
    rotation: 0,
    x: 0,
    y: 0,
  });
});
