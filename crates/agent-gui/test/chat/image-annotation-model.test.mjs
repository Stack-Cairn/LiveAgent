import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv({ mocks: {} });
const model = env.loadModule("@liveagent/ui/lib/chat/imageAnnotation/model.ts");
const render = env.loadModule("@liveagent/ui/lib/chat/imageAnnotation/render.ts");

const RED = "#ef4444";

function rect(id, x, y, w, h) {
  return { id, kind: "rect", x, y, w, h, color: RED, width: 4 };
}
function marker(id, x, y, label = "") {
  return { id, kind: "marker", x, y, n: 0, label, color: RED, size: 14 };
}

test("shapes: add, update and remove renumber markers in stacking order", () => {
  let doc = model.createAnnotationDocument(800, 600);
  assert.equal(model.isDocumentEmpty(doc), true);
  doc = model.addShape(doc, marker("m1", 10, 10, "Login button"));
  doc = model.addShape(doc, rect("r1", 20, 20, 100, 50));
  doc = model.addShape(doc, marker("m2", 200, 200, "  wrong\n colour "));
  doc = model.addShape(doc, marker("m3", 300, 300));
  assert.deepEqual(
    doc.shapes.filter((shape) => shape.kind === "marker").map((shape) => [shape.id, shape.n]),
    [
      ["m1", 1],
      ["m2", 2],
      ["m3", 3],
    ],
  );
  assert.equal(model.nextMarkerNumber(doc), 4);

  doc = model.removeShape(doc, "m1");
  assert.deepEqual(
    doc.shapes.filter((shape) => shape.kind === "marker").map((shape) => [shape.id, shape.n]),
    [
      ["m2", 1],
      ["m3", 2],
    ],
  );
  const moved = model.updateShape(doc, "r1", (shape) => model.translateShape(shape, 1000, -5, doc));
  const movedRect = moved.shapes.find((shape) => shape.id === "r1");
  // Clamped so the rectangle stays on the image.
  assert.deepEqual([movedRect.x, movedRect.y], [700, 15]);
  // A no-op patch keeps the same document (no history step).
  assert.equal(
    model.updateShape(doc, "r1", (shape) => shape),
    doc,
  );
  assert.equal(model.removeShape(doc, "missing"), doc);
});

test("drag rectangles normalise any direction and clamp to the image", () => {
  const bounds = { width: 100, height: 80 };
  assert.deepEqual(model.rectFromPoints({ x: 90, y: 70 }, { x: 10, y: 5 }, bounds), {
    x: 10,
    y: 5,
    w: 80,
    h: 65,
  });
  assert.deepEqual(model.rectFromPoints({ x: -20, y: -20 }, { x: 500, y: 500 }, bounds), {
    x: 0,
    y: 0,
    w: 100,
    h: 80,
  });
  assert.equal(model.isUsableRegion({ x: 0, y: 0, w: 3, h: 50 }), false);
  let doc = model.createAnnotationDocument(100, 80);
  doc = model.setCrop(doc, { x: 10.4, y: 5.6, w: 50.2, h: 40.1 });
  assert.deepEqual(model.exportRegion(doc), doc.crop);
  assert.equal(model.setCrop(doc, { x: 0, y: 0, w: 2, h: 2 }).crop, null);
});

test("hit testing returns the topmost shape under the pointer", () => {
  let doc = model.createAnnotationDocument(400, 400);
  doc = model.addShape(doc, rect("below", 0, 0, 200, 200));
  doc = model.addShape(doc, marker("above", 100, 100));
  assert.equal(model.hitTestShape(doc, { x: 102, y: 98 }, 2)?.id, "above");
  assert.equal(model.hitTestShape(doc, { x: 20, y: 20 }, 2)?.id, "below");
  assert.equal(model.hitTestShape(doc, { x: 390, y: 390 }, 2), null);
});

