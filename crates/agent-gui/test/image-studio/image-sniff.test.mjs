import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { sniffImageBytes, sniffImage } = createTsModuleLoader().loadModule("@liveagent/ui/features/image-studio/imageSniff");
const bytes = (...values) => new Uint8Array(values.flatMap((v) => (typeof v === "string" ? [...v].map((c) => c.charCodeAt(0)) : [v])));

test("magic bytes decide the upload type, not the extension", () => {
  assert.deepEqual(sniffImageBytes(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a)), { kind: "supported", mime: "image/png", label: "PNG" });
  assert.deepEqual(sniffImageBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, "JFIF")), { kind: "supported", mime: "image/jpeg", label: "JPEG" });
  assert.deepEqual(sniffImageBytes(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 ")), { kind: "supported", mime: "image/webp", label: "WebP" });
});

test("known unsupported formats are named so the user knows what to convert", () => {
  assert.equal(sniffImageBytes(bytes("GIF89a")).label, "GIF");
  assert.equal(sniffImageBytes(bytes("BM", 0, 0)).label, "BMP");
  assert.equal(sniffImageBytes(bytes(0, 0, 0, 24, "ftypheic")).label, "HEIC");
  assert.equal(sniffImageBytes(bytes(0, 0, 0, 24, "ftypavif")).label, "AVIF");
  assert.equal(sniffImageBytes(bytes("<svg xmlns=")).label, "SVG");
  assert.deepEqual(sniffImageBytes(bytes("plain text")), { kind: "unknown" });
});

test("sniffImage reads only the head of a Blob", async () => {
  const blob = new Blob([bytes(0xff, 0xd8, 0xff, 0xe1), new Uint8Array(1024 * 1024)], { type: "image/png" });
  assert.equal((await sniffImage(blob)).mime, "image/jpeg");
  assert.deepEqual(await sniffImage(new Blob([])), { kind: "unknown" });
});
