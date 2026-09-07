import "fake-indexeddb/auto";
import type {
  SerializedSpan,
  SpanSource,
} from "@web-ai-otel/extension-transport/protocol";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

type StorageModule = typeof import("../src/storage/indexed-db.js");

const MS_PER_SECOND = 1000;
const NANOS_PER_MS = 1_000_000;
const OK = 1;
const ERROR = 2;

let storage: StorageModule;

/**
 * The module memoizes its database handle, so each test needs a fresh module
 * instance on top of a fresh database.
 */
async function freshStorage(): Promise<StorageModule> {
  vi.resetModules();
  // Deleting the database blocks while the previous module instance still
  // holds its connection, so swap in a whole new factory instead.
  globalThis.indexedDB = new IDBFactory() as unknown as IDBFactory;
  return await import("../src/storage/indexed-db.js");
}

function hr(ms: number): [number, number] {
  return [Math.floor(ms / MS_PER_SECOND), (ms % MS_PER_SECOND) * NANOS_PER_MS];
}

function encodeMessages(role: string, content: string): string {
  return JSON.stringify([{ role, parts: [{ type: "text", content }] }]);
}

function span(overrides: {
  name: string;
  traceId: string;
  spanId: string;
  startMs?: number;
  endMs?: number;
  statusCode?: number;
  conversationId?: string;
  attributes?: Record<string, unknown>;
}): SerializedSpan {
  const startMs = overrides.startMs ?? 1000;
  return {
    protocolVersion: 1,
    traceId: overrides.traceId,
    spanId: overrides.spanId,
    name: overrides.name,
    kind: 0,
    startTime: hr(startMs),
    endTime: hr(overrides.endMs ?? startMs + 10),
    attributes: {
      ...(overrides.conversationId
        ? { "gen_ai.conversation.id": overrides.conversationId }
        : {}),
      ...overrides.attributes,
    },
    events: [],
    status: { code: overrides.statusCode ?? OK },
  };
}

const TAB_A: SpanSource = {
  tabId: 1,
  frameId: 0,
  url: "https://a.test/app",
  origin: "https://a.test",
};
const TAB_B: SpanSource = {
  tabId: 2,
  frameId: 0,
  url: "https://b.test/app",
  origin: "https://b.test",
};

const CONVERSATION = "conv-1";

