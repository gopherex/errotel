import { describe, expect, it } from 'vitest'
import type { OccurrenceSummary } from '@gopherex/errotel-api'
import { NewErrors } from '../../app/src/newErrors'

function item(id: string, timestamp = '100'): OccurrenceSummary {
  return {
    ref: id,
    eventId: id,
    timestampUnixNano: timestamp,
    origin: 'sdk',
    contextStatus: 'not_loaded',
  }
}

describe('new error notifications', () => {
  it('silently baselines each query, deduplicates retries, and permits equal timestamps', () => {
    const tracker = new NewErrors()
    expect(tracker.observe('a', [item('1')])).toEqual([])
    expect(tracker.observe('a', [item('2'), item('1')])).toEqual([item('2')])
    expect(tracker.observe('a', [item('2'), item('1')])).toEqual([])
    expect(tracker.observe('b', [item('3')])).toEqual([])
    expect(tracker.observe('b', [item('4')])).toEqual([item('4')])
    tracker.reset()
    expect(tracker.observe('b', [item('5')])).toEqual([])
  })
  it('bounds retention and does not announce older rows again after eviction', () => {
    const tracker = new NewErrors(2)
    tracker.observe('a', [item('1', '10'), item('2', '20')])
    expect(tracker.observe('a', [item('3', '30')])).toEqual([item('3', '30')])
    expect(tracker.observe('a', [item('1', '10'), item('0', '5')])).toEqual([])
    expect(tracker.observe('a', [item('late', '25')])).toEqual([item('late', '25')])
  })
  it('handles an initially empty result and ordinary exceptions without event IDs', () => {
    const tracker = new NewErrors()
    const plain = { ...item('ref'), eventId: undefined, origin: 'otel-log' as const }
    expect(tracker.observe('a', [])).toEqual([])
    expect(tracker.observe('a', [plain])).toEqual([plain])
    expect(tracker.observe('a', [plain])).toEqual([])
  })
})
