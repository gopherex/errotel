import { useEffect, useRef, useState } from 'react'
import { Accordion, Alert, Badge, Button, Group, Select, Tabs } from '@mantine/core'
import { IconCopy, IconRoute, IconListDetails } from '@tabler/icons-react'
import {
  getOccurrence,
  getRelatedLogs,
  type OccurrenceDetail,
  type RelatedRequest,
  type RelatedResponse,
} from '@gopherex/errotel-api'
import { type ApiClient, errorText, timeLabel } from './api'
import { CacheNote, JsonPanel, NoData, RawPanel, RequestState, Warnings } from './components'
import { TracePage } from './TracePage'

export function OccurrencePage({
  client,
  occurrenceRef,
}: {
  client: ApiClient
  occurrenceRef: string
}) {
  const [detail, setDetail] = useState<OccurrenceDetail>()
  const [response, setResponse] = useState<Response>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<string | null>('context')
  const [traceOpened, setTraceOpened] = useState(false)
  const [kind, setKind] = useState<RelatedRequest['kind']>('time_window')
  const [related, setRelated] = useState<RelatedResponse>()
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [relatedError, setRelatedError] = useState<string>()
  const [relatedResponse, setRelatedResponse] = useState<Response>()
  const relatedAbort = useRef<AbortController | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the request.
  useEffect(() => {
    const abort = new AbortController()
    setError(undefined)
    getOccurrence({
      client,
      path: { ref: occurrenceRef },
      signal: abort.signal,
      throwOnError: true,
    })
      .then((result) => {
        if (!abort.signal.aborted) {
          setDetail(result.data)
          setResponse(result.response)
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorText(failure))
      })
    return () => {
      abort.abort()
      relatedAbort.current?.abort()
    }
  }, [client, occurrenceRef, attempt])
  async function loadRelated() {
    relatedAbort.current?.abort()
    const abort = new AbortController()
    relatedAbort.current = abort
    setRelatedLoading(true)
    setRelatedError(undefined)
    setRelated(undefined)
    try {
      const result = await getRelatedLogs({
        client,
        path: { ref: occurrenceRef },
        body: { kind },
        signal: abort.signal,
        throwOnError: true,
      })
      if (!abort.signal.aborted) {
        setRelated(result.data)
        setRelatedResponse(result.response)
      }
    } catch (failure) {
      if (!abort.signal.aborted) setRelatedError(errorText(failure))
    } finally {
      if (!abort.signal.aborted) setRelatedLoading(false)
    }
  }
  if (!detail)
    return (
      <div className="detail-content">
        <RequestState loading={!error} error={error} />
        {error && <Button onClick={() => setAttempt((value) => value + 1)}>Retry detail</Button>}
      </div>
    )
  const envelope = detail.payload.status === 'available' ? detail.payload.value : undefined
  const conflict = detail.warnings.some((warning) =>
    ['index_payload_mismatch', 'event_id_body_conflict'].includes(warning)
  )
  return (
    <article className="detail-content">
      <div className="error-heading">
        <div>
          <div className="detail-meta">
            <Badge color="red" size="sm">
              ERROR
            </Badge>
            <span>{detail.summary.service || 'Unknown service'}</span>
            <span>{timeLabel(detail.summary.timestampUnixNano)}</span>
          </div>
          <h1>{detail.exception.type || 'Exception'}</h1>
          <p className="exception-message">{detail.exception.message ?? 'No message recorded'}</p>
        </div>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconCopy size={14} />}
          onClick={() => {
            void navigator.clipboard
              .writeText(`${location.origin}${location.pathname}#/occurrences/${occurrenceRef}`)
              .catch(() => {})
          }}
        >
          Copy link
        </Button>
      </div>
      <Group gap="xs" className="detail-badges">
        <Badge variant="light" size="xs">
          {detail.summary.origin}
        </Badge>
        {detail.summary.environment && (
          <Badge size="xs" variant="outline">
            {detail.summary.environment}
          </Badge>
        )}
        <CacheNote response={response} />
      </Group>
      <Warnings values={detail.warnings} />
      <Tabs
        value={tab}
        onChange={(value) => {
          setTab(value)
          if (value === 'trace') setTraceOpened(true)
        }}
        keepMounted
      >
        <Tabs.List>
          <Tabs.Tab value="context" leftSection={<IconListDetails size={14} />}>
            Error & context
          </Tabs.Tab>
          {detail.summary.traceId && (
            <Tabs.Tab value="trace" disabled={conflict} leftSection={<IconRoute size={14} />}>
              Trace
            </Tabs.Tab>
          )}
          <Tabs.Tab value="logs" disabled={conflict}>
            Related logs
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="context">
          <div className="investigation">
            <section className="stack-section">
              <div className="section-title">
                <h2>Original stacktrace</h2>
                <Button
                  variant="subtle"
                  size="compact-xs"
                  disabled={detail.exception.stacktrace === undefined}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(detail.exception.stacktrace ?? '')
                      .catch(() => {})
                  }}
                >
                  Copy stack
                </Button>
              </div>
              {detail.exception.stacktrace !== undefined ? (
                <pre data-testid="stacktrace">{detail.exception.stacktrace}</pre>
              ) : (
                <NoData text="No stacktrace was captured." />
              )}
              {envelope &&
                (envelope.exception.cause ||
                  envelope.exception.errors ||
                  envelope.exception.incomplete) && (
                  <details>
                    <summary>Exception causes</summary>
                    <JsonPanel value={envelope.exception} />
                  </details>
                )}
              {!!envelope?.diagnostics?.length && (
                <Alert color="yellow" title="Some diagnostic data could not be captured">
                  <JsonPanel value={envelope.diagnostics} />
                </Alert>
              )}
              {detail.exception.location && (
                <details>
                  <summary>Reported location</summary>
                  <JsonPanel value={detail.exception.location} />
                </details>
              )}
              {detail.payload.status !== 'available' && (
                <>
                  <Alert
                    color={detail.payload.status === 'absent' ? 'gray' : 'yellow'}
                    title={`Diagnostic context: ${detail.payload.status.replaceAll('_', ' ')}`}
                  />
                  {'raw' in detail.payload && detail.payload.raw !== undefined && (
                    <RawPanel raw={detail.payload.raw} />
                  )}
                </>
              )}
              <details>
                <summary>Stored fields · flattened VM projection</summary>
                <JsonPanel value={detail.storedFields} />
              </details>
            </section>
            {envelope && (
              <section className="state-section">
                <h2>State at capture</h2>
                <Accordion multiple variant="separated">
                  {envelope.state.sources.map((source) => (
                    <Accordion.Item value={source.registrationId} key={source.registrationId}>
                      <Accordion.Control>
                        {source.name}{' '}
                        <Badge size="xs" color={source.status === 'ok' ? 'green' : 'red'}>
                          {source.status}
                        </Badge>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <small className="muted">
                          Registration {source.registrationId} ·{' '}
                          {timeLabel(source.capturedAtUnixNano)}
                        </small>
                        <JsonPanel value={source.status === 'ok' ? source.value : source.error} />
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                  {envelope.state.inline && (
                    <Accordion.Item value="inline">
                      <Accordion.Control>Inline state</Accordion.Control>
                      <Accordion.Panel>
                        <JsonPanel
                          value={
                            envelope.state.inline.status === 'ok'
                              ? envelope.state.inline.value
                              : envelope.state.inline.error
                          }
                        />
                      </Accordion.Panel>
                    </Accordion.Item>
                  )}
                </Accordion>
                {!envelope.state.sources.length && !envelope.state.inline && (
                  <NoData text="No state attached." />
                )}
                <h2>
                  History <span className="muted">{envelope.history.items.length}</span>
                </h2>
                <p className="muted">
                  {envelope.history.enabled
                    ? `${envelope.history.evictedCount} entries evicted since ${timeLabel(envelope.history.sinceUnixNano)}`
                    : 'History disabled'}
                </p>
                <Accordion multiple variant="separated">
                  {envelope.history.items.map((item) => (
                    <Accordion.Item value={item.id} key={item.id}>
                      <Accordion.Control>
                        <span className="history-label">
                          <code>
                            {((item.monotonicMs - envelope.monotonicMs) / 1000).toFixed(3)}s
                          </code>
                          <span>{item.kind === 'breadcrumb' ? item.name : item.snapshot.name}</span>
                          <Badge size="xs" variant="outline">
                            {item.kind}
                          </Badge>
                        </span>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <small className="muted">
                          #{item.sequence} · {timeLabel(item.timestampUnixNano)}
                        </small>
                        <JsonPanel
                          value={item.kind === 'state' ? item.snapshot : (item.data ?? null)}
                        />
                        {item.trace && <JsonPanel value={item.trace} />}
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion>
              </section>
            )}
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="trace">
          {traceOpened && detail.summary.traceId && (
            <TracePage
              client={client}
              traceId={detail.summary.traceId}
              focusSpan={detail.summary.spanId}
            />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="logs">
          <div className="related">
            <p className="muted">
              Identifiers establish a relationship. A time window shows neighboring logs.
            </p>
            <Group>
              <Select
                aria-label="Relation"
                value={kind}
                onChange={(value) => {
                  relatedAbort.current?.abort()
                  setRelatedLoading(false)
                  setRelatedError(undefined)
                  setKind(value as RelatedRequest['kind'])
                  setRelated(undefined)
                }}
                data={[
                  { value: 'same_span', label: 'Same span', disabled: !detail.summary.spanId },
                  { value: 'same_trace', label: 'Same trace', disabled: !detail.summary.traceId },
                  {
                    value: 'same_runtime',
                    label: 'Same runtime',
                    disabled: !detail.summary.runtimeId,
                  },
                  { value: 'time_window', label: 'Time window · ±5 min' },
                ]}
              />
              <Button onClick={() => void loadRelated()} loading={relatedLoading}>
                Load related logs
              </Button>
            </Group>
            <RequestState loading={false} error={relatedError} />
            {related && (
              <>
                <CacheNote response={relatedResponse} />
                {'data' in related ? (
                  <>
                    <Badge>{related.data.evidence.kind}</Badge>
                    {related.status === 'partial' && <Alert color="yellow">{related.reason}</Alert>}
                    {related.data.items.map((item, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a returned log page may contain identical records and is replaced as a unit.
                      <details key={`${item.timestampUnixNano}-${index}`}>
                        <summary>
                          {timeLabel(item.timestampUnixNano)} ·{' '}
                          {item.fields._msg?.slice(0, 160) ?? 'Log record'}
                        </summary>
                        <JsonPanel value={item.fields} />
                      </details>
                    ))}
                  </>
                ) : (
                  <Alert color="gray" title={related.status.replaceAll('_', ' ')}>
                    {related.reason}
                  </Alert>
                )}
              </>
            )}
          </div>
        </Tabs.Panel>
      </Tabs>
    </article>
  )
}
