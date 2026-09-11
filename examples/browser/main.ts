import { ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { LogRecord } from '@opentelemetry/api-logs'
import { SDK_VERSION, redactKeys } from '../../packages/sdk/src/index'
import { createOtlpClient } from '../../packages/sdk/src/otlp'
import type { DebugEnvelopeV1 } from '../../packages/sdk/src/protocol'

interface ScenarioOptions {
  logsUrl?: string
  tracesUrl?: string
  service?: string
  largeBytes?: number
  seedCases?: boolean
}
interface ScenarioResult {
  eventId: string
  traceId: string
  spanId: string
  service: string
  envelope: DebugEnvelopeV1
  cases: string[]
}
declare global {
  interface Window {
    runScenario: (options?: ScenarioOptions) => Promise<ScenarioResult>
  }
}

const input = (id: string) => (document.getElementById(id) as HTMLInputElement).value
export async function runScenario(options: ScenarioOptions = {}): Promise<ScenarioResult> {
  const service = options.service ?? `errotel-example-${crypto.randomUUID()}`
  const resource = {
    'service.name': service,
    'service.version': 'synthetic-v1',
    'deployment.environment.name': 'local-test',
  }
  const records: LogRecord[] = []
  const tracerProvider = new BasicTracerProvider({
    resource: resourceFromAttributes(resource),
    spanProcessors: [
      new SimpleSpanProcessor(new OTLPTraceExporter({ url: options.tracesUrl ?? input('traces') })),
    ],
  })
  const client = createOtlpClient({
    url: options.logsUrl ?? input('logs'),
    resource,
    batch: { scheduledDelayMillis: 60_000 },
    sanitize: redactKeys(['password']),
  })
  // Observe the actual record from this owned provider without changing its body.
  // The export processor remains the real HTTP/protobuf implementation.
  const logger = client.provider.getLogger('app-debug.browser', SDK_VERSION)
  const emit = logger.emit.bind(logger)
  logger.emit = (record) => {
    records.push(record as LogRecord)
    emit(record)
  }
  const span = tracerProvider.getTracer('errotel-example').startSpan('apply synthetic patch')
  const context = trace.setSpan(ROOT_CONTEXT, span)
  span.addEvent('exception', {
    'exception.type': 'SyntheticError',
    'exception.message': 'Synthetic span event',
  })
  const state = {
    documentId: 'synthetic-document',
    selection: 0,
    flags: [false, null, '', [], {}],
    'key.with.dots': 'Привет 世界',
    revision: 1,
  }
  client.registerState('editor', { read: () => state })
  client.addBreadcrumb('command.started', { command: 'applyPatch' }, { context })
  client.recordState('editor', { context })
  state.revision = 2
  const error = new Error('Synthetic patch failed <img src=x onerror=alert(1)>', {
    cause: new Error('Synthetic underlying failure'),
  })
  error.name = 'SyntheticError'
  const result = client.captureException(error, {
    context,
    state: {
      command: 'applyPatch',
      patchId: 'synthetic-7',
      password: 'SYNTHETIC_SECRET_NEVER_EXPORT',
      payload: 'x'.repeat(options.largeBytes ?? 0),
    },
    groupKey: 'synthetic-patch',
  })
  if (result.status !== 'emitted') throw new Error(`Capture failed: ${result.reason}`)
  const record = records[0]
  if (!record || typeof record.body !== 'string') throw new Error('No SDK LogRecord captured')
  const envelope = JSON.parse(record.body) as DebugEnvelopeV1
  const cases: string[] = []
  if (options.seedCases) {
    const extra = client.provider.getLogger('synthetic-seed')
    const copy = (
      name: string,
      mutate: (body: Record<string, unknown>) => void,
      index?: Record<string, string | number>
    ) => {
      const body = JSON.parse(record.body as string) as Record<string, unknown>
      const eventId = crypto.randomUUID()
      body.eventId = eventId
      mutate(body)
      extra.emit({
        ...record,
        body: JSON.stringify(body),
        attributes: { ...record.attributes, 'app.debug.event.id': eventId, ...index },
      })
      cases.push(name)
    }
    // Retries keep both timestamp and eventId; no extra SDK occurrence is invented.
    extra.emit(record)
    copy(
      'unsupported_version',
      (body) => {
        body.schemaVersion = 99
      },
      { 'app.debug.schema.version': 99 }
    )
    copy('invalid_state', (body) => {
      body.state = { sources: 'corrupt' }
    })
    copy('index_mismatch', () => {}, { 'app.debug.runtime.id': crypto.randomUUID() })
    copy('invalid_event_id', () => {}, { 'app.debug.event.id': 'malformed-id' })
    const conflictId = crypto.randomUUID()
    for (const value of ['one', 'two']) {
      const body = { ...envelope, eventId: conflictId, extensions: { syntheticConflict: value } }
      extra.emit({
        ...record,
        body: JSON.stringify(body),
        attributes: { ...record.attributes, 'app.debug.event.id': conflictId },
      })
    }
    cases.push('duplicate', 'conflict')
    extra.emit({
      ...record,
      body: '{broken',
      attributes: { ...record.attributes, 'app.debug.event.id': crypto.randomUUID() },
    })
    extra.emit({
      body: 'Vanilla synthetic exception',
      severityNumber: 17,
      context,
      attributes: {
        'exception.type': 'VanillaError',
        'exception.message': 'Plain OTel exception',
        'exception.stacktrace': 'original vanilla stack',
      },
    })
    extra.emit({ body: 'ERROR severity without an exception', severityNumber: 17 })
    cases.push('malformed_body', 'vanilla_exception', 'ordinary_error_log')
  }
  span.end()
  await client.flush()
  await tracerProvider.forceFlush()
  await client.shutdown()
  await tracerProvider.shutdown()
  return {
    eventId: result.eventId,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    service,
    envelope,
    cases,
  }
}
window.runScenario = runScenario
for (const [id, seedCases] of [
  ['capture', false],
  ['seed', true],
] as const) {
  document.getElementById(id)?.addEventListener('click', async () => {
    const result = document.getElementById('result')
    if (!result) return
    try {
      const captured = await runScenario({ seedCases })
      result.textContent = JSON.stringify(
        {
          eventId: captured.eventId,
          traceId: captured.traceId,
          service: captured.service,
          cases: captured.cases,
        },
        null,
        2
      )
    } catch (error) {
      result.textContent = String(error)
    }
  })
}

export { createClient } from '../../packages/sdk/src/index'
