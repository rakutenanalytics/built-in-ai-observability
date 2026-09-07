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
  sessionId: string;
  parentSessionId?: string;
}

export interface FrameContext {
  tabId?: number;
  frameId?: number;
  url?: string;
  origin?: string;
}

export interface InstrumentationConfig extends CaptureConfig {
  providerName?: string;
  /** Include MLflow preview attributes for backends that use them. */
  includeMlflowPreview?: boolean;
}
