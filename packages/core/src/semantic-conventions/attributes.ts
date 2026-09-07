/** OpenTelemetry GenAI semantic convention attribute names. */
export const GEN_AI = {
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",
  REQUEST_STREAM: "gen_ai.request.stream",
  OUTPUT_TYPE: "gen_ai.output.type",
  INPUT_MESSAGES: "gen_ai.input.messages",
  OUTPUT_MESSAGES: "gen_ai.output.messages",
  SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
  TIME_TO_FIRST_CHUNK: "gen_ai.response.time_to_first_chunk",
  FINISH_REASONS: "gen_ai.response.finish_reasons",
  CONVERSATION_ID: "gen_ai.conversation.id",
  CONVERSATION_COMPACTED: "gen_ai.conversation.compacted",
} as const;

/** Experimental Web AI attributes not covered by standard OTel conventions. */
export const WEB_AI = {
  API_NAME: "web_ai.api.name",
  AVAILABILITY_STATUS: "web_ai.availability.status",
  BROWSER_NAME: "web_ai.runtime.browser.name",
  BROWSER_VERSION: "web_ai.runtime.browser.version",
  DEVICE_MEMORY_GIB: "web_ai.runtime.device_memory_gib",
  CONTEXT_WINDOW: "web_ai.context.window_tokens",
  CONTEXT_USAGE_BEFORE: "web_ai.context.usage_before_tokens",
  CONTEXT_USAGE_AFTER: "web_ai.context.usage_after_tokens",
  CONTEXT_USAGE_DELTA: "web_ai.context.usage_delta_tokens",
  CONTEXT_REMAINING_AFTER: "web_ai.context.remaining_after_tokens",
  CONTEXT_UTILIZATION_AFTER: "web_ai.context.utilization_after",
  CONTEXT_OVERFLOWED: "web_ai.context.overflowed",
  CHUNK_COUNT: "web_ai.stream.chunk_count",
  DOWNLOAD_OBSERVED: "web_ai.model.download_observed",
  DOWNLOAD_DURATION: "web_ai.model.download_duration",
  DOWNLOAD_PROGRESS: "web_ai.model.download_progress",
  TURN_INDEX: "web_ai.conversation.turn_index",
  SAMPLING_MODE: "web_ai.request.sampling_mode",
  SESSION_EXPECTED_INPUTS: "web_ai.session.expected_inputs",
  SESSION_EXPECTED_OUTPUTS: "web_ai.session.expected_outputs",
  SESSION_ID: "web_ai.session.id",
  SESSION_PARENT_ID: "web_ai.session.parent_id",
} as const;

export const ERROR_TYPE = "error.type";
export const SESSION_ID = "session.id";

export const OPERATION_GENERATE_CONTENT = "generate_content";
export const DEFAULT_PROVIDER_NAME = "google.chrome";
export const PROMPT_API_NAME = "LanguageModel";
