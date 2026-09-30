import { PROTOCOL_VERSION } from "@built-in-ai-obs/extension-transport/protocol";
import { describe, expect, it } from "vitest";
import { groupSpans } from "../src/panel/span-groups.js";
import { axisTicks, timelineLayout } from "../src/panel/span-timeline.js";
import type { StoredSpan } from "../src/storage/indexed-db.js";

const MS_PER_SECOND = 1000;
const NANOS_PER_MS = 1_000_000;

function hr(ms: number): [number, number] {
  return [Math.floor(ms / MS_PER_SECOND), (ms % MS_PER_SECOND) * NANOS_PER_MS];
}

function span(overrides: {
  spanId: string;
  name?: string;
  parentSpanId?: string;
  startMs: number;
  durationMs: number;
}): StoredSpan {
  return {
    attributes: {},
    durationMs: overrides.durationMs,
    endTime: hr(overrides.startMs + overrides.durationMs),
    events: [],
    kind: 0,
    name: overrides.name ?? overrides.spanId,
    parentSpanId: overrides.parentSpanId,
    protocolVersion: PROTOCOL_VERSION,
    source: {
      frameId: 0,
      origin: "https://a.test",
      tabId: 1,
      url: "https://a.test/",
    },
    spanId: overrides.spanId,
    startTime: hr(overrides.startMs),
    startTimeMs: overrides.startMs,
    status: { code: 1 },
    traceId: "trace-1",
  };
}

function layoutOf(spans: StoredSpan[]) {
  return timelineLayout(spans, groupSpans(spans));
}

describe("timelineLayout", () => {
  it("places bars proportionally within the trace window", () => {
    const spans = [
      span({ durationMs: 400, spanId: "root", startMs: 1000 }),
      span({
        durationMs: 200,
        parentSpanId: "root",
        spanId: "child",
        startMs: 1200,
      }),
    ];

    const { rows, totalMs } = layoutOf(spans);

    expect(totalMs).toBe(400);
    expect(rows.map((row) => row.span.spanId)).toEqual(["root", "child"]);
    expect(rows[0]).toMatchObject({ depth: 0, offsetPct: 0, widthPct: 100 });
    expect(rows[1]).toMatchObject({ depth: 1, offsetPct: 50, widthPct: 50 });
  });

  it("orders siblings by start time and nests their children", () => {
    const spans = [
      span({ durationMs: 100, spanId: "root", startMs: 0 }),
      span({
        durationMs: 10,
        parentSpanId: "root",
        spanId: "late",
        startMs: 60,
      }),
      span({
        durationMs: 10,
        parentSpanId: "root",
        spanId: "early",
        startMs: 10,
      }),
      span({
        durationMs: 2,
        parentSpanId: "early",
        spanId: "leaf",
        startMs: 12,
      }),
    ];

    const { rows } = layoutOf(spans);

    expect(rows.map((row) => [row.span.spanId, row.depth])).toEqual([
      ["root", 0],
      ["early", 1],
      ["leaf", 2],
      ["late", 1],
    ]);
  });

  /** A tool call that resolves synchronously still needs a place on the axis. */
  it("keeps a zero-duration span positioned where it happened", () => {
    const spans = [
      span({ durationMs: 200, spanId: "root", startMs: 0 }),
      span({
        durationMs: 0,
        parentSpanId: "root",
        spanId: "tool",
        startMs: 150,
      }),
    ];

    const { rows } = layoutOf(spans);

    expect(rows[1]).toMatchObject({ offsetPct: 75, widthPct: 0 });
  });

  it("treats a span reaching past its parent as the window end", () => {
    const spans = [
      span({ durationMs: 50, spanId: "root", startMs: 0 }),
      span({
        durationMs: 75,
        parentSpanId: "root",
        spanId: "child",
        startMs: 25,
      }),
    ];

    const { totalMs, rows } = layoutOf(spans);

    expect(totalMs).toBe(100);
    expect(rows[0]).toMatchObject({ offsetPct: 0, widthPct: 50 });
    expect(rows[1]).toMatchObject({ offsetPct: 25, widthPct: 75 });
  });

  it("handles an empty trace and an instantaneous one without dividing by zero", () => {
    expect(layoutOf([])).toEqual({ rows: [], totalMs: 0 });

    const { rows, totalMs } = layoutOf([
      span({ durationMs: 0, spanId: "only", startMs: 500 }),
    ]);
    expect(totalMs).toBe(0);
    expect(rows[0]).toMatchObject({ offsetPct: 0, widthPct: 0 });
  });
});

describe("axisTicks", () => {
  it("steps a multi-second trace in whole seconds", () => {
    expect(axisTicks(3070)).toEqual([0, 1000, 2000, 3000]);
  });

  it("steps a sub-second trace in round fractions", () => {
    expect(axisTicks(939)).toEqual([0, 200, 400, 600, 800]);
  });

  it("never steps finer than a millisecond", () => {
    expect(axisTicks(2)).toEqual([0, 1, 2]);
  });

  it("has nothing to label without a window", () => {
    expect(axisTicks(0)).toEqual([]);
  });
});
