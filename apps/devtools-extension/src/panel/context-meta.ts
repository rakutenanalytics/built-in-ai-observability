import { WEB_AI } from "@built-in-ai-obs/core";

interface ContextSummary {
  contextUsage?: number;
  contextUtilization?: number;
  contextWindow?: number;
}

function numberAttr(
  attributes: Record<string, unknown>,
  key: string
): number | undefined {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Reads utilization from the span attribute, or derives it from usage / window. */
export function contextUtilizationFromAttributes(
  attributes: Record<string, unknown>
): number | undefined {
  const utilization = numberAttr(attributes, WEB_AI.CONTEXT_UTILIZATION_AFTER);
  if (utilization !== undefined) {
    return utilization;
  }

  const usage = numberAttr(attributes, WEB_AI.CONTEXT_USAGE_AFTER);
  const window = numberAttr(attributes, WEB_AI.CONTEXT_WINDOW);
  if (usage !== undefined && window !== undefined && window > 0) {
    return usage / window;
  }
}

export function contextUtilizationFromSummary(
  summary: ContextSummary
): number | undefined {
  if (summary.contextUtilization !== undefined) {
    return summary.contextUtilization;
  }
  if (
    summary.contextUsage !== undefined &&
    summary.contextWindow !== undefined &&
    summary.contextWindow > 0
  ) {
    return summary.contextUsage / summary.contextWindow;
  }
}

export function formatContextUtilization(
  utilization: number | undefined
): string | undefined {
  if (utilization === undefined) {
    return;
  }
  const percent = utilization * 100;
  const rounded =
    percent >= 10 || percent === 0
      ? Math.round(percent)
      : Math.round(percent * 10) / 10;
  return `${rounded}%`;
}

export function contextUtilizationLabel(
  summary: ContextSummary
): string | undefined {
  return formatContextUtilization(contextUtilizationFromSummary(summary));
}
