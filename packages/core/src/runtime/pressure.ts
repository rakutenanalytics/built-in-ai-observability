import type { Attributes } from "@opentelemetry/api";
import { WEB_AI } from "../semantic-conventions/attributes.js";

/** Ordered from least to most pressure; the index is the rank. */
const PRESSURE_STATES = ["nominal", "fair", "serious", "critical"] as const;

/**
 * Pressure sources we record, and the span attribute each one lands on.
 * Chromium only implements "cpu" today. A new source needs one line here.
 */
const SOURCE_ATTRIBUTES = { cpu: WEB_AI.PRESSURE_CPU_MAX } as const;

type PressureSourceName = keyof typeof SOURCE_ATTRIBUTES;

const SAMPLE_INTERVAL_MS = 1000;
/**
 * Chrome only delivers readings to a focused document, so a held value can be
 * arbitrarily old. Past this age it is dropped rather than stamped on a span
 * that ran while the tab was in the background.
 */
const STALE_AFTER_MS = 5000;

interface PressureRecordLike {
  source: string;
  state: string;
}

interface PressureObserverLike {
  disconnect: () => void;
  observe: (
    source: string,
    options?: { sampleInterval: number }
  ) => Promise<undefined>;
}

interface PressureObserverConstructor {
  readonly knownSources?: readonly string[];
  new (callback: (records: PressureRecordLike[]) => void): PressureObserverLike;
}

const isSource = (source: string): source is PressureSourceName =>
  source in SOURCE_ATTRIBUTES;

/**
 * Tracks the Compute Pressure API and reports the worst state seen while a
 * span was open. Opt-in: observing can surface a browser notice to the user.
 *
 * A source with no fresh reading yields no attribute, never `nominal`: Chrome
 * withholds readings from unfocused tabs, and "unknown" is not "fine".
 */
export class PressureMonitor {
  private observer: PressureObserverLike | undefined;
  private readonly latest = new Map<
    PressureSourceName,
    { at: number; rank: number }
  >();
  private readonly open = new Set<Map<PressureSourceName, number>>();

  /** Starts observing. A no-op where the API or a source is missing. */
  start(): void {
    if (this.observer) {
      return;
    }
    const Observer = (
      globalThis as { PressureObserver?: PressureObserverConstructor }
    ).PressureObserver;
    if (!Observer) {
      return;
    }

    try {
      const observer = new Observer((records) => {
        for (const record of records) {
          this.record(record);
        }
      });
      this.observer = observer;
      for (const source of Object.keys(SOURCE_ATTRIBUTES)) {
        if (Observer.knownSources?.includes(source)) {
          observer
            .observe(source, { sampleInterval: SAMPLE_INTERVAL_MS })
            .catch(() => {
              // Unsupported or blocked by Permissions-Policy: record nothing.
            });
        }
      }
    } catch {
      this.observer = undefined;
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.latest.clear();
    this.open.clear();
  }

  /**
   * Opens a window for one span. The returned function closes it and gives
   * back the attributes to set on the span.
   */
  begin(): () => Attributes {
    const window = new Map<PressureSourceName, number>();
    const now = performance.now();
    for (const [source, { at, rank }] of this.latest) {
      if (now - at <= STALE_AFTER_MS) {
        window.set(source, rank);
      }
    }
    this.open.add(window);

    return () => {
      this.open.delete(window);
      const attributes: Attributes = {};
      for (const [source, rank] of window) {
        attributes[SOURCE_ATTRIBUTES[source]] = PRESSURE_STATES[rank];
      }
      return attributes;
    };
  }

  private record({ source, state }: PressureRecordLike): void {
    const rank = PRESSURE_STATES.indexOf(state as never);
    if (!isSource(source) || rank < 0) {
      return;
    }
    this.latest.set(source, { at: performance.now(), rank });
    for (const window of this.open) {
      window.set(source, Math.max(window.get(source) ?? rank, rank));
    }
  }
}
