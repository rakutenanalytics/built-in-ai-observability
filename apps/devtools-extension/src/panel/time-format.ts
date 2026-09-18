const MS_PER_DAY = 86_400_000;

export type TimeBucket = "earlier" | "this-week" | "today" | "yesterday";

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Week starts on Monday in the user's local timezone. */
export function startOfLocalWeek(date: Date): Date {
  const start = startOfLocalDay(date);
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  return start;
}

export function getTimeBucket(
  timestampMs: number,
  nowMs = Date.now()
): TimeBucket {
  const when = startOfLocalDay(new Date(timestampMs)).getTime();
  const today = startOfLocalDay(new Date(nowMs)).getTime();
  if (when >= today) {
    return "today";
  }
  const yesterday = today - MS_PER_DAY;
  if (when >= yesterday) {
    return "yesterday";
  }
  const weekStart = startOfLocalWeek(new Date(nowMs)).getTime();
  if (when >= weekStart) {
    return "this-week";
  }
  return "earlier";
}

export function timeBucketLabel(bucket: TimeBucket): string {
  switch (bucket) {
    case "today":
      return "Today";
    case "yesterday":
      return "Yesterday";
    case "this-week":
      return "This week";
    case "earlier":
      return "Earlier";
    default:
      return bucket;
  }
}

/** Full local date and time for trace/span detail panels. */
export function formatDateTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

/**
 * Compact local time for list rows. The section header carries the day bucket,
 * so today/yesterday show time only; older rows add weekday or full date.
 */
export function formatTraceListTime(
  timestampMs: number,
  nowMs = Date.now()
): string {
  const bucket = getTimeBucket(timestampMs, nowMs);
  const date = new Date(timestampMs);
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  switch (bucket) {
    case "today":
    case "yesterday":
      return time;
    case "this-week":
      return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
    case "earlier":
      return date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    default:
      return time;
  }
}
