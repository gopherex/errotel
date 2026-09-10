import { context, trace, isSpanContextValid, ROOT_CONTEXT, type Context } from '@opentelemetry/api'
import { SeverityNumber, type LoggerProvider, type LogAttributes } from '@opentelemetry/api-logs'
import { materialize } from './json.js'
import type {
  CaptureDiagnostic,
  CapturedValue,
  CaptureResult,
  DebugEnvelopeV1,
  ExceptionData,
  HistoryEntry,
  JsonStateSource,
  JsonValue,
  SourceSnapshot,
  StateSource,
  TraceRef,
} from './protocol.js'
export type * from './protocol.js'

export interface ClientOptions {
  loggerProvider: LoggerProvider
  captureUnhandled?: boolean
  history?: { enabled?: boolean; maxEntries?: number; maxAgeMs?: number | null }
  onDiagnostic?: (diagnostic: CaptureDiagnostic) => void
  flush?: () => Promise<void>
}
export interface CaptureOptions {
  state?: JsonValue
  serializeState?: (value: unknown) => JsonValue
  context?: Context
  includeRegisteredState?: boolean
  includeHistory?: boolean
  handled?: boolean
  groupKey?: string
  extensions?: Readonly<Record<string, JsonValue>>
  attributes?: LogAttributes
  severityNumber?: SeverityNumber
  severityText?: string
}
export type HistoryResult =
  | { status: 'recorded'; id: string }
  | { status: 'not_recorded'; reason: string }
const ownerKey = Symbol.for('errotel.auto-handlers.v1')
const nano = () => (BigInt(Date.now()) * 1_000_000n).toString()
const mono = () => performance.now()
const id = () => crypto.randomUUID()

function correlation(explicit?: Context): { context: Context; trace?: TraceRef } {
  for (const [ctx, origin] of [
    [explicit, 'explicit'],
    [context.active(), 'active'],
  ] as const) {
    if (!ctx) continue
    const sc = trace.getSpanContext(ctx)
    if (
      sc &&
      isSpanContextValid(sc) &&
      /^[0-9a-f]{32}$/.test(sc.traceId) &&
      /^[0-9a-f]{16}$/.test(sc.spanId)
    ) {
      // Snapshot the span context before calling application readers.
      return {
        context: trace.setSpanContext(ROOT_CONTEXT, { ...sc }),
        trace: { traceId: sc.traceId, spanId: sc.spanId, traceFlags: sc.traceFlags, origin },
      }
    }
  }
  return { context: ROOT_CONTEXT }
}
function exceptionData(
  value: unknown,
  mechanism: ExceptionData['mechanism'],
  handled?: boolean
): ExceptionData {
  const result: {
    type?: string
    message?: string
    stacktrace?: string
    mechanism: ExceptionData['mechanism']
    handled?: boolean
  } = { mechanism }
  if (handled !== undefined) result.handled = handled
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    for (const [key, dest] of [
      ['name', 'type'],
      ['message', 'message'],
      ['stack', 'stacktrace'],
    ] as const) {
      try {
        const v = (value as Record<string, unknown>)[key]
        if (typeof v === 'string') result[dest] = v
      } catch {
        /* A hostile exception getter is isolated. */
      }
    }
  } else result.message = String(value)
  return result
}

