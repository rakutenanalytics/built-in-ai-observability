import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PressureMonitor } from "../src/runtime/pressure.js";

const CPU_MAX = "web_ai.runtime.pressure.cpu.max";
const STALE_MS = 6000;

type Callback = (records: { source: string; state: string }[]) => void;

let rejectObserve = false;

class FakeObserver {
  static knownSources: string[] = ["cpu"];
  static instances: FakeObserver[] = [];

  readonly disconnect = vi.fn();
  readonly observe = vi.fn((_source: string) =>
    rejectObserve
      ? Promise.reject(new Error("denied"))
      : Promise.resolve(undefined)
  );
  readonly emit: (state: string, source?: string) => void;

  constructor(callback: Callback) {
    this.emit = (state, source = "cpu") => callback([{ source, state }]);
    FakeObserver.instances.push(this);
  }
}

const observer = (): FakeObserver => {
  const [first] = FakeObserver.instances;
  if (!first) {
    throw new Error("PressureObserver was never constructed");
  }
  return first;
};

describe("PressureMonitor", () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    FakeObserver.instances = [];
    FakeObserver.knownSources = ["cpu"];
    rejectObserve = false;
    (globalThis as Record<string, unknown>).PressureObserver = FakeObserver;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as Record<string, unknown>).PressureObserver = undefined;
  });

  it("reports the worst state seen while the window was open", () => {
    const monitor = new PressureMonitor();
    monitor.start();
    observer().emit("fair");

    const end = monitor.begin();
    observer().emit("critical");
    observer().emit("nominal");

    expect(end()).toEqual({ [CPU_MAX]: "critical" });
  });

  it("seeds a window from the latest fresh reading", () => {
    const monitor = new PressureMonitor();
    monitor.start();
    observer().emit("serious");

    expect(monitor.begin()()).toEqual({ [CPU_MAX]: "serious" });
  });

  it("sets nothing without a reading, rather than reporting nominal", () => {
    const monitor = new PressureMonitor();
    monitor.start();

    expect(monitor.begin()()).toEqual({});
  });

  it("drops a reading too old to describe the span", () => {
    const monitor = new PressureMonitor();
    monitor.start();
    observer().emit("critical");

    now = STALE_MS;
    expect(monitor.begin()()).toEqual({});
  });

  it("ignores states and sources it does not know", () => {
    const monitor = new PressureMonitor();
    monitor.start();
    const end = monitor.begin();
    observer().emit("warp-speed");
    observer().emit("critical", "gpu");

    expect(end()).toEqual({});
  });

  it("only observes sources the browser knows", () => {
    FakeObserver.knownSources = [];
    new PressureMonitor().start();

    expect(observer().observe).not.toHaveBeenCalled();
  });

  it("is a no-op where PressureObserver is missing", () => {
    (globalThis as Record<string, unknown>).PressureObserver = undefined;
    const monitor = new PressureMonitor();

    expect(() => monitor.start()).not.toThrow();
    expect(monitor.begin()()).toEqual({});
  });

  it("swallows a rejected observe()", async () => {
    rejectObserve = true;
    const monitor = new PressureMonitor();
    monitor.start();
    // An unhandled rejection would fail the run once the microtask drains.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observer().observe).toHaveBeenCalledOnce();
    expect(monitor.begin()()).toEqual({});
  });

  it("disconnects on stop", () => {
    const monitor = new PressureMonitor();
    monitor.start();
    monitor.stop();

    expect(observer().disconnect).toHaveBeenCalledOnce();
  });
});
