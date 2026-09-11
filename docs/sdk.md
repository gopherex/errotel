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
gets a new registration ID. Reads are synchronous, only on `recordState`, or a
capture/local snapshot that includes registered state. Registration creates no subscription or
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

## Local snapshot

`client.snapshot()` reads the diagnostic picture already retained by the client
for user bug reports or another application-owned workflow. Deliver it through
your application's RPC. It does **not** emit an OTel LogRecord, write to the
outbox, call `filter`, consume rate-limit tokens, or record itself in history.
`kind: 'snapshot'` is client-local only: it is **not accepted by the ErrOtel read
server** and is not part of the exception wire envelope/schema.

```ts
import type { SnapshotOptions, SnapshotResult } from '@gopherex/errotel-sdk'
import type { DebugSnapshotV1 } from '@gopherex/errotel-sdk/protocol'

const result = client.snapshot({
  includeRegisteredState: true, // default
  includeHistory: true,         // default
  maxHistoryEntries: 50,        // optional: keep newest retained entries
  maxBytes: 64 * 1024,          // default: UTF-8 bytes of JSON.stringify(value)
  context: explicitOtelContext, // optional, otherwise active context
})
if (result.status === 'ok') {
  await applicationRpc.submitBugReport({ description, diagnostics: result.value })
}
```

The core method signature is `snapshot(opts?: SnapshotOptions): SnapshotResult`.
It is also available on `createOtlpClient` without changing provider ownership.
`SnapshotResult` is `{ status: 'ok'; value: DebugSnapshotV1 }` or
`{ status: 'unavailable'; reason: 'closed' | 'reentrant' }`.

Sources use the **same** read → optional serialize → sanitize → strict JSON copy
path and reader-error handling as capture. History uses the same monotonic age and
capacity retention and is copied before any source callback. It includes state
records and all breadcrumbs, including application logs named `log.<namespace>`;
the SDK does not collect those logs a second time. Without snapshot-specific
trimming, sources and history match a capture at the same time. Retained entries
keep their original timestamps and correlation and are not sanitized a second time.
The result is detached plain JSON: mutating it cannot change SDK history or future
captures. Both `JSON.stringify` and `structuredClone` are supported.

`snapshotId` identifies this local read. `runtime.sequence` is the current event
sequence at the start of the read; snapshots do not advance it. Trace correlation
uses the same explicit → active → absent policy as capture, including unsampled
contexts. With disabled history the result remains `ok`, with `enabled: false` and
empty items. `includeHistory: false` omits items without changing configured
`enabled` or counting them as truncations. `includeRegisteredState: false` skips
source callbacks. No inline state or exception is invented.

Normal retention runs first. Then `maxHistoryEntries` drops oldest entries; the
byte budget drops more oldest entries before replacing the largest source values
with `status: 'error', error: { code: 'budget_exceeded', stage: 'serialize' }`.
Source names, registration IDs and timestamps are preserved. Trimming changes only
the returned DTO. `history.truncatedCount` counts history items omitted by this
read's limits; `evictedCount` still counts normal retention evictions. A byte-budget
overflow adds `snapshot_budget` to the returned diagnostics. Bytes include all
metadata, Unicode encoding, error markers and diagnostics.

Limits accept nonnegative safe integers (including zero). Invalid numeric options
fall back to their defaults and report `snapshot_options`. If even required
metadata/error markers exceed `maxBytes` (for example, zero bytes or very long
source names), the SDK returns the valid reduced DTO with `snapshot_budget` even
though it exceeds the budget; it never throws just because the budget is too small.
Consumers with a strict RPC limit must check the final encoded size. The method is
synchronous: the output budget does not bound source callback work or peak copying
memory, and cannot interrupt application code.

Calls after disposal return `closed`; calls inside capture, source readers,
serializers, sanitizers, filters or diagnostic callbacks return `reentrant`.
Successful reads increment only the new `stats().snapshots` counter, leaving
capture counters/timings untouched. Unavailable calls do not increment it. Normal
retention can update history entry/eviction counts. Snapshot reader/budget errors
are local diagnostics only: they do not invoke `onDiagnostic` or change its
capture diagnostic counters. Application callbacks are still application code;
explicit mutations made by a reader retain their usual effect and fall after the
fixed history boundary.

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
const pending = await client.outbox?.stats() // queue size/age and delivery counters; may already be sent
await client.flush() // bounded export attempt; not a VM acknowledgement
// On account/tenant change, stop this client, clear its queue, then use a new namespace.
client.dispose()
await client.outbox?.clear()
await client.shutdown()
```

This opt-in extension uses a logs processor on the **owned** provider, replacing
`batch` (specifying both is an error). Core `createClient` can still use a borrowed provider. The processor starts an IndexedDB write immediately on emit and
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
checks run while the page exists, with exponential backoff and randomized delay up to one minute;
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


## Data policy and admission control

```ts
import { createClient, redactKeys } from '@gopherex/errotel-sdk'

