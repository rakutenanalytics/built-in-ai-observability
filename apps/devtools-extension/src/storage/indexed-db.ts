import type {
  SerializedSpan,
  SpanSource,
} from "@built-in-ai-obs/extension-transport/protocol";

const DB_NAME = "built-in-ai-obs";
const DB_VERSION = 4;
const SPANS_STORE = "spans";
const TRACES_STORE = "traces";
const SESSIONS_STORE = "sessions";

/** Newest traces to retain; older ones are pruned along with their spans. */
const MAX_TRACES = 2000;
/** Newest sessions to retain. Capped separately from traces. */
const MAX_SESSIONS = 500;

const NANOS_PER_MS = 1_000_000;
const MS_PER_SECOND = 1000;
const SPAN_STATUS_ERROR = 2;
const PREVIEW_MAX_LENGTH = 200;

const CONVERSATION_ID = "gen_ai.conversation.id";
const SESSION_ID = "web_ai.session.id";
const INPUT_MESSAGES = "gen_ai.input.messages";
const OUTPUT_MESSAGES = "gen_ai.output.messages";
const CONTEXT_WINDOW = "web_ai.context.window_tokens";
const CONTEXT_USAGE_AFTER = "web_ai.context.usage_after_tokens";
const CONTEXT_UTILIZATION_AFTER = "web_ai.context.utilization_after";
const OPERATION_NAME = "gen_ai.operation.name";
const TURN_SPAN_NAME = "generate_content";
const EXECUTE_TOOL_OPERATION = "execute_tool";

/** A span plus the attribution the extension derived from the sender. */
export interface StoredSpan extends SerializedSpan {
  /** Denormalized for indexing; IndexedDB keyPaths cannot contain dots. */
  conversationId?: string;
  durationMs: number;
  source: SpanSource;
  startTimeMs: number;
}

export interface TraceSummary {
  contextUsage?: number;
  contextUtilization?: number;
  contextWindow?: number;
  conversationId?: string;
  durationMs: number;
  endTimeMs: number;
  origin: string;
  /** The question and the answer, both taken from the root span. */
  request?: string;
  response?: string;
  rootSpanName: string;
  spanCount: number;
  startTimeMs: number;
  statusCode: number;
  tabId?: number;
  /** `execute_tool` spans in the trace, so a tool exchange reads as one. */
  toolCallCount: number;
  traceId: string;
  url?: string;
}

/**
 * A conversation, spanning every trace that shares a `gen_ai.conversation.id`.
 * One `LanguageModel` session (plus any clones of it) maps to one of these.
 */
export interface SessionSummary {
  contextUsage?: number;
  contextUtilization?: number;
  contextWindow?: number;
  conversationId: string;
  durationMs: number;
  endTimeMs: number;
  errorCount: number;
  origin: string;
  /** First captured user text; absent when content capture is off. */
  request?: string;
  /** Most recent captured assistant text. */
  response?: string;
  spanCount: number;
  startTimeMs: number;
  tabId?: number;
  toolCallCount: number;
  traceIds: string[];
  turnCount: number;
  url?: string;
}

function contextFromSpan(span: StoredSpan): {
  contextWindow?: number;
  contextUsage?: number;
  contextUtilization?: number;
} {
  return {
    contextUsage: numberAttr(span, CONTEXT_USAGE_AFTER),
    contextUtilization: numberAttr(span, CONTEXT_UTILIZATION_AFTER),
    contextWindow: numberAttr(span, CONTEXT_WINDOW),
  };
}

function mergeContext<
  T extends {
    contextWindow?: number;
    contextUsage?: number;
    contextUtilization?: number;
  },
>(
  existing: T | undefined,
  span: StoredSpan
): Pick<T, "contextWindow" | "contextUsage" | "contextUtilization"> {
  const latest = contextFromSpan(span);
  return {
    contextUsage: latest.contextUsage ?? existing?.contextUsage,
    contextUtilization:
      latest.contextUtilization ?? existing?.contextUtilization,
    contextWindow: latest.contextWindow ?? existing?.contextWindow,
  };
}

function hrTimeToMs(hr: [number, number]): number {
  return hr[0] * MS_PER_SECOND + hr[1] / NANOS_PER_MS;
}

function stringAttr(span: SerializedSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" ? value : undefined;
}

