import {
  BuiltInAIObservability,
  readAssistantTurn,
} from "@built-in-ai-obs/sdk-browser";
import {
  buildAudioPrompt,
  buildImagePrompt,
  createAudioSession,
  createImageSession,
  loadAudioBuffer,
  loadImageBitmap,
  recordAudio,
} from "./multimodal.js";
import {
  DEFAULT_TOOL_PROMPT,
  TOOL_EXAMPLE_PROMPTS,
  TOOL_SYSTEM_PROMPT,
  tools,
  toolsByName,
  toolUseSupported,
  withoutNulls,
} from "./tools.js";

const params = new URLSearchParams(location.search);
const USE_SDK = params.get("sdk") !== "false";

const COLLECTOR_OTLP_URL = "http://localhost:4318/v1/traces";
const MLFLOW_OTLP_URL = "http://localhost:5000/v1/traces";

/**
 * `?experiment=<id>` points the exporter at a local MLflow, which ingests OTLP
 * but needs to be told which experiment to file traces under. `?otlp=<url>`
 * overrides the destination for any other collector.
 */
const experimentId = params.get("experiment");
const otlpUrl =
  params.get("otlp") ?? (experimentId ? MLFLOW_OTLP_URL : COLLECTOR_OTLP_URL);
const otlpHeaders: Record<string, string> = experimentId
  ? { "x-mlflow-experiment-id": experimentId }
  : {};

const modeInfo = document.getElementById("mode-info");
const output = document.getElementById("output");
const promptInput = document.getElementById("prompt") as HTMLTextAreaElement;
const form = document.getElementById("form") as HTMLFormElement;

const imagePromptInput = document.getElementById(
  "image-prompt"
) as HTMLTextAreaElement;
const imageFileInput = document.getElementById(
  "image-file"
) as HTMLInputElement;
const imagePreview = document.getElementById(
  "image-preview"
) as HTMLImageElement;

const audioPromptInput = document.getElementById(
  "audio-prompt"
) as HTMLTextAreaElement;
const audioFileInput = document.getElementById(
  "audio-file"
) as HTMLInputElement;
const audioPreview = document.getElementById(
  "audio-preview"
) as HTMLAudioElement;

type PlaygroundMode = "audio" | "image" | "text";

if (modeInfo) {
  modeInfo.textContent = USE_SDK
    ? `Mode: Built-in AI Observability SDK, exporting to ${otlpUrl}${
        experimentId ? ` (MLflow experiment ${experimentId})` : ""
      }`
    : "Mode: Extension only (no Built-in AI Observability SDK; use DevTools extension)";
}

if (USE_SDK) {
  const observability = new BuiltInAIObservability({
    captureInput: true,
    // MLflow builds its list previews and chat view from these; other backends
    // read the GenAI attributes and do not need them.
    captureMultimodalPreview: Boolean(experimentId),
    captureOutput: true,
    includeMlflowPreview: Boolean(experimentId),
    otlpHeaders,
    otlpUrl,
    serviceName: "playground",
  });
  await observability.start();
}

function setOutput(text: string) {
  if (output) {
    output.textContent = text;
  }
}

function formatError(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

function selectMode(mode: PlaygroundMode): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".mode-tabs [role=tab]"
  )) {
    const selected = button.dataset.mode === mode;
    button.setAttribute("aria-selected", String(selected));
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
    panel.hidden = panel.id !== `panel-${mode}`;
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>(
  ".mode-tabs [role=tab]"
)) {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode as PlaygroundMode | undefined;
    if (mode) {
      selectMode(mode);
    }
  });
}

promptInput.placeholder = DEFAULT_TOOL_PROMPT;

const toolExamples = document.getElementById("tool-examples");
if (toolExamples) {
  for (const example of TOOL_EXAMPLE_PROMPTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = example.label;
    button.title = example.prompt;
    button.addEventListener("click", () => {
      promptInput.value = example.prompt;
      promptInput.focus();
    });
    toolExamples.append(button);
  }
}

