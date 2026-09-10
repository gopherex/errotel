import { createClient } from '@gopherex/errotel-sdk'
import { ROOT_CONTEXT, SpanStatusCode, trace, type Context } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
} from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'

// This provider belongs exclusively to the manual test generator. OTel flush can
// resolve after reporting an export failure to its global diagnostic handler, so
// the toast must inspect the exporter callback rather than infer success from flush.
export function createTestClient(
  url: string,
  tracesUrl: string,
  service: string,
  environment: string
) {
  const transport = new OTLPLogExporter({ url, timeoutMillis: 5000 })
  let completion: Promise<ExportResult> | undefined
  const observed: LogRecordExporter = {
    export(records, callback) {
      completion = new Promise((resolve) => {
        const complete = (result: ExportResult) => {
          resolve(result)
          callback(result)
        }
        try {
          transport.export(records, complete)
        } catch {
          complete({ code: ExportResultCode.FAILED })
        }
      })
    },
    shutdown: () => transport.shutdown(),
    forceFlush: () => transport.forceFlush(),
  }
  const resource = resourceFromAttributes({
    'service.name': service,
    'deployment.environment.name': environment,
    'service.version': 'synthetic-ui-v1',
  })
  const traceTransport = new OTLPTraceExporter({ url: tracesUrl, timeoutMillis: 5000 })
  const traceCompletions: Promise<ExportResult>[] = []
  const observedTraces: SpanExporter = {
    export(spans, callback) {
      traceCompletions.push(
        new Promise((resolve) => {
          const complete = (result: ExportResult) => {
            resolve(result)
            callback(result)
          }
          try {
            traceTransport.export(spans, complete)
          } catch {
            complete({ code: ExportResultCode.FAILED })
          }
        })
      )
    },
    shutdown: () => traceTransport.shutdown(),
  }
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(observedTraces)],
  })
  const tracer = tracerProvider.getTracer('errotel-ui-test', '0.1.0')
  const provider = new LoggerProvider({
    resource,
    logRecordLimits: { attributeValueLengthLimit: Infinity, attributeCountLimit: Infinity },
    processors: [new SimpleLogRecordProcessor({ exporter: observed })],
  })
  const client = createClient({
    loggerProvider: provider,
    history: { enabled: true, maxEntries: 100, maxAgeMs: null },
    flush: async () => {
      const flushed = await Promise.allSettled([provider.forceFlush(), tracerProvider.forceFlush()])
      // SimpleLogRecordProcessor.forceFlush does not await ordinary exports.
      const result = await completion
      const traceResults = await Promise.all(traceCompletions.splice(0))
      if (result?.code !== ExportResultCode.SUCCESS)
        throw new Error(
          'OTLP export failed. Check the endpoint, connection and CORS/CSP configuration.'
        )
      if (
        !traceResults.length ||
        traceResults.some((value) => value.code !== ExportResultCode.SUCCESS)
      )
        throw new Error(
          'The error log was exported, but its trace export failed. Check the OTLP traces endpoint and CORS/CSP configuration.'
        )
      if (flushed.some((value) => value.status === 'rejected'))
        throw new Error('OTLP flush failed. Export completion could not be fully confirmed.')
    },
  })
  let shutdown: Promise<void> | undefined
  return {
    ...client,
    // These spans instrument the synthetic operation, not the SDK capture implementation.
    // Explicit contexts keep this isolated from the application's global providers.
    async runOperation<T>(exception: Error, capture: (context: Context) => T): Promise<T> {
      const operation = tracer.startSpan(
        'test.send-error',
        {
          attributes: { 'test.synthetic': true },
        },
        ROOT_CONTEXT
      )
      const parent = trace.setSpan(ROOT_CONTEXT, operation)
      try {
        const prepare = tracer.startSpan('test.prepare-state', {}, parent)
        // Intentional synthetic latency gives the sample waterfall readable durations.
        await new Promise((resolve) => setTimeout(resolve, 40))
        prepare.end()
        const failed = tracer.startSpan('test.capture-error', {}, parent)
        try {
          await new Promise((resolve) => setTimeout(resolve, 60))
          failed.recordException(exception)
          failed.setStatus({ code: SpanStatusCode.ERROR, message: exception.message })
          operation.setStatus({ code: SpanStatusCode.ERROR, message: exception.message })
          return capture(trace.setSpan(parent, failed))
        } finally {
          failed.end()
        }
      } finally {
        operation.end()
      }
    },
    shutdown: () => {
      client.dispose()
      shutdown ??= Promise.all([provider.shutdown(), tracerProvider.shutdown()]).then(() => {})
      return shutdown
    },
  }
}
