import { browserResourceAttributes } from "@built-in-ai-obs/core";
import { ExtensionSpanExporter } from "@built-in-ai-obs/extension-transport";
import { PromptApiInstrumentation } from "@built-in-ai-obs/instrumentation-prompt-api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

const INSTALLED_KEY = "__webAiOtelInstalled";

const globals = globalThis as Record<string, unknown>;

// Runs at document_start in the page's MAIN world. Everything below is
// synchronous so the API is patched before any page script can call it.
if (!globals[INSTALLED_KEY]) {
  globals[INSTALLED_KEY] = true;

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "web-ai-page",
      ...browserResourceAttributes(),
    }),
    spanProcessors: [new SimpleSpanProcessor(new ExtensionSpanExporter())],
  });

  // Deliberately not calling provider.register(): that would replace the
  // page's own global OpenTelemetry context, which we must not disturb.
  const instrumentation = new PromptApiInstrumentation({
    captureInput: true,
    captureMultimodalPreview: true,
    captureOutput: true,
    includeMlflowPreview: true,
    tracerProvider: provider,
  });
  instrumentation.enable();
}
