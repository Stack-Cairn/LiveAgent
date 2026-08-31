import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const viewer = loader.loadModule("@liveagent/ui/components/chat/imagePreviewModel.ts");
const imagePreview = loader.loadModule("@liveagent/ui/components/chat/ImagePreview.tsx");
const userAttachments = loader.loadModule("@liveagent/ui/components/chat/UserAttachmentCards.tsx");

function approximately(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be close to ${expected}`);
}

test("image viewer clamps scale and uses smooth dynamic wheel increments", () => {
  assert.equal(viewer.clampImageViewerScale(0), viewer.IMAGE_VIEWER_MIN_SCALE);
  assert.equal(viewer.clampImageViewerScale(99), viewer.IMAGE_VIEWER_MAX_SCALE);
  approximately(viewer.imageViewerScaleAfterStep(1, 1), viewer.IMAGE_VIEWER_ZOOM_RATIO);
  approximately(viewer.imageViewerScaleAfterStep(1, -1), 1 / viewer.IMAGE_VIEWER_ZOOM_RATIO);
  approximately(viewer.imageViewerScaleAfterWheelDelta(1, -100, 0), viewer.IMAGE_VIEWER_ZOOM_RATIO);
  approximately(viewer.imageViewerScaleAfterWheelDelta(1, 100, 0), 1 / viewer.IMAGE_VIEWER_ZOOM_RATIO);
});

test("zoom keeps the image point under the cursor while remaining within pan bounds", () => {
  const options = {
    imageSize: { width: 800, height: 600 },
    viewportSize: { width: 400, height: 300 },
  };
  const anchor = { x: 100, y: -50 };
  const before = { x: 0, y: 0, scale: 1, rotation: 0 };
  const after = viewer.zoomImageViewerAtPoint(before, 2, anchor, options);

  assert.equal(after.scale, 2);
  assert.equal(after.x, -100);
  assert.equal(after.y, 50);
  approximately((anchor.x - before.x) / before.scale, (anchor.x - after.x) / after.scale);
  approximately((anchor.y - before.y) / before.scale, (anchor.y - after.y) / after.scale);
});

test("rotation-aware fit and panning use rotated dimensions while retaining continuous rotation", () => {
  assert.deepEqual(
    viewer.fitImageViewerSize({ width: 400, height: 200 }, { width: 200, height: 200 }, 90),
    { width: 200, height: 100 },
  );
  assert.deepEqual(
    viewer.clampImageViewerPan(
      { x: 999, y: -999 },
      {
        imageSize: { width: 400, height: 200 },
        viewportSize: { width: 200, height: 200 },
        scale: 2,
        rotation: 0,
      },
    ),
    { x: 300, y: -100 },
  );
  assert.deepEqual(
    viewer.clampImageViewerPan(
      { x: 999, y: -999 },
      {
        imageSize: { width: 400, height: 200 },
        viewportSize: { width: 200, height: 200 },
        scale: 2,
        rotation: 90,
      },
    ),
    { x: 100, y: -300 },
  );
  assert.equal(
    viewer.clampImageViewerState(
      { x: 0, y: 0, scale: 1, rotation: 360 },
      { imageSize: { width: 100, height: 100 }, viewportSize: { width: 100, height: 100 } },
    ).rotation,
    360,
  );
  assert.deepEqual(viewer.resetImageViewerState(), { x: 0, y: 0, scale: 1, rotation: 0 });
});

test("viewer index, image data parsing, and MIME inference cover inline and proxy-backed sources", async () => {
  assert.equal(viewer.clampImagePreviewIndex(-1, 3), 0);
  assert.equal(viewer.clampImagePreviewIndex(8, 3), 2);
  assert.equal(viewer.normalizeImagePreviewIndex(2.9), 2);
  assert.equal(viewer.normalizeImagePreviewIndex(Number.NaN), 0);

  assert.deepEqual(
    await viewer.resolveImagePreviewData({
      src: "ignored",
      dataBase64: "aGVsbG8=",
      mimeType: "image/png",
      sizeBytes: 5,
    }),
    { dataBase64: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 },
  );
  assert.deepEqual(
    await viewer.resolveImagePreviewData({ src: "data:image/svg+xml;base64,PHN2Zz4=" }),
    { dataBase64: "PHN2Zz4=", mimeType: "image/svg+xml", sizeBytes: 5 },
  );
  assert.deepEqual(
    await viewer.resolveImagePreviewData({ src: "data:image/svg+xml,%3Csvg%3E" }),
    { dataBase64: "PHN2Zz4=", mimeType: "image/svg+xml", sizeBytes: 5 },
  );
  const textSvg = "<svg><text>1+1 + 你好</text></svg>";
  assert.deepEqual(
    await viewer.resolveImagePreviewData({
      src: "data:image/svg+xml,%3Csvg%3E%3Ctext%3E1+1%20%2B%20%E4%BD%A0%E5%A5%BD%3C%2Ftext%3E%3C%2Fsvg%3E",
    }),
    {
      dataBase64: Buffer.from(textSvg).toString("base64"),
      mimeType: "image/svg+xml",
      sizeBytes: Buffer.byteLength(textSvg),
    },
  );
  assert.equal(
    viewer.getImagePreviewMimeType({ src: "data:image/png,%ZZ", fileName: "fallback.webp" }),
    "image/webp",
  );
  assert.equal(viewer.getImagePreviewMimeType({ src: "blob:local", fileName: "sketch.webp" }), "image/webp");
  assert.equal(
    viewer.getImagePreviewDisplaySource({
      src: "",
      dataBase64: " AQID\n",
      mimeType: "image/png",
    }),
    "data:image/png;base64,AQID",
  );

  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      blob: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: "image/webp" }),
    };
  };
  try {
    assert.deepEqual(
      await viewer.resolveImagePreviewData({ src: "https://proxy.example/image" }),
      { dataBase64: "AQID", mimeType: "image/webp", sizeBytes: 3 },
    );
    assert.deepEqual(requests, ["https://proxy.example/image"]);
  } finally {
    if (typeof previousFetch === "undefined") delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test("context-menu actions close immediately and report failures through their persistent owner", async () => {
  const events = [];
  let rejectAction;
  const action = new Promise((_, reject) => {
    rejectAction = reject;
  });
  const pending = imagePreview.runImagePreviewContextMenuAction({
    action: () => {
      events.push("action");
      return action;
    },
    fallback: "fallback",
    onClose: () => events.push("close"),
    onActionError: (message) => events.push(`error:${message}`),
  });

  assert.deepEqual(events, ["close", "action"]);
  rejectAction(new Error("clipboard denied"));
  await pending;
  assert.deepEqual(events, ["close", "action", "error:clipboard denied"]);

  await imagePreview.runImagePreviewContextMenuAction({
    action: () => {
      throw new Error("save failed");
    },
    fallback: "save failed",
    onClose: () => events.push("sync-close"),
    onActionError: (message) => events.push(`sync-error:${message}`),
  });
  assert.deepEqual(events.slice(-2), ["sync-close", "sync-error:save failed"]);
});

test("viewer capabilities expose filesystem actions only for a complete verified attachment", () => {
  const remote = viewer.getImagePreviewCapabilities({ src: "https://proxy.example/image" }, true);
  assert.deepEqual(remote, {
    canSave: true,
    canCopyImage: true,
    canCopyPaths: false,
    canOpenSystem: false,
  });
  const verifiedSlide = {
    src: "data:image/png;base64,AQ==",
    attachment: {
      workdir: "C:/work",
      absolutePath: "C:/work/assets/chart.png",
      relativePath: "assets/chart.png",
    },
  };
  assert.equal(viewer.getImagePreviewCapabilities(verifiedSlide, true).canOpenSystem, true);
  assert.equal(viewer.getImagePreviewCapabilities(verifiedSlide, true).canCopyPaths, true);
  assert.equal(viewer.getImagePreviewCapabilities(verifiedSlide, false).canOpenSystem, false);
  assert.equal(viewer.getImagePreviewCapabilities(verifiedSlide, false).canCopyPaths, false);
  assert.equal(
    viewer.getImagePreviewCapabilities(
      { ...verifiedSlide, attachment: { ...verifiedSlide.attachment, relativePath: "" } },
      true,
    ).canCopyPaths,
    false,
  );
  assert.equal(
    viewer.isVerifiedImagePreviewAttachment({
      workdir: null,
      absolutePath: "C:/work/assets/chart.png",
      relativePath: "assets/chart.png",
    }),
    false,
  );
});

test("chat attachment sources preserve verified metadata and keep menus scoped to loaded images", () => {
  const slide = userAttachments.createUserAttachmentImagePreviewSlide(
    {
      relativePath: "assets/chart.png",
      absolutePath: "C:/work/assets/chart.png",
      fileName: "chart.png",
      kind: "image",
      sizeBytes: 321,
    },
    "data:image/png;base64,AQ==",
    " C:/work ",
  );
  assert.deepEqual(slide?.attachment, {
    workdir: "C:/work",
    absolutePath: "C:/work/assets/chart.png",
    relativePath: "assets/chart.png",
  });
  assert.equal(
    userAttachments.createUserAttachmentImagePreviewSlide(
      { ...slide, relativePath: "" },
      "data:image/png;base64,AQ==",
      "C:/work",
    )?.attachment,
    undefined,
  );

  const toolImages = fs.readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/components/chat/assistant-bubble/ToolImages.tsx", import.meta.url)),
    "utf8",
  );
  const viewerSource = fs.readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/components/chat/ImagePreview.tsx", import.meta.url)),
    "utf8",
  );
  const overlayStyles = fs.readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/styles/common-overlays.css", import.meta.url)),
    "utf8",
  );
  const composerSource = fs.readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/components/chat/ComposerAttachmentCard.tsx", import.meta.url)),
    "utf8",
  );
  const userAttachmentSource = fs.readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/components/chat/UserAttachmentCards.tsx", import.meta.url)),
    "utf8",
  );
  const userImageAttachmentSource = userAttachmentSource.slice(
    userAttachmentSource.indexOf("function UserImageAttachmentCard"),
    userAttachmentSource.indexOf("function UserFileAttachmentCard"),
  );

  assert.match(composerSource, /file\?: PendingUploadedFile/);
  assert.match(composerSource, /workspaceRoot\?: string/);
  assert.match(composerSource, /onContextMenu=\{\(event\) =>/);
  assert.match(composerSource, /attachment: \{/);
  assert.match(composerSource, /className="block h-full w-full object-cover"/);
  assert.match(composerSource, /const \[imageLoadState, setImageLoadState\] = useState<\{/);
  assert.match(composerSource, /if \(!canPreview\) return;/);
  assert.match(userImageAttachmentSource, /"block w-full bg-black\/\[0\.02\] dark:bg-white\/5"/);
  assert.match(userImageAttachmentSource, /imageLoadState\?\.src === imageSrc/);
  assert.match(userImageAttachmentSource, /disabled=\{!canPreview\}/);
  assert.match(userImageAttachmentSource, /onError=\{\(\) => \{/);
  assert.doesNotMatch(userImageAttachmentSource, /hover:scale/);
  assert.doesNotMatch(userImageAttachmentSource, /hover:shadow-\[0_2px_8px_rgba\(0,0,0,0\.1\)\]/);
  assert.match(toolImages, /dataBase64: image\.data/);
  assert.match(toolImages, /src: imageSources\[index\]\?\.src \?\? ""/);
  assert.match(toolImages, /"block max-h-\[32rem\] w-full rounded-md object-contain/);
  assert.match(toolImages, /onContextMenu=\{\(\{ x, y \}\) => setContextMenu\(\{ index, x, y \}\)\}/);
  assert.match(toolImages, /if \(!canPreview\) return;/);
  assert.match(viewerSource, /@liveagent\/ui\/components\/ui\/dialog/);
  assert.match(viewerSource, /<DialogContent/);
  assert.match(viewerSource, /<DialogClose/);
  assert.match(viewerSource, /disablePointerDismissal/);
  assert.doesNotMatch(viewerSource, /role="dialog"/);
  assert.doesNotMatch(viewerSource, /aria-modal="true"/);
  assert.match(viewerSource, /layer-popover fixed min-w-52/);
  assert.match(viewerSource, /layer-toast fixed inset-x-0/);
  assert.match(viewerSource, /eventDetails\.reason === "escape-key"/);
  assert.match(viewerSource, /event\.stopPropagation\(\)/);
  assert.match(viewerSource, /document\.addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(viewerSource, /new ResizeObserver\(updateMenuPosition\)/);
  assert.match(viewerSource, /window\.addEventListener\("resize", updateMenuPosition\)/);
  assert.match(viewerSource, /chat-image-preview-dialog flex h-\[min\(78vh,760px\)\] w-\[min\(82vw,1120px\)\]/);
  assert.match(viewerSource, /const \[isFullscreen, setIsFullscreen\] = useState\(false\)/);
  assert.match(viewerSource, /\{capabilities\?\.canCopyPaths && verifiedAttachment \? \(/);
  assert.match(viewerSource, /document\.addEventListener\("fullscreenchange", updateFullscreenState\)/);
  assert.match(viewerSource, /await dialog\.requestFullscreen\(\)/);
  assert.match(viewerSource, /await document\.exitFullscreen\(\)/);
  assert.match(viewerSource, /chat\.imageViewer\.exitFullscreen/);
  assert.match(viewerSource, /<Minimize2 className="h-4 w-4" \/>/);
  assert.match(
    viewerSource,
    /const writeImage = await prepareImagePreviewSave\([\s\S]*const data = await resolveData\(slide\)/,
  );
  assert.match(
    viewerSource,
    /supportsDirectUploadedImageCopy &&[\s\S]*getImagePreviewMimeType\(slide\) !== "image\/svg\+xml" &&[\s\S]*isVerifiedImagePreviewAttachment\(slide\.attachment\)/,
  );
  assert.match(viewerSource, /void prepareUploadedImagePreviewCopy\(\{/);
  assert.match(viewerSource, /prepareUploadedImagePreviewCopy\([\s\S]*\.catch\(\(\) => undefined\)/);
  assert.match(viewerSource, /await copyUploadedImagePreview\(/);
  assert.match(viewerSource, /const \[isCopying, setIsCopying\] = useState\(false\)/);
  assert.match(viewerSource, /const \[isSaving, setIsSaving\] = useState\(false\)/);
  assert.match(viewerSource, /params\.onClose\(\);[\s\S]*return params\.action\(\)\.catch/);
  assert.match(viewerSource, /export function ImagePreviewActionFeedback/);
  assert.match(composerSource, /onActionError=\{setActionError\}/);
  assert.match(userImageAttachmentSource, /onActionError=\{setActionError\}/);
  assert.equal(toolImages.match(/onActionError=\{setActionError\}/g)?.length, 2);
  assert.match(viewerSource, /if \(!slide \|\| isSaving\) return;/);
  assert.match(viewerSource, /disabled=\{isSaving\}/);
  assert.match(viewerSource, /<Loader2 className="h-4 w-4 animate-spin" \/>/);
  assert.match(viewerSource, /new WeakMap<ImagePreviewSlide, ReturnType<typeof resolveImagePreviewData>>\(\)/);
  assert.match(viewerSource, /const hasInlineImageData = Boolean\(slide\?\.dataBase64\?\.trim\(\) \|\| imageSource\.startsWith\("data:"\)\)/);
  assert.match(viewerSource, /if \(hasInlineImageData\) void resolveCachedImageData\(slide\);/);
  assert.match(viewerSource, /await saveImagePreviewSlide\(slide, resolveCachedImageData\)/);
  assert.match(viewerSource, /await copyImagePreviewSlide\(slide, resolveCachedImageData\)/);
  assert.match(overlayStyles, /\.chat-image-preview-dialog:fullscreen \{/);
  assert.match(overlayStyles, /\.chat-image-preview-dialog:fullscreen \{[\s\S]*width: 100vw;/);
  assert.match(overlayStyles, /\.chat-image-preview-dialog:fullscreen \{[\s\S]*height: 100vh;/);
  assert.match(viewerSource, /src=\{imageSource\}/);
  assert.match(viewerSource, /onPointerDown/);
  assert.match(viewerSource, /onContextMenu/);
  assert.match(viewerSource, /zoomByStep\(-1\)/);
  assert.match(viewerSource, /zoomByStep\(1\)/);
});

test("slide keys stay compact for megabyte inline payloads and never embed the full data", () => {
  const bigPayload = "A".repeat(4 * 1024 * 1024);
  const bigSrc = `data:image/svg+xml;base64,${bigPayload}`;
  const slide = { src: bigSrc, dataBase64: bigPayload };

  const key = viewer.getImagePreviewSlideKey(slide);
  // 指纹必须是 O(1) 体积——巨串进 React key/effect deps 会让缩放拖拽的每帧
  // 重渲染反复物化整图体积的字符串（SVG 预览内存暴涨回归点）。
  assert.ok(key.length < 1024, `slide key must stay compact, got ${key.length} chars`);
  assert.equal(key, viewer.getImagePreviewSlideKey({ ...slide }));

  // 不同 payload（长度相同、内容不同头尾）必须区分。
  const otherPayload = `B${"A".repeat(4 * 1024 * 1024 - 2)}C`;
  assert.notEqual(
    viewer.getImagePreviewSlideKey({ src: bigSrc, dataBase64: otherPayload }),
    key,
  );

  // 模板化 SVG 形态：相同头（XML 声明/样式）、相同尾（</svg>）、等长，
  // 只有中间的文本/颜色/坐标不同——头尾采样对此确定性碰撞，全串哈希必须区分。
  const svgHead = `<svg xmlns="http://www.w3.org/2000/svg"><style>.t{fill:#000}</style>`;
  const svgTail = `</svg>`;
  const templatedSvg = (fill) =>
    `${svgHead}<rect fill="#${fill}" width="100" height="100"/>${"A".repeat(4096)}${svgTail}`;
  const redSvg = templatedSvg("ff0000");
  const greenSvg = templatedSvg("00ff00");
  assert.equal(redSvg.length, greenSvg.length);
  assert.notEqual(
    viewer.getImagePreviewSlideKey({ src: redSvg, dataBase64: "" }),
    viewer.getImagePreviewSlideKey({ src: greenSvg, dataBase64: "" }),
  );

  // 同一 slide 对象重复取 key 必须缓存命中（引用相等），撑住每帧渲染。
  assert.equal(viewer.getImagePreviewSlideKey(slide), viewer.getImagePreviewSlideKey(slide));

  // 短串走原文，行为与旧 key 等价。
  assert.equal(
    viewer.getImagePreviewSlideKey({ src: "data:image/png;base64,AQ==", dataBase64: "AQ==" }),
    "data:image/png;base64,AQ==\0AQ==",
  );
});

