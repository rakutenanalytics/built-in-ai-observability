import { WEB_AI } from "@built-in-ai-obs/core";
import { describe, expect, it } from "vitest";
import {
  contextUtilizationFromAttributes,
  contextUtilizationLabel,
  formatContextUtilization,
} from "../src/panel/context-meta.js";

describe("formatContextUtilization", () => {
  it("formats ratios as percentages", () => {
    expect(formatContextUtilization(0.3)).toBe("30%");
    expect(formatContextUtilization(0)).toBe("0%");
  });
});

describe("contextUtilizationFromAttributes", () => {
  it("prefers utilization_after over derived usage", () => {
    expect(
      contextUtilizationFromAttributes({
        [WEB_AI.CONTEXT_UTILIZATION_AFTER]: 0.25,
        [WEB_AI.CONTEXT_USAGE_AFTER]: 500,
        [WEB_AI.CONTEXT_WINDOW]: 1000,
      })
    ).toBe(0.25);
  });

  it("derives utilization from usage and window", () => {
    expect(
      contextUtilizationFromAttributes({
        [WEB_AI.CONTEXT_USAGE_AFTER]: 691,
        [WEB_AI.CONTEXT_WINDOW]: 9216,
      })
    ).toBeCloseTo(691 / 9216);
  });
});

describe("contextUtilizationLabel", () => {
  it("falls back to usage and window on summaries", () => {
    expect(
      contextUtilizationLabel({
        contextUsage: 921,
        contextWindow: 9216,
      })
    ).toBe("10%");
  });
});
