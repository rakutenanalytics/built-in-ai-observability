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
  TOOL_DEFINITIONS: "gen_ai.tool.definitions",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_DESCRIPTION: "gen_ai.tool.description",
  TOOL_TYPE: "gen_ai.tool.type",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
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
  /** Tools declared on the session. */
  TOOL_COUNT: "web_ai.tool.count",
  TOOL_NAMES: "web_ai.tool.names",
  /**
   * Tool activity on a turn. Recorded even when content capture is off, so the
   * shape of an exchange stays visible without its payloads.
   */
  TOOL_CALL_COUNT: "web_ai.tool.call_count",
  TOOL_CALL_NAMES: "web_ai.tool.call_names",
  TOOL_RESPONSE_COUNT: "web_ai.tool.response_count",
  /** Chrome leaves `callID` empty, so calls are identified by position. */
  TOOL_CALL_INDEX: "web_ai.tool.call_index",
  TOOL_CALL_ARGUMENTS: "web_ai.tool.call_arguments",
  TOOL_RESULT: "web_ai.tool.result",
  TOOL_FAILED: "web_ai.tool.failed",
  /** Set on a turn that carries tool responses, continuing an earlier turn. */
  TURN_CONTINUATION: "web_ai.conversation.turn_continuation",
} as const;

export const ERROR_TYPE = "error.type";
export const SESSION_ID = "session.id";

export const OPERATION_GENERATE_CONTENT = "generate_content";
export const OPERATION_EXECUTE_TOOL = "execute_tool";
/** Only kind of tool the Prompt API exposes. */
export const TOOL_TYPE_FUNCTION = "function";
export const DEFAULT_PROVIDER_NAME = "google.chrome";
export const PROMPT_API_NAME = "LanguageModel";
