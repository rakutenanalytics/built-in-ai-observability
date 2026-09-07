# Implementation proposal: Web AI OpenTelemetry monorepo

Discovery based on `web-ai-demos/prompt-api-observability/` (PoC).

## 1. Reusable code from the PoC

| PoC artifact | Reuse plan |
| --- | --- |
| `telemetry.js` semantic constants (`GEN_AI`, `WEB_AI`) | Move to `@web-ai-otel/core` |
| Message encoding (`encodeInputMessages`, redaction) | Move to `core` |
| Context window helpers (`readContextWindow`, `contextAttributes`) | Move to `core` |
| Session state + overflow reconciliation | Move to `instrumentation-prompt-api` |
| `tracedPrompt` / `tracedPromptStreaming` logic | Move to `instrumentation-prompt-api` |
| Browser resource attributes | Move to `core` |
| `initTelemetry` + OTLP exporter wiring | Move to `sdk-browser` |
| `createInstrumentedSession` wrapper pattern | **Replace** with global `LanguageModel` patching (required for zero-code extension) |
| MLflow-specific `mlflow.spanInputs/Outputs` | Optional attributes in instrumentation config, not required for core path |
| `script.js` playground UI | Basis for `apps/playground` |

**Not copied:** monolithic file structure, app-level wrapper requirement, MLflow as default backend.

## 2. Monorepo structure (final)

```text
built-in-ai-observability/
├── packages/
│   ├── core/                         # Semantic conventions, types, browser attrs, message encoding
│   ├── instrumentation-prompt-api/   # Host-agnostic LanguageModel patching
│   ├── sdk-browser/                  # WebTracerProvider + instrumentation registration
│   ├── extension-transport/          # SpanExporter → postMessage bridge protocol
│   ├── instrumentation-{api}/      # Placeholders only (README each)
├── apps/
│   ├── devtools-extension/           # MV3 DevTools panel + background + content scripts
│   └── playground/                   # Manual test app (SDK mode + extension mode)
├── examples/
│   └── vanilla/                      # Minimal SDK integration example
```

**Deviation from proposal:** No separate `exporter-otlp` package. The SDK uses `@opentelemetry/exporter-trace-otlp-http` directly. A thin wrapper adds no value in iteration 1.

## 3. OpenTelemetry dependencies

Aligned with the PoC (OTel JS 2.x):

| Package | Version |
| --- | --- |
| `@opentelemetry/api` | ^1.9.0 |
| `@opentelemetry/resources` | ^2.1.0 |
| `@opentelemetry/sdk-trace-base` | ^2.1.0 |
| `@opentelemetry/sdk-trace-web` | ^2.1.0 |
| `@opentelemetry/exporter-trace-otlp-http` | ^0.205.0 |
| `@opentelemetry/semantic-conventions` | ^1.28.0 |

Types: ambient declarations in `types/prompt-api.d.ts`. `@types/dom-chromium-ai` was the intended source, but its tool types describe the superseded `execute` callback design; see the file header.

## 4. Prompt API methods to instrument

| Method | Span | Notes |
| --- | --- | --- |
| `LanguageModel.availability()` | `web_ai.check_availability` | Records result status, options |
| `LanguageModel.create()` | `web_ai.create_session` | Session config, context window |
| `session.prompt()` | `generate_content` | GenAI inference span |
| `session.promptStreaming()` | `generate_content` | + TTFT, chunk count |
| `session.clone()` | `web_ai.clone_session` | Parent session id linkage |
| `session.destroy()` | `web_ai.destroy_session` | |
| `session.append()` | Pass-through in v1 | Low priority; document as gap |

## 5. OTel GenAI conventions per operation

| Operation | `gen_ai.operation.name` | Span kind |
| --- | --- | --- |
| `prompt` / `promptStreaming` | `generate_content` | `INTERNAL` (in-process model) |
| `create` | (none — not inference) | `INTERNAL` |
| `availability` | (none) | `INTERNAL` |
| `clone` / `destroy` | (none) | `INTERNAL` |

