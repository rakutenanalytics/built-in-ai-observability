/**
 * Epoch milliseconds for timestamps an instrumentation sets by hand.
 *
 * Left alone, the SDK starts a span from `Date.now()`, which is whole
 * milliseconds, and derives its end from the monotonic clock. That is enough
 * for a span timed in one place, but a tool exchange is timed across several
 * calls: at millisecond granularity a fast tool collapses into a zero-length
 * span starting on the same tick as the turn it precedes, and siblings sharing
 * a start have no order left for a trace viewer to show. Taking every hand-set
 * timestamp from the monotonic clock instead keeps a reconstructed span
 * sub-millisecond and strictly between its neighbours.
 *
 * The result is still epoch milliseconds, which is what the SDK expects of a
 * `startTime` above the process start; a value on the `performance.now()` scale
 * would instead be re-based per span, reintroducing the drift this avoids.
 */
export function spanTimestamp(): number {
  return performance.timeOrigin + performance.now();
}