test("image render paths avoid re-materializing inline payloads per render", () => {
  const toolImages = fs.readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/components/chat/assistant-bubble/ToolImages.tsx", import.meta.url)),
    "utf8",
  );
  const viewerSource = fs.readFileSync(
    fileURLToPath(new URL("../../../agent-ui/src/components/chat/ImagePreview.tsx", import.meta.url)),
    "utf8",
  );

  // 巨串禁止直接拼进 key/deps：换灯片检测统一走紧凑指纹。
  assert.match(viewerSource, /getImagePreviewSlideKey\(slide\)/);
  assert.doesNotMatch(viewerSource, /\$\{slide\.src\}\\0/);
  assert.doesNotMatch(viewerSource, /key=\{`\$\{slide\.src\}/);

  // data URL 按 ImageContent 缓存，只拼一次。
  assert.match(toolImages, /const imageDataUrlCache = new WeakMap<ImageContent, string>\(\)/);
  // sources 数组身份稳定化，撑起下游 slides/ImagePreview 的 memo 链。
  assert.match(toolImages, /return useMemo\(\s*\(\)\s*=>\s*entries\.map/);
  // display_image payload 按 toolResult 缓存 + 组件 memo，隔离转录区高频渲染。
  assert.match(toolImages, /const displayImagePayloadCache = new WeakMap</);
  assert.match(toolImages, /export const NativeDisplayImageBlock = memo\(/);
});