const redact = redactKeys(['password', 'authorization', 'accessToken', 'refreshToken'])
const client = createClient({
  loggerProvider,
  sanitize(value, context) {
    // The application owns string redaction, including exception messages/stacks.
    if (typeof value === 'string') return value.replaceAll(knownSecret, '[REDACTED]')
    return redact(value, context)
  },
  filter: exception => exception.type !== 'ExpectedCancellation',
  rateLimit: { burst: 10, perSecond: 2 },
  exceptionLimits: { maxDepth: 8, maxNodes: 32 },
})
```

All these policies are optional. The rate limiter is a per-client token bucket
using monotonic time; it runs before exception extraction, serialization and source
reads. Distinct errors remain distinct; this does not deduplicate messages/stacks.
Rejected captures return `not_emitted / filtered`; `stats().rateLimited` and the
`rate_limited` diagnostic distinguish rate limiting from the user filter. The
filter receives a detached, sanitized exception before source reads. A filter that
throws rejects the capture and reports `filter_failed`.

`sanitize(value, { area, name? })` receives detached JSON, then its output is copied
and validated again. Areas: `source`, `inline`, `breadcrumb`, `exception`,
`attributes`, `extensions`, `label`. Sources, breadcrumbs and labels are sanitized
when recorded, before retention in history. Exception strings (including nested
causes and location URL) are sanitized before Body and mirrored attributes are
constructed. Source names, breadcrumb names and group keys use `label`.
`name` identifies the original source/breadcrumb or exception field for the callback.
The hook cannot rewrite identity, timestamps or trace correlation.

A failed sanitizer never falls back to sending unsanitized data: state receives an
error status, auxiliary sections are omitted, labels become `[REDACTED]`, exception
text is omitted with `incomplete: unreadable`. Diagnostics contain codes only.
A bad attributes/extensions value also omits that section without losing the
exception, with capture-local `diagnostics` visible in API and UI. Callbacks cannot
recursively capture or record history. They are synchronous and must remain fast;
the SDK cannot preempt an infinite loop in application code on the same thread.

`redactKeys()` matches complete object keys case-insensitively at every depth,
including literal dotted keys; it preserves JSON types and does not parse strings.
It does not detect secrets embedded in messages, URLs, stacks or JSON strings.
Configure string redaction explicitly. Resource data and records emitted directly
through a provider are outside the client's sanitizer; configure those at their
source. Changing identity/account still requires a fresh outbox namespace. Previously
persisted data is not retroactively sanitized: clear old queues when changing policy.

## Exception chains and wire compatibility

Wire version remains **1**. Optional fields `exception.cause`, `exception.errors`
(recursive ExceptionInfo), `exception.incomplete`, and envelope `diagnostics` are
specified in `docs/protocol.ts` and the runtime JSON Schema. Existing required
fields retain their meaning. Older readers permit unknown fields; older records
remain valid. This follows SPEC section 14's additive-field compatibility rule.

The default extraction bounds are 8 cause levels and 32 actual exception nodes
(including the root). Configure integers 1..256 through `exceptionLimits`. An
incomplete tree is marked `limit`, `cycle`, or `unreadable`; it is never presented
as the complete root cause. These bounds apply only to automatic exception-tree
extraction, not snapshot sizes. Each node contains only name/message/stack and
explicit cause/error links; arbitrary rejection objects are not fully serialized.
Cause/errors accessors and arbitrary iterators are never invoked. Repeated references
in different branches remain distinct entries; ancestral cycles are marked.

Public OpenAPI/TypeScript describe the tree recursively. Ogen 1.20.3 rejects the
optional recursive tree inside the required exception field; its build-only Go
projection represents nested ExceptionInfo nodes as lossless raw JSON. The original
runtime schema still validates the complete payload before it is exposed. This is
an adapter limitation, not a weakened public wire contract.

## Browser breadcrumbs and React

```ts
import { instrumentBrowser, createReactErrorHandler } from '@gopherex/errotel-sdk/browser'

const stop = instrumentBrowser(client, {
  fetch: true,
  xhr: true,
  navigation: true,
  excludeUrls: ['https://collector.example/custom-export-endpoint'],
})
// Optional early removal; client.dispose() also removes these instrumentations.
stop()

