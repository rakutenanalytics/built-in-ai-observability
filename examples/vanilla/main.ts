import { readAssistantTurn, WebAISDK } from "@web-ai-otel/sdk-browser";

const sdk = new WebAISDK({
  captureInput: false,
  captureOutput: false,
  serviceName: "vanilla-example",
});
await sdk.start();

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
