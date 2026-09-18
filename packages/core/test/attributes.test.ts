import { describe, expect, it } from "vitest";
import { contextAttributes } from "../src/attributes/context.js";
import {
  sessionAttributes,
  truncateAttribute,
} from "../src/attributes/helpers.js";
import {
  encodeInputMessages,
  encodeOutputMessages,
  encodeSystemInstructions,
  fitMlflowPreview,
  mlflowChatPreview,
  mlflowChatPreviewFromPrompt,
  promptNeedsAsyncMlflowPreview,
} from "../src/attributes/messages.js";

describe("encodeInputMessages", () => {
  it("wraps a bare string as a user text part", () => {
    expect(encodeInputMessages("hello")).toEqual([
      { parts: [{ content: "hello", type: "text" }], role: "user" },
    ]);
  });

  it("defaults a missing role to user", () => {
    expect(encodeInputMessages({ content: "hi" })[0]?.role).toBe("user");
  });

  it("reads text from either value or content", () => {
    const parts = encodeInputMessages([
      { content: [{ type: "text", value: "from-value" }], role: "user" },
      { content: [{ content: "from-content", type: "text" }], role: "user" },
    ]);
    expect(parts[0]?.parts).toEqual([{ content: "from-value", type: "text" }]);
    expect(parts[1]?.parts).toEqual([
      { content: "from-content", type: "text" },
    ]);
  });

  it("redacts non-text modalities, keeping only the kind", () => {
    const [message] = encodeInputMessages([
      { content: [{ type: "image", value: "secret-bytes" }], role: "user" },
    ]);
    expect(message?.parts).toEqual([{ modality: "image", type: "redacted" }]);
    expect(JSON.stringify(message)).not.toContain("secret-bytes");
  });
});

describe("encodeOutputMessages", () => {
  it("records the assistant reply and finish reason", () => {
    expect(encodeOutputMessages("done", "stop")).toEqual([
      {
        finish_reason: "stop",
        parts: [{ content: "done", type: "text" }],
        role: "assistant",
      },
    ]);
  });
});

describe("encodeSystemInstructions", () => {
  it("collects only system messages", () => {
    expect(
      encodeSystemInstructions([
        { content: "be terse", role: "system" },
        { content: "ignored", role: "user" },
      ])
    ).toEqual([{ content: "be terse", type: "text" }]);
  });

  it("returns undefined when there are no system messages", () => {
    expect(
      encodeSystemInstructions([{ content: "hi", role: "user" }])
    ).toBeUndefined();
  });

  it("skips non-text parts of a system message", () => {
    expect(
      encodeSystemInstructions([
        {
          content: [
            { type: "text", value: "rule" },
            { type: "image", value: "logo" },
          ],
          role: "system",
        },
      ])
    ).toEqual([{ content: "rule", type: "text" }]);
  });
});

describe("mlflowChatPreview", () => {
  const preview = (
    messages: Parameters<typeof mlflowChatPreview>[0],
    maxLength = 0
  ) => JSON.parse(mlflowChatPreview(messages, maxLength) ?? "null");

  it("joins the text parts of a message into its content", () => {
    expect(
      preview([
        {
          parts: [
            { content: "a", type: "text" },
            { content: "b", type: "text" },
          ],
          role: "user",
        },
      ])
    ).toEqual({ messages: [{ content: "a\nb", role: "user" }] });
  });

  it("carries a tool call over as an OpenAI tool_calls entry", () => {
    expect(
      preview([
        {
          parts: [
            {
              arguments: { city: "Kyoto" },
              id: "call-1",
              name: "get_weather",
              type: "tool_call",
            },
          ],
          role: "assistant",
        },
      ])
    ).toEqual({
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
    });
  });

  it("lifts a tool result into its own tool message", () => {
    expect(
      preview([
        {
          parts: [
            {
              id: "call-1",
              name: "get_weather",
              response: { tempC: 24 },
              type: "tool_call_response",
            },
          ],
          role: "user",
        },
      ])
    ).toEqual({
      messages: [
        { content: '{"tempC":24}', role: "tool", tool_call_id: "call-1" },
      ],
    });
  });

  it("previews a tool error in place of its result", () => {
    expect(
      preview([
        {
          parts: [
            { error: "boom", name: "get_weather", type: "tool_call_response" },
          ],
          role: "user",
        },
      ])
    ).toEqual({ messages: [{ content: '"boom"', role: "tool" }] });
  });

  /**
   * A turn with nothing renderable would otherwise leave the attribute unset,
   * and MLflow then derives its own copy and shows every message twice.
   */
  it("stands in for a redacted modality so the preview is never empty", () => {
    expect(
      preview([
        { parts: [{ modality: "image", type: "redacted" }], role: "user" },
      ])
    ).toEqual({ messages: [{ content: "[image]", role: "user" }] });
  });

  it("returns nothing when there is no part to preview", () => {
    expect(mlflowChatPreview([{ parts: [], role: "user" }], 0)).toBeUndefined();
  });

  it("truncates to the configured attribute length", () => {
    expect(
      mlflowChatPreview(
        [{ parts: [{ content: "hello", type: "text" }], role: "user" }],
        4
      )
    ).toBe('{"me…[truncated]');
  });
});

