import { useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Group, TextInput } from '@mantine/core'
import { getTrace, type TraceResponse, type TraceSpan } from '@gopherex/errotel-api'
import { type ApiClient, errorText } from './api'
import { CacheNote, JsonPanel, RequestState, Warnings } from './components'
import { TimelineChart } from './vendor/hyperdx/TimelineChart'

export function TracePage({
  client,
  traceId,
  focusSpan,
}: {
  client: ApiClient
  traceId: string
  focusSpan?: string
}) {
  const [result, setResult] = useState<TraceResponse>()
  const [response, setResponse] = useState<Response>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(focusSpan)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the request.
  useEffect(() => {
    const abort = new AbortController()
    setError(undefined)
    setResult(undefined)
    getTrace({ client, path: { traceId }, signal: abort.signal, throwOnError: true })
      .then((value) => {
        if (!abort.signal.aborted) {
          setResult(value.data)
          setResponse(value.response)
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorText(failure))
      })
    return () => abort.abort()
  }, [client, traceId, attempt])
  const spans = result && 'data' in result ? result.data.spans : undefined
  const rows = useMemo(() => {
    if (!spans?.length) return []
    const byId = new Map(spans.map((span) => [span.spanId, span]))
    const sorted = [...spans].sort((a, b) =>
      BigInt(a.startUnixNano) < BigInt(b.startUnixNano) ? -1 : 1
    )
    const start = sorted.reduce(
      (min, span) => (BigInt(span.startUnixNano) < min ? BigInt(span.startUnixNano) : min),
      BigInt(sorted[0].startUnixNano)
    )
    const children = new Map<string, TraceSpan[]>()
    for (const span of sorted) {
      const parent = span.parentSpanId && byId.has(span.parentSpanId) ? span.parentSpanId : ''
      children.set(parent, [...(children.get(parent) ?? []), span])
    }
    const visited = new Set<string>()
    const ordered: { span: TraceSpan; depth: number }[] = []
    const walk = (root: TraceSpan, rootDepth: number) => {
      const pending = [{ span: root, depth: rootDepth, hidden: false }]
      while (pending.length) {
        const entry = pending.pop()
        if (!entry || visited.has(entry.span.spanId)) continue
        const { span, depth, hidden } = entry
        visited.add(span.spanId)
        if (!hidden) ordered.push({ span, depth })
        for (const child of [...(children.get(span.spanId) ?? [])].reverse())
          pending.push({
            span: child,
            depth: Math.min(depth + 1, 20),
            hidden: hidden || collapsed.has(span.spanId),
          })
      }
    }
    for (const span of children.get('') ?? []) walk(span, 0)
    for (const span of sorted) if (!visited.has(span.spanId)) walk(span, 0)
    return ordered
      .filter(({ span }) =>
        `${span.operation} ${span.service} ${span.spanId}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
      .map(({ span, depth }) => {
        const offset = Number(BigInt(span.startUnixNano) - start) / 1e6
        const duration = Number(BigInt(span.durationNano)) / 1e6
        const isError = span.tags.some(
          (tag) =>
            (tag.key === 'error' && (tag.value === true || tag.value === 'true')) ||
            (tag.key === 'otel.status_code' && tag.value === 'ERROR')
        )
        return {
          id: span.spanId,
          isActive: span.spanId === selected,
          label: (
            <div className="span-label" style={{ paddingLeft: depth * 12 }}>
              {!!children.get(span.spanId)?.length && (
                <button
                  type="button"
                  aria-label={`Toggle children of ${span.operation}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setCollapsed((before) => {
                      const next = new Set(before)
                      if (next.has(span.spanId)) next.delete(span.spanId)
                      else next.add(span.spanId)
                      return next
                    })
                  }}
                >
                  {collapsed.has(span.spanId) ? '▸' : '▾'}
                </button>
              )}
              <button type="button" onClick={() => setSelected(span.spanId)}>
                <small>{span.service}</small> {span.operation}
              </button>
            </div>
          ),
          events: [
            {
              id: span.spanId,
              start: offset,
              end: offset + duration,
              tooltip: `${span.operation} · ${duration.toFixed(3)} ms`,
              body: span.operation,
              color: '#d7d8db',
              backgroundColor: isError ? '#813434' : '#24564a',
              minWidthPx: 2,
              isError,
              showDuration: true,
            },
          ],
        }
      })
  }, [spans, collapsed, query, selected])
  const active = spans?.find((span) => span.spanId === selected)
  return (
    <section className="trace-view">
      <Group justify="space-between">
        <code className="trace-id">{traceId}</code>
        <Button variant="subtle" size="compact-xs" onClick={() => setAttempt((value) => value + 1)}>
          Refresh trace
        </Button>
      </Group>
      <RequestState loading={!result && !error} error={error} />
      <CacheNote response={response} />
      {result &&
        ('data' in result ? (
          <>
            <Warnings values={result.data.warnings} />
            <Badge variant="outline" size="xs">
              Completeness: {result.data.completeness}
            </Badge>
            <TextInput
              aria-label="Filter spans"
              placeholder="Filter spans by operation, service or ID"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="span-search"
            />
            {rows.length ? (
              <TimelineChart
                initialScrollRowIndex={Math.max(
                  0,
                  rows.findIndex((row) => row.id === focusSpan)
                )}
                labelWidth={280}
                maxHeight={350}
                rowHeight={28}
                rows={rows}
                onEventClick={(row) => setSelected(row.id)}
              />
            ) : (
              <p className="muted">No matching spans.</p>
            )}
            {active && (
              <div className="span-detail">
                <h2>{active.operation}</h2>
                <code>{active.spanId}</code>
                <p className="muted">
                  {(Number(BigInt(active.durationNano)) / 1e6).toFixed(3)} ms · {active.service}
                </p>
                <JsonPanel value={active.tags} />
                <h3>Span events / logs</h3>
                <JsonPanel value={active.logs} />
              </div>
            )}
          </>
        ) : (
          <Alert
            color={result.status === 'unavailable' ? 'yellow' : 'gray'}
            title={result.status.replaceAll('_', ' ')}
          >
            {result.reason}
          </Alert>
        ))}
    </section>
  )
}