describe("devtools trace storage", () => {
  beforeEach(async () => {
    storage = await freshStorage();
  });

  it("summarizes a trace and a session from a single span", async () => {
    await storage.storeSpan(
      span({
        name: "web_ai.create_session",
        traceId: "t1",
        spanId: "s1",
        startMs: 5000,
        endMs: 5040,
        conversationId: CONVERSATION,
        attributes: { "web_ai.context.window_tokens": 9216 },
      }),
      TAB_A
    );

    const [trace] = await storage.listTraces({});
    expect(trace).toMatchObject({
      traceId: "t1",
      rootSpanName: "web_ai.create_session",
      spanCount: 1,
      origin: "https://a.test",
      tabId: 1,
      conversationId: CONVERSATION,
    });
    expect(trace.durationMs).toBeCloseTo(40);

    const [session] = await storage.listSessions({});
    expect(session).toMatchObject({
      conversationId: CONVERSATION,
      traceIds: ["t1"],
      spanCount: 1,
      turnCount: 0,
      errorCount: 0,
      contextWindow: 9216,
      tabId: 1,
    });
  });

  it("groups separate traces sharing a conversation id into one session", async () => {
    await storage.storeSpan(
      span({
        name: "web_ai.create_session",
        traceId: "t1",
        spanId: "s1",
        startMs: 1000,
        conversationId: CONVERSATION,
      }),
      TAB_A
    );
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t2",
        spanId: "s2",
        startMs: 2000,
        conversationId: CONVERSATION,
      }),
      TAB_A
    );
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t3",
        spanId: "s3",
        startMs: 3000,
        endMs: 3500,
        conversationId: CONVERSATION,
      }),
      TAB_A
    );

    expect(await storage.listTraces({})).toHaveLength(3);

    const sessions = await storage.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      conversationId: CONVERSATION,
      traceIds: ["t1", "t2", "t3"],
      spanCount: 3,
      turnCount: 2,
    });
    // Spans out of one conversation define the session's wall-clock extent.
    expect(sessions[0].startTimeMs).toBeCloseTo(1000);
    expect(sessions[0].endTimeMs).toBeCloseTo(3500);
    expect(sessions[0].durationMs).toBeCloseTo(2500);
  });

  it("counts the tool calls in a tool exchange", async () => {
    // One question answered with a tool: two model turns and one tool run, all
    // in the same trace because the second turn carried the tool response.
    const spans = [
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s1",
        startMs: 1000,
        conversationId: CONVERSATION,
        attributes: { "gen_ai.operation.name": "generate_content" },
      }),
      span({
        name: "execute_tool get_weather",
        traceId: "t1",
        spanId: "s2",
        startMs: 1010,
        conversationId: CONVERSATION,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "get_weather",
        },
      }),
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s3",
        startMs: 1020,
        conversationId: CONVERSATION,
        attributes: { "gen_ai.operation.name": "generate_content" },
      }),
    ];
    for (const record of spans) {
      await storage.storeSpan(record, TAB_A);
    }

    const [trace] = await storage.listTraces({});
    expect(trace).toMatchObject({ spanCount: 3, toolCallCount: 1 });

    const [session] = await storage.listSessions({});
    expect(session).toMatchObject({ turnCount: 2, toolCallCount: 1 });
  });

  it("counts no tool calls for a plain turn", async () => {
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s1",
        conversationId: CONVERSATION,
        attributes: { "gen_ai.operation.name": "generate_content" },
      }),
      TAB_A
    );

    const [trace] = await storage.listTraces({});
    expect(trace.toolCallCount).toBe(0);
  });

  it("counts errors and marks the owning trace as failed", async () => {
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s1",
        conversationId: CONVERSATION,
      }),
      TAB_A
    );
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s2",
        startMs: 1100,
        statusCode: ERROR,
        conversationId: CONVERSATION,
      }),
      TAB_A
    );

    const [trace] = await storage.listTraces({});
    expect(trace.spanCount).toBe(2);
    expect(trace.statusCode).toBe(ERROR);

    const [session] = await storage.listSessions({});
    expect(session.errorCount).toBe(1);
    expect(session.turnCount).toBe(2);
  });

  it("keeps the opening request and the latest response as previews", async () => {
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s1",
        startMs: 1000,
        conversationId: CONVERSATION,
        attributes: {
          "gen_ai.input.messages": encodeMessages("user", "first question"),
          "gen_ai.output.messages": encodeMessages("assistant", "first answer"),
        },
      }),
      TAB_A
    );
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t2",
        spanId: "s2",
        startMs: 2000,
        conversationId: CONVERSATION,
        attributes: {
          "gen_ai.input.messages": encodeMessages("user", "second question"),
          "gen_ai.output.messages": encodeMessages(
            "assistant",
            "second answer"
          ),
        },
      }),
      TAB_A
    );

    const [session] = await storage.listSessions({});
    expect(session.request).toBe("first question");
    expect(session.response).toBe("second answer");
  });

  it("truncates long previews and ignores malformed message json", async () => {
    const long = "x".repeat(500);
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s1",
        conversationId: CONVERSATION,
        attributes: {
          "gen_ai.input.messages": encodeMessages("user", long),
          "gen_ai.output.messages": "not json at all",
        },
      }),
      TAB_A
    );

    const [session] = await storage.listSessions({});
    expect(session.request).toHaveLength(201);
    expect(session.request?.endsWith("…")).toBe(true);
    expect(session.response).toBeUndefined();
  });

  it("leaves spans without a conversation id out of the sessions view", async () => {
    await storage.storeSpan(
      span({
        name: "web_ai.check_availability",
        traceId: "t1",
        spanId: "s1",
        attributes: { "web_ai.availability.status": "available" },
      }),
      TAB_A
    );

    expect(await storage.listTraces({})).toHaveLength(1);
    expect(await storage.listSessions({})).toHaveLength(0);
  });

  it("falls back to web_ai.session.id when no conversation id is present", async () => {
    await storage.storeSpan(
      span({
        name: "web_ai.destroy_session",
        traceId: "t1",
        spanId: "s1",
        attributes: { "web_ai.session.id": "session-only" },
      }),
      TAB_A
    );

    const [session] = await storage.listSessions({});
    expect(session.conversationId).toBe("session-only");
  });

  it("scopes traces and sessions to the inspected tab", async () => {
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s1",
        conversationId: "conv-a",
      }),
      TAB_A
    );
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t2",
        spanId: "s2",
        conversationId: "conv-b",
      }),
      TAB_B
    );

    expect(await storage.listTraces({})).toHaveLength(2);

    const tracesA = await storage.listTraces({ tabId: 1 });
    expect(tracesA).toHaveLength(1);
    expect(tracesA[0].traceId).toBe("t1");

    const sessionsB = await storage.listSessions({ tabId: 2 });
    expect(sessionsB).toHaveLength(1);
    expect(sessionsB[0].conversationId).toBe("conv-b");

    const exportedA = await storage.exportSpans(1);
    expect(exportedA.map((s) => s.spanId)).toEqual(["s1"]);
  });

  it("lists newest first and honors the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.storeSpan(
        span({
          name: "generate_content",
          traceId: `t${i}`,
          spanId: `s${i}`,
          startMs: 1000 + i * 100,
          conversationId: `conv-${i}`,
        }),
        TAB_A
      );
    }

    const traces = await storage.listTraces({ limit: 2 });
    expect(traces.map((t) => t.traceId)).toEqual(["t4", "t3"]);
  });

  it("returns every span of a session in start order across traces", async () => {
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t2",
        spanId: "later",
        startMs: 3000,
        conversationId: CONVERSATION,
      }),
      TAB_A
    );
    await storage.storeSpan(
      span({
        name: "web_ai.create_session",
        traceId: "t1",
        spanId: "earlier",
        startMs: 1000,
        conversationId: CONVERSATION,
      }),
      TAB_A
    );

    const spans = await storage.getSpansForSession(CONVERSATION);
    expect(spans.map((s) => s.spanId)).toEqual(["earlier", "later"]);

    const traceSpans = await storage.getSpansForTrace("t1");
    expect(traceSpans.map((s) => s.spanId)).toEqual(["earlier"]);
  });

  it("clears only the requested tab", async () => {
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s1",
        conversationId: "conv-a",
      }),
      TAB_A
    );
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t2",
        spanId: "s2",
        conversationId: "conv-b",
      }),
      TAB_B
    );

    await storage.clearTraces(1);

    expect((await storage.listTraces({})).map((t) => t.traceId)).toEqual([
      "t2",
    ]);
    expect(
      (await storage.listSessions({})).map((s) => s.conversationId)
    ).toEqual(["conv-b"]);
    expect((await storage.exportSpans()).map((s) => s.spanId)).toEqual(["s2"]);
  });

  it("prunes the oldest traces along with their spans", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.storeSpan(
        span({
          name: "generate_content",
          traceId: `t${i}`,
          spanId: `s${i}`,
          startMs: 1000 + i * 100,
          conversationId: `conv-${i}`,
        }),
        TAB_A
      );
    }

    await storage.pruneOldTraces({ maxTraces: 2, maxSessions: 100 });

    const traces = await storage.listTraces({});
    expect(traces.map((t) => t.traceId)).toEqual(["t4", "t3"]);
    // Spans of pruned traces must go with them.
    expect((await storage.exportSpans()).map((s) => s.spanId)).toEqual([
      "s3",
      "s4",
    ]);
  });

  it("prunes the oldest sessions so the store stays bounded", async () => {
    for (let i = 0; i < 4; i++) {
      await storage.storeSpan(
        span({
          name: "generate_content",
          traceId: `t${i}`,
          spanId: `s${i}`,
          startMs: 1000 + i * 100,
          conversationId: `conv-${i}`,
        }),
        TAB_A
      );
    }

    await storage.pruneOldTraces({ maxTraces: 100, maxSessions: 2 });

    const sessions = await storage.listSessions({});
    expect(sessions.map((s) => s.conversationId)).toEqual(["conv-3", "conv-2"]);
    // Traces are capped independently and should be untouched here.
    expect(await storage.listTraces({})).toHaveLength(4);
  });

  it("keeps everything when under the caps", async () => {
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s1",
        conversationId: CONVERSATION,
      }),
      TAB_A
    );

    await storage.pruneOldTraces();

    expect(await storage.listTraces({})).toHaveLength(1);
    expect(await storage.listSessions({})).toHaveLength(1);
  });

  it("clears everything when no tab is given", async () => {
    await storage.storeSpan(
      span({
        name: "generate_content",
        traceId: "t1",
        spanId: "s1",
        conversationId: CONVERSATION,
      }),
      TAB_A
    );

    await storage.clearTraces();

    expect(await storage.listTraces({})).toHaveLength(0);
    expect(await storage.listSessions({})).toHaveLength(0);
    expect(await storage.exportSpans()).toHaveLength(0);
  });
});