Standard attributes on inference spans: `gen_ai.provider.name`, `gen_ai.conversation.id`, `gen_ai.request.stream`, `gen_ai.output.type`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.response.finish_reasons`, `gen_ai.response.time_to_first_chunk`, `gen_ai.conversation.compacted`.

**Unset by design:** `gen_ai.request.model`, `gen_ai.usage.*` (Prompt API has no model id or per-request token counts).

## 6. Experimental Web AI attributes

| Attribute | Why |
| --- | --- |
| `web_ai.context.window_tokens` | Context window size; not tokens per OTel definition |
| `web_ai.context.usage_*` | Before/after/delta/remaining/utilization |
| `web_ai.context.overflowed` | Compaction indicator |
| `web_ai.stream.chunk_count` | Streaming metadata |
| `web_ai.conversation.turn_index` | Turn ordering within session |
| `web_ai.request.sampling_mode` | Prompt API config |
| `web_ai.session.expected_inputs/outputs` | Session modality config |
| `web_ai.runtime.browser.name/version` | Runtime identity (also `browser.*` where standard) |
| `web_ai.runtime.device_memory_gib` | Coarse hardware hint |
| `web_ai.session.id` | Stable Web AI session id (maps to `gen_ai.conversation.id`) |
| `web_ai.session.parent_id` | Clone parent linkage |
| `web_ai.availability.status` | Result of `availability()` |

## 7. Dual deployment: SDK vs extension MAIN world

Both call the same API:

```typescript
import { PromptApiInstrumentation } from "@web-ai-otel/instrumentation-prompt-api";

const instrumentation = new PromptApiInstrumentation({
  tracerProvider, // or uses global tracer
  captureInput: false,
  captureOutput: false,
});
instrumentation.enable();
```

- **SDK:** `WebAISDK.start()` creates `WebTracerProvider`, registers OTLP exporter, enables instrumentation.
- **Extension:** MAIN-world bundle creates a minimal `WebTracerProvider` with `ExtensionSpanExporter`, enables the same instrumentation class.

Patching strategy: replace `LanguageModel.create` and wrap returned session prototypes. Idempotent enable/disable. Preserves `this` binding and original behavior.

## 8. Extension communication architecture

```text
MAIN world (interceptor.js)
  → ExtensionSpanExporter.onEnd(span)
  → postMessage({ type: "web-ai-otel:span", payload: SerializedSpan })

ISOLATED content script (bridge.js)
  → validate schema, ignore unknown page messages
  → chrome.runtime.sendMessage({ type: "span", ... })

Service worker (background.js)
  → append to IndexedDB
  → notify DevTools panel (chrome.runtime.sendMessage)

DevTools panel (panel.js)
  → query IndexedDB, render trace list + span tree
```

Message schema is versioned (`protocolVersion: 1`). Only `web-ai-otel:*` types accepted.

Frame metadata attached in bridge: `tabId`, `frameId`, `url`, `origin` from `chrome.runtime` APIs.

## 9. IndexedDB persistence

Single database `web-ai-otel`, version 1.

| Store | Key | Value |
| --- | --- | --- |
| `spans` | `spanId` | Serialized OTel span + traceId + frame metadata |
| `traces` | `traceId` | Trace summary (root span name, start, duration, origin) |

Indexes: `traces` by `origin` + `startTime`. TTL eviction: delete traces older than 7 days (configurable).

No separate `applications` / `pageSessions` tables in v1. Origin and URL live on trace records.

## 10. DevTools UI (v1)

Panel name: **AI Traces**.

- Left: trace list grouped by origin, sorted by time
- Right: span tree with timing, status, input/output (when captured), context attrs, raw JSON
- Actions: clear all, export JSON, export OTLP JSON

No waterfall chart in v1.

## 11. Export strategy

- **DevTools:** Download JSON array of spans (OTel-compatible structure). Optional OTLP/HTTP export to user-configured endpoint (manual action, not automatic).
- **SDK:** Standard `OTLPTraceExporter` to collector or MLflow (`/v1/traces`).

## 12. Risks and limitations

| Risk | Mitigation |
| --- | --- |
| Early `LanguageModel` reference capture before injection | `document_start` + `world: MAIN` content script |
| Cross-origin iframe instrumentation | Inject in all frames; record `frameId` / `origin` |
| `activeTab` insufficient from DevTools panel | Use `tabs` permission + `host_permissions` |
| MAIN-world postMessage spoofing | Strict schema validation; no privileged ops from page |
| Large prompt/output attributes | Configurable capture + max attribute length truncation |
| Service worker ephemerality | Persist state in `chrome.storage` + IndexedDB |
| PoC wrapper vs patch semantic drift | Equivalence tests comparing SDK and extension output |

## Session identity decision

One `gen_ai.conversation.id` per `LanguageModel.create()` call. Cloned sessions get a new id with `web_ai.session.parent_id` pointing to the source. `session.id` retained as alias for MLflow compatibility when configured.
