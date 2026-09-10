import { describe, expect, it } from 'vitest'
import { alertLabels, alertSearchUrl } from '../../app/src/alertConfig'
import { parseQuery } from '../../app/src/query'

describe('alert export inputs', () => {
  it('preserves the filter and replaces an absolute brush range with a rolling window', () => {
    const document = parseQuery(
      'service:"checkout<script>" AND time:[2026-09-10T10:00:00Z TO 2026-09-10T11:00:00Z}'
    )
    const url = new URL(alertSearchUrl('https://errors.example/tools/', document, 300))
    const query = new URL(url.hash.slice(1), url.origin).searchParams.get('q') ?? ''
    expect(parseQuery(query).filter).toEqual(document.filter)
    expect(parseQuery(query).time).toEqual({ from: 'now-300s', to: 'now' })
    expect(url.pathname).toBe('/tools/')
    expect(url.search).toBe('')
    expect(url.href).not.toContain('<script>')
  })
  it('rejects credential URLs and duplicate or reserved routing labels', () => {
    for (const url of [
      'javascript:alert(1)',
      'https://a:b@example/',
      'https://example/?token=x',
      'https://example/#token=x',
    ])
      expect(() => alertSearchUrl(url, parseQuery('time:[now-5m TO now}'), 300)).toThrow()
    for (const rows of [
      [
        { name: 'team', value: 'a' },
        { name: 'team', value: 'b' },
      ],
      [{ name: '__proto__', value: 'a' }],
      [{ name: 'errotel_source', value: 'a' }],
      [{ name: 'alertname', value: 'a' }],
    ])
      expect(() => alertLabels(rows)).toThrow()
    const labels = alertLabels([
      { name: 'constructor', value: 'literal' },
      { name: 'team', value: 'frontend' },
    ])
    expect(Object.getPrototypeOf(labels)).toBeNull()
    expect(labels.team).toBe('frontend')
  })
})
