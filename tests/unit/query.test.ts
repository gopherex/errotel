import { describe, expect, it } from 'vitest'
import {
  addFilter,
  parseQuery,
  nanoISO,
  printQuery,
  removeFilter,
  resolveRange,
  searchRequest,
} from '../../app/src/query'

const time = 'time:[now-15m TO now}'
describe('query document', () => {
  it('round-trips grouped filters, immutable button edits and time', () => {
    const before = parseQuery(`${time} AND (service:web OR service:api)`)
    const after = parseQuery(addFilter(before, 'environment', 'prod'))
    expect(after.filter?.op).toBe('and')
    expect(after.filter?.children?.[0].op).toBe('or')
    expect(before.filter?.op).toBe('or')
    expect(parseQuery(printQuery(after))).toEqual(after)
    expect(parseQuery(removeFilter(after, [1]))).toEqual(before)
    expect(
      parseQuery(printQuery({ ...after, time: { from: 'now-1h', to: 'now' } })).time.from
    ).toBe('now-1h')
  })
  it('preserves Unicode, quotes, dotted values, empty strings and literal wildcards', () => {
    for (const value of [
      'Ошибка "оплаты"',
      'C:\\path\\file',
      '',
      'x.y',
      '*',
      '__proto__',
      '\n',
      '😀',
    ]) {
      const document = parseQuery(addFilter(parseQuery(time), 'service', value))
      expect(document.filter?.value).toBe(value)
      expect(parseQuery(printQuery(document))).toEqual(document)
    }
  })
  it('handles exclusion, shorthand groups, message and prefix searches', () => {
    expect(parseQuery(`${time} AND NOT service:demo`).filter?.op).toBe('not')
    expect(
      parseQuery(`${time} AND type:(TypeError OR RangeError)`).filter?.children?.map((f) => f.field)
    ).toEqual(['exceptionType', 'exceptionType'])
    expect(parseQuery(`${time} AND timeout`).filter).toEqual({
      field: 'message',
      op: 'icontains',
      value: 'timeout',
    })
    expect(parseQuery(`${time} AND service:web*`).filter).toEqual({
      field: 'service',
      op: 'prefix',
      value: 'web',
    })
  })
  it('round-trips escaped prefix punctuation and exact nanosecond boundaries', () => {
    for (const value of ['web*literal', 'a?b', 'a b', 'a\\b']) {
      const document = {
        time: { from: 'now-1h', to: 'now' },
        filter: { op: 'prefix' as const, field: 'service' as const, value },
      }
      expect(parseQuery(printQuery(document))).toEqual(document)
    }
    const stamp = 1789034400000000001n
    expect(nanoISO(stamp)).toBe('2026-09-10T10:00:00.000000001Z')
  })
  it('requires a single global half-open time range and unambiguous groups', () => {
    for (const input of [
      'service:web',
      `${time} OR service:web`,
      `NOT (${time} AND service:web)`,
      `${time} AND ${time}`,
      'time:[now-15m TO now]',
      `${time} AND (service:web AND service:api OR service:worker)`,
      `${time} AND body:secret`,
      `${time} AND state.foo:1`,
      `${time} AND service:demo^2`,
      `${time} AND (`,
      `${time} AND * | stats count()`,
    ])
      expect(() => parseQuery(input), input).toThrow()
    expect(() => parseQuery(`(${time} AND service:web) AND (type:A OR type:B)`)).not.toThrow()
  })
  it('preserves nanoseconds and resolves now once for all requests', () => {
    const doc = parseQuery(
      'time:[2026-09-10T10:00:00.000000001Z TO 2026-09-10T10:00:00.000000002Z}'
    )
    const range = resolveRange(doc.time)
    expect(BigInt(range.endUnixNano) - BigInt(range.startUnixNano)).toBe(1n)
    expect(searchRequest(parseQuery(time), 2_000_000, 86_400_000).range).toEqual({
      startUnixNano: '1100000000000',
      endUnixNano: '2000000000000',
    })
    expect(() => resolveRange({ from: '2026-02-30T00:00:00Z', to: 'now' })).toThrow()
  })
})
