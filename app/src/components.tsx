import { useMemo, useState } from 'react'
import { Alert, Badge, Button, Loader, TextInput } from '@mantine/core'
import { IconCopy, IconSearch } from '@tabler/icons-react'
import HyperJson from './vendor/hyperdx/HyperJson'

export function JsonPanel({ value }: { value: unknown }) {
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const data = value !== null && typeof value === 'object' ? value : { value }
  const matches = useMemo(() => {
    if (!query) return []
    const found: { path: string; value: unknown }[] = []
    const needle = query.toLocaleLowerCase()
    const pending: { path: string[]; value: unknown }[] = [{ path: [], value }]
    while (pending.length && found.length < 100) {
      const item = pending.pop()
      if (!item) break
      if (
        item.path.at(-1)?.toLocaleLowerCase().includes(needle) ||
        (typeof item.value !== 'object' && String(item.value).toLocaleLowerCase().includes(needle))
      )
        found.push({ path: JSON.stringify(item.path), value: item.value })
      if (item.value && typeof item.value === 'object')
        for (const [key, child] of Object.entries(item.value))
          pending.push({ path: [...item.path, key], value: child })
    }
    return found
  }, [value, query])
  return (
    <div className="json-panel">
      <div className="json-tools">
        <TextInput
          size="xs"
          aria-label="Search JSON"
          placeholder="Find key or value"
          leftSection={<IconSearch size={13} />}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconCopy size={13} />}
          onClick={() => {
            void navigator.clipboard
              .writeText(JSON.stringify(value, null, 2))
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }}
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </Button>
      </div>
      {query ? (
        <>
          <small className="muted">
            {matches.length === 100 ? 'First 100 matches' : `${matches.length} matches`}
          </small>
          {matches.map((match) => (
            <div key={match.path} className="json-match">
              <code>{match.path}</code>
              <HyperJson data={{ value: match.value }} />
            </div>
          ))}
        </>
      ) : (
        <HyperJson
          data={data}
          normallyExpanded={false}
          getLineActions={({ keyPath, value: item }) => [
            {
              key: 'copy-value',
              label: 'Copy value',
              onClick: () => {
                void navigator.clipboard.writeText(JSON.stringify(item)).catch(() => {})
              },
            },
            {
              key: 'copy-path',
              label: 'Copy path',
              onClick: () => {
                void navigator.clipboard.writeText(JSON.stringify(keyPath)).catch(() => {})
              },
            },
          ]}
        />
      )}
    </div>
  )
}
export function Warnings({ values }: { values: readonly string[] }) {
  return (
    <>
      {[...new Set(values)].map((warning) => (
        <Alert
          key={warning}
          color="yellow"
          className="notice"
          title={warning.replaceAll('_', ' ')}
        />
      ))}
    </>
  )
}
export function RequestState({ loading, error }: { loading: boolean; error?: string }) {
  return (
    <>
      {loading && (
        <div className="loading" role="status">
          <Loader size="sm" /> Loading…
        </div>
      )}
      {error && (
        <Alert color="red" title="Request failed" role="alert">
          {error}
        </Alert>
      )}
    </>
  )
}
export function CacheNote({ response }: { response?: Response }) {
  if (!response) return null
  return (
    <small className="muted">
      <Badge size="xs" variant="light">
        {response.headers.get('X-Errotel-Cache') === 'hit' ? 'Cache' : 'Upstream'}
      </Badge>{' '}
      Read {response.headers.get('X-Errotel-Fetched-At') ?? 'now'}
      {response.headers.get('X-Errotel-Cache-Age-Ms') &&
        ` · age ${response.headers.get('X-Errotel-Cache-Age-Ms')} ms`}
    </small>
  )
}
export function RawPanel({ raw }: { raw: string }) {
  return (
    <details>
      <summary>Inspect raw payload · unvalidated</summary>
      <pre>{raw}</pre>
    </details>
  )
}
export function NoData({ text = 'No errors match this query and time range.' }: { text?: string }) {
  return <div className="empty-state">{text}</div>
}
