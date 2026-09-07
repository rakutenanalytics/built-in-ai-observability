# Web AI OpenTelemetry

OpenTelemetry instrumentation for browser Web AI APIs. One shared instrumentation library, two ways to run it: a production browser SDK, or a Chrome DevTools extension that instruments pages without code changes.

Browser-local AI runs inside the page. Network-level observability never sees the prompts, the model calls, or context window usage. This project instruments the Web AI APIs directly and exports standard OpenTelemetry spans.

## Two usage modes

```
Production SDK                    Chrome DevTools extension
      │                                    │
      ▼                                    ▼
 same @web-ai-otel/instrumentation-prompt-api
      │                                    │
      ▼                                    ▼
 OpenTelemetry spans              OpenTelemetry spans
      │                                    │
      ▼                                    ▼
 OTLP exporter                   IndexedDB + trace explorer
      │                                    │
      ▼                                    ▼
 Collector / MLflow / …           Export JSON / OTLP
```

## Architecture

```text
Web AI APIs (LanguageModel, …)
        │
        ▼
Shared instrumentation packages
        │
        ▼
OpenTelemetry API (spans, events, attributes)
        │
   ┌────┴────┐
   │         │
 SDK     Extension MAIN-world injector
   │         │
 OTLP    Extension transport → IndexedDB → DevTools panel
```

OpenTelemetry is the canonical telemetry model. MLflow, Langfuse, Grafana, Phoenix, and other backends are export destinations, not internal trace formats.

## Current support

| API | Status |
| --- | --- |
| Prompt API (`LanguageModel`) | Initial implementation |
| Summarizer API | Planned |
| Writer API | Planned |
| Rewriter API | Planned |
| Translator API | Planned |
| Language Detector API | Planned |
| Semantic Embedder API | Planned |
| WebMCP | Future exploration |

## Quick start

### Prerequisites

- Node.js 20+
- pnpm 10+
- Chrome with Prompt API support (for live testing)

### Install

```bash
cd built-in-ai-observability
pnpm install
pnpm build
```

### Production SDK

```typescript
import { WebAISDK } from "@web-ai-otel/sdk-browser";

const sdk = new WebAISDK({
  serviceName: "my-app",
  otlpUrl: "http://localhost:4318/v1/traces",
  captureInput: false,
  captureOutput: false,
});

await sdk.start();

// Use LanguageModel as usual — calls are traced automatically.
const session = await LanguageModel.create({ … });
```

See `examples/vanilla/` for a minimal app.

### DevTools extension

```bash
pnpm --filter @web-ai-otel/devtools-extension build
```

Load `apps/devtools-extension/dist` as an unpacked extension in Chrome. Open DevTools on any page using the Prompt API and select the **AI Traces** panel.

The extension injects instrumentation at `document_start` in the MAIN world, before application code can capture references to the original API. Installation is fully synchronous for that reason — nothing is awaited before `LanguageModel` is patched.

The panel only shows traces recorded for the tab you are inspecting; attribution comes from the message sender rather than the page, so it cannot be spoofed by page scripts. Traces are dropped when their tab closes, and the newest 2000 traces per profile are retained.

The injected provider is deliberately **not** registered as the page's global OpenTelemetry provider, so the extension never disturbs an app's own OpenTelemetry setup.

### Playground

```bash
pnpm --filter @web-ai-otel/playground dev
```

- Default: SDK mode with OTLP export
- Extension-only: `http://localhost:5173?sdk=false` (no SDK; use the extension)

## Packages

| Package | Purpose |
| --- | --- |
| `@web-ai-otel/core` | Semantic conventions, types, message encoding, browser runtime attrs |
| `@web-ai-otel/instrumentation-prompt-api` | Host-agnostic `LanguageModel` instrumentation |
| `@web-ai-otel/sdk-browser` | Production browser SDK |
| `@web-ai-otel/extension-transport` | Span exporter for extension `postMessage` bridge |

## Semantic conventions

Inference spans follow [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai) where they apply. Browser-specific gaps use experimental `web_ai.*` attributes (context window usage, streaming chunk count, model download state, session config, and similar).