test("undo/redo walk the history and a new edit drops the redo branch", () => {
  const base = model.createAnnotationDocument(100, 100);
  let history = model.createHistory(base);
  assert.equal(model.canUndo(history), false);
  const one = model.addShape(base, rect("a", 1, 1, 10, 10));
  const two = model.addShape(one, rect("b", 20, 20, 10, 10));
  history = model.commit(history, one);
  history = model.commit(history, two);
  assert.equal(model.commit(history, history.present), history, "no-op commits record nothing");
  history = model.undo(history);
  assert.equal(history.present, one);
  history = model.undo(history);
  assert.equal(history.present, base);
  assert.equal(model.undo(history), history);
  history = model.redo(history);
  assert.equal(history.present, one);
  assert.equal(model.canRedo(history), true);
  const branch = model.setCrop(one, { x: 0, y: 0, w: 50, h: 50 });
  history = model.commit(history, branch);
  assert.equal(model.canRedo(history), false);
  assert.equal(model.redo(history), history);

  // Bounded history.
  let long = model.createHistory(base);
  let doc = base;
  for (let index = 0; index < model.ANNOTATION_HISTORY_LIMIT + 20; index += 1) {
    doc = model.addShape(doc, rect(`s${index}`, 1, 1, 10, 10));
    long = model.commit(long, doc);
  }
  assert.equal(long.past.length, model.ANNOTATION_HISTORY_LIMIT);
});

test("marker labels and free text become the structured note", () => {
  let doc = model.createAnnotationDocument(400, 300);
  doc = model.addShape(doc, marker("m1", 10, 10, "Button is misaligned"));
  doc = model.addShape(doc, marker("m2", 20, 20));
  doc = model.addShape(doc, marker("m3", 30, 30, "Should be\nbold"));
  doc = model.addShape(doc, {
    id: "t1",
    kind: "text",
    x: 5,
    y: 5,
    text: "TODO:\nremove",
    color: RED,
    size: 18,
  });
  assert.equal(
    model.buildAnnotationNote(doc),
    '1: Button is misaligned\n3: Should be bold\nText on image: "TODO: remove"',
  );
  assert.equal(model.buildAnnotationNote(model.createAnnotationDocument(10, 10)), "");
});

test("serialization round-trips and parsing drops invalid shapes", () => {
  let doc = model.createAnnotationDocument(640, 480);
  doc = model.addShape(doc, rect("r", 10, 10, 50, 40));
  doc = model.addShape(doc, {
    id: "a",
    kind: "arrow",
    from: { x: 1, y: 2 },
    to: { x: 300, y: 200 },
    color: "#3b82f6",
    width: 4,
  });
  doc = model.addShape(doc, {
    id: "p",
    kind: "pen",
    points: [
      { x: 1, y: 1 },
      { x: 5, y: 9 },
    ],
    color: "#22c55e",
    width: 2,
  });
  doc = model.addShape(doc, { id: "b", kind: "blur", x: 100, y: 100, w: 80, h: 30, block: 8 });
  doc = model.addShape(doc, marker("m", 50, 50, "note"));
  doc = model.setCrop(doc, { x: 0, y: 0, w: 320, h: 240 });
  const json = model.serializeAnnotationDocument(doc);
  assert.deepEqual(model.parseAnnotationDocument(json), doc);
  assert.deepEqual(model.parseAnnotationDocument(JSON.parse(json)), doc);

  const tampered = JSON.parse(json);
  tampered.shapes.push({ id: "x", kind: "ellipse" }, { id: "y", kind: "rect", x: "nope" });
  tampered.shapes[0].x = 99_999;
  const parsed = model.parseAnnotationDocument(tampered);
  assert.equal(parsed.shapes.length, doc.shapes.length);
  assert.ok(parsed.shapes[0].x <= 640);
  assert.equal(model.parseAnnotationDocument("{not json"), null);
  assert.equal(model.parseAnnotationDocument({ version: 1, width: 0, height: 10 }), null);
});

/** A canvas context backed by a real RGBA buffer: drawImage copies a source
 *  buffer 1:1, getImageData/putImageData read and write it; vector drawing
 *  is a no-op (only blur touches pixels directly). */
