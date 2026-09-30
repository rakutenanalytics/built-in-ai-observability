# Minimal example

The smallest app that traces the Prompt API: one button, one `LanguageModel.prompt()` call, spans exported over OTLP/HTTP.

No framework and no build config beyond Vite's defaults.

## Run it

From the repository root:

```bash
pnpm install
pnpm build          # build the workspace packages this example links against
pnpm dev:minimal
```

Requires a [browser with Prompt API support](https://developer.mozilla.org/en-US/docs/Web/API/Prompt_API#browser_compatibility).

## See the traces

Spans are exported to `http://localhost:4318/v1/traces`, the OTLP/HTTP default. Start a collector before clicking **Run prompt**, or the export will fail silently.

A local MLflow server is the quickest option:

```bash
pnpm mlflow         # from the repository root, then open http://localhost:5000/?experiment=0
```

Any OTLP/HTTP collector works — pass `otlpUrl` to point somewhere else.

## What the code does

[`main.ts`](./main.ts) is the whole example:

1. Construct `BuiltInAIObservability` with a `serviceName` and await `start()`. This patches `LanguageModel` and wires up the exporter, and must happen before the app holds a reference to the API.
2. Call `LanguageModel.create()` and `session.prompt()` as normal. Instrumentation is transparent — no telemetry code at the call site.
3. Pass the result through `readAssistantTurn()` to get the text.

Content capture is off (`captureInput` / `captureOutput` are `false`), which is the SDK default: spans carry timings, model metadata, and token counts, but no prompt or response text. Turn them on for local debugging.

## Next steps

- [Telemetry reference](../../docs/telemetry-reference.md) — spans and attributes emitted
- [DevTools extension](../../README.md#devtools-extension) — inspect traces in Chrome without wiring up an exporter
