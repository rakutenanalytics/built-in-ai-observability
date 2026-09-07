import { WebAISDK } from "@web-ai-otel/sdk-browser";

const USE_SDK = new URLSearchParams(location.search).get("sdk") !== "false";

const modeInfo = document.getElementById("mode-info");
const output = document.getElementById("output");
const promptInput = document.getElementById("prompt") as HTMLTextAreaElement;
const form = document.getElementById("form") as HTMLFormElement;

if (modeInfo) {
  modeInfo.textContent = USE_SDK
    ? "Mode: Production SDK (OTLP export enabled)"
    : "Mode: Extension only (no SDK — use DevTools extension)";
}

if (USE_SDK) {
  const sdk = new WebAISDK({
    serviceName: "playground",
    otlpUrl: "http://localhost:4318/v1/traces",
    captureInput: true,
    captureOutput: true,
  });
  await sdk.start();
}

if ("LanguageModel" in globalThis) {
  let session: LanguageModel | null = null;

  async function ensureSession(): Promise<LanguageModel> {
    if (!session) {
      session = await LanguageModel.create({
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        initialPrompts: [
          { role: "system", content: "You are a helpful assistant." },
        ],
      });
    }
    return session;
  }

  function setOutput(text: string) {
    if (output) {
      output.textContent = text;
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt) {
      return;
    }
    const s = await ensureSession();
    setOutput("Generating…");
    try {
      const text = await s.prompt(prompt);
      setOutput(text);
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
      let text = "";
      // Chrome does not support async iteration of ReadableStream yet.
      const reader = s.promptStreaming(prompt).getReader();
      let reading = true;
      while (reading) {
        const { done, value } = await reader.read();
        if (done) {
          reading = false;
          break;
        }
        text += value;
        setOutput(text);
      }
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
    promptInput.value = "";
    setOutput("Session reset.");
    await ensureSession();
  });
} else if (output) {
  output.textContent = "LanguageModel API not available in this browser.";
}