function createPixelContext(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const noop = () => {};
  return {
    data,
    width,
    height,
    save: noop,
    restore: noop,
    setTransform: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    arc: noop,
    rect: noop,
    stroke: noop,
    fill: noop,
    fillRect: noop,
    fillText: noop,
    strokeText: noop,
    measureText: (text) => ({ width: text.length * 8 }),
    drawImage(source) {
      data.set(source.data);
    },
    getImageData(sx, sy, sw, sh) {
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y += 1) {
        const start = ((sy + y) * width + sx) * 4;
        out.set(data.subarray(start, start + sw * 4), y * sw * 4);
      }
      return { data: out, width: sw, height: sh };
    },
    putImageData(pixels, dx, dy) {
      for (let y = 0; y < pixels.height; y += 1) {
        const start = ((dy + y) * width + dx) * 4;
        data.set(pixels.data.subarray(y * pixels.width * 4, (y + 1) * pixels.width * 4), start);
      }
    },
  };
}

/** Every pixel distinct: a stand-in for text or a secret token. */
function noiseImage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = (index * 37) % 256;
    data[index * 4 + 1] = (index * 91 + 13) % 256;
    data[index * 4 + 2] = (index * 53 + 101) % 256;
    data[index * 4 + 3] = 255;
  }
  return { data, width, height };
}

function pixelAt(buffer, width, x, y) {
  const index = (y * width + x) * 4;
  return [...buffer.subarray(index, index + 4)];
}

test("blur destroys the pixels under it in the flattened output", () => {
  const width = 64;
  const height = 48;
  const image = noiseImage(width, height);
  let doc = model.createAnnotationDocument(width, height);
  doc = model.addShape(doc, { id: "b", kind: "blur", x: 8, y: 8, w: 32, h: 16, block: 8 });
  const ctx = createPixelContext(width, height);
  const view = render.exportView(render.planAnnotationExport(doc));
  render.renderAnnotatedImage(ctx, { image, doc, view });

  // Each 8x8 block inside the region collapses to one colour: the original
  // per-pixel values cannot be recovered from the output.
  for (let blockY = 8; blockY < 24; blockY += 8) {
    for (let blockX = 8; blockX < 40; blockX += 8) {
      const first = pixelAt(ctx.data, width, blockX, blockY);
      const colours = new Set();
      for (let y = blockY; y < blockY + 8; y += 1) {
        for (let x = blockX; x < blockX + 8; x += 1) {
          colours.add(pixelAt(ctx.data, width, x, y).join(","));
        }
      }
      assert.equal(colours.size, 1, `block ${blockX},${blockY} is uniform`);
      assert.notDeepEqual(first, pixelAt(image.data, width, blockX, blockY));
    }
  }
  let unchanged = 0;
  for (let y = 8; y < 24; y += 1) {
    for (let x = 8; x < 40; x += 1) {
      if (pixelAt(ctx.data, width, x, y).join() === pixelAt(image.data, width, x, y).join()) {
        unchanged += 1;
      }
    }
  }
  assert.ok(unchanged <= 8, `at most one pixel per block may coincide (got ${unchanged})`);
  // Outside the region the image is untouched.
  assert.deepEqual(pixelAt(ctx.data, width, 0, 0), pixelAt(image.data, width, 0, 0));
  assert.deepEqual(pixelAt(ctx.data, width, 50, 30), pixelAt(image.data, width, 50, 30));

  // The pixelate primitive itself: averages each block in place.
  const tile = { data: new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 50, 255]), width: 2, height: 1 };
  render.pixelateImageData(tile, 2);
  assert.deepEqual([...tile.data], [100, 50, 25, 255, 100, 50, 25, 255]);
});

function fakeEncoder({ pngBytesPerPixel, jpegBytesPerPixel }) {
  const calls = [];
  return {
    calls,
    render: (plan, background) => ({ width: plan.width, height: plan.height, background }),
    encode: async (canvas, mimeType, quality) => {
      calls.push({ mimeType, quality, width: canvas.width, height: canvas.height });
      const perPixel = mimeType === "image/png" ? pngBytesPerPixel : jpegBytesPerPixel * (quality ?? 1);
      return { size: Math.round(canvas.width * canvas.height * perPixel), mimeType };
    },
  };
}