if ("LanguageModel" in globalThis) {
  let session: LanguageModel | null = null;
  let imageSession: LanguageModel | null = null;
  let audioSession: LanguageModel | null = null;
  let imageBitmap: ImageBitmap | null = null;
  let audioBuffer: ArrayBuffer | null = null;

  async function ensureSession(): Promise<LanguageModel> {
    if (!session) {
      session = await LanguageModel.create({
        expectedInputs: [{ languages: ["en"], type: "text" }],
        expectedOutputs: [{ languages: ["en"], type: "text" }],
        initialPrompts: [
          { content: "You are a helpful assistant.", role: "system" },
        ],
      });
    }
    return session;
  }

  async function ensureImageSession(): Promise<LanguageModel> {
    if (!imageSession) {
      imageSession = await createImageSession();
    }
    return imageSession;
  }

  async function ensureAudioSession(): Promise<LanguageModel> {
    if (!audioSession) {
      audioSession = await createAudioSession();
    }
    return audioSession;
  }

  /**
   * Reads one model turn off the stream. The stream is heterogeneous: text
   * arrives as bare strings and each tool call as its own structured chunk.
   */
  async function streamTurn(
    s: LanguageModel,
    input: LanguageModelPrompt,
    onText: (text: string) => void
  ): Promise<{ text: string; calls: LanguageModelToolCall[] }> {
    const reader = s.promptStreaming(input).getReader();
    const calls: LanguageModelToolCall[] = [];
    let text = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (typeof value === "string") {
        text += value;
        onText(text);
      } else if (value.type === "tool-call") {
        calls.push(value.value);
      }
    }

    return { calls, text };
  }

  let toolSession: LanguageModel | null = null;

  async function ensureToolSession(): Promise<LanguageModel> {
    if (!toolSession) {
      toolSession = await LanguageModel.create({
        expectedInputs: [
          { languages: ["en"], type: "text" },
          { type: "tool-response" },
          { type: "tool-call" },
        ],
        expectedOutputs: [
          { languages: ["en"], type: "text" },
          { type: "tool-call" },
        ],
        initialPrompts: [{ content: TOOL_SYSTEM_PROMPT, role: "system" }],
        tools,
      });
    }
    return toolSession;
  }

  async function runTool(
    call: LanguageModelToolCall
  ): Promise<LanguageModelToolResponse> {
    const tool = toolsByName.get(call.name);
    if (!tool) {
      return new LanguageModelToolError({
        callID: call.callID,
        errorMessage: `There is no tool named ${call.name}.`,
        name: call.name,
      });
    }

    try {
      const result = await tool.execute(call.arguments ?? {});
      return new LanguageModelToolSuccess({
        callID: call.callID,
        name: call.name,
        result: [{ type: "object", value: withoutNulls(result) }],
      });
    } catch (err) {
      return new LanguageModelToolError({
        callID: call.callID,
        errorMessage: err instanceof Error ? err.message : String(err),
        name: call.name,
      });
    }
  }

  const MAX_TOOL_ROUNDS = 5;

  async function runToolExchange(question: string): Promise<void> {
    const s = await ensureToolSession();
    const log = [`> ${question}`];
    const render = (extra = "") => {
      setOutput([...log, extra].filter(Boolean).join("\n"));
    };
    render("Thinking…");

    let input: LanguageModelPrompt = question;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const { text, calls } = await streamTurn(s, input, (partial) => {
        render(partial);
      });
      if (text) {
        log.push(text);
      }
      if (calls.length === 0) {
        render();
        return;
      }

      const responses: LanguageModelToolResponseContent[] = [];
      for (const call of calls) {
        log.push(`⚙ ${call.name}(${JSON.stringify(call.arguments)})`);
        render();
        responses.push({ type: "tool-response", value: await runTool(call) });
      }
      input = [{ content: responses, role: "user" }];
    }

    log.push(`Stopped after ${MAX_TOOL_ROUNDS} tool rounds.`);
    render();
  }

  function requireImage(): ImageBitmap {
    if (!imageBitmap) {
      throw new Error("Choose an image file first.");
    }
    return imageBitmap;
  }

  function requireAudio(): ArrayBuffer {
    if (!audioBuffer) {
      throw new Error("Record or choose an audio file first.");
    }
    return audioBuffer;
  }

  async function runImagePrompt(streaming: boolean): Promise<void> {
    const prompt = imagePromptInput.value.trim();
    if (!prompt) {
      return;
    }
    const s = await ensureImageSession();
    const input = buildImagePrompt(prompt, requireImage());
    setOutput(streaming ? "Streaming…" : "Generating…");
    if (streaming) {
      const { text } = await streamTurn(s, input, setOutput);
      setOutput(text);
      return;
    }
    const { text } = readAssistantTurn(await s.prompt(input));
    setOutput(text);
  }

  async function runAudioPrompt(streaming: boolean): Promise<void> {
    const prompt = audioPromptInput.value.trim();
    if (!prompt) {
      return;
    }
    const s = await ensureAudioSession();
    const input = buildAudioPrompt(prompt, requireAudio());
    setOutput(streaming ? "Streaming…" : "Generating…");
    if (streaming) {
      const { text } = await streamTurn(s, input, setOutput);
      setOutput(text);
      return;
    }
    const { text } = readAssistantTurn(await s.prompt(input));
    setOutput(text);
  }

  function setAudioPreview(buffer: ArrayBuffer, mimeType = "audio/webm"): void {
    audioBuffer = buffer;
    audioPreview.hidden = false;
    audioPreview.src = URL.createObjectURL(
      new Blob([buffer], { type: mimeType })
    );
  }

  imageFileInput.addEventListener("change", async () => {
    const file = imageFileInput.files?.[0];
    if (!file) {
      imageBitmap = null;
      imagePreview.hidden = true;
      imagePreview.removeAttribute("src");
      return;
    }
    try {
      imageBitmap?.close();
      imageBitmap = await loadImageBitmap(file);
      imagePreview.hidden = false;
      imagePreview.src = URL.createObjectURL(file);
    } catch (err) {
      imageBitmap = null;
      setOutput(formatError(err));
    }
  });

  audioFileInput.addEventListener("change", async () => {
    const file = audioFileInput.files?.[0];
    if (!file) {
      audioBuffer = null;
      audioPreview.hidden = true;
      audioPreview.removeAttribute("src");
      return;
    }
    try {
      setAudioPreview(await loadAudioBuffer(file), file.type || "audio/webm");
    } catch (err) {
      audioBuffer = null;
      setOutput(formatError(err));
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt) {
      return;
    }
    const s = await ensureSession();
    setOutput("Generating…");
    try {
      const { text } = readAssistantTurn(await s.prompt(prompt));
      setOutput(text);
    } catch (err) {
      setOutput(formatError(err));
    }
  });

  document.getElementById("stream")?.addEventListener("click", async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      return;
    }
    const s = await ensureSession();
    setOutput("Streaming…");
    try {
      const { text } = await streamTurn(s, prompt, setOutput);
      setOutput(text);
    } catch (err) {
      setOutput(formatError(err));
    }
  });

  document.getElementById("tool-call")?.addEventListener("click", async () => {
    if (!toolUseSupported()) {
      setOutput(
        "Tool use is not enabled. Turn on chrome://flags/#prompt-api-tool-use " +
          "and restart the browser."
      );
      return;
    }
    const question = promptInput.value.trim() || DEFAULT_TOOL_PROMPT;
    try {
      await runToolExchange(question);
    } catch (err) {
      setOutput(formatError(err));
    }
  });

  document.getElementById("clone")?.addEventListener("click", async () => {
    if (!session) {
      await ensureSession();
    }
    if (session) {
      session = await session.clone();
      setOutput("Session cloned.");
    }
  });

  document.getElementById("reset")?.addEventListener("click", async () => {
    session?.destroy();
    session = null;
    toolSession?.destroy();
    toolSession = null;
    imageSession?.destroy();
    imageSession = null;
    audioSession?.destroy();
    audioSession = null;
    imageBitmap?.close();
    imageBitmap = null;
    audioBuffer = null;
    promptInput.value = "";
    imageFileInput.value = "";
    audioFileInput.value = "";
    imagePreview.hidden = true;
    imagePreview.removeAttribute("src");
    audioPreview.hidden = true;
    audioPreview.removeAttribute("src");
    setOutput("All sessions reset.");
    await ensureSession();
  });

  document.getElementById("image-send")?.addEventListener("click", async () => {
    try {
      await runImagePrompt(false);
    } catch (err) {
      setOutput(formatError(err));
    }
  });

  document
    .getElementById("image-stream")
    ?.addEventListener("click", async () => {
      try {
        await runImagePrompt(true);
      } catch (err) {
        setOutput(formatError(err));
      }
    });

  document
    .getElementById("audio-record")
    ?.addEventListener("click", async () => {
      setOutput("Recording for 5 seconds…");
      try {
        setAudioPreview(await recordAudio());
        setOutput("Recording ready. Send or stream to transcribe.");
      } catch (err) {
        setOutput(formatError(err));
      }
    });

  document.getElementById("audio-send")?.addEventListener("click", async () => {
    try {
      await runAudioPrompt(false);
    } catch (err) {
      setOutput(formatError(err));
    }
  });

  document
    .getElementById("audio-stream")
    ?.addEventListener("click", async () => {
      try {
        await runAudioPrompt(true);
      } catch (err) {
        setOutput(formatError(err));
      }
    });
} else if (output) {
  output.textContent = "LanguageModel API not available in this browser.";
}