Context window measurements are **not** mapped to `gen_ai.usage.*` token counts. The Prompt API reports context occupancy, not per-request token billing.

Every span carries `web_ai.api.name` so traces stay attributable once more Web AI APIs are instrumented. Spans emitted per session:

| Span | When |
| --- | --- |
| `web_ai.create_session` | `LanguageModel.create()`, including model download state |
| `web_ai.check_availability` | `LanguageModel.availability()` |
| `generate_content` | `prompt()` and `promptStreaming()` |
| `web_ai.clone_session` | `clone()`; keeps `gen_ai.conversation.id`, new session id |
| `web_ai.destroy_session` | `destroy()` |

### Model download state

`web_ai.model.download_observed` is only set when a `downloadprogress` event reports *fractional* progress. Chrome fires `loaded: 0` immediately followed by `loaded: 1` even when the model is already on disk, so treating the first event as a download start reports one on every `create()`. `web_ai.model.download_duration` and the `web_ai.model.download_complete` event are likewise emitted only once real progress is seen; an instantaneous download is therefore reported as no download rather than a phantom one.

## Traces and sessions

Only `generate_content` is instrumented today, so each operation is its own single-span trace. That is the expected shape at this stage: once tool calling is instrumented, one trace will hold several `generate_content` spans plus the tool call and result spans beneath them.

Because a trace is currently one operation, conversation-level context comes from the **session**: every span carries `gen_ai.conversation.id` (mirrored to `session.id` and `web_ai.session.id`), and clones inherit the conversation while getting a fresh `web_ai.session.id` plus `web_ai.session.parent_id`.

The DevTools panel therefore offers two views, mirroring how MLflow separates traces from chat sessions:

| View | Shows |
| --- | --- |
| **Traces** | Every individual trace, newest first, with span count and duration |
| **Sessions** | Traces grouped by `gen_ai.conversation.id`, with request/response previews, turn count, errors, and context-window usage |

Both views are scoped to the tab you are inspecting, and the header shows which tab and origin that is. Spans without a conversation (such as `web_ai.check_availability`) appear only under Traces.

Stored data is a disposable local cache: traces (with their spans) and sessions are each capped independently and pruned oldest-first, and closing a tab clears its traces.

When tool calling arrives, nested spans in the extension will need the parent threaded explicitly through `SessionState`, because the injected provider is not registered globally and therefore has no ambient context manager.

## Known limitations

- **The MAIN-world → extension channel is page-observable.** The instrumented page must hand spans to the isolated world via `postMessage`, so other scripts on the page can observe them. The page already owns this data, but on pages with third-party scripts, prefer leaving content capture off. Payloads are structurally validated before they reach the privileged extension context.
- **Chrome does not support async iteration of `ReadableStream`.** Consume `promptStreaming()` with `getReader()`.
- **Token usage is unavailable.** The Prompt API exposes no per-request token counts.

## Privacy

- `captureInput` / `captureOutput` control prompt and response content in spans
- SDK defaults: content capture off
- DevTools extension defaults: content capture on (local debugging)
- Image and audio parts are never exported as bytes; they are redacted

Telemetry never leaves the browser unless you configure an exporter or explicitly export from DevTools.

## Development

```bash
pnpm dev        # watch mode (packages)
pnpm build      # build all packages
pnpm test       # run tests
pnpm typecheck  # tsc across every package and app
pnpm check      # lint + format check
pnpm format     # auto-fix lint and formatting
```

Lint rules come from [Ultracite](https://github.com/haydenbleasel/ultracite) via `biome.jsonc`, but the scripts call Biome directly because `ultracite check` currently fails to render diagnostics.

Ambient Prompt API types live in `types/prompt-api.d.ts` and are shared by every package that needs them, rather than relying on `@types/dom-chromium-ai` (which still describes the older `ai.languageModel` shape).

## Relationship to the PoC

This repo refactors concepts from `web-ai-demos/prompt-api-observability/`. The PoC used an explicit `createInstrumentedSession()` wrapper; this project patches `LanguageModel` globally so the same instrumentation works in both SDK and extension modes.

See `docs/implementation-proposal.md` for design decisions.

## License

Apache-2.0
