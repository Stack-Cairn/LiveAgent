import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
});
const {
  STT_MAX_BUFFER_BYTES,
  STT_SAMPLES_PER_CHUNK,
  STT_TAIL_SILENCE_MS,
  SttStreamingResampler,
  SttPcmFifo,
  appendTailSilence,
  floatToPcm16,
  pcm16ToLittleEndianBytes,
  resampleTo16k,
} = loader.loadModule("@liveagent/ui/lib/stt/audio");

function concatenateFloat32(parts) {
  const output = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function chunk(sequence, samples, durationMs = 100) {
  return { sequence, pcm: new Int16Array(samples), durationMs };
}

test("STT audio constants describe 100 ms chunks and a 400 ms zero tail", () => {
  assert.equal(STT_SAMPLES_PER_CHUNK, 1600);
  assert.equal(STT_TAIL_SILENCE_MS, 400);
  const tail = appendTailSilence();
  assert.equal(tail.length, 6400);
  assert.ok(tail.every((sample) => sample === 0));
});

test("resampleTo16k preserves boundaries and handles empty or invalid input", () => {
  const source = new Float32Array([-1, 0, 1, 0]);
  const output = resampleTo16k(source, 8_000);
  assert.equal(output.length, 8);
  assert.equal(output[0], -1);
  assert.equal(output.at(-1), 0);
  assert.deepEqual([...resampleTo16k(source, 16_000)], [...source]);
  assert.deepEqual([...resampleTo16k(new Float32Array(), 48_000)], [0]);
  assert.deepEqual([...resampleTo16k(source, Number.NaN)], [...source]);
  assert.doesNotThrow(() => resampleTo16k(source, -1));
});

test("streaming resampler preserves phase across arbitrary 48 kHz blocks", () => {
  const source = Float32Array.from(
    { length: 48_000 },
    (_, index) => Math.sin((2 * Math.PI * 440 * index) / 48_000),
  );
  const whole = new SttStreamingResampler(48_000);
  const expected = concatenateFloat32([whole.process(source), whole.flush()]);
  const split = new SttStreamingResampler(48_000);
  const actualParts = [];
  for (let offset = 0; offset < source.length; offset += 4096) {
    actualParts.push(split.process(source.slice(offset, offset + 4096)));
  }
  actualParts.push(split.flush());
  const actual = concatenateFloat32(actualParts);

  assert.equal(actual.length, 16_000);
  assert.deepEqual(actual, expected);
});

test("streaming resampler has the correct long-run count at 44.1 kHz", () => {
  const source = Float32Array.from({ length: 44_100 }, (_, index) => index / 44_100);
  const resampler = new SttStreamingResampler(44_100);
  const parts = [];
  for (let offset = 0; offset < source.length; offset += 997) {
    parts.push(resampler.process(source.slice(offset, offset + 997)));
  }
  parts.push(resampler.flush());
  const output = concatenateFloat32(parts);

  assert.equal(output.length, 16_000);
  assert.equal(output[0], 0);
  assert.ok(output.at(-1) > 0.99);
});

test("streaming resampler rejects invalid rates and handles empty blocks", () => {
  assert.throws(() => new SttStreamingResampler(0), /采样率/);
  assert.throws(() => new SttStreamingResampler(Number.NaN), /采样率/);
  const resampler = new SttStreamingResampler(16_000);
  assert.deepEqual(resampler.process(new Float32Array()), new Float32Array());
  assert.deepEqual(resampler.process(new Float32Array([0.25, -0.25])), new Float32Array([0.25, -0.25]));
  assert.deepEqual(resampler.flush(), new Float32Array());
});

test("floatToPcm16 clamps positive and negative saturation", () => {
  assert.deepEqual(
    [...floatToPcm16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]))],
    [-32768, -32768, -16384, 0, 16384, 32767, 32767],
  );
});

test("PCM16 encoding is signed little-endian", () => {
  assert.deepEqual(
    [...pcm16ToLittleEndianBytes(new Int16Array([0x1234, -2, -32768, 32767]))],
    [0x34, 0x12, 0xfe, 0xff, 0x00, 0x80, 0xff, 0x7f],
  );
});

test("SttPcmFifo preserves order, rejects overflow, and drains or clears", () => {
  const fifo = new SttPcmFifo(8);
  assert.equal(fifo.push(chunk(3, [3, 3])), true);
  assert.equal(fifo.push(chunk(4, [4, 4])), true);
  assert.equal(fifo.push(chunk(5, [5])), false);
  assert.equal(fifo.sizeBytes, 8);
  assert.equal(fifo.length, 2);
  assert.deepEqual(fifo.drain().map((value) => value.sequence), [3, 4]);
  assert.equal(fifo.sizeBytes, 0);
  assert.equal(fifo.length, 0);
  assert.equal(fifo.push(chunk(6, [6])), true);
  fifo.clear();
  assert.equal(fifo.sizeBytes, 0);
  assert.equal(fifo.length, 0);
  const defaultFifo = new SttPcmFifo();
  assert.equal(defaultFifo.push(chunk(0, new Array(STT_MAX_BUFFER_BYTES / 2))), true);
  assert.equal(defaultFifo.push(chunk(1, [1])), false);
});

test("partial audio fragments do not make FIFO helpers throw", () => {
  assert.doesNotThrow(() => {
    const fifo = new SttPcmFifo(0);
    fifo.push(chunk(0, []));
    fifo.drain();
    fifo.clear();
    appendTailSilence(0.5);
  });
});