// React: use as componentDidCatch(error, info), or React root onCaughtError.
const onCaughtError = createReactErrorHandler(client, { groupKey: 'react.render' })
```

Each instrumentation is explicit opt-in; no automatic console, DOM or body capture.
Requests record method, URL origin/path, status or failure, duration, and the OTel
context available at request start. Query, fragment and URL credentials are removed;
paths can still contain sensitive identifiers, so use the sanitizer. Request/response
bodies and headers are not read. Default `/v1/logs`, `/v1/traces`, `/v1/metrics`
endpoints are excluded; configure custom telemetry endpoints explicitly.
Navigation records the resulting URL, not History state. This is diagnostic history,
not replay or tracing instrumentation. One browser-breadcrumb owner is allowed per
window; duplicate installation throws. Disposal restores only wrappers still owned
by this integration, and does not overwrite another library's subsequent wrapper.

The React helper captures `handled: true` and stores the original React component
stack separately under `extensions["errotel.react"]`. It does not invent JavaScript
stack frames or depend on React. Attach it at one reporting boundary to avoid
reporting the same handled error through both componentDidCatch and onCaughtError.
For React's onUncaughtError, call captureException with `handled: false` instead.
See [React root error callbacks](https://react.dev/reference/react-dom/client/createRoot#parameters).

## Trace context across async operations

The SDK consumes OTel context; it does not install a tracer provider, global
context manager or HTTP propagation. If the application already instruments its
requests, use that provider's active context. Without a working context manager,
`context.active()` may have no span. Do not assume an async continuation retained it.
An explicit context works without changing any global configuration:

```ts
import { context, trace, ROOT_CONTEXT } from '@opentelemetry/api'

const span = applicationTracer.startSpan('save document')
const operationContext = trace.setSpan(ROOT_CONTEXT, span)
try {
  // Supply the context to your HTTP instrumentation/propagation separately.
  await saveDocument()
} catch (error) {
  client.captureException(error, { context: operationContext })
} finally {
  span.end()
}
```

Use your application's OTel HTTP instrumentation to propagate traceparent to allowed
backends; this SDK's breadcrumbs do not inject headers or create spans. Explicit
unsampled contexts are still recorded. See [OTel JavaScript context](https://opentelemetry.io/docs/languages/js/context/).

## Diagnostics, retries and verification

`client.stats()` is a detached synchronous snapshot: local `snapshots`, attempted/emitted/filtered,
rateLimited/failed/reentrant, current history entries/evictions, last/max capture
milliseconds, and counters by diagnostic code. These are client-lifetime counters;
clearHistory resets only history and its eviction count. Timing includes policy and
synchronous encoding, not deferred export. No state or secrets appear in statistics.

`await client.outbox.stats()` additionally reports entries/bytes/oldestAgeMs,
persisted/evicted/expired/invalid/bypassed/storageFailures, exportAttempts,
accepted/retried/rejected/unpersistedLost and lastAcceptedAt. Delivery counters are
local to this processor and reset on restart; the pending queue is persisted.
Accepted counts receiver-success callbacks, not confirmed VM storage. Retried
counts record attempts that failed transiently, not unique occurrences.

The pinned OTel exporter handles its internal retry timing and Retry-After. The
outbox performs later retries with exponential jitter. The exporter does not expose
Retry-After to the processor after completing its own retry cycle; the later outbox
cycle therefore uses its own delay rather than promising to retain that header. It recognizes permanent
HTTP 4xx/5xx failures except 429/502/503/504 and removes rejected records with an
`outbox_export_rejected` diagnostic. Unknown errors retain the record for retry
until budget/TTL eviction. The browser exporter currently exposes permanent HTTP
status in an error message: this narrow adapter is pinned and covered by actual
browser exporter HTTP-response tests. Upgrading OTel requires rerunning them.
See [OTLP retry rules](https://opentelemetry.io/docs/specs/otlp/#retryable-response-codes).

```sh
yarn test                          # unit and contract tests
yarn typecheck:core
yarn test:browser                  # Chromium VM round-trip + Chromium/Firefox/WebKit SDK tests
make ci-vm PLAYWRIGHT_INSTALL_FLAGS=--with-deps
```

Browser SDK tests cover native fetch/XHR/navigation, IndexedDB eviction/expiry/leases,
sanitation on disk, permanent exporter rejection, offline recovery, large captures
and 10,000 attempted errors with early rate limiting. Each performance test attaches
`sdk-performance.json` (10 KiB / 1 MiB p95/max capture latency). Broad timeout guards
catch pathological stalls; these are measurements on the test machine, not universal
latency promises. The main Chromium scenario separately uses real VictoriaLogs,
VictoriaTraces, the read API and UI, including reopening after server restart.
HTTP-response fixtures are not counted as that real VM round-trip.


On Linux distributions unsupported by Playwright's downloaded WebKit binary, run
that project in the matching pinned test image (no host package changes):

```sh
docker run --rm --network host --ipc host --user "$(id -u):$(id -g)" \
  -v "$PWD:$PWD" -w "$PWD" mcr.microsoft.com/playwright:v1.63.0-noble \
  yarn playwright test --config tests/browser/playwright.config.ts \
  --project webkit --output test-results/webkit
```

This container is optional test infrastructure; it is not used by the product.
