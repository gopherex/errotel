import { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { HistogramResponse } from '@gopherex/errotel-api'
import { nanoISO } from './query'
import { RequestState, Warnings } from './components'

export function Histogram({
  result,
  loading,
  error,
  onRange,
}: {
  result?: HistogramResponse
  loading: boolean
  error?: string
  onRange(from: string, to: string): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const callback = useRef(onRange)
  callback.current = onRange
  const [hover, setHover] = useState('Drag to select a time range')
  useEffect(() => {
    if (!host.current || !result) return
    setHover('Drag to select a time range')
    const start = Number(BigInt(result.range.startUnixNano)) / 1e9
    const end = Number(BigInt(result.range.endUnixNano)) / 1e9
    const data: uPlot.AlignedData = [
      result.buckets.map(
        (bucket) =>
          (Number(BigInt(bucket.startUnixNano)) + Number(BigInt(bucket.endUnixNano))) / 2e9
      ),
      result.buckets.map((bucket) =>
        result.meta.queryStatus === 'partial' && bucket.count === 0 ? null : bucket.count
      ),
    ]
    const plot = new uPlot(
      {
        tzDate: (stamp) => uPlot.tzDate(new Date(stamp * 1000), 'Etc/UTC'),
        width: host.current.clientWidth,
        height: 140,
        padding: [8, 16, 0, 0],
        legend: { show: false },
        cursor: { drag: { x: true, y: false, setScale: false } },
        select: { show: true, left: 0, top: 0, width: 0, height: 0 },
        scales: {
          x: { time: true, min: start, max: end },
          y: { range: (_u, _min, max) => [0, Math.max(1, max * 1.15)] },
        },
        axes: [
          {
            stroke: '#909296',
            grid: { show: false },
            ticks: { stroke: '#25262b' },
            font: '11px IBM Plex Mono',
          },
          {
            stroke: '#909296',
            size: 44,
            grid: { stroke: '#25262b', width: 1 },
            ticks: { show: false },
            font: '11px IBM Plex Mono',
            values: (_u, ticks) =>
              ticks.map((value) => (Number.isInteger(value) ? String(value) : '')),
          },
        ],
        series: [
          {},
          {
            label: 'Errors',
            stroke: '#25e2a5',
            fill: '#008362',
            paths: uPlot.paths.bars?.({ size: [0.8, 60] }),
            points: { show: false },
          },
        ],
        hooks: {
          setCursor: [
            (u) => {
              const bucket = result.buckets[u.cursor.idx ?? -1]
              setHover(
                bucket
                  ? `${new Date(Number(BigInt(bucket.startUnixNano) / 1_000_000n)).toISOString()} · ${result.meta.queryStatus === 'partial' ? 'at least ' : ''}${bucket.count} errors`
                  : 'Drag to select a time range'
              )
            },
          ],
          setSelect: [
            (u) => {
              if (u.select.width < 4) return
              const from = Math.max(start * 1000, Math.floor(u.posToVal(u.select.left, 'x') * 1000))
              const to = Math.min(
                end * 1000,
                Math.ceil(u.posToVal(u.select.left + u.select.width, 'x') * 1000)
              )
              if (to > from) {
                u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
                callback.current(
                  nanoISO(
                    BigInt(Math.floor(from)) * 1_000_000n < BigInt(result.range.startUnixNano)
                      ? BigInt(result.range.startUnixNano)
                      : BigInt(Math.floor(from)) * 1_000_000n
                  ),
                  nanoISO(
                    BigInt(Math.ceil(to)) * 1_000_000n > BigInt(result.range.endUnixNano)
                      ? BigInt(result.range.endUnixNano)
                      : BigInt(Math.ceil(to)) * 1_000_000n
                  )
                )
              }
            },
          ],
        },
      },
      data,
      host.current
    )
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width) plot.setSize({ width: entry.contentRect.width, height: 140 })
    })
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      plot.destroy()
    }
  }, [result])
  return (
    <section className="histogram" aria-label="Error frequency">
      <div className="histogram-heading">
        <span>
          Error frequency{' '}
          {result && (
            <strong>
              {result.meta.queryStatus === 'partial' ? '≥ ' : ''}
              {result.total.toLocaleString()}
            </strong>
          )}
        </span>
        <small>
          {result
            ? `Count / ${result.intervalMs < 1000 ? `${result.intervalMs} ms` : `${result.intervalMs / 1000} s`} · ${result.meta.servedFrom}`
            : 'Across the full query range'}
        </small>
      </div>
      <RequestState loading={loading && !result} error={error} />
      {result && <Warnings values={result.meta.warnings} />}
      <div
        ref={host}
        tabIndex={-1}
        onPointerDown={() => host.current?.focus({ preventScroll: true })}
        data-testid="histogram-plot"
        className={loading ? 'chart refreshing' : 'chart'}
      />
      <div className="histogram-caption">
        <span>{hover}</span>
        <span>UTC · {loading ? 'Updating…' : 'Drag to zoom · Ctrl+Z to undo'}</span>
      </div>
    </section>
  )
}
