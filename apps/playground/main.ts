import { readAssistantTurn, WebAISDK } from "@web-ai-otel/sdk-browser";
import {
  TOOL_SYSTEM_PROMPT,
  tools,
  toolsByName,
  toolUseSupported,
  withoutNulls,
} from "./tools.js";

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

    return { text, calls };
  }

  let toolSession: LanguageModel | null = null;

  async function ensureToolSession(): Promise<LanguageModel> {
    if (!toolSession) {
      toolSession = await LanguageModel.create({
        expectedInputs: [
          { type: "text", languages: ["en"] },
          { type: "tool-response" },
          { type: "tool-call" },
        ],
        expectedOutputs: [
          { type: "text", languages: ["en"] },
          { type: "tool-call" },
        ],
        tools,
        initialPrompts: [{ role: "system", content: TOOL_SYSTEM_PROMPT }],
      });
    }
    return toolSession;
  }

  async function runTool(
    call: LanguageModelToolCall
  ): Promise<LanguageModelToolResponse> {
    const tool = toolsByName.get(call.name);
    if (!tool) {
      // Report an invented tool back as an error, so the model can correct
      // itself instead of the turn dying.
      return new LanguageModelToolError({
        callID: call.callID,
        name: call.name,
        errorMessage: `There is no tool named ${call.name}.`,
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
        name: call.name,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const MAX_TOOL_ROUNDS = 5;

  /**
   * Runs the tool loop the way a real app does: stream a turn, run whatever it
   * asked for, feed the results back, repeat. Each round is another
   * `generate_content` span, and the instrumentation stitches them into a
   * single trace because the input carries tool responses.
   */
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
      input = [{ role: "user", content: responses }];
    }

    log.push(`Stopped after ${MAX_TOOL_ROUNDS} tool rounds.`);
    render();
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
      const { text } = readAssistantTurn(await s.prompt(prompt));
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
      const { text } = await streamTurn(s, prompt, setOutput);
      setOutput(text);
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
    const question =
      promptInput.value.trim() ||
      "What is the weather and the population of Kyoto?";
    try {
      await runToolExchange(question);
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
    toolSession?.destroy();
    toolSession = null;
    promptInput.value = "";
    setOutput("Session reset.");
    await ensureSession();
  });
} else if (output) {
  output.textContent = "LanguageModel API not available in this browser.";
}
