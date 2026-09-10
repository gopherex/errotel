import type { AlertPreparation } from '@gopherex/errotel-api'
import { printQuery, type QueryDocument } from './query'

export function alertSearchUrl(base: string, document: QueryDocument, windowSeconds: number) {
  const url = new URL(base)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use a public http(s) Errotel URL without credentials, query or fragment.')
  const query = printQuery({ ...document, time: { from: `now-${windowSeconds}s`, to: 'now' } })
  url.hash = `/?q=${encodeURIComponent(query)}`
  return url.href
}

export function alertLabels(rows: { name: string; value: string }[]): AlertPreparation['labels'] {
  const labels: Record<string, string> = Object.create(null)
  for (const row of rows) {
    if (!row.name && !row.value) continue
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.name) ||
      row.name.startsWith('__') ||
      ['alertname', 'errotel_source'].includes(row.name)
    )
      throw new Error(
        'Use valid label names; alertname, errotel_source and __ prefixes are reserved.'
      )
    if (Object.hasOwn(labels, row.name)) throw new Error(`Duplicate label: ${row.name}`)
    labels[row.name] = row.value
  }
  return labels
}

export function downloadConfiguration(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
