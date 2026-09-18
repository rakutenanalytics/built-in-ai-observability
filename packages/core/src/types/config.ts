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
  /**
   * Capture base64 image/audio previews for MLflow and DevTools. GenAI
   * attributes remain redacted — previews live only in mlflow.spanInputs.
   */
  captureMultimodalPreview?: boolean;
  /** Include MLflow preview attributes for backends that use them. */
  includeMlflowPreview?: boolean;
  /**
   * Cap for mlflow.spanInputs once it carries base64 media. maxAttributeLength
   * is sized for text, and a base64 WAV blows past it, so reusing it here
   * strips the media back out. Default 1 MB.
   */
  maxMlflowMediaPreviewLength?: number;
  /** Max decoded bytes for a multimodal preview. Default 512 KB, 200 KB audio. */
  multimodalPreviewMaxBytes?: number;
  providerName?: string;
}