test("flatten exports at original resolution, capped to the upload limits", async () => {
  // Small screenshot: lossless PNG at full size.
  const small = model.createAnnotationDocument(1440, 900);
  let encoder = fakeEncoder({ pngBytesPerPixel: 1, jpegBytesPerPixel: 0.3 });
  let result = await render.encodeAnnotatedImage({ doc: small, ...encoder });
  assert.deepEqual([result.mimeType, result.width, result.height], ["image/png", 1440, 900]);
  assert.equal(encoder.calls.length, 1);

  // Crop exports exactly the cropped region at original pixels.
  const cropped = model.setCrop(small, { x: 100, y: 50, w: 640, h: 360 });
  encoder = fakeEncoder({ pngBytesPerPixel: 1, jpegBytesPerPixel: 0.3 });
  result = await render.encodeAnnotatedImage({ doc: cropped, ...encoder });
  assert.deepEqual([result.width, result.height], [640, 360]);

  // Larger than the preview decoder accepts: the long side is capped.
  const huge = model.createAnnotationDocument(12_000, 3_000);
  encoder = fakeEncoder({ pngBytesPerPixel: 0.01, jpegBytesPerPixel: 0.01 });
  result = await render.encodeAnnotatedImage({ doc: huge, ...encoder });
  assert.equal(result.width, render.ANNOTATION_EXPORT_MAX_DIMENSION);
  assert.equal(result.height, 2048);

  // PNG too big: JPEG (with a white background) at the first quality that fits.
  const photo = model.createAnnotationDocument(4000, 3000);
  encoder = fakeEncoder({ pngBytesPerPixel: 3, jpegBytesPerPixel: 0.5 });
  result = await render.encodeAnnotatedImage({ doc: photo, ...encoder });
  assert.equal(result.mimeType, "image/jpeg");
  assert.ok(result.blob.size <= render.ANNOTATION_EXPORT_MAX_BYTES);
  assert.deepEqual([result.width, result.height], [4000, 3000]);
  assert.deepEqual(
    encoder.calls.map((call) => call.quality),
    // 12 MP × 0.5 B/px × q: 0.92 → 5.52 MB (too big), 0.85 → 5.1 MB (fits).
    [undefined, 0.92, 0.85],
  );

  // Still too big: progressively downscaled until it fits.
  encoder = fakeEncoder({ pngBytesPerPixel: 3, jpegBytesPerPixel: 2 });
  result = await render.encodeAnnotatedImage({ doc: photo, ...encoder });
  assert.equal(result.mimeType, "image/jpeg");
  assert.ok(result.width < 4000 && result.blob.size <= render.ANNOTATION_EXPORT_MAX_BYTES);
  assert.equal(Math.round((result.width / result.height) * 100), Math.round((4 / 3) * 100));

  // Nothing fits: no attachment rather than a broken one.
  encoder = fakeEncoder({ pngBytesPerPixel: 1e6, jpegBytesPerPixel: 1e6 });
  assert.equal(await render.encodeAnnotatedImage({ doc: photo, ...encoder }), null);
});

test("editing bitmap is downscaled and the view fits the image", () => {
  assert.deepEqual(render.workingBitmapSize(1200, 800), { width: 1200, height: 800, scale: 1 });
  const large = render.workingBitmapSize(10_240, 5_120);
  assert.equal(large.width, render.ANNOTATION_WORKING_MAX_DIMENSION);
  assert.equal(large.height, 1280);
  const fit = render.fitView({ width: 2000, height: 1000 }, { width: 1048, height: 548 }, 2);
  assert.equal(fit.zoom, 0.5);
  assert.deepEqual([fit.panX, fit.panY, fit.dpr], [24, 24, 2]);
});

test.after(() => env.cleanup());
