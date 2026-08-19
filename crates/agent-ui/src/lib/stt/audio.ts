export const STT_SAMPLE_RATE = 16_000;
export const STT_CHANNELS = 1;
export const STT_CHUNK_MS = 100;
export const STT_SAMPLES_PER_CHUNK = (STT_SAMPLE_RATE * STT_CHUNK_MS) / 1000;
export const STT_TAIL_SILENCE_MS = 400;
export const STT_SILENCE_TIMEOUT_MS = 3_000;
export const STT_CONNECT_TIMEOUT_MS = 10_000;
export const STT_MAX_BUFFER_BYTES = STT_SAMPLE_RATE * 2 * 10;

export type PcmChunk = { sequence: number; pcm: Int16Array; durationMs: number };

export class SttPcmFifo {
  private readonly chunks: PcmChunk[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes = STT_MAX_BUFFER_BYTES) {}
  get sizeBytes() {
    return this.bytes;
  }
  get length() {
    return this.chunks.length;
  }
  push(chunk: PcmChunk) {
    const chunkBytes = chunk.pcm.byteLength;
    if (this.bytes + chunkBytes > this.maxBytes) return false;
    this.chunks.push(chunk);
    this.bytes += chunkBytes;
    return true;
  }
  drain() {
    const output = this.chunks.splice(0);
    this.bytes = 0;
    return output;
  }
  clear() {
    this.chunks.splice(0);
    this.bytes = 0;
  }
}

export function pcm16ToLittleEndianBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true);
  }
  return bytes;
}

export function appendTailSilence(
  samples: number = (STT_SAMPLE_RATE * STT_TAIL_SILENCE_MS) / 1000,
) {
  return new Int16Array(Math.round(samples));
}

