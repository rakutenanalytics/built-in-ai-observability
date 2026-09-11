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
    protocolVersion: 1,
    traceId: "trace-1",
    spanId: overrides.spanId,
    parentSpanId: overrides.parentSpanId,
    name: overrides.name ?? overrides.spanId,
    kind: 0,
    startTime: hr(overrides.startMs),
    endTime: hr(overrides.startMs + overrides.durationMs),
    attributes: {},
    events: [],
    status: { code: 1 },
    source: {
      tabId: 1,
      frameId: 0,
      url: "https://a.test/",
      origin: "https://a.test",
    },
    startTimeMs: overrides.startMs,
    durationMs: overrides.durationMs,
  };
}

function layoutOf(spans: StoredSpan[]) {
  return timelineLayout(spans, groupSpans(spans));
}

describe("timelineLayout", () => {
  it("places bars proportionally within the trace window", () => {
    const spans = [
      span({ spanId: "root", startMs: 1000, durationMs: 400 }),
      span({
        spanId: "child",
        parentSpanId: "root",
        startMs: 1200,
        durationMs: 200,
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
      span({ spanId: "root", startMs: 0, durationMs: 100 }),
      span({
        spanId: "late",
        parentSpanId: "root",
        startMs: 60,
        durationMs: 10,
      }),
      span({
        spanId: "early",
        parentSpanId: "root",
        startMs: 10,
        durationMs: 10,
      }),
      span({
        spanId: "leaf",
        parentSpanId: "early",
        startMs: 12,
        durationMs: 2,
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
      span({ spanId: "root", startMs: 0, durationMs: 200 }),
      span({
        spanId: "tool",
        parentSpanId: "root",
        startMs: 150,
        durationMs: 0,
      }),
    ];

    const { rows } = layoutOf(spans);

    expect(rows[1]).toMatchObject({ offsetPct: 75, widthPct: 0 });
  });

  it("treats a span reaching past its parent as the window end", () => {
    const spans = [
      span({ spanId: "root", startMs: 0, durationMs: 50 }),
      span({
        spanId: "child",
        parentSpanId: "root",
        startMs: 25,
        durationMs: 75,
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
      span({ spanId: "only", startMs: 500, durationMs: 0 }),
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