describe("mlflowChatPreviewFromPrompt", () => {
  const preview = (
    input: Parameters<typeof mlflowChatPreviewFromPrompt>[0],
    options?: Parameters<typeof mlflowChatPreviewFromPrompt>[2]
  ) => JSON.parse(mlflowChatPreviewFromPrompt(input, 0, options) ?? "null");

  it("exports WAV audio as OpenAI input_audio parts", () => {
    const audio = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00,
      0x64, 0x61, 0x74, 0x61, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]).buffer;
    const parsed = preview(
      [
        {
          content: [
            { type: "text", value: "Transcribe this" },
            { type: "audio", value: audio },
          ],
          role: "user",
        },
      ],
      { captureMultimodalPreview: true }
    );
    expect(parsed.messages[0].content[0]).toEqual({
      text: "Transcribe this",
      type: "text",
    });
    expect(parsed.messages[0].content[1].type).toBe("input_audio");
    expect(parsed.messages[0].content[1].input_audio.format).toBe("wav");
  });

  it("defers WebM audio to async preview enrichment", () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]).buffer;
    expect(
      promptNeedsAsyncMlflowPreview([
        { content: [{ type: "audio", value: webm }], role: "user" },
      ])
    ).toBe(true);
    expect(
      preview(
        [
          {
            content: [
              { type: "text", value: "Transcribe this" },
              { type: "audio", value: webm },
            ],
            role: "user",
          },
        ],
        { captureMultimodalPreview: true }
      )
    ).toEqual({
      messages: [
        {
          content: "Transcribe this\n[audio]",
          role: "user",
        },
      ],
    });
  });

  it("falls back to placeholders when previews are disabled", () => {
    expect(
      preview([
        {
          content: [{ type: "image", value: "secret" }],
          role: "user",
        },
      ])
    ).toEqual({
      messages: [{ content: "[image]", role: "user" }],
    });
  });

  it("strips media bytes before hard truncation", () => {
    const json = fitMlflowPreview(
      [
        {
          content: [
            { text: "hello", type: "text" },
            {
              input_audio: { data: "A".repeat(40_000), format: "wav" },
              type: "input_audio",
            },
          ],
          role: "user",
        },
      ],
      500
    );
    expect(json).toBeDefined();
    const parsed = JSON.parse(json ?? "null");
    expect(parsed.messages[0].content[1].input_audio.data).toBe("");
    expect(JSON.parse(json ?? "null")).toEqual(parsed);
  });

  it("keeps gen_ai attributes redacted while exporting previews separately", () => {
    const encoded = encodeInputMessages([
      { content: [{ type: "audio", value: "secret-bytes" }], role: "user" },
    ]);
    expect(encoded[0]?.parts).toEqual([
      { modality: "audio", type: "redacted" },
    ]);
    expect(JSON.stringify(encoded)).not.toContain("secret-bytes");
  });
});

describe("contextAttributes", () => {
  it("derives delta, remaining and utilization", () => {
    expect(contextAttributes(1000, 100, 300)).toEqual({
      "web_ai.context.remaining_after_tokens": 700,
      "web_ai.context.usage_after_tokens": 300,
      "web_ai.context.usage_before_tokens": 100,
      "web_ai.context.usage_delta_tokens": 200,
      "web_ai.context.utilization_after": 0.3,
    });
  });

  it("omits window-derived values when the window is unknown", () => {
    const attrs = contextAttributes(undefined, 100, 300);
    expect(attrs["web_ai.context.remaining_after_tokens"]).toBeUndefined();
    expect(attrs["web_ai.context.utilization_after"]).toBeUndefined();
  });

  it("avoids dividing by a zero-sized window", () => {
    const attrs = contextAttributes(0, 0, 0);
    expect(attrs["web_ai.context.utilization_after"]).toBeUndefined();
  });

  it("returns nothing useful when usage is unknown", () => {
    expect(contextAttributes(1000, undefined, undefined)).toEqual({});
  });
});

describe("sessionAttributes", () => {
  it("emits conversation and session identity", () => {
    expect(
      sessionAttributes({ conversationId: "c1", sessionId: "s1" })
    ).toEqual({
      "gen_ai.conversation.id": "c1",
      "session.id": "s1",
      "web_ai.session.id": "s1",
    });
  });

  it("includes the parent session only when cloned", () => {
    const attrs = sessionAttributes({
      conversationId: "c1",
      parentSessionId: "s1",
      sessionId: "s2",
    });
    expect(attrs["web_ai.session.parent_id"]).toBe("s1");
  });
});

describe("truncateAttribute", () => {
  it("leaves short values untouched", () => {
    expect(truncateAttribute("short", 100)).toBe("short");
  });

  it("marks truncated values", () => {
    expect(truncateAttribute("abcdef", 3)).toBe("abc…[truncated]");
  });

  it("treats a non-positive limit as unlimited", () => {
    expect(truncateAttribute("abcdef", 0)).toBe("abcdef");
  });
});
