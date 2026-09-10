import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Loader } from '@mantine/core'
import { getFacets, type FacetRequest, type FacetResponse } from '@gopherex/errotel-api'
import { type ApiClient, errorText, timeLabel } from './api'
import { searchRequest, type QueryDocument } from './query'

export function FacetValues({
  client,
  document,
  field,
  prefix,
  maxRangeMs,
  maxPageSize,
  onChoose,
}: {
  client: ApiClient
  document: QueryDocument
  field: FacetRequest['field']
  prefix: string
  maxRangeMs: number
  maxPageSize: number
  onChoose(value: string): void
}) {
  const [response, setResponse] = useState<FacetResponse>()
  const [body, setBody] = useState<FacetRequest>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const paging = useRef<AbortController | null>(null)
  const input = useMemo(
    () => ({ document, field, prefix, maxRangeMs, maxPageSize }),
    [document, field, prefix, maxRangeMs, maxPageSize]
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the bounded request.
  useEffect(() => {
    const abort = new AbortController()
    paging.current?.abort()
    setResponse(undefined)
    setError(undefined)
    setLoading(true)
    const timer = setTimeout(() => {
      try {
        const search = searchRequest(input.document, Date.now(), input.maxRangeMs)
        const request: FacetRequest = {
          field: input.field,
          range: search.range,
          filter: search.filter,
          prefix: input.prefix,
          pageSize: Math.min(10, input.maxPageSize),
        }
        setBody(request)
        getFacets({ client, body: request, signal: abort.signal, throwOnError: true })
          .then((result) => {
            if (!abort.signal.aborted) setResponse(result.data)
          })
          .catch((error) => {
            if (!abort.signal.aborted) setError(errorText(error))
          })
          .finally(() => {
            if (!abort.signal.aborted) setLoading(false)
          })
      } catch (error) {
        if (!abort.signal.aborted) {
          setError(errorText(error))
          setLoading(false)
        }
      }
    }, 250)
    return () => {
      clearTimeout(timer)
      abort.abort()
      paging.current?.abort()
    }
  }, [client, input, attempt])
  async function more() {
    if (!body || !response?.nextCursor) return
    const abort = new AbortController()
    paging.current?.abort()
    paging.current = abort
    setLoading(true)
    setError(undefined)
    try {
      const result = await getFacets({
        client,
        body: { ...body, cursor: response.nextCursor },
        signal: abort.signal,
        throwOnError: true,
      })
      if (!abort.signal.aborted)
        setResponse((previous) => ({
          ...result.data,
          items: [
            ...(previous?.items ?? []),
            ...result.data.items.filter(
              (item) => !previous?.items.some((old) => old.value === item.value)
            ),
          ],
        }))
    } catch (error) {
      if (!abort.signal.aborted) setError(errorText(error))
    } finally {
      if (!abort.signal.aborted) setLoading(false)
    }
  }
  return (
    <section className="facet-values" aria-label="Observed filter values">
      <small className="muted">
        Observed in matching exceptions · not an application inventory
      </small>
      {loading && <Loader size="xs" aria-label="Loading filter values" />}
      {error && (
        <Alert role="alert" color="yellow">
          {error}
          <Button size="compact-xs" variant="subtle" onClick={() => setAttempt((v) => v + 1)}>
            Retry values
          </Button>
        </Alert>
      )}
      {response && (
        <>
          <small className="muted">
            {response.meta.queryStatus} · {response.meta.servedFrom}
            {response.meta.cacheAgeMs !== undefined ? ` · age ${response.meta.cacheAgeMs}ms` : ''}
          </small>
          {response.meta.warnings.map((warning) => (
            <Alert key={warning} color="yellow" role="alert">
              {warning}
            </Alert>
          ))}
          {!response.items.length && <small>No recorded values in this scope.</small>}
          {response.items.map((item) => (
            <button
              type="button"
              className="facet-value"
              key={item.value}
              onClick={() => onChoose(item.value)}
              title={`Last observed ${timeLabel(item.lastSeenUnixNano)}`}
            >
              <span>{item.value || '(not recorded / empty)'}</span>
              <small>{item.errorCount} errors</small>
            </button>
          ))}
          {response.nextCursor && (
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={loading}
              onClick={() => void more()}
            >
              More values
            </Button>
          )}
        </>
      )}
    </section>
  )
}
