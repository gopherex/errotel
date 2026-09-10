import type { OccurrenceSummary } from '@gopherex/errotel-api'

// Track only newly observed rows in the newest search page. This is not an alert index.
export class NewErrors {
  private scope: string | undefined
  private seen = new Map<string, bigint>()
  private floor = 0n

  constructor(private readonly capacity = 5000) {}

  reset() {
    this.scope = undefined
    this.seen.clear()
    this.floor = 0n
  }

  observe(scope: string, items: readonly OccurrenceSummary[]): OccurrenceSummary[] {
    const baseline = scope !== this.scope
    if (baseline) {
      this.reset()
      this.scope = scope
    }
    const fresh: OccurrenceSummary[] = []
    for (const item of items) {
      const key = item.eventId ?? item.ref
      const stamp = BigInt(item.timestampUnixNano)
      if (this.seen.has(key) || stamp < this.floor) continue
      this.seen.set(key, stamp)
      if (!baseline) fresh.push(item)
    }
    // Rows older than our retained window cannot become "new" after eviction.
    const ordered = [...this.seen.entries()].sort((a, b) =>
      a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
    )
    if (baseline && ordered.length) this.floor = ordered[0][1]
    for (const [key, stamp] of ordered.slice(0, Math.max(0, ordered.length - this.capacity))) {
      this.seen.delete(key)
      if (stamp >= this.floor) this.floor = stamp + 1n
    }
    return fresh
  }
}