export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0 || inputRate === STT_SAMPLE_RATE)
    return input.slice();
  const outputLength = Math.max(1, Math.round((input.length * STT_SAMPLE_RATE) / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / STT_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}

/**
 * Linear resampler for a continuous microphone stream. Web Audio delivers
 * independent blocks, but interpolation phase must carry across block
 * boundaries or 44.1/48 kHz input slowly loses samples and develops clicks.
 */
export class SttStreamingResampler {
  private readonly ratio: number;
  private buffered = new Float32Array(0);
  private bufferStart = 0;
  private received = 0;
  private outputIndex = 0;

  constructor(
    private readonly inputRate: number,
    private readonly outputRate = STT_SAMPLE_RATE,
  ) {
    if (!Number.isFinite(inputRate) || inputRate <= 0) {
      throw new Error("麦克风采样率无效");
    }
    if (!Number.isFinite(outputRate) || outputRate <= 0) {
      throw new Error("语音识别采样率无效");
    }
    this.ratio = inputRate / outputRate;
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    if (this.inputRate === this.outputRate) return input.slice();

    const joined = new Float32Array(this.buffered.length + input.length);
    joined.set(this.buffered);
    joined.set(input, this.buffered.length);
    this.buffered = joined;
    this.received += input.length;

    const output: number[] = [];
    while (this.sourcePosition() + 1 < this.received) {
      const relativePosition = this.sourcePosition() - this.bufferStart;
      const left = Math.floor(relativePosition);
      const fraction = relativePosition - left;
      output.push(
        (this.buffered[left] ?? 0) * (1 - fraction) +
          (this.buffered[left + 1] ?? 0) * fraction,
      );
      this.outputIndex += 1;
    }
    this.compact();
    return Float32Array.from(output);
  }

  flush(): Float32Array {
    if (this.inputRate === this.outputRate || this.buffered.length === 0) {
      this.reset();
      return new Float32Array(0);
    }

    const output: number[] = [];
    while (this.sourcePosition() < this.received - Number.EPSILON * this.received) {
      const relativePosition = this.sourcePosition() - this.bufferStart;
      const left = Math.floor(relativePosition);
      const right = Math.min(left + 1, this.buffered.length - 1);
      const fraction = relativePosition - left;
      output.push(
        (this.buffered[left] ?? 0) * (1 - fraction) +
          (this.buffered[right] ?? 0) * fraction,
      );
      this.outputIndex += 1;
    }
    this.reset();
    return Float32Array.from(output);
  }

  reset() {
    this.buffered = new Float32Array(0);
    this.bufferStart = 0;
    this.received = 0;
    this.outputIndex = 0;
  }

  private compact() {
    // Keep one real source sample for interpolation with the next Web Audio block.
    const keepFrom = Math.min(Math.floor(this.sourcePosition()), this.received - 1);
    const consumed = Math.max(0, keepFrom - this.bufferStart);
    if (consumed <= 0) return;
    this.buffered = this.buffered.slice(consumed);
    this.bufferStart += consumed;
  }

  private sourcePosition() {
    return this.outputIndex * this.ratio;
  }
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
    output[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return output;
}

export function pcmRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export type SttAudioCaptureOptions = {
  onChunk: (chunk: PcmChunk, hasVoice: boolean) => void;
  onSilenceTimeout?: () => void;
  onCaptureError?: (message: string) => void;
  vadThreshold?: number;
};

export class SttAudioCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private resampler: SttStreamingResampler | null = null;
  private pending = new Float32Array(0);
  private sequence = 0;
  private lastVoiceAt = 0;
  private silenceTimer: number | null = null;
  private stopped = true;
  private readonly threshold: number;
  private baselineSamples: number[] = [];

  constructor(private readonly options: SttAudioCaptureOptions) {
    this.threshold = options.vadThreshold ?? 0.012;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前环境不支持麦克风");
    try {
      const preferredConstraints: MediaStreamConstraints = {
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      };
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
      } catch (cause) {
        if (!isMediaConstraintError(cause)) throw cause;
        // Older WebKitGTK/WebKit WebViews reject unknown audio constraints as
        // a whole. Let the runtime choose its supported microphone settings;
        // the AudioContext resampler still normalizes output to 16 kHz mono.
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      this.context = new AudioContext({ latencyHint: "interactive" });
      await this.context.resume();
      this.resampler = new SttStreamingResampler(this.context.sampleRate);
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (event) => this.consume(event.inputBuffer.getChannelData(0));
      for (const track of this.stream.getAudioTracks()) {
        track.addEventListener("ended", this.handleTrackEnded, { once: true });
      }
      this.source.connect(this.processor);
      this.processor.connect(this.context.destination);
      this.stopped = false;
      this.baselineSamples = [];
      this.resetSilenceClock();
      this.silenceTimer = window.setInterval(() => {
        if (!this.stopped && performance.now() - this.lastVoiceAt >= STT_SILENCE_TIMEOUT_MS)
          this.options.onSilenceTimeout?.();
      }, 250);
    } catch (cause) {
      await this.releaseResources();
      throw new Error(mediaCaptureErrorMessage(cause));
    }
  }

  resetSilenceClock() {
    this.lastVoiceAt = performance.now();
  }

  private readonly handleTrackEnded = () => {
    if (!this.stopped) this.options.onCaptureError?.("麦克风设备已断开或权限已撤销");
  };

  private consume(input: Float32Array) {
    if (this.stopped || !this.context) return;
    const resampled = this.resampler?.process(input) ?? new Float32Array(0);
    this.appendPending(resampled);
    this.emitFullChunks();
  }

  private appendPending(samples: Float32Array) {
    if (samples.length === 0) return;
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    this.pending = merged;
  }

  private emitFullChunks() {
    while (this.pending.length >= STT_SAMPLES_PER_CHUNK) {
      const samples = this.pending.slice(0, STT_SAMPLES_PER_CHUNK);
      this.pending = this.pending.slice(STT_SAMPLES_PER_CHUNK);
      const rms = pcmRms(samples);
      if (this.baselineSamples.length < 10 && rms < 0.02) this.baselineSamples.push(rms);
      const baseline = this.baselineSamples.length
        ? this.baselineSamples.reduce((sum, value) => sum + value, 0) / this.baselineSamples.length
        : 0.003;
      const threshold = this.options.vadThreshold === undefined
        ? Math.max(0.005, Math.min(0.009, baseline * 1.8))
        : this.threshold;
      const hasVoice = rms >= threshold;
      if (hasVoice) this.lastVoiceAt = performance.now();
      this.options.onChunk(
        { sequence: this.sequence++, pcm: floatToPcm16(samples), durationMs: STT_CHUNK_MS },
        hasVoice,
      );
    }
  }

  async stop() {
    if (this.stopped && !this.stream && !this.context && !this.processor && !this.source) return;
    this.stopped = true;
    if (this.processor) this.processor.onaudioprocess = null;
    this.appendPending(this.resampler?.flush() ?? new Float32Array(0));
    if (this.pending.length > 0) {
      const samples = this.pending;
      this.pending = new Float32Array(0);
      const hasVoice = pcmRms(samples) >= this.threshold;
      this.options.onChunk(
        {
          sequence: this.sequence++,
          pcm: floatToPcm16(samples),
          durationMs: (samples.length * 1000) / STT_SAMPLE_RATE,
        },
        hasVoice,
      );
    }
    await this.releaseResources();
  }

  private async releaseResources() {
    if (this.silenceTimer !== null) window.clearInterval(this.silenceTimer);
    this.silenceTimer = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.processor = null;
    this.source = null;
    this.stream?.getTracks().forEach((track) => {
      track.removeEventListener("ended", this.handleTrackEnded);
      track.stop();
    });
    this.stream = null;
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.resampler?.reset();
    this.resampler = null;
    this.pending = new Float32Array(0);
    this.baselineSamples = [];
  }
}

function mediaCaptureErrorMessage(cause: unknown): string {
  const name = mediaErrorName(cause);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "麦克风权限已拒绝，请在系统设置中允许访问";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "未检测到可用麦克风设备";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "麦克风设备不可用或正被其他应用占用";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "未检测到可用麦克风设备，或设备不支持录音参数";
  }
  return cause instanceof Error && cause.message ? cause.message : "无法启动麦克风";
}

function isMediaConstraintError(cause: unknown): boolean {
  const name = mediaErrorName(cause);
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  return (
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError" ||
    name === "TypeError" ||
    message.includes("constraint")
  );
}

function mediaErrorName(cause: unknown): string {
  if (!cause || typeof cause !== "object" || !("name" in cause)) return "";
  return typeof cause.name === "string" ? cause.name : "";
}
