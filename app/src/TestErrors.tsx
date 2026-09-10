import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Group, Modal, Notification, Textarea, TextInput } from '@mantine/core'
import { IconFlask, IconSend } from '@tabler/icons-react'
import type { JsonValue } from '@gopherex/errotel-sdk/protocol'
import { errorText } from './api'

type OwnedClient = ReturnType<typeof import('./testTelemetry')['createTestClient']>

export function TestErrors() {
  const [opened, setOpened] = useState(false)
  const [endpoint, setEndpoint] = useState(
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
      ? 'http://127.0.0.1:14318/v1/logs'
      : ''
  )
  const [service, setService] = useState('errotel-ui-test')
  const [tracesEndpoint, setTracesEndpoint] = useState(
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
      ? 'http://127.0.0.1:14318/v1/traces'
      : ''
  )
  const [environment, setEnvironment] = useState('local-test')
  const [message, setMessage] = useState('Synthetic error from Errotel UI')
  const [state, setState] = useState('{"operation":"checkout","amount":42,"ready":false}')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(0)
  const [failure, setFailure] = useState<string>()
  const [notice, setNotice] = useState<{ title: string; text: string; error?: boolean }>()
  const current = useRef<{ key: string; client: OwnedClient } | undefined>(undefined)
  const sequence = useRef(0)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void current.current?.client.shutdown().catch(() => {})
      current.current = undefined
    }
  }, [])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  function close() {
    if (pending.current) return
    setOpened(false)
    const previous = current.current
    current.current = undefined
    void previous?.client.shutdown().catch(() => {})
  }
  async function send() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFailure(undefined)
    try {
      const url = new URL(endpoint)
      const tracesUrl = new URL(tracesEndpoint)
      if (
        [url, tracesUrl].some(
          (value) =>
            !['http:', 'https:'].includes(value.protocol) ||
            value.username ||
            value.password ||
            value.hash
        )
      )
        throw new Error('Enter HTTP(S) OTLP endpoints without embedded credentials or fragments.')
      if (!service.trim()) throw new Error('Service is required.')
      const inline = JSON.parse(state) as JsonValue
      const key = JSON.stringify([url.href, tracesUrl.href, service, environment])
      if (current.current?.key !== key) {
        await current.current?.client.shutdown()
        current.current = undefined
        const { createTestClient } = await import('./testTelemetry')
        if (!mounted.current) return
        const client = createTestClient(url.href, tracesUrl.href, service, environment)
        client.registerState('test-generator', {
          read: () => ({ sequence: sequence.current, synthetic: true }),
        })
        current.current = { key, client }
      }
      const client = current.current.client
      sequence.current++
      const exception = new Error(message)
      exception.name = 'SyntheticError'
      const capture = await client.runOperation(exception, (context) => {
        client.addBreadcrumb('test.send', { sequence: sequence.current }, { context })
        client.recordState('test-generator', { context })
        return client.captureException(exception, { state: inline, context })
      })
      if (capture.status !== 'emitted') throw new Error(`Capture failed: ${capture.reason}`)
      await client.flush()
      if (!mounted.current) return
      setSent((value) => value + 1)
      setNotice({
        title: 'Sent to OTLP',
        text: `Error #${sequence.current} and its trace exported. VM search visibility may take a moment.`,
      })
    } catch (error) {
      if (!mounted.current) return
      const text = errorText(error)
      setFailure(text)
      setNotice({ title: 'Error was not confirmed sent', text, error: true })
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <>
      <Button
        size="compact-xs"
        variant="subtle"
        leftSection={<IconFlask size={14} />}
        onClick={() => setOpened(true)}
      >
        Test errors
      </Button>
      <Modal
        opened={opened}
        onClose={close}
        title="Send test errors"
        size="lg"
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
        withCloseButton={!busy}
      >
        <form
          className="synthetic-fields"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <p>
            Send an SDK error with state, history and a three-span synthetic trace. Open the error's
            Trace tab to explore the operation. Each send creates a new trace.
          </p>
          <TextInput
            label="OTLP logs endpoint"
            placeholder="https://collector.example/v1/logs"
            value={endpoint}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
            required
            disabled={busy}
          />
          <TextInput
            label="OTLP traces endpoint"
            placeholder="https://collector.example/v1/traces"
            value={tracesEndpoint}
            onChange={(event) => setTracesEndpoint(event.currentTarget.value)}
            required
            disabled={busy}
          />
          <Group grow>
            <TextInput
              label="Service"
              value={service}
              onChange={(event) => setService(event.currentTarget.value)}
              required
              disabled={busy}
            />
            <TextInput
              label="Environment"
              value={environment}
              onChange={(event) => setEnvironment(event.currentTarget.value)}
              disabled={busy}
            />
          </Group>
          <TextInput
            label="Error message"
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            disabled={busy}
          />
          <Textarea
            label="Inline state · JSON"
            value={state}
            onChange={(event) => setState(event.currentTarget.value)}
            minRows={4}
            autosize
            disabled={busy}
            spellCheck={false}
          />
          <p>
            Uses the collector's CORS policy. The read API token is never sent to OTLP. Export
            completion does not confirm durable storage in VM.
          </p>
          {failure && (
            <Alert color="red" role="alert">
              {failure}
            </Alert>
          )}
          <Group justify="space-between">
            <span className="muted">Sent: {sent}</span>
            <Button type="submit" loading={busy} leftSection={<IconSend size={14} />}>
              Send error
            </Button>
          </Group>
        </form>
      </Modal>
      {notice && (
        <div className="synthetic-toast" role={notice.error ? 'alert' : 'status'}>
          <Notification
            title={notice.title}
            color={notice.error ? 'red' : 'green'}
            onClose={() => setNotice(undefined)}
          >
            {notice.text}
          </Notification>
        </div>
      )}
    </>
  )
}
