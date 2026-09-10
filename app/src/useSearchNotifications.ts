import { useCallback, useEffect, useRef, useState } from 'react'
import type { OccurrenceSummary } from '@gopherex/errotel-api'
import { NewErrors } from './newErrors'

type Baseline = { scope: string; items: readonly OccurrenceSummary[] }

export function useSearchNotifications(onSelect: (ref: string) => void) {
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const active = useRef(false)
  const mounted = useRef(true)
  const tracker = useRef(new NewErrors())
  const notification = useRef<Notification | undefined>(undefined)
  const select = useRef(onSelect)
  select.current = onSelect
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      active.current = false
      notification.current?.close()
    }
  }, [])

  async function toggle(baseline?: Baseline): Promise<boolean> {
    if (active.current) {
      active.current = false
      setEnabled(false)
      tracker.current.reset()
      notification.current?.close()
      return false
    }
    setProblem(undefined)
    if (!window.isSecureContext || !('Notification' in window)) {
      setProblem('Browser notifications require a supported browser and HTTPS (or localhost).')
      return false
    }
    setPending(true)
    try {
      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission
      if (!mounted.current) return false
      if (permission !== 'granted') {
        setProblem(
          permission === 'denied'
            ? 'Notifications are blocked. Allow them in this site’s browser settings to enable alerts.'
            : 'Notification permission was not granted.'
        )
        return false
      }
      tracker.current.reset()
      if (baseline) tracker.current.observe(baseline.scope, baseline.items)
      active.current = true
      setEnabled(true)
      return true
    } catch {
      if (mounted.current) setProblem('This browser could not enable notifications.')
      return false
    } finally {
      if (mounted.current) setPending(false)
    }
  }

  const observe = useCallback((scope: string, items: readonly OccurrenceSummary[]) => {
    if (!active.current) return
    if (Notification.permission !== 'granted') {
      active.current = false
      setEnabled(false)
      notification.current?.close()
      setProblem('Notification permission was revoked. Enable it in this site’s browser settings.')
      return
    }
    const fresh = tracker.current.observe(scope, items)
    if (!fresh.length) return
    try {
      notification.current?.close()
      // Keep telemetry text and secrets out of lock-screen notifications.
      const next = new Notification(
        `Errotel · ${fresh.length} new ${fresh.length === 1 ? 'error' : 'errors'}`,
        {
          body: 'New matching errors in the current search. Click to investigate.',
        }
      )
      next.onclick = () => {
        window.focus()
        select.current(fresh[0].ref)
        next.close()
      }
      notification.current = next
    } catch {
      active.current = false
      setEnabled(false)
      setProblem('This browser could not display a notification. Search refresh remains enabled.')
    }
  }, [])

  return { enabled, pending, problem, toggle, observe }
}
