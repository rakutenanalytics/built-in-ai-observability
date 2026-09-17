export interface CaptureConfig {
  captureInput: boolean;
  captureOutput: boolean;
  /** Truncate string attributes longer than this (bytes). 0 = no limit. */
  maxAttributeLength: number;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  captureInput: false,
  captureOutput: false,
  maxAttributeLength: 32_768,
};

export interface SessionTelemetryMeta {
  conversationId: string;
  parentSessionId?: string;
  sessionId: string;
}

export interface FrameContext {
  frameId?: number;
  origin?: string;
  tabId?: number;
  url?: string;
}

export interface InstrumentationConfig extends CaptureConfig {
  /** Include MLflow preview attributes for backends that use them. */
  includeMlflowPreview?: boolean;
  providerName?: string;
}