function numberAttr(span: SerializedSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Matched on the operation rather than the span name, since the name carries
 * the tool as well (`execute_tool get_weather`).
 */
function isToolSpan(span: SerializedSpan): boolean {
  return stringAttr(span, OPERATION_NAME) === EXECUTE_TOOL_OPERATION;
}

function countOf(condition: boolean): number {
  return condition ? 1 : 0;
}

function truncate(text: string): string {
  return text.length > PREVIEW_MAX_LENGTH
    ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…`
    : text;
}

/** Pulls the first text part out of an encoded GenAI message array. */
function previewFrom(json: string | undefined): string | undefined {
  if (!json) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) {
    return;
  }
  for (const message of parsed as Array<{
    parts?: Array<{ type?: string; content?: string }>;
  }>) {
    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.content) {
        return truncate(part.content);
      }
    }
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Span records are a disposable local cache, so upgrades rebuild the
      // stores rather than migrating.
      for (const name of [SPANS_STORE, TRACES_STORE, SESSIONS_STORE]) {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name);
        }
      }
      const spans = db.createObjectStore(SPANS_STORE, { keyPath: "spanId" });
      spans.createIndex("traceId", "traceId", { unique: false });
      spans.createIndex("conversationId", "conversationId", { unique: false });
      spans.createIndex("startTimeMs", "startTimeMs", { unique: false });

      const traces = db.createObjectStore(TRACES_STORE, { keyPath: "traceId" });
      traces.createIndex("startTimeMs", "startTimeMs", { unique: false });
      traces.createIndex("tabId", "tabId", { unique: false });

      const sessions = db.createObjectStore(SESSIONS_STORE, {
        keyPath: "conversationId",
      });
      sessions.createIndex("startTimeMs", "startTimeMs", { unique: false });
      sessions.createIndex("tabId", "tabId", { unique: false });
    };
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function originOf(span: StoredSpan): string {
  return span.source.origin ?? span.frame?.origin ?? "unknown";
}

/**
 * Only the root span speaks for the whole trace. On a tool exchange the turns
 * underneath it output tool calls rather than the answer, so reading them would
 * summarise the trace by something the user never asked about.
 */
function rootContent(span: StoredSpan): Partial<TraceSummary> {
  if (span.parentSpanId !== undefined) {
    return {};
  }
  return {
    request: previewFrom(stringAttr(span, INPUT_MESSAGES)),
    response: previewFrom(stringAttr(span, OUTPUT_MESSAGES)),
    rootSpanName: span.name,
  };
}

function mergeTrace(
  existing: TraceSummary | undefined,
  span: StoredSpan,
  endTimeMs: number
): TraceSummary {
  if (!existing) {
    return {
      conversationId: span.conversationId,
      durationMs: span.durationMs,
      endTimeMs,
      origin: originOf(span),
      rootSpanName: span.name,
      spanCount: 1,
      startTimeMs: span.startTimeMs,
      statusCode: span.status.code,
      tabId: span.source.tabId,
      toolCallCount: countOf(isToolSpan(span)),
      traceId: span.traceId,
      url: span.source.url ?? span.frame?.url,
      ...rootContent(span),
      ...contextFromSpan(span),
    };
  }

  const startTimeMs = Math.min(existing.startTimeMs, span.startTimeMs);
  const mergedEnd = Math.max(existing.endTimeMs, endTimeMs);
  return {
    ...existing,
    conversationId: existing.conversationId ?? span.conversationId,
    durationMs: mergedEnd - startTimeMs,
    endTimeMs: mergedEnd,
    spanCount: existing.spanCount + 1,
    startTimeMs,
    // SpanStatusCode orders UNSET < OK < ERROR, so this surfaces failures.
    statusCode: Math.max(existing.statusCode, span.status.code),
    toolCallCount: existing.toolCallCount + countOf(isToolSpan(span)),
    // The root arrives last, since it cannot end before what it holds.
    ...rootContent(span),
    ...mergeContext(existing, span),
  };
}

function newSession(
  span: StoredSpan,
  conversationId: string,
  endTimeMs: number
): SessionSummary {
  return {
    conversationId,
    durationMs: span.durationMs,
    endTimeMs,
    errorCount: countOf(span.status.code === SPAN_STATUS_ERROR),
    origin: originOf(span),
    request: previewFrom(stringAttr(span, INPUT_MESSAGES)),
    response: previewFrom(stringAttr(span, OUTPUT_MESSAGES)),
    spanCount: 1,
    startTimeMs: span.startTimeMs,
    tabId: span.source.tabId,
    toolCallCount: countOf(isToolSpan(span)),
    traceIds: [span.traceId],
    turnCount: countOf(span.name === TURN_SPAN_NAME),
    url: span.source.url ?? span.frame?.url,
    ...contextFromSpan(span),
  };
}

function mergeSession(
  existing: SessionSummary | undefined,
  span: StoredSpan,
  conversationId: string,
  endTimeMs: number
): SessionSummary {
  if (!existing) {
    return newSession(span, conversationId, endTimeMs);
  }

  const startTimeMs = Math.min(existing.startTimeMs, span.startTimeMs);
  const mergedEnd = Math.max(existing.endTimeMs, endTimeMs);
  const traceIds = existing.traceIds.includes(span.traceId)
    ? existing.traceIds
    : [...existing.traceIds, span.traceId];

  return {
    ...existing,
    durationMs: mergedEnd - startTimeMs,
    endTimeMs: mergedEnd,
    errorCount:
      existing.errorCount + countOf(span.status.code === SPAN_STATUS_ERROR),
    // Keep the opening request, but track the latest response.
    request: existing.request ?? previewFrom(stringAttr(span, INPUT_MESSAGES)),
    response:
      previewFrom(stringAttr(span, OUTPUT_MESSAGES)) ?? existing.response,
    spanCount: existing.spanCount + 1,
    startTimeMs,
    toolCallCount: existing.toolCallCount + countOf(isToolSpan(span)),
    traceIds,
    turnCount: existing.turnCount + countOf(span.name === TURN_SPAN_NAME),
    ...mergeContext(existing, span),
  };
}

export async function storeSpan(
  span: SerializedSpan,
  source: SpanSource
): Promise<void> {
  const db = await openDb();
  const startTimeMs = hrTimeToMs(span.startTime);
  const endTimeMs = hrTimeToMs(span.endTime);

  const record: StoredSpan = {
    ...span,
    conversationId:
      stringAttr(span, CONVERSATION_ID) ?? stringAttr(span, SESSION_ID),
    durationMs: endTimeMs - startTimeMs,
    source,
    startTimeMs,
  };

  const tx = db.transaction(
    [SPANS_STORE, TRACES_STORE, SESSIONS_STORE],
    "readwrite"
  );
  tx.objectStore(SPANS_STORE).put(record);

  const traces = tx.objectStore(TRACES_STORE);
  const traceReq = traces.get(span.traceId);
  traceReq.onsuccess = () => {
    traces.put(
      mergeTrace(traceReq.result as TraceSummary | undefined, record, endTimeMs)
    );
  };

  // Spans without a conversation id (e.g. availability checks) stay
  // trace-only; there is no session to attribute them to.
  const { conversationId } = record;
  if (conversationId) {
    const sessions = tx.objectStore(SESSIONS_STORE);
    const sessionReq = sessions.get(conversationId);
    sessionReq.onsuccess = () => {
      sessions.put(
        mergeSession(
          sessionReq.result as SessionSummary | undefined,
          record,
          conversationId,
          endTimeMs
        )
      );
    };
  }

  await txDone(tx);
}

/** Deletes oldest-first from a store until at most `max` records remain. */
function pruneOldest(
  store: IDBObjectStore,
  max: number,
  onDelete?: (value: unknown) => void
): void {
  const countReq = store.count();
  countReq.onsuccess = () => {
    let toDelete = countReq.result - max;
    if (toDelete <= 0) {
      return;
    }
    // Oldest first, so the newest `max` records survive.
    const cursorReq = store.index("startTimeMs").openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || toDelete <= 0) {
        return;
      }
      onDelete?.(cursor.value);
      cursor.delete();
      toDelete -= 1;
      cursor.continue();
    };
  };
}

export interface PruneOptions {
  maxSessions?: number;
  maxTraces?: number;
}

/** Drops the oldest traces (with their spans) and sessions beyond the caps. */
export async function pruneOldTraces(
  options: PruneOptions = {}
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(
    [SPANS_STORE, TRACES_STORE, SESSIONS_STORE],
    "readwrite"
  );
  const spans = tx.objectStore(SPANS_STORE);
  const spanIndex = spans.index("traceId");

  pruneOldest(
    tx.objectStore(TRACES_STORE),
    options.maxTraces ?? MAX_TRACES,
    (value) => {
      const spanKeys = spanIndex.getAllKeys((value as TraceSummary).traceId);
      spanKeys.onsuccess = () => {
        for (const key of spanKeys.result) {
          spans.delete(key);
        }
      };
    }
  );

  // Session spans are already removed with their traces above.
  pruneOldest(
    tx.objectStore(SESSIONS_STORE),
    options.maxSessions ?? MAX_SESSIONS
  );

  await txDone(tx);
}

async function listByTab<T extends { tabId?: number; startTimeMs: number }>(
  store: string,
  tabId: number | undefined,
  limit: number
): Promise<T[]> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const results: T[] = [];
  // Newest first.
  const cursorReq = tx
    .objectStore(store)
    .index("startTimeMs")
    .openCursor(null, "prev");
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor || results.length >= limit) {
      return;
    }
    const value = cursor.value as T;
    if (tabId === undefined || value.tabId === tabId) {
      results.push(value);
    }
    cursor.continue();
  };

  await txDone(tx);
  return results;
}

export function listTraces(options: {
  tabId?: number;
  limit?: number;
}): Promise<TraceSummary[]> {
  return listByTab<TraceSummary>(
    TRACES_STORE,
    options.tabId,
    options.limit ?? 200
  );
}

export function listSessions(options: {
  tabId?: number;
  limit?: number;
}): Promise<SessionSummary[]> {
  return listByTab<SessionSummary>(
    SESSIONS_STORE,
    options.tabId,
    options.limit ?? 200
  );
}

/**
 * Orders spans as they ran, with a total order so a trace never renders two
 * ways. Siblings can still share a start when a tool returns inside the clock's
 * resolution; the shorter one ran first, since the span it ties with is the one
 * waiting on its result. `spanId` settles anything left, which keeps repeated
 * reads of the same trace identical rather than leaving it to storage order.
 */
function inRunOrder(a: StoredSpan, b: StoredSpan): number {
  return (
    a.startTimeMs - b.startTimeMs ||
    a.durationMs - b.durationMs ||
    a.spanId.localeCompare(b.spanId)
  );
}

async function spansByIndex(
  index: "traceId" | "conversationId",
  key: string
): Promise<StoredSpan[]> {
  const db = await openDb();
  const tx = db.transaction(SPANS_STORE, "readonly");
  const request = tx.objectStore(SPANS_STORE).index(index).getAll(key);
  await txDone(tx);
  return (request.result as StoredSpan[]).sort(inRunOrder);
}

export function getSpansForTrace(traceId: string): Promise<StoredSpan[]> {
  return spansByIndex("traceId", traceId);
}

export function getSpansForSession(
  conversationId: string
): Promise<StoredSpan[]> {
  return spansByIndex("conversationId", conversationId);
}

export async function clearTraces(tabId?: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(
    [SPANS_STORE, TRACES_STORE, SESSIONS_STORE],
    "readwrite"
  );
  const spans = tx.objectStore(SPANS_STORE);
  const traces = tx.objectStore(TRACES_STORE);
  const sessions = tx.objectStore(SESSIONS_STORE);

  if (tabId === undefined) {
    spans.clear();
    traces.clear();
    sessions.clear();
    await txDone(tx);
    return;
  }

  const spanIndex = spans.index("traceId");
  const traceKeys = traces.index("tabId").getAllKeys(tabId);
  traceKeys.onsuccess = () => {
    for (const key of traceKeys.result) {
      traces.delete(key);
      const spanKeys = spanIndex.getAllKeys(key as string);
      spanKeys.onsuccess = () => {
        for (const spanKey of spanKeys.result) {
          spans.delete(spanKey);
        }
      };
    }
  };
  const sessionKeys = sessions.index("tabId").getAllKeys(tabId);
  sessionKeys.onsuccess = () => {
    for (const key of sessionKeys.result) {
      sessions.delete(key);
    }
  };

  await txDone(tx);
}

export async function exportSpans(tabId?: number): Promise<StoredSpan[]> {
  const db = await openDb();
  const tx = db.transaction(SPANS_STORE, "readonly");
  const request = tx.objectStore(SPANS_STORE).getAll();
  await txDone(tx);
  const all = request.result as StoredSpan[];
  const scoped =
    tabId === undefined
      ? all
      : all.filter((span) => span.source.tabId === tabId);
  return scoped.sort(inRunOrder);
}
