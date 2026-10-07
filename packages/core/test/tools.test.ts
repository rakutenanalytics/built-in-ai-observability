import { describe, expect, it } from "vitest";
import {
  encodeInputMessages,
  encodeOutputMessages,
} from "../src/attributes/messages.js";
import {
  readAssistantTurn,
  readToolCall,
  readToolResponse,
  toolCallFromChunk,
  toolTrafficFrom,
} from "../src/attributes/tools.js";

/**
 * The real interfaces keep every field on the prototype, so `Object.keys()`
 * returns nothing and `JSON.stringify()` renders `{}`. These doubles reproduce
 * that, which is the whole reason the readers exist.
 */
function onPrototype<T>(fields: Record<string, unknown>): T {
  return Object.create(fields) as T;
}

const weatherCall = () =>
  onPrototype<unknown>({
    arguments: { city: "Tokyo" },
    callId: "call-1",
    name: "get_weather",
  });

describe("readToolCall", () => {
  it("reads fields held on the prototype", () => {
    expect(readToolCall(weatherCall())).toEqual({
      arguments: { city: "Tokyo" },
      id: "call-1",
      name: "get_weather",
    });
  });

  it("does not read the pre-rename callID key", () => {
    const call = onPrototype<unknown>({ callID: "abc", name: "t" });
    expect(readToolCall(call)?.id).toBe("");
  });

  it("rejects values that are not tool calls", () => {
    expect(readToolCall(undefined)).toBeUndefined();
    expect(readToolCall("get_weather")).toBeUndefined();
    expect(readToolCall({ arguments: {} })).toBeUndefined();
  });
});

describe("readToolResponse", () => {
  it("reads a success and keeps the result parts", () => {
    const success = onPrototype<unknown>({
      callId: "call-1",
      name: "get_weather",
      result: [{ type: "object", value: { tempC: 24 } }],
    });

    expect(readToolResponse(success)).toEqual({
      id: "call-1",
      name: "get_weather",
      result: [{ type: "object", value: { tempC: 24 } }],
    });
  });

  it("reads a failure and reports no result", () => {
    const failure = onPrototype<unknown>({
      callId: "",
      errorMessage: 'missing "city"',
      name: "get_weather",
    });

    const response = readToolResponse(failure);
    expect(response?.errorMessage).toBe('missing "city"');
    expect(response?.result).toBeUndefined();
  });
});

describe("toolCallFromChunk", () => {
  it("recognizes a tool-call chunk", () => {
    const chunk = { type: "tool-call", value: weatherCall() };
    expect(toolCallFromChunk(chunk)?.name).toBe("get_weather");
  });

  it("ignores text chunks", () => {
    expect(toolCallFromChunk("hello")).toBeUndefined();
    expect(toolCallFromChunk({ type: "text", value: "hello" })).toBeUndefined();
  });
});

describe("toolTrafficFrom", () => {
  it("finds tool responses carried by a user message", () => {
    const response = onPrototype<unknown>({
      callId: "",
      name: "get_weather",
      result: [{ type: "object", value: { tempC: 24 } }],
    });

    const traffic = toolTrafficFrom([
      { content: [{ type: "tool-response", value: response }], role: "user" },
    ]);

    expect(traffic.responses).toHaveLength(1);
    expect(traffic.responses[0]?.name).toBe("get_weather");
    expect(traffic.calls).toHaveLength(0);
  });

  it("reports nothing for a plain text prompt", () => {
    expect(toolTrafficFrom("what is the weather?")).toEqual({
      calls: [],
      responses: [],
    });
  });
});

describe("readAssistantTurn", () => {
  it("treats a bare string as text", () => {
    expect(readAssistantTurn("hello")).toEqual({
      text: "hello",
      toolCalls: [],
    });
  });

  it("splits a content sequence into text and calls", () => {
    const turn = readAssistantTurn([
      { type: "text", value: "Let me check. " },
      { type: "tool-call", value: weatherCall() },
    ]);

    expect(turn.text).toBe("Let me check. ");
    expect(turn.toolCalls.map((call) => call.name)).toEqual(["get_weather"]);
  });

  it("handles a turn that only asks for tools", () => {
    const turn = readAssistantTurn([
      { type: "tool-call", value: weatherCall() },
    ]);
    expect(turn.text).toBe("");
    expect(turn.toolCalls).toHaveLength(1);
  });
});

describe("tool message encoding", () => {
  it("encodes a tool response as a tool_call_response part", () => {
    const response = onPrototype<unknown>({
      callId: "",
      name: "get_weather",
      result: [{ type: "object", value: { tempC: 24 } }],
    });

    const [message] = encodeInputMessages([
      {
        content: [{ type: "tool-response", value: response }],
        role: "user",
      },
    ] as never);

    expect(message?.parts[0]).toEqual({
      name: "get_weather",
      response: [{ type: "object", value: { tempC: 24 } }],
      type: "tool_call_response",
    });
  });

  it("encodes a tool failure as an error rather than a response", () => {
    const failure = onPrototype<unknown>({
      callId: "",
      errorMessage: "boom",
      name: "get_weather",
    });

    const [message] = encodeInputMessages([
      { content: [{ type: "tool-response", value: failure }], role: "user" },
    ] as never);

    expect(message?.parts[0]).toEqual({
      error: "boom",
      name: "get_weather",
      type: "tool_call_response",
    });
  });

  it("encodes tool calls on the assistant turn", () => {
    const [message] = encodeOutputMessages(
      {
        text: "Checking.",
        toolCalls: [
          { arguments: { city: "Tokyo" }, id: "", name: "get_weather" },
        ],
      },
      "tool_call"
    );

    expect(message?.finish_reason).toBe("tool_call");
    expect(message?.parts).toEqual([
      { content: "Checking.", type: "text" },
      { arguments: { city: "Tokyo" }, name: "get_weather", type: "tool_call" },
    ]);
  });

  it("leaves out an empty text part for a tool-only turn", () => {
    const [message] = encodeOutputMessages(
      { text: "", toolCalls: [{ id: "", name: "get_weather" }] },
      "tool_call"
    );

    expect(message?.parts).toEqual([
      { name: "get_weather", type: "tool_call" },
    ]);
  });

  it("still encodes a plain string turn as one text part", () => {
    const [message] = encodeOutputMessages("hello", "stop");
    expect(message?.parts).toEqual([{ content: "hello", type: "text" }]);
  });
});
