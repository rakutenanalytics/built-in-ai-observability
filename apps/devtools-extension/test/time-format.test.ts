import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatTraceListTime,
  getTimeBucket,
  startOfLocalWeek,
  timeBucketLabel,
} from "../src/panel/time-format.js";

// Wednesday, 17 Sep 2026 15:00 local
const NOW = new Date(2026, 8, 17, 15, 0, 0).getTime();

describe("getTimeBucket", () => {
  it("classifies today, yesterday, this week, and earlier", () => {
    expect(getTimeBucket(new Date(2026, 8, 17, 14, 0, 0).getTime(), NOW)).toBe(
      "today"
    );
    expect(getTimeBucket(new Date(2026, 8, 16, 10, 0, 0).getTime(), NOW)).toBe(
      "yesterday"
    );
    expect(getTimeBucket(new Date(2026, 8, 14, 10, 0, 0).getTime(), NOW)).toBe(
      "this-week"
    );
    expect(getTimeBucket(new Date(2026, 8, 10, 10, 0, 0).getTime(), NOW)).toBe(
      "earlier"
    );
  });

  it("starts the week on Monday", () => {
    const wednesday = new Date(2026, 8, 17, 12, 0, 0);
    expect(startOfLocalWeek(wednesday).getDay()).toBe(1);
    expect(startOfLocalWeek(wednesday).getDate()).toBe(14);
  });
});

describe("timeBucketLabel", () => {
  it("returns readable section titles", () => {
    expect(timeBucketLabel("today")).toBe("Today");
    expect(timeBucketLabel("yesterday")).toBe("Yesterday");
    expect(timeBucketLabel("this-week")).toBe("This week");
    expect(timeBucketLabel("earlier")).toBe("Earlier");
  });
});

describe("formatTraceListTime", () => {
  it("shows time only for today and yesterday", () => {
    const today = new Date(2026, 8, 17, 14, 30, 0).getTime();
    const yesterday = new Date(2026, 8, 16, 9, 15, 0).getTime();
    expect(formatTraceListTime(today, NOW)).toContain("30");
    expect(formatTraceListTime(yesterday, NOW)).toContain("15");
    expect(formatTraceListTime(today, NOW)).not.toContain("Sep");
  });

  it("adds weekday for this week and full date for earlier", () => {
    const monday = new Date(2026, 8, 14, 11, 0, 0).getTime();
    const earlier = new Date(2026, 8, 1, 11, 0, 0).getTime();
    expect(formatTraceListTime(monday, NOW).toLowerCase()).toContain("mon");
    expect(formatTraceListTime(earlier, NOW)).toContain("2026");
  });
});

describe("formatDateTime", () => {
  it("includes both date and time", () => {
    const formatted = formatDateTime(
      new Date(2026, 8, 17, 14, 30, 45).getTime()
    );
    expect(formatted).toContain("2026");
    expect(formatted).toContain("17");
    expect(formatted).toContain("30");
  });
});
