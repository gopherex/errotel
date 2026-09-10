# SDK

## SDK API

```ts
import { createClient } from '@gopherex/errotel-sdk'

const client = createClient({
  loggerProvider: existingLoggerProvider,
  captureUnhandled: true,
  history: { enabled: true, maxEntries: 100, maxAgeMs: 30_000 },
  onDiagnostic: ({ code, stage }) => reportDiagnosticCode(code, stage),
})

const unregister = client.registerState('editor', {
  read: () => ({ documentId: editor.id, revision: editor.revision }),
})
client.addBreadcrumb('command.started', { command: 'applyPatch' })
client.recordState('editor')
const result = client.captureException(error, {
  state: { command: 'applyPatch', patchId },
  context: explicitOtelContext, // optional, otherwise the active context
  groupKey: 'editor.patch',
})
unregister()
client.clearHistory()
client.dispose()
```

Sources may register/unregister at any time. Duplicate names throw; re-registering
gets a new registration ID. Reads are synchronous, only on `recordState` or a
capture that includes registered state. Registration creates no subscription or
polling. A non-JSON source supplies `serialize(value)` explicitly. For arbitrary
inline input use `serializeState`; otherwise `state` must already be JSON.

JSON snapshots are materialized immediately. Getters and `toJSON` are not called;
unsupported values produce source diagnostics rather than erasing the exception.
The JSON validator preserves null, falsy values, Unicode and literal dotted keys.
It rejects cycles, sparse arrays, undefined, non-finite numbers and class objects.

History is local to this client. Its boundary is captured before source callbacks.
Capacity and age evict whole entries; emission does not clear it. Set
`maxAgeMs: null` to disable age eviction. Capture options also include
`includeHistory`, `includeRegisteredState`, `handled`, `extensions`, and ordinary
OTel attributes; reserved exception/app.debug attributes cannot be overwritten.

Automatic `error`/`unhandledrejection` capture is opt-in. Import has no handlers or
network side effects. Only one automatic owner is installed per window; extra
clients still support manual captures and report an ownership diagnostic. Dispose
removes the owner's listeners. It neither prevents browser defaults nor replaces
other handlers. Resource loading events are excluded. No stack frames are invented.

One successful capture attempts one `Logger.emit`. Body is a JSON string in a
standard OTLP protobuf LogRecord; correlation uses the native trace/span fields.
There is no artificial span, state in Resource/Baggage, or global OTel reset.
Explicit valid context takes priority over active context; absent context stays
unlinked. Unsampled context does not suppress capture.

### Owned provider convenience entrypoint

```ts
import { createOtlpClient } from '@gopherex/errotel-sdk/otlp'

const client = createOtlpClient({
  url: 'https://your-collector.example/v1/logs',
  resource: { 'service.name': 'editor-web' },
  captureUnhandled: true,
  batch: { scheduledDelayMillis: 1000 },
})
// The same registration/capture methods are available.
await client.flush()
await client.shutdown()
```

Core `createClient` never shuts down a supplied provider; its optional `flush`
callback belongs to the caller. `createOtlpClient` owns its logger provider and
protobuf exporter. Its `shutdown()` disposes handlers and shuts down that provider.
Neither entrypoint installs a global logger provider. `CaptureResult.status =
'emitted'` describes the synchronous emit attempt. Flush/shutdown describe local
exporter lifecycle, **not confirmed durable storage in VM**. Page termination,
exporter queue overflow, network failures, retries and upstream rejection remain
possible. The default batch processor keeps its queue in memory. The optional
IndexedDB outbox below survives browser restarts; neither mode guarantees exactly-once delivery.

### Optional persistent browser outbox

```ts
const client = createOtlpClient({
  url: 'https://your-collector.example/v1/logs',
  resource: { 'service.name': 'editor-web' },
  outbox: {
    name: 'editor-account-42', // explicit app/account namespace, 1..100 [a-zA-Z0-9_.-]
    maxEntries: 1000,          // default
    maxBytes: 10 * 1024 * 1024, // default, UTF-8 serialized record bytes
    maxAgeMs: 24 * 3600 * 1000, // default, 24 hours
  },
  onDiagnostic: ({ code }) => reportDiagnosticCode(code),
})
client.captureException(error, { state: diagnosticState })
await client.outbox?.flushStorage() // IDB transactions; can reject if storage failed
const pending = await client.outbox?.stats() // { entries, bytes }; may already be sent
await client.flush() // bounded export attempt; not a VM acknowledgement
// On account/tenant change, stop this client, clear its queue, then use a new namespace.
client.dispose()
await client.outbox?.clear()
await client.shutdown()
```

This opt-in extension uses a logs processor on the **owned** provider, replacing
`batch` (specifying both is an error). Core `createClient` and the wire v1 contract
are unchanged. The processor starts an IndexedDB write immediately on emit and
requests strict transaction durability. A crash before that asynchronous commit can
still lose the record. `CaptureResult` remains synchronous and does not report a
storage acknowledgement. No service worker or background process is installed.

Only immutable log DTOs are persisted: original Body, attributes, eventId,
resource, timestamps and trace/span context. Retries use the genuine OTLP/HTTP
protobuf exporter with the current connection headers. Headers and exporter
credentials are never stored. The database name binds the namespace to a SHA-256
hash of the configured endpoint. Change the explicit namespace when the account or
tenant changes, including when only authentication headers change. Diagnostics
contain codes, not user state; avoid enabling OTel DEBUG logging with sensitive data.

Opening a client with the same namespace and endpoint replays its queue. Retry
checks run while the page exists, with exponential backoff up to one minute;
online/hidden-page events trigger another attempt. A 30-second IDB lease prevents
simultaneous tabs from normally sending the same queued record. After a crash an
in-flight lease may take up to 30 seconds to expire. This coordinates transport
only: SDK runtimes and state histories remain separate per client.
`dispose()` stops this client's listeners and retry timer; it retains persisted
records. `shutdown()` also attempts a bounded flush and closes its provider,
exporter and database. `clear()` cannot recall an already in-flight HTTP request.

Capacity/TTL remove whole records with diagnostics (`outbox_evicted`,
`outbox_expired`); the byte budget excludes IndexedDB's own storage overhead.
A record larger than the queue budget is exported once without persistence and
reports `outbox_capacity_bypass`; its Body is **not truncated**. The same fallback
applies when pending write memory is full. Unavailable/quota-failed IDB reports
`outbox_storage_failed` and attempts ordinary export. Fallback concurrency is
bounded; failed fallback is reported as `outbox_unpersisted_export_failed`.
Inspect `onDiagnostic`, since a fulfilled capture is not a delivery guarantee.

Records are removed on the exporter's success callback, meaning the OTLP receiver
answered successfully, not that VM persisted every record. In this OTel version,
HTTP-success responses with OTLP partial rejection also report exporter success;
receiver diagnostics/monitoring remain necessary. A lost response after upstream
acceptance can produce duplicate delivery; preserved eventId lets ErrOtel deduplicate.
Browser storage eviction, user-cleared site data, private browsing, quota exhaustion,
and expired/evicted records remain loss cases. Payloads are readable by same-origin
JavaScript: enable persistence deliberately for the diagnostic data you collect.
The SDK does not request persistent-storage permission automatically.

