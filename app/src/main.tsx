import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, Button, MantineProvider, PasswordInput } from '@mantine/core'
import { IconActivity, IconArrowLeft, IconLogout } from '@tabler/icons-react'
import { getCapabilities, type Capabilities } from '@gopherex/errotel-api'
import { apiClient, errorText } from './api'
import { SearchPage } from './SearchPage'
import { OccurrencePage } from './OccurrencePage'
import { TracePage } from './TracePage'
import { AgentAccess } from './AgentAccess'
import { TestErrors } from './TestErrors'
import { theme } from './theme'
import '@mantine/core/styles.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import './style.css'

function App() {
  const [token, setToken] = useState('')
  const [input, setInput] = useState('')
  const [capabilities, setCapabilities] = useState<Capabilities>()
  const [route, setRoute] = useState(location.hash || '#/')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const client = useMemo(() => apiClient(token), [token])
  useEffect(() => {
    const update = () => setRoute(location.hash || '#/')
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  async function connect(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError(undefined)
    try {
      const response = await getCapabilities({ client: apiClient(input), throwOnError: true })
      setCapabilities(response.data)
      setToken(input)
      setInput('')
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setLoading(false)
    }
  }
  const url = new URL(route.slice(1) || '/', location.origin)
  const [, page, reference] = url.pathname.split('/')
  const updateSearch = useCallback((key: string, value?: string) => {
    const next = new URL(location.hash.slice(1) || '/', location.origin)
    if (value) next.searchParams.set(key, value)
    else next.searchParams.delete(key)
    const hash = `#/${next.search}`
    history.replaceState(null, '', hash)
    setRoute(hash)
  }, [])
  const select = useCallback((ref?: string) => updateSearch('ref', ref), [updateSearch])
  const query = useCallback((text: string) => updateSearch('q', text), [updateSearch])
  const searchLink = `#/${url.searchParams.has('q') ? `?q=${encodeURIComponent(url.searchParams.get('q') ?? '')}` : ''}`
  const knownRoute = !page || page === 'occurrences' || page === 'traces'
  return (
    <MantineProvider theme={theme} forceColorScheme="dark">
      <button
        type="button"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main')?.focus()
        }}
      >
        Skip to content
      </button>
      <header className="app-header">
        <a href="#/" className="brand">
          <IconActivity size={23} />
          <strong>ErrOtel</strong>
          <span>ERROR EXPLORER</span>
        </a>
        <div className="header-right">
          <AgentAccess
            occurrenceRef={
              page === 'occurrences' ? reference : (url.searchParams.get('ref') ?? undefined)
            }
            query={!page ? (url.searchParams.get('q') ?? undefined) : undefined}
            maxRangeMs={capabilities?.maxRangeMs}
          />
          {token && (
            <>
              <span className="source-name">{capabilities?.source}</span>
              <TestErrors />
              <Button
                variant="subtle"
                size="compact-xs"
                leftSection={<IconLogout size={14} />}
                onClick={() => {
                  setToken('')
                  setCapabilities(undefined)
                }}
              >
                Disconnect
              </Button>
            </>
          )}
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {token && capabilities ? (
          <>
            {!capabilities.features.queryFilters && (
              <Alert color="yellow">
                The read server needs an update to support query filters and histograms.
              </Alert>
            )}
            {!knownRoute ? (
              <div className="standalone">
                <h1>Page not found</h1>
                <a href="#/">Open error search</a>
              </div>
            ) : page && reference ? (
              <div className="standalone">
                <a className="back-link" href={searchLink}>
                  <IconArrowLeft size={14} /> Back to errors
                </a>
                {page === 'occurrences' ? (
                  <OccurrencePage key={reference} client={client} occurrenceRef={reference} />
                ) : (
                  <TracePage key={reference} client={client} traceId={reference} />
                )}
              </div>
            ) : (
              <SearchPage
                client={client}
                capabilities={capabilities}
                selected={url.searchParams.get('ref') ?? undefined}
                initial={url.searchParams.get('q') ?? undefined}
                onSelect={select}
                onQuery={query}
              />
            )}
          </>
        ) : (
          <div className="connect-page">
            <div className="connect-intro">
              <IconActivity size={32} />
              <h1>Every error has context.</h1>
              <p>Connect to investigate the stack, state and history captured with your errors.</p>
            </div>
            <form onSubmit={(event) => void connect(event)} className="connect-form">
              <h2>Connect to Errotel</h2>
              <PasswordInput
                label="API token"
                name="token"
                autoComplete="off"
                required
                value={input}
                onChange={(event) => setInput(event.currentTarget.value)}
              />
              <p className="muted">Your token stays in this tab’s memory.</p>
              {error && (
                <Alert color="red" role="alert">
                  {error}
                </Alert>
              )}
              <Button type="submit" loading={loading} fullWidth>
                Connect
              </Button>
            </form>
          </div>
        )}
      </main>
    </MantineProvider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
