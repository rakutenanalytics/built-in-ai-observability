/** Lightweight media payload for MLflow previews and local DevTools rendering. */
export interface MediaPreview {
  dataBase64: string;
  mimeType: string;
}

export interface MultimodalPreviewOptions {
  /** Skip previews larger than this (decoded bytes). Default 200 KB for audio. */
  maxPreviewBytes?: number;
}

const DEFAULT_MAX_PREVIEW_BYTES = 512_000;
/**
 * MLflow only renders an audio player for `wav`/`mp3`, and a browser can encode
 * neither Opus nor MP3 — so previews are 16-bit PCM WAV, which costs 32 KB per
 * second at 16 kHz mono. The budget has to hold MAX_AUDIO_PREVIEW_SECONDS at
 * that rate (~160 KB) or previews get trimmed down to silent fractions of a
 * second.
 */
const DEFAULT_MAX_AUDIO_PREVIEW_BYTES = 200_000;
const IMAGE_MAX_DIMENSION = 320;
const MAX_AUDIO_PREVIEW_SECONDS = 5;

function maxPreviewBytes(
  options?: MultimodalPreviewOptions,
  modality?: string
): number {
  if (options?.maxPreviewBytes !== undefined) {
    return options.maxPreviewBytes;
  }
  return modality === "audio"
    ? DEFAULT_MAX_AUDIO_PREVIEW_BYTES
    : DEFAULT_MAX_PREVIEW_BYTES;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x80_00;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function canvasPreview(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxBytes: number
): MediaPreview | undefined {
  if (typeof document === "undefined") {
    return;
  }
  const canvas = document.createElement("canvas");
  let targetWidth = width;
  let targetHeight = height;
  const maxDim = IMAGE_MAX_DIMENSION;
  if (targetWidth > maxDim || targetHeight > maxDim) {
    const scale = maxDim / Math.max(targetWidth, targetHeight);
    targetWidth = Math.round(targetWidth * scale);
    targetHeight = Math.round(targetHeight * scale);
  }
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.drawImage(source, 0, 0, targetWidth, targetHeight);

  for (const quality of [0.85, 0.7, 0.5, 0.35]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const [, base64] = dataUrl.split(",");
    if (base64 && base64.length * 0.75 <= maxBytes) {
      return { dataBase64: base64, mimeType: "image/jpeg" };
    }
  }
}

function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

function isMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 3) {
    return false;
  }
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  return bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0;
}

export function isWebmAudio(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

/** Encodes mono float samples (-1..1) as 16-bit PCM WAV. */
export function encodeWavFromSamples(
  samples: Float32Array,
  sampleRate: number
): ArrayBuffer {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (baseOffset: number, str: string): void => {
    for (const [index, char] of [...str].entries()) {
      view.setUint8(baseOffset + index, char.charCodeAt(0));
    }
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let dataOffset = 44;
  for (const sampleValue of samples) {
    const sample = Math.max(-1, Math.min(1, sampleValue));
    const pcm = Math.max(
      -32_768,
      Math.min(32_767, Math.round(sample * 32_767))
    );
    view.setInt16(dataOffset, pcm, true);
    dataOffset += 2;
  }
  return buffer;
}

function renderMonoPreview(
  decoded: AudioBuffer,
  targetRate: number,
  maxSeconds: number
): Promise<AudioBuffer | undefined> {
  if (typeof OfflineAudioContext === "undefined") {
    return Promise.resolve(undefined);
  }
  const duration = Math.min(decoded.duration, maxSeconds);
  const frameCount = Math.max(1, Math.ceil(duration * targetRate));
  const offline = new OfflineAudioContext(1, frameCount, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0, 0, duration);
  return offline.startRendering();
}

async function previewWavAtRate(
  decoded: AudioBuffer,
  targetRate: number,
  maxBytes: number
): Promise<ArrayBuffer | undefined> {
  const rendered = await renderMonoPreview(
    decoded,
    targetRate,
    MAX_AUDIO_PREVIEW_SECONDS
  );
  if (!rendered) {
    return;
  }
  return wavWithinBudget(rendered.getChannelData(0), targetRate, maxBytes);
}

function wavWithinBudget(
  samples: Float32Array,
  sampleRate: number,
  maxBytes: number
): ArrayBuffer | undefined {
  const maxSamples = Math.floor((maxBytes - 44) / 2);
  if (maxSamples <= 0) {
    return;
  }
  const trimmed =
    samples.length <= maxSamples ? samples : samples.subarray(0, maxSamples);
  const wav = encodeWavFromSamples(trimmed, sampleRate);
  return wav.byteLength <= maxBytes ? wav : undefined;
}

/** Transcodes browser-captured WebM/Opus audio into WAV for MLflow previews. */
export async function transcodeAudioToWav(
  buffer: ArrayBuffer,
  options?: MultimodalPreviewOptions
): Promise<ArrayBuffer | undefined> {
  if (typeof AudioContext === "undefined") {
    return;
  }
  const maxBytes = maxPreviewBytes(options, "audio");
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext
      .decodeAudioData(buffer.slice(0))
      .catch(() => undefined);
    if (!decoded) {
      return;
    }

    return (
      (await previewWavAtRate(decoded, 16_000, maxBytes)) ??
      (await previewWavAtRate(decoded, 8000, maxBytes)) ??
      (await previewWavAtRate(decoded, 4000, maxBytes))
    );
  } finally {
    await audioContext.close();
  }
}

/** Maps MIME types to MLflow/OpenAI `input_audio.format` values. */
export function audioFormatFromMime(mimeType: string): "mp3" | "wav" {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("wav")) {
    return "wav";
  }
  return "mp3";
}

