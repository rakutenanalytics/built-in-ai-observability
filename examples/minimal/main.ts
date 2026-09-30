import {
  BuiltInAIObservability,
  readAssistantTurn,
} from "@built-in-ai-obs/sdk-browser";

const observability = new BuiltInAIObservability({
  captureInput: false,
  captureOutput: false,
  serviceName: "minimal-example",
});
await observability.start();

const out = document.getElementById("out");
document.getElementById("run")?.addEventListener("click", async () => {
  if (!("LanguageModel" in globalThis)) {
    if (out) {
      out.textContent = "LanguageModel not available.";
    }
    return;
  }
  const session = await LanguageModel.create();
  // No tools are declared here, so the turn is always plain text.
  const { text } = readAssistantTurn(
    await session.prompt("Say hello in one sentence.")
  );
  if (out) {
    out.textContent = text;
  }
});
