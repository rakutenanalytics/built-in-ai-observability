import {
  type SpanSource,
  validateSerializedSpan,
} from "@web-ai-otel/extension-transport/protocol";
import {
  BRIDGE_SPAN,
  type PanelRequest,
  TRACES_UPDATED,
} from "../shared/messages.js";
import {
  clearTraces,
  exportSpans,
  getSpansForSession,
  getSpansForTrace,
  listSessions,
  listTraces,
  pruneOldTraces,
  storeSpan,
} from "../storage/indexed-db.js";

/** Prune every N stored spans rather than on every insert. */
const PRUNE_INTERVAL = 200;
let spansSincePrune = 0;

/**
 * Derives attribution from the message sender. Page scripts can forge the span
 * body but not the sender, so this is the authoritative origin/tab.
 */
function sourceFromSender(sender: chrome.runtime.MessageSender): SpanSource {
  return {
    frameId: sender.frameId,
    origin: sender.origin ?? (sender.url && new URL(sender.url).origin),
    tabId: sender.tab?.id,
    url: sender.url,
  };
}

function notifyPanels(tabId?: number): void {
  chrome.runtime.sendMessage({ tabId, type: TRACES_UPDATED }).catch(() => {
    // No DevTools panel is open.
  });
}

async function handleBridgeSpan(
  payload: unknown,
  sender: chrome.runtime.MessageSender
): Promise<void> {
  // Re-validate: the bridge is a content script and shares the page process.
  const span = validateSerializedSpan(payload);
  if (!span) {
    return;
  }

  const source = sourceFromSender(sender);
  await storeSpan(span, source);

  spansSincePrune += 1;
  if (spansSincePrune >= PRUNE_INTERVAL) {
    spansSincePrune = 0;
    await pruneOldTraces();
  }

  notifyPanels(source.tabId);
}

async function handlePanelRequest(
  message: PanelRequest
): Promise<Record<string, unknown>> {
  switch (message.type) {
    case "list-traces":
      return { traces: await listTraces({ tabId: message.tabId }) };
    case "list-sessions":
      return { sessions: await listSessions({ tabId: message.tabId }) };
    case "get-trace-spans":
      return { spans: await getSpansForTrace(message.traceId) };
    case "get-session-spans":
      return { spans: await getSpansForSession(message.conversationId) };
    case "clear-traces":
      await clearTraces(message.tabId);
      return { ok: true };
    case "export-traces":
      return { spans: await exportSpans(message.tabId) };
    default:
      return { error: "unknown message" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message as { type?: string };
  if (!type) {
    return false;
  }

  if (type === BRIDGE_SPAN) {
    handleBridgeSpan((message as { payload?: unknown }).payload, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ error: String(err) }));
    return true;
  }

  // Ignore our own broadcast so it is not treated as an unknown request.
  if (type === TRACES_UPDATED) {
    return false;
  }

  handlePanelRequest(message as PanelRequest)
    .then(sendResponse)
    .catch((err: unknown) => sendResponse({ error: String(err) }));
  return true;
});

// Traces are scoped to a tab, so drop them when that tab goes away.
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTraces(tabId).catch(() => {
    // Nothing stored for this tab.
  });
});