export function createClient(options: ClientOptions) {
  const logger = options.loggerProvider.getLogger('app-debug.browser', '0.1.0')
  const enabled = options.history?.enabled ?? true
  const maxEntries = options.history?.maxEntries ?? 100
  const maxAgeMs = options.history?.maxAgeMs === undefined ? 30_000 : options.history.maxAgeMs
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    (maxAgeMs !== null && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0))
  )
    throw new TypeError('invalid_history_config')
  let runtimeId = id(),
    sequence = 0,
    since = nano(),
    evicted = 0
  let history: HistoryEntry[] = []
  let closed = false,
    capturing = false,
    diagnosing = false
  const reading = new Set<string>()
  const sources = new Map<
    string,
    { registrationId: string; source: { read(): unknown; serialize?(value: unknown): JsonValue } }
  >()
  function diagnostic(
    code: string,
    stage: CaptureDiagnostic['stage'] = 'capture'
  ): CaptureDiagnostic {
    const d = { code, stage }
    if (!diagnosing) {
      diagnosing = true
      try {
        options.onDiagnostic?.(d)
      } catch {
        /* Never capture diagnostic failures. */
      } finally {
        diagnosing = false
      }
    }
    return d
  }
  function clearHistory() {
    history = []
    evicted = 0
    since = nano()
  }
  function nextSequence() {
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      runtimeId = id()
      sequence = 0
      clearHistory()
    }
    return ++sequence
  }
  function prune(now: number) {
    if (maxAgeMs !== null) {
      const kept = history.filter((item) => now - item.monotonicMs <= maxAgeMs)
      evicted += history.length - kept.length
      history = kept
    }
    if (history.length > maxEntries) {
      evicted += history.length - maxEntries
      history = history.slice(history.length - maxEntries)
    }
  }
  function captured(value: unknown, serializer?: (value: unknown) => JsonValue): CapturedValue {
    if (serializer) {
      try {
        value = serializer(value)
      } catch {
        return { status: 'error', error: diagnostic('serializer_failed', 'serialize') }
      }
    }
    try {
      return { status: 'ok', value: materialize(value) }
    } catch {
      return { status: 'error', error: diagnostic('invalid_json', 'validate') }
    }
  }
  function snapshot(
    name: string,
    registration: NonNullable<ReturnType<typeof sources.get>>
  ): SourceSnapshot {
    const base = {
      name,
      registrationId: registration.registrationId,
      capturedAtUnixNano: nano(),
      monotonicMs: mono(),
    }
    if (reading.has(registration.registrationId))
      return { ...base, status: 'error', error: diagnostic('reentrant_read', 'read') }
    reading.add(registration.registrationId)
    try {
      let value: unknown
      try {
        value = registration.source.read()
      } catch {
        return { ...base, status: 'error', error: diagnostic('reader_failed', 'read') }
      }
      return { ...base, ...captured(value, registration.source.serialize) }
    } finally {
      reading.delete(registration.registrationId)
    }
  }
  function registerState(name: string, source: JsonStateSource): () => void
  function registerState<T>(name: string, source: StateSource<T>): () => void
  function registerState(
    name: string,
    source: { read(): unknown; serialize?(value: unknown): JsonValue }
  ) {
    if (
      closed ||
      !name ||
      sources.has(name) ||
      typeof source.read !== 'function' ||
      (source.serialize !== undefined && typeof source.serialize !== 'function')
    )
      throw new TypeError('invalid_or_duplicate_registration')
    const registration = { registrationId: id(), source }
    sources.set(name, registration)
    return () => {
      if (sources.get(name) === registration) sources.delete(name)
    }
  }
  function add(
    kind: 'breadcrumb' | 'state',
    name: string,
    data?: JsonValue,
    ctx?: Context
  ): HistoryResult {
    if (closed || diagnosing || !enabled || !name) {
      diagnostic('history_unavailable')
      return { status: 'not_recorded', reason: 'closed_disabled_or_invalid' }
    }
    const registration = sources.get(name)
    if (kind === 'state' && (!registration || reading.has(registration.registrationId))) {
      diagnostic('source_unavailable')
      return { status: 'not_recorded', reason: 'source_unavailable' }
    }
    const base = {
      id: id(),
      sequence: nextSequence(),
      timestampUnixNano: nano(),
      monotonicMs: mono(),
      trace: correlation(ctx).trace,
    }
    const item: HistoryEntry =
      kind === 'state'
        ? {
            ...base,
            kind,
            snapshot: snapshot(name, registration as NonNullable<typeof registration>),
          }
        : { ...base, kind, name, ...(data === undefined ? {} : { data: captured(data) }) }
    history.push(item)
    prune(mono())
    return { status: 'recorded', id: item.id }
  }
  function capture(
    value: unknown,
    opts: CaptureOptions = {},
    mechanism: ExceptionData['mechanism'] = 'manual',
    location?: ExceptionData['location']
  ): CaptureResult {
    if (closed) return { status: 'not_emitted', reason: 'closed' }
    if (capturing || diagnosing) return { status: 'not_emitted', reason: 'reentrant' }
    capturing = true
    try {
      const timestamp = nano(),
        monotonicMs = mono(),
        seq = nextSequence()
      const link = correlation(opts.context)
      prune(monotonicMs)
      const retained = {
        enabled,
        sinceUnixNano: since,
        evictedCount: evicted,
        items: opts.includeHistory === false ? [] : [...history],
      }
      const registrations = [...sources]
      const exception = {
        ...exceptionData(value, mechanism, mechanism === 'manual' ? opts.handled : false),
        ...(location ? { location } : {}),
      }
      const envelope: DebugEnvelopeV1 = {
        schema: 'app-debug',
        schemaVersion: 1,
        kind: 'exception',
        eventId: id(),
        timestampUnixNano: timestamp,
        monotonicMs,
        runtime: { id: runtimeId, sequence: seq },
        exception,
        ...(link.trace ? { trace: link.trace } : {}),
        state: {
          sources:
            opts.includeRegisteredState === false
              ? []
              : registrations.map(([name, source]) => snapshot(name, source)),
          ...('state' in opts ? { inline: captured(opts.state, opts.serializeState) } : {}),
        },
        history: retained,
        ...(opts.groupKey === undefined ? {} : { groupKey: opts.groupKey }),
        ...(opts.extensions === undefined
          ? {}
          : { extensions: materialize(opts.extensions) as Record<string, JsonValue> }),
      }
      if (opts.groupKey !== undefined && !opts.groupKey) throw new TypeError('empty_group_key')
      if (
        opts.severityNumber !== undefined &&
        (!Number.isInteger(opts.severityNumber) ||
          opts.severityNumber < 0 ||
          opts.severityNumber > 24)
      )
        throw new TypeError('invalid_severity')
      const attrs: LogAttributes = Object.create(null)
      if (opts.attributes) {
        const user = materialize(opts.attributes) as Record<string, JsonValue>
        for (const [key, val] of Object.entries(user)) {
          if (
            /^(app\.debug\.|exception\.|_|trace_id$|span_id$|severity_|event_name$|scope\.|service\.|deployment\.)/.test(
              key
            )
          ) {
            diagnostic('reserved_attribute')
            continue
          }
          attrs[key] = val as LogAttributes[string]
        }
      }
      Object.assign(attrs, {
        'app.debug.schema.version': 1,
        'app.debug.kind': 'exception',
        'app.debug.event.id': envelope.eventId,
        'app.debug.runtime.id': envelope.runtime.id,
        'app.debug.event.sequence': seq,
        'app.debug.exception.mechanism': mechanism,
      })
      for (const key of ['type', 'message', 'stacktrace'] as const)
        if (exception[key] !== undefined) attrs[`exception.${key}`] = exception[key]
      if (exception.handled !== undefined) attrs['app.debug.exception.handled'] = exception.handled
      if (envelope.groupKey !== undefined) attrs['app.debug.group.key'] = envelope.groupKey
      const body = JSON.stringify(envelope)
      const n = BigInt(timestamp),
        time: [number, number] = [Number(n / 1_000_000_000n), Number(n % 1_000_000_000n)]
      try {
        logger.emit({
          eventName: 'exception',
          timestamp: time,
          observedTimestamp: time,
          context: link.context,
          severityNumber: opts.severityNumber ?? SeverityNumber.ERROR,
          severityText:
            opts.severityText ?? (opts.severityNumber === undefined ? 'ERROR' : undefined),
          body,
          attributes: attrs,
        })
      } catch {
        diagnostic('emit_failed')
        return { status: 'not_emitted', reason: 'emit_failed' }
      }
      return { status: 'emitted', eventId: envelope.eventId }
    } catch {
      diagnostic('encode_failed')
      return { status: 'not_emitted', reason: 'encode_failed' }
    } finally {
      capturing = false
    }
  }
  let removeHandlers = () => {}
  if (options.captureUnhandled && typeof window !== 'undefined') {
    const host = window as unknown as Record<symbol, unknown>
    if (host[ownerKey]) diagnostic('auto_handlers_already_owned')
    else {
      const owner = {}
      host[ownerKey] = owner
      const onError = (event: ErrorEvent) => {
        if (!(event instanceof ErrorEvent) || event.target !== window) return
        capture(event.error ?? event.message, {}, 'window.error', {
          ...(event.filename ? { url: event.filename } : {}),
          line: event.lineno,
          column: event.colno,
        })
      }
      const onRejection = (event: PromiseRejectionEvent) => {
        capture(event.reason, {}, 'unhandledrejection')
      }
      window.addEventListener('error', onError)
      window.addEventListener('unhandledrejection', onRejection)
      removeHandlers = () => {
        window.removeEventListener('error', onError)
        window.removeEventListener('unhandledrejection', onRejection)
        if (host[ownerKey] === owner) delete host[ownerKey]
      }
    }
  }
  return {
    registerState,
    captureException: (value: unknown, opts?: CaptureOptions) => capture(value, opts),
    addBreadcrumb: (name: string, data?: JsonValue, opts?: { context?: Context }) =>
      add('breadcrumb', name, data, opts?.context),
    recordState: (name: string, opts?: { context?: Context }) =>
      add('state', name, undefined, opts?.context),
    clearHistory,
    flush: async () => {
      await options.flush?.()
    },
    dispose: () => {
      if (!closed) {
        closed = true
        removeHandlers()
        sources.clear()
        clearHistory()
      }
    },
  }
}
