import { WEB_AI } from "../semantic-conventions/attributes.js";

interface LanguageModelSession {
  contextWindow?: number;
  inputQuota?: number;
  contextUsage?: number;
  inputUsage?: number;
}

export function readContextWindow(
  session: LanguageModelSession
): number | undefined {
  const value = session.contextWindow ?? session.inputQuota;
  return Number.isFinite(value) ? value : undefined;
}

export function readContextUsage(
  session: LanguageModelSession
): number | undefined {
  const value = session.contextUsage ?? session.inputUsage;
  return Number.isFinite(value) ? value : undefined;
}

export function contextAttributes(
  windowTokens: number | undefined,
  before: number | undefined,
  after: number | undefined
): Record<string, number> {
  const attributes: Record<string, number> = {};
  if (before !== undefined) {
    attributes[WEB_AI.CONTEXT_USAGE_BEFORE] = before;
  }
  if (after === undefined) {
    return attributes;
  }

  attributes[WEB_AI.CONTEXT_USAGE_AFTER] = after;
  if (before !== undefined) {
    attributes[WEB_AI.CONTEXT_USAGE_DELTA] = after - before;
  }
  if (windowTokens !== undefined && windowTokens > 0) {
    attributes[WEB_AI.CONTEXT_REMAINING_AFTER] = windowTokens - after;
    attributes[WEB_AI.CONTEXT_UTILIZATION_AFTER] = after / windowTokens;
  }
  return attributes;
}
