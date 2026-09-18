const DEFAULT_RECORD_MS = 5000;

export function loadImageBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

export function loadAudioBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

/** Records microphone input for a fixed duration, like the MediaRecorder sample. */
export async function recordAudio(
  durationMs = DEFAULT_RECORD_MS
): Promise<ArrayBuffer> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const chunks: BlobPart[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = ({ data }) => {
      chunks.push(data);
    };
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    recorder.stop();
    await new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    return new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
  } finally {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

export function buildImagePrompt(
  text: string,
  image: ImageBitmap
): LanguageModelPrompt {
  return [
    {
      content: [
        { type: "text", value: text },
        { type: "image", value: image },
      ],
      role: "user",
    },
  ];
}

export function buildAudioPrompt(
  text: string,
  audio: ArrayBuffer
): LanguageModelPrompt {
  return [
    {
      content: [
        { type: "text", value: text },
        { type: "audio", value: audio },
      ],
      role: "user",
    },
  ];
}

export function createImageSession(): Promise<LanguageModel> {
  return LanguageModel.create({
    expectedInputs: [{ type: "image" }, { languages: ["en"], type: "text" }],
    expectedOutputs: [{ languages: ["en"], type: "text" }],
  });
}

export function createAudioSession(): Promise<LanguageModel> {
  return LanguageModel.create({
    expectedInputs: [{ type: "audio" }, { languages: ["en"], type: "text" }],
    expectedOutputs: [{ languages: ["en"], type: "text" }],
  });
}
