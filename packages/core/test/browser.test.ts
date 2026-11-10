import { afterEach, describe, expect, it, vi } from "vitest";
import { browserResourceAttributes } from "../src/runtime/browser.js";

describe("browserResourceAttributes hardware hints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubNavigator = (hints: Record<string, unknown> = {}) => {
    vi.stubGlobal("navigator", {
      language: "en-US",
      userAgent: "test-browser",
      ...hints,
    });
  };

  it("collects hardware hints even without user-agent client hints", () => {
    stubNavigator({ cpuPerformance: 3, deviceMemory: 0.5 });

    expect(browserResourceAttributes()).toEqual({
      "browser.language": "en-US",
      "user_agent.original": "test-browser",
      "web_ai.runtime.cpu_performance_tier": 3,
      "web_ai.runtime.device_memory_gib": 0.5,
    });
  });

  it.each([0, 1, 4, 5])("preserves CPU tier %s", (cpuPerformance) => {
    stubNavigator({ cpuPerformance });

    expect(
      browserResourceAttributes()["web_ai.runtime.cpu_performance_tier"]
    ).toBe(cpuPerformance);
  });

  it.each([
    undefined,
    null,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "3",
  ])(
    "omits unsupported or invalid CPU tier %s while retaining memory",
    (cpuPerformance) => {
      stubNavigator({ cpuPerformance, deviceMemory: 8 });

      const attributes = browserResourceAttributes();
      expect(attributes).not.toHaveProperty(
        "web_ai.runtime.cpu_performance_tier"
      );
      expect(attributes["web_ai.runtime.device_memory_gib"]).toBe(8);
    }
  );

  it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "8"])(
    "omits unsupported or invalid memory %s while retaining the CPU tier",
    (deviceMemory) => {
      stubNavigator({ cpuPerformance: 2, deviceMemory });

      const attributes = browserResourceAttributes();
      expect(attributes).not.toHaveProperty("web_ai.runtime.device_memory_gib");
      expect(attributes["web_ai.runtime.cpu_performance_tier"]).toBe(2);
    }
  );

  it("omits both hints when neither API is available", () => {
    stubNavigator();

    expect(browserResourceAttributes()).toEqual({
      "browser.language": "en-US",
      "user_agent.original": "test-browser",
    });
  });
});
