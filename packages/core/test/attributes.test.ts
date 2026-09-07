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
  textFromGenAiMessages,
} from "../src/attributes/messages.js";

describe("encodeInputMessages", () => {
  it("wraps a bare string as a user text part", () => {
    expect(encodeInputMessages("hello")).toEqual([
      { role: "user", parts: [{ type: "text", content: "hello" }] },
    ]);
  });

  it("defaults a missing role to user", () => {
    expect(encodeInputMessages({ content: "hi" })[0]?.role).toBe("user");
  });

  it("reads text from either value or content", () => {
    const parts = encodeInputMessages([
      { role: "user", content: [{ type: "text", value: "from-value" }] },
      { role: "user", content: [{ type: "text", content: "from-content" }] },
    ]);
    expect(parts[0]?.parts).toEqual([{ type: "text", content: "from-value" }]);
    expect(parts[1]?.parts).toEqual([
      { type: "text", content: "from-content" },
    ]);
  });

  it("redacts non-text modalities, keeping only the kind", () => {
    const [message] = encodeInputMessages([
      { role: "user", content: [{ type: "image", value: "secret-bytes" }] },
    ]);
    expect(message?.parts).toEqual([{ type: "redacted", modality: "image" }]);
    expect(JSON.stringify(message)).not.toContain("secret-bytes");
  });
});

describe("encodeOutputMessages", () => {
  it("records the assistant reply and finish reason", () => {
    expect(encodeOutputMessages("done", "stop")).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "done" }],
        finish_reason: "stop",
      },
    ]);
  });
});

describe("encodeSystemInstructions", () => {
  it("collects only system messages", () => {
    expect(
      encodeSystemInstructions([
        { role: "system", content: "be terse" },
        { role: "user", content: "ignored" },
      ])
    ).toEqual([{ type: "text", content: "be terse" }]);
  });

  it("returns undefined when there are no system messages", () => {
    expect(
      encodeSystemInstructions([{ role: "user", content: "hi" }])
    ).toBeUndefined();
  });

  it("skips non-text parts of a system message", () => {
    expect(
      encodeSystemInstructions([
        {
          role: "system",
          content: [
            { type: "text", value: "rule" },
            { type: "image", value: "logo" },
          ],
        },
      ])
    ).toEqual([{ type: "text", content: "rule" }]);
  });
});

describe("textFromGenAiMessages", () => {
  it("joins text parts and ignores others", () => {
    expect(
      textFromGenAiMessages([
        { parts: [{ type: "text", content: "a" }, { type: "redacted" }] },
        { parts: [{ type: "text", content: "b" }] },
      ])
    ).toBe("a\nb");
  });
});

describe("contextAttributes", () => {
  it("derives delta, remaining and utilization", () => {
    expect(contextAttributes(1000, 100, 300)).toEqual({
      "web_ai.context.usage_before_tokens": 100,
      "web_ai.context.usage_after_tokens": 300,
      "web_ai.context.usage_delta_tokens": 200,
      "web_ai.context.remaining_after_tokens": 700,
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
      "web_ai.session.id": "s1",
      "session.id": "s1",
    });
  });

  it("includes the parent session only when cloned", () => {
    const attrs = sessionAttributes({
      conversationId: "c1",
      sessionId: "s2",
      parentSessionId: "s1",
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
