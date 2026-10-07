/**
 * Reading tool traffic off the Prompt API.
 *
 * `LanguageModelToolCall`, `LanguageModelToolSuccess` and
 * `LanguageModelToolError` keep every field on the prototype, so `Object.keys()`
 * sees nothing and `JSON.stringify()` renders `{}`. Each field has to be read by
 * name, which is what this module does. Nothing here imports the Prompt API
 * types: the shapes are duck-typed so the same code works against a live
 * browser, a polyfill, or a test double.
 */

/** A tool the model asked for. */
export interface ToolCallInfo {
  arguments?: unknown;
  /**
   * `callId`, which the response repeats. The spec requires it to be non-empty,
   * but Chrome 157 still sends `""`.
   */
  id: string;
  name: string;
}

/** The page's answer to one call: a result, or a failure. */
export interface ToolResponseInfo {
  /** Absent on success. */
  errorMessage?: string;
  id: string;
  name: string;
  /** Result parts, as `{ type, value }`. Absent on failure. */
  result?: unknown;
}

export interface ToolTraffic {
  calls: ToolCallInfo[];
  responses: ToolResponseInfo[];
}

/** A completed turn, split into what it said and what it wants run. */
export interface AssistantTurn {
  text: string;
  toolCalls: ToolCallInfo[];
}

function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") {
    return;
  }
  return value as Record<string, unknown>;
}

function stringField(
  fields: Record<string, unknown>,
  key: string
): string | undefined {
  const value = fields[key];
  return typeof value === "string" ? value : undefined;
}

/** Result parts are kept as declared, so `type` survives alongside `value`. */
function readToolResult(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value ?? undefined;
  }
  return value.map((entry) => {
    const fields = fieldsOf(entry);
    return fields ? { type: fields.type, value: fields.value } : entry;
  });
}

export function readToolCall(value: unknown): ToolCallInfo | undefined {
  const fields = fieldsOf(value);
  const name = fields && stringField(fields, "name");
  if (!(fields && name)) {
    return;
  }
  return {
    arguments: fields.arguments,
    id: stringField(fields, "callId") ?? "",
    name,
  };
}

export function readToolResponse(value: unknown): ToolResponseInfo | undefined {
  const fields = fieldsOf(value);
  const name = fields && stringField(fields, "name");
  if (!(fields && name)) {
    return;
  }

  const id = stringField(fields, "callId") ?? "";
  const errorMessage = stringField(fields, "errorMessage");
  if (errorMessage !== undefined) {
    return { errorMessage, id, name };
  }
  return { id, name, result: readToolResult(fields.result) };
}

/** Pulls a tool call out of one streamed chunk, if that is what it is. */
export function toolCallFromChunk(chunk: unknown): ToolCallInfo | undefined {
  const fields = fieldsOf(chunk);
  if (fields?.type !== "tool-call") {
    return;
  }
  return readToolCall(fields.value);
}

function collectPart(part: unknown, traffic: ToolTraffic): void {
  const fields = fieldsOf(part);
  if (!fields) {
    return;
  }
  if (fields.type === "tool-call") {
    const call = readToolCall(fields.value);
    if (call) {
      traffic.calls.push(call);
    }
    return;
  }
  if (fields.type === "tool-response") {
    const response = readToolResponse(fields.value);
    if (response) {
      traffic.responses.push(response);
    }
  }
}

/**
 * Walks a prompt input for tool content parts. Responses here are the signal
 * that a turn continues an earlier one rather than starting an exchange.
 */
export function toolTrafficFrom(input: unknown): ToolTraffic {
  const traffic: ToolTraffic = { calls: [], responses: [] };
  if (typeof input === "string" || !input) {
    return traffic;
  }

  const messages = Array.isArray(input) ? input : [input];
  for (const message of messages) {
    const content = fieldsOf(message)?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      collectPart(part, traffic);
    }
  }
  return traffic;
}

/**
 * Normalizes what `prompt()` resolves to. Plain text comes back as a string,
 * but a turn that asks for a tool resolves to a content sequence instead.
 */
export function readAssistantTurn(output: unknown): AssistantTurn {
  if (typeof output === "string") {
    return { text: output, toolCalls: [] };
  }
  if (!Array.isArray(output)) {
    return { text: "", toolCalls: [] };
  }

  const turn: AssistantTurn = { text: "", toolCalls: [] };
  for (const part of output) {
    const fields = fieldsOf(part);
    if (!fields) {
      continue;
    }
    if (fields.type === "text") {
      turn.text += String(fields.value ?? "");
      continue;
    }
    const call = toolCallFromChunk(fields);
    if (call) {
      turn.toolCalls.push(call);
    }
  }
  return turn;
}
