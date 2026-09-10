import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Code,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
} from '@mantine/core'
import {
  getHistogram,
  prepareAlert,
  type AlertConfiguration,
  type AlertPreparation,
  type HistogramResponse,
} from '@gopherex/errotel-api'
import { type ApiClient, errorText } from './api'
import { printQuery, type QueryDocument } from './query'
import { alertLabels, alertSearchUrl, downloadConfiguration } from './alertConfig'

export function AlertSetup({
  client,
  document,
  maxRangeMs,
  onClose,
}: {
  client: ApiClient
  document: QueryDocument
  maxRangeMs: number
  onClose(): void
}) {
  const [name, setName] = useState('ErrotelErrors')
  const [windowSeconds, setWindow] = useState<string | number>(300)
  const [threshold, setThreshold] = useState<string | number>(1)
  const [interval, setInterval] = useState<string | number>(30)
  const [pendingFor, setPendingFor] = useState<string | number>(0)
  const [format, setFormat] = useState('file')
  const [namespace, setNamespace] = useState('monitoring')
  const [receiver, setReceiver] = useState('telegram')
  const [newTelegram, setNewTelegram] = useState(false)
  const [base, setBase] = useState(`${location.origin}${location.pathname}`)
  const [labels, setLabels] = useState([{ id: 0, name: 'team', value: 'frontend' }])
  const nextLabel = useRef(1)
  const [prepared, setPrepared] = useState<{ key: string; data: AlertConfiguration }>()
  const [preview, setPreview] = useState<{ key: string; data: HistogramResponse }>()
  const [busy, setBusy] = useState<'prepare' | 'preview'>()
  const [problem, setProblem] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  let body: AlertPreparation | undefined
  let invalid: string | undefined
  try {
    const window = Number(windowSeconds)
    const every = Number(interval)
    const count = Number(threshold)
    const hold = Number(pendingFor)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name))
      throw new Error(
        'Alert name: 1–64 letters, digits or underscores; start with a letter or underscore.'
      )
    if (
      ![window, every, count, hold].every(Number.isInteger) ||
      window < 10 ||
      window > Math.min(604800, maxRangeMs / 1000) ||
      every < 5 ||
      every > Math.min(3600, window) ||
      count < 1 ||
      count > 1e9 ||
      hold < 0 ||
      hold > 604800
    )
      throw new Error(
        'Use integer values: window 10s–7d (within server limit), interval 5s–1h and no longer than window, threshold 1–1e9, pending 0s–7d.'
      )
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace))
      throw new Error('Use a valid Kubernetes namespace.')
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(receiver))
      throw new Error('Receiver name: 1–64 letters, digits, underscores or hyphens.')
    body = {
      filter: document.filter,
      name,
      windowSeconds: window,
      threshold: count,
      intervalSeconds: every,
      forSeconds: hold,
      labels: alertLabels(labels),
      namespace,
      receiver,
      newTelegramReceiver: newTelegram,
      searchUrl: alertSearchUrl(base, document, window),
    }
  } catch (failure) {
    invalid = errorText(failure)
  }
  const key = body ? JSON.stringify(body) : ''
  const previewKey = JSON.stringify({
    filter: document.filter,
    windowSeconds: Number(windowSeconds),
    threshold: Number(threshold),
  })
  const config = prepared?.key === key ? prepared.data : undefined
  const result = preview?.key === previewKey ? preview.data : undefined
  async function run(action: 'prepare' | 'preview') {
    if (!body) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setBusy(action)
    setProblem(undefined)
    setNotice(undefined)
    try {
      if (action === 'prepare') {
        const response = await prepareAlert({
          client,
          body,
          signal: controller.signal,
          throwOnError: true,
        })
        if (!controller.signal.aborted) setPrepared({ key, data: response.data })
      } else {
        setPreview(undefined)
        const end = BigInt(Date.now()) * 1_000_000n
        const response = await getHistogram({
          client,
          body: {
            filter: document.filter,
            range: {
              startUnixNano: String(end - BigInt(body.windowSeconds) * 1_000_000_000n),
              endUnixNano: String(end),
            },
          },
          signal: controller.signal,
          throwOnError: true,
        })
        if (!controller.signal.aborted) setPreview({ key: previewKey, data: response.data })
      }
    } catch (failure) {
      if (!controller.signal.aborted) setProblem(errorText(failure))
    } finally {
      if (!controller.signal.aborted) setBusy(undefined)
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setNotice('Copied')
    } catch {
      setNotice('Clipboard unavailable. Select the text below or download the file.')
    }
  }
  const files = config
    ? [
        {
          id: 'rule',
          label: format === 'kubernetes' ? 'VMRule' : 'vmalert rule',
          name: format === 'kubernetes' ? 'vmrule.yaml' : 'rules.yaml',
          text: format === 'kubernetes' ? config.vmRuleYaml : config.rulesYaml,
        },
        {
          id: 'routing',
          label: 'Alertmanager fragment',
          name: 'alertmanager-fragment.yaml',
          text: config.alertmanagerYaml,
        },
        {
          id: 'instructions',
          label: 'Setup instructions',
          name: 'alert-setup.txt',
          text: config.instructions,
        },
      ]
    : []
  return (
    <Modal
      opened
      onClose={onClose}
      title="Configure external alert"
      size="xl"
      closeOnClickOutside={false}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          VictoriaLogs → vmalert → Alertmanager → your receiver. Errotel prepares files; you apply
          them in your own deployment.
        </Text>
        <details>
          <summary>Search filter used for this alert</summary>
          <Code block>{printQuery(document)}</Code>
        </details>
        <Group grow align="start">
          <TextInput
            label="Alert name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Select
            label="Deployment"
            value={format}
            onChange={(value) => setFormat(value ?? 'file')}
            data={[
              { value: 'file', label: 'File · Docker / systemd / binary' },
              { value: 'kubernetes', label: 'Kubernetes · VM Operator' },
            ]}
          />
        </Group>
        <Group grow align="start">
          <NumberInput
            label="Rolling window · seconds"
            value={windowSeconds}
            onChange={setWindow}
            min={10}
            max={Math.min(604800, maxRangeMs / 1000)}
            allowDecimal={false}
          />
          <NumberInput
            label="Errors ≥"
            value={threshold}
            onChange={setThreshold}
            min={1}
            max={1e9}
            allowDecimal={false}
          />
        </Group>
        <Group grow align="start">
          <NumberInput
            label="Evaluate every · seconds"
            value={interval}
            onChange={setInterval}
            min={5}
            max={3600}
            allowDecimal={false}
          />
          <NumberInput
            label="Pending for · seconds"
            description="0 = trigger on the first matching evaluation"
            value={pendingFor}
            onChange={setPendingFor}
            min={0}
            max={604800}
            allowDecimal={false}
          />
        </Group>
        <Text size="xs" c="dimmed">
          The rolling window replaces the selected timeline range. Counts include unique SDK
          eventIds and ordinary OTel exceptions. Repeated windows can include the same error.
        </Text>
        {format === 'kubernetes' && (
          <>
            <TextInput
              label="VMRule namespace"
              value={namespace}
              onChange={(e) => setNamespace(e.currentTarget.value)}
            />
            <Alert color="yellow">
              Match your VMAlert rule selectors. If VMAlertmanagerConfig requires a namespace alert
              label, add it below; the resource namespace does not add that label.
            </Alert>
          </>
        )}
        <Text size="sm">Alert labels · match your existing routing</Text>
        {labels.map((row) => (
          <Group key={row.id} align="end" grow>
            <TextInput
              aria-label="Alert label name"
              placeholder="team / severity / namespace"
              value={row.name}
              onChange={(e) => {
                const name = e.currentTarget.value
                setLabels((rows) =>
                  rows.map((item) => (item.id === row.id ? { ...item, name } : item))
                )
              }}
            />
            <TextInput
              aria-label="Alert label value"
              placeholder="frontend"
              value={row.value}
              onChange={(e) => {
                const value = e.currentTarget.value
                setLabels((rows) =>
                  rows.map((item) => (item.id === row.id ? { ...item, value } : item))
                )
              }}
            />
            <Button
              variant="subtle"
              onClick={() => setLabels((rows) => rows.filter((item) => item.id !== row.id))}
            >
              Remove label
            </Button>
          </Group>
        ))}
        <Button
          variant="subtle"
          size="compact-sm"
          disabled={labels.length >= 16}
          onClick={() =>
            setLabels((rows) => [...rows, { id: nextLabel.current++, name: '', value: '' }])
          }
        >
          Add alert label
        </Button>
        <TextInput
          label="Alertmanager receiver name"
          description="Existing routing may already match these labels; then no Alertmanager change is needed."
          value={receiver}
          onChange={(e) => setReceiver(e.currentTarget.value)}
        />
        <Switch
          label="Include a new Telegram receiver template"
          checked={newTelegram}
          onChange={(e) => setNewTelegram(e.currentTarget.checked)}
        />
        {newTelegram && (
          <Text size="xs" c="dimmed">
            The exported fragment contains a secret-file path and a chat ID placeholder. Replace
            them outside Errotel.
          </Text>
        )}
        <TextInput
          label="Public Errotel URL"
          description="Used only for the investigation link. The link opens this filter with a rolling time range."
          value={base}
          onChange={(e) => setBase(e.currentTarget.value)}
        />
        {invalid && (
          <Alert color="yellow" role="alert">
            {invalid}
          </Alert>
        )}
        {problem && (
          <Alert color="red" role="alert">
            {problem}
          </Alert>
        )}
        <Group>
          <Button
            disabled={!body || !!busy}
            loading={busy === 'prepare'}
            onClick={() => void run('prepare')}
          >
            Prepare configuration
          </Button>
          <Button
            variant="default"
            disabled={!body || !!busy}
            loading={busy === 'preview'}
            onClick={() => void run('preview')}
          >
            Preview current count
          </Button>
        </Group>
        {result && (
          <Alert color={result.meta.queryStatus === 'partial' ? 'yellow' : 'gray'}>
            {result.meta.queryStatus === 'complete'
              ? `${result.total} matching errors · condition ${result.total >= Number(threshold) ? 'met' : 'not met'}`
              : `${result.total} errors in partial data · condition unknown`}
            <Text size="xs">
              {result.meta.servedFrom} · {result.meta.fetchedAt}
              {result.meta.cacheAgeMs !== undefined
                ? ` · cache age ${result.meta.cacheAgeMs}ms`
                : ''}
              . A point-in-time count does not verify the pending duration or notification delivery.
            </Text>
            {result.meta.warnings.map((warning) => (
              <Text size="xs" key={warning}>
                {warning}
              </Text>
            ))}
          </Alert>
        )}
        {prepared && !config && (
          <Text size="sm" c="yellow">
            Settings changed. Prepare the configuration again.
          </Text>
        )}
        {notice && (
          <Text role="status" size="sm">
            {notice}
          </Text>
        )}
        {config && (
          <>
            <Alert color="teal" title="Configuration prepared">
              Apply it in your deployment to enable the alert. Source: {config.source}.
            </Alert>
            <Tabs defaultValue="rule">
              <Tabs.List>
                {files.map((file) => (
                  <Tabs.Tab key={file.id} value={file.id}>
                    {file.label}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              {files.map((file) => (
                <Tabs.Panel key={file.id} value={file.id} pt="sm">
                  <Stack gap="xs">
                    <Group>
                      <Button size="xs" variant="default" onClick={() => void copy(file.text)}>
                        Copy {file.name}
                      </Button>
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() => downloadConfiguration(file.name, file.text)}
                      >
                        Download {file.name}
                      </Button>
                    </Group>
                    <Code block className="alert-export-code">
                      {file.text}
                    </Code>
                  </Stack>
                </Tabs.Panel>
              ))}
            </Tabs>
          </>
        )}
      </Stack>
    </Modal>
  )
}
