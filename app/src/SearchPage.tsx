import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Button,
  Group as Buttons,
  Menu,
  NumberInput,
  Popover,
  Select,
  Switch,
  TextInput,
  Tooltip,
} from '@mantine/core'
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBell,
  IconClock,
  IconFilter,
  IconLayoutBottombar,
  IconLayoutSidebarRight,
  IconMaximize,
  IconMinimize,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconX,
} from '@tabler/icons-react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import {
  getHistogram,
  searchOccurrences,
  type Capabilities,
  type HistogramResponse,
  type OccurrenceSearch,
  type OccurrenceSummary,
  type SearchFilter,
  type SearchResponse,
} from '@gopherex/errotel-api'
import { type ApiClient, errorText, timeLabel } from './api'
import { NoData, RequestState, Warnings } from './components'
import { QueryEditor, type EditorHandle } from './QueryEditor'
import {
  addFilter,
  fields,
  filterText,
  initialQuery,
  parseQuery,
  printQuery,
  removeFilter,
  searchRequest,
  type QueryDocument,
  type QueryField,
} from './query'
import { Histogram } from './Histogram'
import { OccurrencePage } from './OccurrencePage'
import { FacetValues } from './FacetValues'
import { AlertSetup } from './AlertSetup'
import { useSearchNotifications } from './useSearchNotifications'

function FilterTree({
  filter,
  path = [],
  onRemove,
}: {
  filter: SearchFilter
  path?: number[]
  onRemove(path: number[]): void
}) {
  if (filter.op === 'and' || filter.op === 'or')
    return (
      <div className="filter-group">
        <span className="filter-operator">{filter.op.toUpperCase()}</span>
        {filter.children?.map((child, index) => (
          <FilterTree
            // biome-ignore lint/suspicious/noArrayIndexKey: these stateless controls address expression nodes by structural path.
            key={`${index}-${child.op}`}
            filter={child}
            path={[...path, index]}
            onRemove={onRemove}
          />
        ))}
      </div>
    )
  return (
    <span className="filter-chip">
      <code>{filterText(filter)}</code>
      <ActionIcon
        variant="subtle"
        size="xs"
        aria-label={`Remove ${filterText(filter)}`}
        onClick={() => onRemove(path)}
      >
        <IconX size={11} />
      </ActionIcon>
    </span>
  )
}

