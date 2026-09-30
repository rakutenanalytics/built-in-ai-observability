# Built-in AI Observability

Observability for browser Built-in AI APIs, built on the [OpenTelemetry Browser SDK](https://github.com/open-telemetry/opentelemetry-browser). Instrumentation patches Built-in AI APIs in the page and exports standard OpenTelemetry spans.

`@built-in-ai-obs/instrumentation-prompt-api` patches `LanguageModel` and records spans for each API call. Export those spans from your app with `@built-in-ai-obs/sdk-browser` (`BuiltInAIObservability`, OTLP/HTTP), or load the Chrome DevTools extension to inject the same instrumentation at `document_start` and inspect traces in the **AI Traces** panel.

## Quick start

### Prerequisites

- Node.js 22.18+, 24.11+, or 26+ (required for `tsdown` builds; see `.nvmrc`)
- pnpm 12+
- [Browser with Prompt API support](https://developer.mozilla.org/en-US/docs/Web/API/Prompt_API#browser_compatibility) (for live testing)

### Install

```bash
cd built-in-ai-observability
pnpm install
pnpm build
```


### Built-in AI Observability SDK

```typescript
import { BuiltInAIObservability } from "@built-in-ai-obs/sdk-browser";

const observability = new BuiltInAIObservability({
  serviceName: "my-app",
  otlpUrl: "http://localhost:4318/v1/traces",
  captureInput: false,
  captureOutput: false,
});

await observability.start();

// Use LanguageModel as usual; calls are traced automatically.
const session = await LanguageModel.create({ … });
```

See [`examples/minimal/`](./examples/minimal/) for a complete app.

### DevTools extension

```bash
pnpm build:extension
```

Load `apps/devtools-extension/dist` as an unpacked extension in Chrome. Open DevTools on any page using the Prompt API and select the **AI Traces** panel.

The extension injects instrumentation at `document_start` in the page context, before the app can hold references to the unpatched API. The injected provider is not registered as the page's global OpenTelemetry provider.

The panel shows traces for the tab you are inspecting only. Traces drop when their tab closes; the newest 2000 traces per profile are retained. See [docs/telemetry-reference.md](./docs/telemetry-reference.md#traces-and-sessions) for trace layout and panel behavior.

### Playground

The playground is the kitchen-sink harness used to develop this repo — it exercises every instrumentation path in one page. For code to copy into your own app, use `examples/` instead.

```bash
pnpm dev:playground
```

Tabs cover plain text, image and audio prompts, and tool calling.

- Default: Built-in AI Observability SDK, exporting OTLP to a collector on `localhost:4318`
- Extension-only: `?sdk=false` (no Built-in AI Observability SDK; use the extension)
- MLflow: `?experiment=<id>` exports to a local MLflow server. Also turns on [multimodal previews](./docs/telemetry-reference.md#multimodal-content). `?otlp=<url>` points anywhere else.

```bash
pnpm mlflow   # http://localhost:5000, then open ?experiment=0
```



## Packages


| Package                                   | Purpose                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `@built-in-ai-obs/core`                       | Semantic conventions, types, message encoding, browser runtime attrs |
| `@built-in-ai-obs/instrumentation-prompt-api` | Host-agnostic `LanguageModel` instrumentation                        |
| `@built-in-ai-obs/sdk-browser`                | Built-in AI Observability SDK                                             |
| `@built-in-ai-obs/extension-transport`        | Span exporter for extension `postMessage` bridge                     |

## Repository layout

| Directory  | Contents                                                                        |
| ---------- | ------------------------------------------------------------------------------- |
| `packages/`| Published libraries                                                              |
| `examples/`| Minimal apps written to be read and copied into your own project                 |
| `apps/`    | The DevTools extension (shipped) and the playground (internal harness, not a template) |

## Privacy

- `captureInput` / `captureOutput` control prompt and response content in spans
- Built-in AI Observability SDK defaults: content capture off
- DevTools extension defaults: content capture on (local debugging)
- `gen_ai.*` attributes never carry image or audio bytes; multimodal parts are redacted to their modality
- `captureMultimodalPreview` writes re-encoded previews to `mlflow.spanInputs` only. Off by default in the Built-in AI Observability SDK; on in the extension. See [multimodal content](./docs/telemetry-reference.md#multimodal-content).

Telemetry never leaves the browser unless you configure an exporter or explicitly export from DevTools.

## Development

```bash
pnpm dev        # watch mode (packages)
pnpm build      # build all packages
pnpm test       # run tests
pnpm typecheck  # tsc across every package and app
pnpm check      # lint + format check (full repo)
pnpm format     # auto-fix lint and formatting (full repo)

# Apps and examples
pnpm dev:playground
pnpm dev:minimal
pnpm dev:extension
pnpm build:extension
pnpm mlflow     # local MLflow server for trace viewing
```

Pre-commit hooks ([Lefthook](https://lefthook.dev/)) run [Ultracite](https://github.com/haydenbleasel/ultracite) on staged files after `pnpm install`. Run the hook manually with `pnpm precommit`. For emergencies: `git commit --no-verify`.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).