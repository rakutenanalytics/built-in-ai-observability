/** OpenTelemetry GenAI semantic convention attribute names. */
export const GEN_AI = {
  CONVERSATION_COMPACTED: "gen_ai.conversation.compacted",
  CONVERSATION_ID: "gen_ai.conversation.id",
  FINISH_REASONS: "gen_ai.response.finish_reasons",
  INPUT_MESSAGES: "gen_ai.input.messages",
  OPERATION_NAME: "gen_ai.operation.name",
  OUTPUT_MESSAGES: "gen_ai.output.messages",
  OUTPUT_TYPE: "gen_ai.output.type",
  PROVIDER_NAME: "gen_ai.provider.name",
  REQUEST_STREAM: "gen_ai.request.stream",
  SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
  TIME_TO_FIRST_CHUNK: "gen_ai.response.time_to_first_chunk",
  /**
   * Opt-in in the spec, so both are gated on content capture. The spec asks for
   * a structured object and allows a JSON string where the format cannot carry
   * one, which is the case for OTel span attributes.
   */
  TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_CALL_RESULT: "gen_ai.tool.call.result",
  TOOL_DEFINITIONS: "gen_ai.tool.definitions",
  TOOL_DESCRIPTION: "gen_ai.tool.description",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_TYPE: "gen_ai.tool.type",
} as const;

/** Experimental Built-in AI attributes not covered by standard OTel conventions. */
export const WEB_AI = {
  API_NAME: "web_ai.api.name",
  AVAILABILITY_STATUS: "web_ai.availability.status",
  BROWSER_NAME: "web_ai.runtime.browser.name",
  BROWSER_VERSION: "web_ai.runtime.browser.version",
  CHUNK_COUNT: "web_ai.stream.chunk_count",
  CONTEXT_OVERFLOWED: "web_ai.context.overflowed",
  CONTEXT_REMAINING_AFTER: "web_ai.context.remaining_after_tokens",
  CONTEXT_USAGE_AFTER: "web_ai.context.usage_after_tokens",
  CONTEXT_USAGE_BEFORE: "web_ai.context.usage_before_tokens",
  CONTEXT_USAGE_DELTA: "web_ai.context.usage_delta_tokens",
  CONTEXT_UTILIZATION_AFTER: "web_ai.context.utilization_after",
  CONTEXT_WINDOW: "web_ai.context.window_tokens",
  DEVICE_MEMORY_GIB: "web_ai.runtime.device_memory_gib",
  DOWNLOAD_DURATION: "web_ai.model.download_duration",
  DOWNLOAD_OBSERVED: "web_ai.model.download_observed",
  DOWNLOAD_PROGRESS: "web_ai.model.download_progress",
  /** Set when an exchange ends without the answer the tools were for. */
  EXCHANGE_ABANDONED: "web_ai.exchange.abandoned",
  EXCHANGE_TOOL_CALL_COUNT: "web_ai.exchange.tool_call_count",
  /** Totals for a whole exchange, recorded on its `invoke_agent` span. */
  EXCHANGE_TURN_COUNT: "web_ai.exchange.turn_count",
  SAMPLING_MODE: "web_ai.request.sampling_mode",
  SESSION_EXPECTED_INPUTS: "web_ai.session.expected_inputs",
  SESSION_EXPECTED_OUTPUTS: "web_ai.session.expected_outputs",
  SESSION_ID: "web_ai.session.id",
  SESSION_PARENT_ID: "web_ai.session.parent_id",
  /**
   * Tool activity on a turn. Recorded even when content capture is off, so the
   * shape of an exchange stays visible without its payloads.
   */
  TOOL_CALL_COUNT: "web_ai.tool.call_count",
  TOOL_CALL_NAMES: "web_ai.tool.call_names",
  /** Tools declared on the session. */
  TOOL_COUNT: "web_ai.tool.count",
  TOOL_NAMES: "web_ai.tool.names",
  TOOL_RESPONSE_COUNT: "web_ai.tool.response_count",
  /** Set on a turn that carries tool responses, continuing an earlier turn. */
  TURN_CONTINUATION: "web_ai.conversation.turn_continuation",
  TURN_INDEX: "web_ai.conversation.turn_index",
} as const;

export const ERROR_TYPE = "error.type";
export const SESSION_ID = "session.id";

export const OPERATION_GENERATE_CONTENT = "generate_content";
export const OPERATION_EXECUTE_TOOL = "execute_tool";
/**
 * A question answered with the help of tools. The page runs the tool loop, so
 * this span covers the whole exchange: the model turns, the tool runs, and the
 * answer that ends it.
 */
export const OPERATION_INVOKE_AGENT = "invoke_agent";
/** Only kind of tool the Prompt API exposes. */
export const TOOL_TYPE_FUNCTION = "function";
/** The two ways a turn can end: with an answer, or with a request for tools. */
export const FINISH_STOP = "stop";
export const FINISH_TOOL_CALL = "tool_call";
export const DEFAULT_PROVIDER_NAME = "google.chrome";
export const PROMPT_API_NAME = "LanguageModel";
