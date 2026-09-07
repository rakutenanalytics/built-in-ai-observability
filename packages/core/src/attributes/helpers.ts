import {
  GEN_AI,
  SESSION_ID,
  WEB_AI,
} from "../semantic-conventions/attributes.js";
import type { SessionTelemetryMeta } from "../types/config.js";

export function sessionAttributes(
  meta: SessionTelemetryMeta
): Record<string, string> {
  const attrs: Record<string, string> = {
    [GEN_AI.CONVERSATION_ID]: meta.conversationId,
    [WEB_AI.SESSION_ID]: meta.sessionId,
    [SESSION_ID]: meta.sessionId,
  };
  if (meta.parentSessionId) {
    attrs[WEB_AI.SESSION_PARENT_ID] = meta.parentSessionId;
  }
  return attrs;
}

export function truncateAttribute(value: string, maxLength: number): string {
  if (maxLength <= 0 || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…[truncated]`;
}
