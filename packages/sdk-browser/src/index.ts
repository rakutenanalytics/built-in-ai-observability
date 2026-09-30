import {
  browserResourceAttributes,
  DEFAULT_CAPTURE_CONFIG,
  type InstrumentationConfig,
} from "@built-in-ai-obs/core";
import { PromptApiInstrumentation } from "@built-in-ai-obs/instrumentation-prompt-api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

/**
 * Re-exported because tool use changed what a turn resolves to: `prompt()`
 * answers with a content sequence rather than a string as soon as the model
 * asks for a tool, and every caller now has to split the two apart.
 */
export {
  type AssistantTurn,
  readAssistantTurn,
  type ToolCallInfo,
  type ToolResponseInfo,
} from "@built-in-ai-obs/core";

const DEFAULT_OTLP_URL = "http://localhost:4318/v1/traces";

export interface BuiltInAIObservabilityOptions
  extends Partial<InstrumentationConfig> {
  otlpHeaders?: Record<string, string>;
  otlpUrl?: string;
  /** Enable Prompt API instrumentation. Defaults to true. */
  prompt?: boolean;
  /**
   * Register this provider as the global OpenTelemetry tracer provider.
   * Disable when the host app already manages its own. Defaults to true.
   */
  registerGlobal?: boolean;
  serviceName?: string;
}

export class BuiltInAIObservability {
  private provider: WebTracerProvider | null = null;
  private instrumentation: PromptApiInstrumentation | null = null;
  private teardown: Array<() => void> = [];
  private readonly options: BuiltInAIObservabilityOptions;

  constructor(options: BuiltInAIObservabilityOptions = {}) {
    this.options = { ...DEFAULT_CAPTURE_CONFIG, ...options };
  }

  /**
   * Installs instrumentation. Synchronous internally so that no Prompt API call
   * can slip through untraced, despite the Promise-returning signature.
   */
  start(): Promise<void> {
    if (this.provider) {
      return Promise.resolve();
    }

    const {
      serviceName = "web-ai-app",
      otlpUrl = DEFAULT_OTLP_URL,
      otlpHeaders = {},
      prompt = true,
      registerGlobal = true,
      ...instrumentationConfig
    } = this.options;

    this.provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        "service.name": serviceName,
        ...browserResourceAttributes(),
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ headers: otlpHeaders, url: otlpUrl })
        ),
      ],
    });

    if (registerGlobal) {
      this.provider.register();
    }

    if (prompt) {
      this.instrumentation = new PromptApiInstrumentation({
        ...instrumentationConfig,
        tracerProvider: this.provider,
      });
      this.instrumentation.enable();
    }

    this.installFlushHooks();
    return Promise.resolve();
  }

  private installFlushHooks(): void {
    const flush = () => {
      this.provider?.forceFlush().catch(() => {
        // Best-effort flush while the page is going away.
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };

    addEventListener("visibilitychange", onVisibilityChange);
    addEventListener("pagehide", flush);
    this.teardown = [
      () => removeEventListener("visibilitychange", onVisibilityChange),
      () => removeEventListener("pagehide", flush),
    ];
  }

  async shutdown(): Promise<void> {
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];

    this.instrumentation?.disable();
    this.instrumentation = null;

    if (this.provider) {
      await this.provider.shutdown();
      this.provider = null;
    }
  }

  async flush(): Promise<void> {
    await this.provider?.forceFlush();
  }
}
