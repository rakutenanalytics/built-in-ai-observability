import { describe, expect, it } from "vitest";
import {
  audioFormatFromMime,
  encodeWavFromSamples,
  extractAudioPreview,
  isWebmAudio,
  mediaPreviewDataUri,
} from "../src/attributes/multimodal.js";

describe("audioFormatFromMime", () => {
  it("maps wav MIME types", () => {
    expect(audioFormatFromMime("audio/wav")).toBe("wav");
    expect(audioFormatFromMime("audio/x-wav")).toBe("wav");
  });

  it("defaults other audio MIME types to mp3", () => {
    expect(audioFormatFromMime("audio/webm")).toBe("mp3");
    expect(audioFormatFromMime("audio/mpeg")).toBe("mp3");
  });
});

describe("encodeWavFromSamples", () => {
  it("writes a PCM WAV header that matches the sample rate and length", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWavFromSamples(samples, 8000);
    const view = new DataView(wav);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1))).toBe("RI");
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16_384);
    expect(view.getInt16(48, true)).toBe(-16_383);
  });

  it("caps PCM data to stay within a byte budget", () => {
    const maxBytes = 1000;
    const maxSamples = Math.floor((maxBytes - 44) / 2);
    const samples = new Float32Array(maxSamples + 500).fill(0.25);
    const wav = encodeWavFromSamples(samples.subarray(0, maxSamples), 8000);
    expect(wav.byteLength).toBeLessThanOrEqual(maxBytes);
    expect(new DataView(wav).getUint32(40, true)).toBe(maxSamples * 2);
  });
});

describe("extractAudioPreview", () => {
  it("returns base64 for small WAV buffers", () => {
    const { buffer } = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00,
      0x64, 0x61, 0x74, 0x61, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const preview = extractAudioPreview(buffer);
    expect(preview?.mimeType).toBe("audio/wav");
    if (!preview) {
      throw new Error("expected preview");
    }
    expect(mediaPreviewDataUri(preview)).toBe(
      `data:audio/wav;base64,${preview.dataBase64}`
    );
  });

  it("defers browser WebM audio to async transcoding", () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
    expect(isWebmAudio(webm)).toBe(true);
    expect(extractAudioPreview(webm.buffer)).toBeUndefined();
  });

  it("skips buffers larger than the preview limit", () => {
    const { buffer } = new Uint8Array(600_000);
    expect(
      extractAudioPreview(buffer, { maxPreviewBytes: 512_000 })
    ).toBeUndefined();
  });
});