/** Builds a data URI from a preview for inline rendering. */
export function mediaPreviewDataUri(preview: MediaPreview): string {
  return `data:${preview.mimeType};base64,${preview.dataBase64}`;
}

export function extractImagePreview(
  value: unknown,
  options?: MultimodalPreviewOptions
): MediaPreview | undefined {
  const maxBytes = maxPreviewBytes(options, "image");

  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
    return canvasPreview(value, value.width, value.height, maxBytes);
  }

  if (
    typeof HTMLCanvasElement !== "undefined" &&
    value instanceof HTMLCanvasElement
  ) {
    return canvasPreview(value, value.width, value.height, maxBytes);
  }

  if (
    typeof HTMLImageElement !== "undefined" &&
    value instanceof HTMLImageElement
  ) {
    if (!value.complete || value.naturalWidth === 0) {
      return;
    }
    return canvasPreview(
      value,
      value.naturalWidth,
      value.naturalHeight,
      maxBytes
    );
  }

  if (value instanceof ArrayBuffer) {
    if (value.byteLength > maxBytes) {
      return;
    }
    return { dataBase64: arrayBufferToBase64(value), mimeType: "image/png" };
  }
}

export function extractAudioPreview(
  value: unknown,
  options?: MultimodalPreviewOptions
): MediaPreview | undefined {
  if (!(value instanceof ArrayBuffer) || value.byteLength === 0) {
    return;
  }

  const maxBytes = maxPreviewBytes(options, "audio");
  const bytes = new Uint8Array(value);
  if (isWebmAudio(bytes)) {
    return;
  }

  let mimeType = "audio/wav";
  if (isMp3(bytes)) {
    mimeType = "audio/mpeg";
  } else if (!isWav(bytes)) {
    return;
  }

  if (value.byteLength > maxBytes) {
    return;
  }

  return {
    dataBase64: arrayBufferToBase64(value),
    mimeType,
  };
}

export async function extractAudioPreviewAsync(
  value: unknown,
  options?: MultimodalPreviewOptions
): Promise<MediaPreview | undefined> {
  if (!(value instanceof ArrayBuffer) || value.byteLength === 0) {
    return;
  }

  const bytes = new Uint8Array(value);
  if (isWebmAudio(bytes)) {
    const wav = await transcodeAudioToWav(value, options);
    if (!wav) {
      return;
    }
    return {
      dataBase64: arrayBufferToBase64(wav),
      mimeType: "audio/wav",
    };
  }

  return extractAudioPreview(value, options);
}

export function extractMediaPreview(
  value: unknown,
  modality: string,
  options?: MultimodalPreviewOptions
): MediaPreview | undefined {
  if (modality === "image") {
    return extractImagePreview(value, options);
  }
  if (modality === "audio") {
    return extractAudioPreview(value, options);
  }
}

export function extractMediaPreviewAsync(
  value: unknown,
  modality: string,
  options?: MultimodalPreviewOptions
): Promise<MediaPreview | undefined> {
  if (modality === "image") {
    return Promise.resolve(extractImagePreview(value, options));
  }
  if (modality === "audio") {
    return extractAudioPreviewAsync(value, options);
  }
  return Promise.resolve(undefined);
}
