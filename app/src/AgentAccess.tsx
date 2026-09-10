import { useState } from 'react'
import { Alert, Button, Group, Modal, Textarea, TextInput } from '@mantine/core'
import type { OccurrenceSearch } from '@gopherex/errotel-api'
import { agentBaseURL, agentInstruction } from './agentAccess'
import { errorText } from './api'
import { parseQuery, searchRequest } from './query'

export function AgentAccess({
  occurrenceRef,
  query,
  maxRangeMs,
}: {
  occurrenceRef?: string
  query?: string
  maxRangeMs?: number
}) {
  const [opened, setOpened] = useState(false)
  const [base, setBase] = useState(() => new URL(location.pathname, location.origin).href)
  const [selector, setSelector] = useState<{ ref: string } | { search: OccurrenceSearch }>()
  const [scopeError, setScopeError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string>()
  let instruction = '',
    problem: string | undefined,
    root = ''
  try {
    root = agentBaseURL(base)
    instruction = agentInstruction(base, selector)
  } catch (error) {
    problem = errorText(error)
  }
  return (
    <>
      <Button
        size="compact-xs"
        variant="subtle"
        onClick={() => {
          setScopeError(undefined)
          setCopied(false)
          setCopyError(undefined)
          setSelector(undefined)
          try {
            if (occurrenceRef) setSelector({ ref: occurrenceRef })
            else if (query)
              setSelector({
                search: searchRequest(parseQuery(query), Date.now(), maxRangeMs ?? 86400000),
              })
          } catch (error) {
            setScopeError(errorText(error))
          }
          setOpened(true)
        }}
      >
        API / Agent
      </Button>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title="Connect an investigation agent"
        size="lg"
      >
        <TextInput
          label="ErrOtel service URL"
          description="Use an address reachable by your agent. This is the read service."
          value={base}
          onChange={(event) => {
            setBase(event.currentTarget.value)
            setCopied(false)
          }}
        />
        <p className="muted">
          Supply the token separately through the agent's secret environment. It is never included
          here.
        </p>
        {root && (
          <Group gap="sm">
            <a href={new URL('agent.md', root).href} target="_blank" rel="noreferrer">
              Agent guide
            </a>
            <a href={new URL('openapi.json', root).href} target="_blank" rel="noreferrer">
              OpenAPI
            </a>
          </Group>
        )}
        <p>
          {selector && 'ref' in selector
            ? 'Scope: selected occurrence.'
            : selector
              ? 'Scope: applied search filters, with time fixed when this dialog opened.'
              : 'Scope: discover applications in a bounded range.'}
        </p>
        {(problem || scopeError) && (
          <Alert color="yellow" role="alert">
            {problem || scopeError}
          </Alert>
        )}
        <Textarea
          label="Instruction preview"
          value={instruction}
          readOnly
          autosize
          minRows={8}
          maxRows={16}
        />
        <Button
          mt="sm"
          disabled={!!problem || !!scopeError}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(instruction)
              setCopied(true)
              setCopyError(undefined)
            } catch {
              setCopyError('Clipboard unavailable. Select and copy the preview.')
            }
          }}
        >
          {copied ? 'Copied instruction' : 'Copy instruction for agent'}
        </Button>
        {copyError && (
          <Alert color="yellow" mt="sm" role="alert">
            {copyError}
          </Alert>
        )}
      </Modal>
    </>
  )
}
