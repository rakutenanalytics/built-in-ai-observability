import { GEN_AI } from "@web-ai-otel/core";
import { describe, expect, it } from "vitest";
import { spanInputs, spanOutputs } from "../src/panel/message-preview.js";

describe("spanInputs", () => {
  it("prefers mlflow OpenAI-shaped messages over gen_ai parts", () => {
    const payload = spanInputs({
      "mlflow.spanInputs": JSON.stringify({
        messages: [{ content: "from mlflow", role: "user" }],
      }),
      [GEN_AI.INPUT_MESSAGES]: JSON.stringify([
        { parts: [{ content: "from genai", type: "text" }], role: "user" },
      ]),
    });
    expect(payload?.messages[0]?.text).toBe("from mlflow");
  });

  it("parses gen_ai tool responses into tool cards", () => {
    const payload = spanInputs({
      [GEN_AI.INPUT_MESSAGES]: JSON.stringify([
        {
          parts: [
            {
              name: "get_current_time",
              response: [
                { type: "object", value: { iso: "2026-09-10T02:25:18.662Z" } },
              ],
              type: "tool_call_response",
            },
          ],
          role: "user",
        },
      ]),
    });
    expect(payload?.messages[0]?.title).toBe("Tool");
    expect(payload?.messages[0]?.text).toContain("iso");
  });

  it("falls back to execute_tool arguments", () => {
    const payload = spanInputs({
      [GEN_AI.TOOL_CALL_ARGUMENTS]: JSON.stringify({
        city: "Kyoto",
        date: "2026-09-11",
      }),
    });
    expect(payload?.fields).toEqual({ city: "Kyoto", date: "2026-09-11" });
  });
});

describe("spanOutputs", () => {
  it("renders assistant tool calls from mlflow outputs", () => {
    const payload = spanOutputs({
      "mlflow.spanOutputs": JSON.stringify({
        messages: [
          {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: '{"city":"Kyoto"}',
                  name: "get_weather",
                },
                id: "call-1",
                type: "function",
              },
            ],
          },
        ],
      }),
    });
    expect(payload?.messages[0]?.toolCalls?.[0]).toEqual({
      arguments: { city: "Kyoto" },
      id: "call-1",
      name: "get_weather",
    });
  });

  it("falls back to execute_tool results", () => {
    const payload = spanOutputs({
      [GEN_AI.TOOL_CALL_RESULT]: JSON.stringify({
        conditions: "rainy",
        tempC: 24,
      }),
    });
    expect(payload?.fields).toEqual({ conditions: "rainy", tempC: 24 });
  });

  it("unwraps the Prompt API's content-part envelope around a result", () => {
    // LanguageModelToolSuccess wraps the value as [{ type, value }], unlike
    // arguments, which arrive as a plain object.
    const payload = spanOutputs({
      [GEN_AI.TOOL_CALL_RESULT]: JSON.stringify([
        { type: "object", value: { conditions: "rainy", tempC: 24 } },
      ]),
    });
    expect(payload?.fields).toEqual({ conditions: "rainy", tempC: 24 });
  });

  it("still shows a result that isn't an object after unwrapping", () => {
    const payload = spanOutputs({
      [GEN_AI.TOOL_CALL_RESULT]: JSON.stringify([
        { type: "text", value: "Sunny, 24C" },
      ]),
    });
    expect(payload?.messages[0]).toEqual({
      role: "tool",
      text: "Sunny, 24C",
      title: "Result",
    });
  });
});