export function SearchPage({
  client,
  capabilities,
  selected,
  initial,
  onSelect,
  onQuery,
}: {
  client: ApiClient
  capabilities: Capabilities
  selected?: string
  initial?: string
  onSelect(ref?: string): void
  onQuery(query: string): void
}) {
  const [alertDocument, setAlertDocument] = useState<QueryDocument>()
  const [draft, setDraft] = useState(initial || initialQuery)
  const [undoAvailable, setUndoAvailable] = useState(false)
  const [redoAvailable, setRedoAvailable] = useState(false)
  const editor = useRef<EditorHandle | null>(null)
  const [run, setRun] = useState(0)
  const [autoQuery, setAutoQuery] = useState(true)
  const [refreshPreset, setRefreshPreset] = useState('off')
  const [customRefresh, setCustomRefresh] = useState<string | number>(15)
  const refreshSeconds = refreshPreset === 'custom' ? Number(customRefresh) : Number(refreshPreset)
  const refreshMs =
    Number.isInteger(refreshSeconds) && refreshSeconds >= 5 && refreshSeconds <= 3600
      ? refreshSeconds * 1000
      : 0
  const lastRun = useRef(run)
  const appliedRef = useRef<string | undefined>(undefined)
  const notifications = useSearchNotifications(onSelect)
  const observeErrors = notifications.observe
  const [applied, setApplied] = useState('')
  const [request, setRequest] = useState<OccurrenceSearch>()
  const [result, setResult] = useState<SearchResponse>()
  const [items, setItems] = useState<OccurrenceSummary[]>([])
  const [histogram, setHistogram] = useState<HistogramResponse>()
  const [loading, setLoading] = useState(false)
  const [histogramLoading, setHistogramLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [histogramError, setHistogramError] = useState<string>()
  const [position, setPosition] = useState<'bottom' | 'right'>('bottom')
  const [fullscreen, setFullscreen] = useState(false)
  const [newField, setNewField] = useState<QueryField>('service')
  const [newValue, setNewValue] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [timeOpen, setTimeOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const pagingAbort = useRef<AbortController | null>(null)
  const parsed = useMemo(() => {
    try {
      return { document: parseQuery(draft), error: undefined }
    } catch (failure) {
      return { document: undefined, error: errorText(failure) }
    }
  }, [draft])
  const currentDraft = useRef(draft)
  currentDraft.current = draft
  useEffect(() => {
    if (initial && initial !== currentDraft.current) editor.current?.replace(initial)
  }, [initial])
  const onQueryRef = useRef(onQuery)
  onQueryRef.current = onQuery
  useEffect(() => {
    setLoading(false)
    setHistogramLoading(false)
    const explicitRun = lastRun.current !== run
    lastRun.current = run
    if (!parsed.document) return
    if (!autoQuery && !explicitRun && appliedRef.current !== undefined) return
    const abort = new AbortController()
    pagingAbort.current?.abort()
    const timer = window.setTimeout(
      () => {
        let body: OccurrenceSearch
        try {
          body = searchRequest(
            parsed.document as QueryDocument,
            Date.now(),
            capabilities.maxRangeMs
          )
        } catch (failure) {
          setError(errorText(failure))
          return
        }
        if (appliedRef.current !== draft) {
          setResult(undefined)
          setItems([])
          setHistogram(undefined)
        }
        appliedRef.current = draft
        setRequest(body)
        setApplied(draft)
        onQueryRef.current(draft)
        setLoading(true)
        setHistogramLoading(true)
        setError(undefined)
        setHistogramError(undefined)
        searchOccurrences({ client, body, signal: abort.signal, throwOnError: true })
          .then((response) => {
            if (!abort.signal.aborted) {
              setResult(response.data)
              setItems(response.data.items)
              if (response.data.meta.queryStatus === 'complete')
                observeErrors(printQuery(parsed.document as QueryDocument), response.data.items)
            }
          })
          .catch((failure) => {
            if (!abort.signal.aborted) {
              setResult(undefined)
              setError(errorText(failure))
            }
          })
          .finally(() => {
            if (!abort.signal.aborted) setLoading(false)
          })
        getHistogram({ client, body, signal: abort.signal, throwOnError: true })
          .then((response) => {
            if (!abort.signal.aborted) setHistogram(response.data)
          })
          .catch((failure) => {
            if (!abort.signal.aborted) {
              setHistogram(undefined)
              setHistogramError(errorText(failure))
            }
          })
          .finally(() => {
            if (!abort.signal.aborted) setHistogramLoading(false)
          })
      },
      explicitRun ? 0 : 400
    )
    return () => {
      clearTimeout(timer)
      abort.abort()
      pagingAbort.current?.abort()
    }
  }, [client, draft, parsed.document, run, capabilities.maxRangeMs, autoQuery, observeErrors])
  useEffect(() => {
    if (!refreshMs || loading || histogramLoading || draft !== applied || !parsed.document) return
    const timer = window.setTimeout(() => setRun((value) => value + 1), refreshMs)
    return () => clearTimeout(timer)
  }, [refreshMs, loading, histogramLoading, draft, applied, parsed.document])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !target?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')
      )
        onSelect(undefined)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onSelect])
  const change = useCallback((text: string) => editor.current?.replace(text), [])
  const applyField = useCallback(
    (field: QueryField, value: string, exclude = false) => {
      if (parsed.document) change(addFilter(parsed.document, field, value, exclude))
    },
    [parsed.document, change]
  )
  function changeTime(start: string, end: string) {
    if (parsed.document) change(printQuery({ ...parsed.document, time: { from: start, to: end } }))
  }
  async function loadMore() {
    if (!request || !result?.nextCursor) return
    pagingAbort.current?.abort()
    const abort = new AbortController()
    pagingAbort.current = abort
    setLoading(true)
    try {
      const response = await searchOccurrences({
        client,
        body: { ...request, cursor: result.nextCursor },
        signal: abort.signal,
        throwOnError: true,
      })
      if (!abort.signal.aborted) {
        setResult(response.data)
        setItems((before) => {
          const seen = new Set(before.map((item) => item.eventId ?? item.ref))
          return [
            ...before,
            ...response.data.items.filter((item) => !seen.has(item.eventId ?? item.ref)),
          ]
        })
      }
    } catch (failure) {
      if (!abort.signal.aborted) setError(errorText(failure))
    } finally {
      if (!abort.signal.aborted) setLoading(false)
    }
  }
  const valueMenu = useCallback(
    (field: QueryField, value?: string) =>
      value === undefined ? (
        <span className="muted">—</span>
      ) : (
        <Menu withinPortal>
          <Menu.Target>
            <button type="button" className="field-value" disabled={!parsed.document}>
              {value || '(empty)'}
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => applyField(field, value)}>Include {value}</Menu.Item>
            <Menu.Item onClick={() => applyField(field, value, true)}>Exclude {value}</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      ),
    [applyField, parsed.document]
  )
  const openColumnFilter = useCallback(
    (column: string) => {
      if (column === 'time') {
        setFrom(parsed.document?.time.from ?? '')
        setTo(parsed.document?.time.to ?? '')
        setTimeOpen(true)
      } else {
        const field = column === 'exception' ? 'type' : column
        setNewField(field as QueryField)
        setNewValue('')
        setFilterOpen(true)
      }
    },
    [parsed.document]
  )
  const columns = useMemo<ColumnDef<OccurrenceSummary>[]>(
    () => [
      {
        id: 'time',
        header: 'Time · UTC',
        cell: ({ row }) => (
          <span className="row-time">{timeLabel(row.original.timestampUnixNano)}</span>
        ),
      },
      {
        id: 'exception',
        header: 'Exception',
        cell: ({ row }) => (
          <button type="button" className="error-cell" onClick={() => onSelect(row.original.ref)}>
            <span className="error-dot" />
            <strong>{row.original.exceptionType || 'Exception'}</strong>
            <span>{row.original.message ?? 'No message recorded'}</span>
          </button>
        ),
      },
      {
        id: 'service',
        header: 'Service',
        cell: ({ row }) => valueMenu('service', row.original.service),
      },
      {
        id: 'environment',
        header: 'Environment',
        cell: ({ row }) => valueMenu('environment', row.original.environment),
      },
      {
        id: 'origin',
        header: 'Source',
        cell: ({ row }) => <span className="muted">{row.original.origin}</span>,
      },
    ],
    [onSelect, valueMenu]
  )
  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (item) => item.eventId ?? item.ref,
  })
  return (
    <div className="search-page">
      <div className="search-heading">
        <Buttons gap="xs" className="search-heading-left">
          <h1>Errors</h1>
          {capabilities.features.alertExport && (
            <Button
              size="xs"
              variant="default"
              disabled={!parsed.document}
              onClick={() => setAlertDocument(parsed.document)}
            >
              Configure alert
            </Button>
          )}
          <Tooltip label="Notify about newly observed matching errors while this search is open">
            <Button
              size="xs"
              variant={notifications.enabled ? 'light' : 'default'}
              leftSection={<IconBell size={14} />}
              loading={notifications.pending}
              aria-pressed={notifications.enabled}
              onClick={() => {
                const baseline =
                  result?.meta.queryStatus === 'complete' && draft === applied && parsed.document
                    ? { scope: printQuery(parsed.document), items }
                    : undefined
                void notifications.toggle(baseline).then((enabled) => {
                  if (enabled && !refreshMs) setRefreshPreset('10')
                })
              }}
            >
              {notifications.enabled ? 'Alerts on' : 'Browser alerts'}
            </Button>
          </Tooltip>
        </Buttons>
        <Buttons gap="xs" className="search-heading-right">
          <Tooltip label="Undo · Ctrl/Cmd+Z">
            <ActionIcon
              aria-label="Undo query"
              variant="default"
              disabled={!undoAvailable}
              onClick={() => editor.current?.undo()}
            >
              <IconArrowBackUp size={17} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Redo · Ctrl/Cmd+Shift+Z">
            <ActionIcon
              aria-label="Redo query"
              variant="default"
              disabled={!redoAvailable}
              onClick={() => editor.current?.redo()}
            >
              <IconArrowForwardUp size={17} />
            </ActionIcon>
          </Tooltip>
          <fieldset className="refresh-control" aria-label="Refresh controls">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconRefresh size={14} />}
              onClick={() => setRun((value) => value + 1)}
              disabled={!parsed.document}
            >
              Refresh
            </Button>
            <Select
              aria-label="Auto refresh interval"
              size="xs"
              w={136}
              value={refreshPreset}
              onChange={(value) => setRefreshPreset(value ?? 'off')}
              data={[
                { value: 'off', label: 'Off' },
                ...[5, 10, 30, 60, 300].map((seconds) => ({
                  value: String(seconds),
                  label: `Every ${seconds}s`,
                })),
                { value: 'custom', label: 'Custom interval' },
              ]}
            />
            {refreshPreset === 'custom' && (
              <NumberInput
                aria-label="Custom refresh seconds"
                size="xs"
                w={110}
                suffix=" s"
                min={5}
                max={3600}
                allowDecimal={false}
                value={customRefresh}
                onChange={setCustomRefresh}
              />
            )}
          </fieldset>
        </Buttons>
      </div>
      {notifications.problem && (
        <Alert color="yellow" role="alert">
          {notifications.problem}
        </Alert>
      )}
      <div className="query-bar">
        <IconSearch size={18} className="query-icon" />
        <QueryEditor
          initial={draft}
          onReady={(handle) => {
            editor.current = handle
          }}
          onRun={() => setRun((value) => value + 1)}
          onChange={(text, canUndo, canRedo) => {
            setDraft(text)
            setUndoAvailable(canUndo)
            setRedoAvailable(canRedo)
          }}
        />
        <Button
          className="run-query"
          size="sm"
          onClick={() => setRun((value) => value + 1)}
          disabled={!parsed.document}
        >
          Run query
        </Button>
      </div>
      {parsed.error && (
        <Alert color="yellow" className="query-error" role="alert">
          {parsed.error} Previous results remain visible.
        </Alert>
      )}
      {alertDocument && (
        <AlertSetup
          client={client}
          document={alertDocument}
          maxRangeMs={capabilities.maxRangeMs}
          onClose={() => setAlertDocument(undefined)}
        />
      )}
      <div className="query-controls">
        <div className="query-filter-controls">
          {refreshMs > 0 && (
            <span className="muted refresh-status">
              {draft !== applied || !parsed.document
                ? 'Refresh paused · query not applied'
                : `Auto refresh · ${refreshSeconds}s`}
            </span>
          )}
          <Popover opened={timeOpen} onChange={setTimeOpen} position="bottom-start" withinPortal>
            <Popover.Target>
              <Button
                size="compact-sm"
                variant="default"
                disabled={!parsed.document}
                leftSection={<IconClock size={14} />}
                onClick={() => {
                  setTimeOpen(!timeOpen)
                  setFrom(parsed.document?.time.from ?? '')
                  setTo(parsed.document?.time.to ?? '')
                }}
              >
                {parsed.document
                  ? `${parsed.document.time.from} → ${parsed.document.time.to}`
                  : 'Time range'}
              </Button>
            </Popover.Target>
            <Popover.Dropdown>
              <div className="time-picker">
                <Buttons gap="xs">
                  {['15m', '1h', '24h', '7d'].map((period) => (
                    <Button
                      key={period}
                      size="compact-xs"
                      variant="light"
                      onClick={() => {
                        changeTime(`now-${period}`, 'now')
                        setTimeOpen(false)
                      }}
                    >
                      Last {period}
                    </Button>
                  ))}
                </Buttons>
                <TextInput
                  label="From · UTC ISO or now-15m"
                  value={from}
                  onChange={(event) => setFrom(event.currentTarget.value)}
                />
                <TextInput
                  label="To · exclusive"
                  value={to}
                  onChange={(event) => setTo(event.currentTarget.value)}
                />
                <Button
                  size="xs"
                  onClick={() => {
                    changeTime(from, to)
                    setTimeOpen(false)
                  }}
                >
                  Apply time range
                </Button>
              </div>
            </Popover.Dropdown>
          </Popover>
          <Popover
            opened={filterOpen}
            onChange={setFilterOpen}
            position="bottom-start"
            withinPortal
          >
            <Popover.Target>
              <Button
                size="compact-sm"
                variant="subtle"
                disabled={!parsed.document}
                leftSection={<IconPlus size={14} />}
                onClick={() => setFilterOpen(!filterOpen)}
              >
                Add filter
              </Button>
            </Popover.Target>
            <Popover.Dropdown>
              <div className="filter-form">
                <Select
                  label="Field"
                  value={newField}
                  onChange={(value) => {
                    setNewField(value as QueryField)
                    setNewValue('')
                  }}
                  data={Object.keys(fields)}
                />
                <TextInput
                  label="Value"
                  value={newValue}
                  onChange={(event) => setNewValue(event.currentTarget.value)}
                />
                {filterOpen &&
                  capabilities.features.facets &&
                  parsed.document &&
                  (newField === 'service' ||
                    newField === 'environment' ||
                    newField === 'release') && (
                    <FacetValues
                      client={client}
                      document={parsed.document}
                      field={newField}
                      prefix={newValue}
                      maxRangeMs={capabilities.maxRangeMs}
                      maxPageSize={capabilities.maxPageSize}
                      onChoose={(value) => {
                        applyField(newField, value)
                        setFilterOpen(false)
                      }}
                    />
                  )}
                <Buttons>
                  <Button
                    size="xs"
                    onClick={() => {
                      applyField(newField, newValue)
                      setFilterOpen(false)
                    }}
                  >
                    Include
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => {
                      applyField(newField, newValue, true)
                      setFilterOpen(false)
                    }}
                  >
                    Exclude
                  </Button>
                </Buttons>
              </div>
            </Popover.Dropdown>
          </Popover>
          {parsed.document?.filter && (
            <FilterTree
              filter={parsed.document.filter}
              onRemove={(path) => {
                if (parsed.document) change(removeFilter(parsed.document, path))
              }}
            />
          )}
          <details className="query-help">
            <summary>Syntax</summary>
            <div>
              Fields: service, environment, type, message, message_exact, release, trace_id,
              runtime_id, group_key, origin. Double quotes preserve literal values. Message search
              ignores case; other fields match exactly. Use parentheses for mixed AND/OR. field:*
              means a nonempty stored field. One global {'time:[start TO end}'} is required. Ctrl+Z
              undoes typing, filters and time selection.
            </div>
          </details>
        </div>
        <Tooltip label="Apply query and filter changes automatically; does not control periodic refresh">
          <div className="auto-query-control">
            <Switch
              size="xs"
              label="Auto query"
              checked={autoQuery}
              onChange={(event) => setAutoQuery(event.currentTarget.checked)}
            />
          </div>
        </Tooltip>
      </div>
      <Histogram
        result={histogram}
        loading={histogramLoading}
        error={histogramError}
        onRange={changeTime}
      />
      <div className="result-meta">
        <span>
          {items.length} loaded{' '}
          {histogram && (
            <>
              of {histogram.meta.queryStatus === 'partial' ? 'at least ' : ''}
              {histogram.total.toLocaleString()} matching records
            </>
          )}
        </span>
        <span>
          {draft !== applied
            ? 'Query changed · previous results'
            : loading
              ? 'Updating…'
              : result
                ? `${result.meta.queryStatus} · ${result.meta.servedFrom} · ${new Date(result.meta.fetchedAt).toLocaleTimeString()}`
                : ''}
        </span>
      </div>
      {result && <Warnings values={result.meta.warnings} />}
      <RequestState loading={false} error={error} />
      <Group
        orientation={position === 'bottom' ? 'vertical' : 'horizontal'}
        className="investigation-layout"
        data-position={position}
      >
        <Panel id="results" defaultSize="45%" minSize="15%" className="results-panel">
          <div className="table-scroll">
            <table className="errors-table">
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => (
                      <th key={header.id}>
                        <div className="column-heading">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            aria-label={`Filter ${header.column.columnDef.header}`}
                            disabled={!parsed.document}
                            onClick={() => openColumnFilter(header.column.id)}
                          >
                            <IconFilter size={13} />
                          </ActionIcon>
                        </div>
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className={selected === row.original.ref ? 'selected-row' : ''}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && !loading && result && (
              <NoData
                text={
                  result.meta.queryStatus === 'partial'
                    ? 'No matching rows in the returned partial data.'
                    : undefined
                }
              />
            )}
            {loading && !items.length && <RequestState loading />}
            {result?.nextCursor && (
              <Button
                variant="subtle"
                loading={loading}
                disabled={draft !== applied}
                onClick={() => void loadMore()}
              >
                Load more errors
              </Button>
            )}
          </div>
        </Panel>
        {selected && (
          <>
            <Separator className="panel-separator" />
            <Panel id="detail" defaultSize="55%" minSize="20%">
              <section
                className={fullscreen ? 'occurrence-panel fullscreen' : 'occurrence-panel'}
                aria-label="Selected occurrence"
              >
                <div className="panel-toolbar">
                  <span>Occurrence details</span>
                  <Buttons gap={4}>
                    <ActionIcon
                      aria-label="Dock below"
                      variant={position === 'bottom' ? 'light' : 'subtle'}
                      onClick={() => setPosition('bottom')}
                    >
                      <IconLayoutBottombar size={17} />
                    </ActionIcon>
                    <ActionIcon
                      aria-label="Dock right"
                      variant={position === 'right' ? 'light' : 'subtle'}
                      onClick={() => setPosition('right')}
                    >
                      <IconLayoutSidebarRight size={17} />
                    </ActionIcon>
                    <ActionIcon
                      aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen occurrence'}
                      variant="subtle"
                      onClick={() => setFullscreen(!fullscreen)}
                    >
                      {fullscreen ? <IconMinimize size={17} /> : <IconMaximize size={17} />}
                    </ActionIcon>
                    <ActionIcon
                      aria-label="Close occurrence"
                      variant="subtle"
                      onClick={() => {
                        onSelect(undefined)
                        setFullscreen(false)
                      }}
                    >
                      <IconX size={17} />
                    </ActionIcon>
                  </Buttons>
                </div>
                <div className="detail-scroll">
                  <OccurrencePage key={selected} client={client} occurrenceRef={selected} />
                </div>
              </section>
            </Panel>
          </>
        )}
      </Group>
    </div>
  )
}
