# Errotel

Browser exception SDK and stateless read API for VictoriaLogs / VictoriaTraces.

Errotel records browser errors with immutable state and history through the user's
OTLP pipeline. Its stateless Go server reads VictoriaLogs and VictoriaTraces and
serves the investigation UI. Search, visual filters and the frequency histogram
share one visible query and one Undo/Redo history.

## Layout and tools

- `packages/sdk`: browser TypeScript SDK; `@gopherex/errotel-sdk/protocol` is type-only.
- `packages/api`: generated frontend client from `openapi/openapi.json`.
- `app`: React investigation UI workspace.
- `services/errotel`: independent Go module, outside Yarn workspaces.
- `docs`: original protocol, wire schema, specification, and synthetic fixtures.
- `examples/browser`: runnable telemetry producer, not an investigation UI.

Yarn **1.22.22** is pinned in `packageManager`; use the repository lockfile. Node
**22.23.1**, Go **1.26.7**, Biome **2.4.16**, golangci-lint **2.11.3**.
Go uses chi, structconf, xlog, xprobe, xshutdown and google/uuid. Exact Go module
versions are recorded in `services/errotel/go.mod` and `go.sum`. These are published
versions; building does not require local sibling checkouts or `replace` paths.

The Go choice follows the requested gopherex libraries and keeps deployment to one
binary. There is no database, ingestion service or persistent cache in Errotel.

## Install and run locally

```sh
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile
make generate
yarn build:packages
make build-server
make stack-up
```

`make stack-up` runs VictoriaLogs, VictoriaTraces, VictoriaMetrics, a test OTel
Collector, the read server and its UI. The old standalone example is optional (`--profile fixtures`). All published ports bind to loopback:

| Component | Address |
| --- | --- |
| Errotel UI | http://127.0.0.1:18080 |
| Errotel read API | http://127.0.0.1:18080/api/v1/capabilities |
| Collector OTLP HTTP | http://127.0.0.1:14318/v1/logs and `/v1/traces` |
| VictoriaLogs | http://127.0.0.1:19428 |
| VictoriaTraces | http://127.0.0.1:20428 |
| VictoriaMetrics | http://127.0.0.1:18428 |

The Compose token defaults to `local-synthetic-only`, exclusively for this local
synthetic stack. Override it through `APP_DEBUG_API_TOKEN`; it is passed only to
the backend container. Open **Test errors** in the UI header. The modal sends real
SDK errors and a new three-span trace directly to the local Collector, keeps state/history
between sends and stays open. The synthetic operation has `test.send-error` as its parent,
`test.prepare-state` and `test.capture-error` as children, and intentional 40/60 ms delays
for a readable waterfall. Error capture and its breadcrumb/snapshot use the failed child's
explicit context. Open the occurrence's **Trace** tab to load its waterfall from VictoriaTraces;
the error span is selected automatically. Existing errors sent without trace context remain unlinked.
A toast reports both exporter callback results, rather than inferring success from
`flush()` (OTel can report export failures through diagnostics while resolving flush). It never attaches the read
API token to OTLP. Logs/traces endpoints, service, environment, message and inline JSON are editable.
If only the trace export fails, the modal explicitly reports that the log was already exported.
Set `ui_connect_origins: [https://collector.example]` in server configuration to
allow that exact origin in the UI's CSP `connect-src`; paths, wildcards and CSP
directives are rejected. The local configuration allows `http://127.0.0.1:14318`.
The logs and traces providers are created only on Send and disposed when the modal closes;
changing endpoints or resource settings creates new owned providers. They never install
global providers or context managers. No automatic UI instrumentation or transmission occurs.
On non-loopback hosts both OTLP endpoints start empty.

Search has an **Auto query** switch (on by default): valid edits, filter buttons,
time selection and undo apply after 400 ms of idle typing. With it off, use **Run query**
or Ctrl/Cmd+Enter. Invalid queries keep previous results and never reach the API.
The combined **Refresh** button and interval selector (**Off** by default) offers 5/10/30/60/300-second presets and a custom 5–3600-second interval.
The interval starts after both search and histogram finish; requests never overlap.
An unapplied draft pauses refresh. Relative `now` ranges advance on each refresh; absolute
ranges stay fixed. Refresh replaces the newest results page and preserves the selected
occurrence, docking and query undo history. Existing rows remain visible during refresh.

**Browser alerts** requests [browser notification permission](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)
only on click and enables a 10-second refresh if polling was off. The first successful
complete result for each query is a silent baseline; subsequent complete responses can
notify about newly observed matching errors. Retries/cache hits do not repeat alerts.
Only a count is shown in the OS notification; click it to focus this tab and open the error.
Denied/revoked permission or unsupported browsers produce an explicit message.
All controls and deduplication stay in tab memory; disconnecting/leaving search stops polling
and notifications. HTTPS or localhost is required. There is no service worker, push service
or closed-tab delivery. Background tabs may be throttled by the browser. This is a best-effort
watch of the newest search page, not exhaustive alerting: bursts beyond that page, older late
arrivals and more than 5000 retained identities may be missed. Partial/failed reads do not
generate alerts, and changing the query starts a new baseline.

The standalone example remains a test fixture. To seed malformed/conflicting records:

```sh
docker compose --profile fixtures up -d example
```

Then:

```sh
yarn playwright install chromium
yarn seed
```

The seed command opens an actual headless browser. It sends a valid SDK error,
retry duplicate, conflicting bodies, unsupported schema version, damaged body,
index mismatch, malformed event ID, ordinary OTel exception and a non-exception ERROR log. It prints
IDs and service name, not the payload. The example has only OTLP endpoints, no
Errotel API address or API token. Use only the local synthetic endpoints for tests.

To run the backend and example on the host instead of their containers:

```sh
docker compose up -d victorialogs victoriatraces victoriametrics collector
make build-server
APP_DEBUG_API_TOKEN=local-synthetic-only ERROTEL_LISTEN=127.0.0.1:18080 \
  ./bin/errotel -config config.example.yaml
# In another terminal:
yarn example
```

Stop host processes before starting Compose on the same ports. `make stack-down`
stops the local stack and retains VM volumes. The VM/Collector stack is test
infrastructure; production Errotel connects to the user's existing endpoints.

## UI development and investigation

With the Compose stack running:

```sh
yarn dev                        # UI on http://127.0.0.1:5173, API proxy to :18080
# Equivalent: cd app && yarn dev
# To develop the example on the host:
docker compose stop example
yarn example                    # http://127.0.0.1:14173
# Equivalent: cd examples/browser && yarn dev
```

Override the dev proxy with `ERROTEL_API_URL=http://127.0.0.1:PORT yarn dev`.
This is the read server address, not a credential. The Docker UI remains available
on 18080 while the local Vite UI runs on 5173. Stop one example instance before
starting another on 14173.

Alert configuration and browser alerts sit on the left of the search heading; Undo/Redo and
the combined refresh control sit on the right. Auto query sits below Run query, to the right
of the filter controls. The compact search toolbar leaves room for the table; its headers expose filter actions that update the visible query. The table reaches both viewport edges, with themed scrollbars.

Errors open below the table. The pane can dock right, resize and expand to full
screen; opened JSON sections survive layout changes. Original stacktrace is shown
first. Registered state, inline state and history have independent expandable trees.
Trace and related logs load only after an explicit action. The trace viewer uses
HyperDX's waterfall with a local adapter for normalized read API spans. Logs expose
the chosen relationship; time neighbors are not described as causes.

Query syntax and visual behavior are specified in [docs/query-language.md](docs/query-language.md).
`Ctrl/Cmd+Z` (including Russian keyboard layout) undoes text edits, filter actions and histogram/time selections in their
original order. `Ctrl/Cmd+Shift+Z` and `Ctrl+Y` redo. Toolbar buttons expose the same
history. Other inputs keep native text undo. `Ctrl/Cmd+Enter` runs the query;
`Escape` outside input/dialog controls closes the occurrence. Query history is local
to the mounted search screen; reload does not persist the undo stack.

Presentation uses Mantine 9.6.1, TanStack Table 8.21.3, CodeMirror 6, uPlot 1.6.32
and react-resizable-panels 4.12.4. HyperDX's MIT HyperJson and TimelineChart are
vendored at commit `fda038d630ef66963d90399648dc7d107c0ca69f`, with relative import,
formatting and safe string-rendering adaptations. Sources, changes and copyright
are in [NOTICE](app/src/vendor/hyperdx/NOTICE.md); distributed notices are served at
`/third-party-notices.txt`. No HyperDX backend or full application is embedded.
Large JSON is collapsed, string values stay strings, explicit expansion reveals
more entries, and telemetry is never interpreted as HTML or fetched as a URL.

## External alerts: export configuration

On error search, **Configure alert** takes the current filter into a modal. Set the rolling
window, minimum error count, evaluation interval, pending duration and routing labels.
**Preview current count** reads the real histogram for that rolling window and shows its
completeness/cache metadata. It does not evaluate the pending duration or test notification delivery.
**Prepare configuration** uses the server's field mapping and produces copyable/downloadable files:

- `rules.yaml`: ordinary vmalert configuration for binary, systemd or Docker (default).
- `vmrule.yaml`: the same rule wrapped in a VM Operator `VMRule` (optional deployment choice).
- `alertmanager-fragment.yaml`: a child route targeting a named existing receiver; optionally
  includes a Telegram receiver template with `bot_token_file` and a numeric chat ID placeholder.
- `alert-setup.txt`: installation, validation, routing, selectors and HA instructions.

The UI says **Configuration prepared**, never enabled. There is no scheduler, Telegram client,
external configuration write, rule CRUD, rule storage or added volume in Errotel. Closing the
modal discards the form. vmalert evaluates the rule independently of the browser; Alertmanager
handles routing, grouping, deduplication and notification delivery. Existing matching routes
need no Alertmanager change. API tokens and VM credentials are not included in any export.

The authenticated `POST /api/v1/alerts/prepare` is an ogen-generated operation. It accepts an
allowlisted filter tree and bounded rule settings, never raw LogsQL or a destination to contact.
It renders without contacting upstreams. `searchUrl` is only a textual annotation (http(s), no
userinfo or outer query); the UI builds its fragment from the filter and rolling window. The
returned mapping fingerprint covers field mapping only, not credentials. Regenerate files after
changing source/mapping. Copy the upstream read credentials/tenant configuration to vmalert
through your existing secret management, outside Errotel.

A rule counts unique valid SDK `eventId`s plus ordinary exception records in one LogsQL stats
query. Retry/conflicting SDK bodies count once per rolling window. ERROR severity alone does not
qualify. Absolute timeline selection becomes the explicit rolling window; the investigation link
also opens a rolling search relative to click time. Overlapping windows can contain the same
error. This is a threshold alert, not one Telegram message per occurrence. Partial/failed preview
reads never claim the condition is satisfied. Late arrivals and vmalert evaluation delay can change
counts. Monitor vmalert evaluation failures separately. Large distinct counts consume upstream RAM.

vmalert expands `%{ENV}` before parsing YAML: the generator rejects those literals in filters and
mapping instead of changing their meaning. Alert label values also reject Go template expressions.
YAML is serialized, template annotations use quoted literals, and Telegram uses plain-text mode.
The bot token is never entered into Errotel. Replace the exported chat ID placeholder with an
unquoted integer and mount the secret file on the Alertmanager host/container before validating.

For a standalone evaluator, after downloading `rules.yaml` and choosing reachable addresses:

```sh
# Validate with the tested image; no notifier request is made by dryRun.
docker run --rm -v "$PWD/rules.yaml:/etc/vmalert/rules.yaml:ro,Z" \
  victoriametrics/vmalert:v1.151.0 -rule=/etc/vmalert/rules.yaml -dryRun

# Replace these hostnames with your existing services; use their Docker network if necessary.
docker run --rm -v "$PWD/rules.yaml:/etc/vmalert/rules.yaml:ro,Z" \
  victoriametrics/vmalert:v1.151.0 -rule=/etc/vmalert/rules.yaml \
  -datasource.url=http://VICTORIALOGS:9428 -notifier.url=http://ALERTMANAGER:9093

# The binary/systemd ExecStart uses the same flags:
vmalert-prod -rule=/etc/vmalert/rules.yaml \
  -datasource.url=http://VICTORIALOGS:9428 -notifier.url=http://ALERTMANAGER:9093
```

`:Z` labels a private bind mount on SELinux hosts; omit it where inappropriate. An existing
vmalert that reads metrics needs a VictoriaLogs datasource for these `type: vlogs` rules; do not
replace its metrics datasource and break existing rules. Use a separate evaluator if needed.

Merge the Alertmanager child route into the existing `route.routes`, keeping the root receiver,
other routes and their ordering/continue behavior. Append a receiver only when creating one.
Validate the **complete merged file** with `amtool check-config`, then apply/reload through your
normal deployment process. The generated fragment alone is intentionally not a complete config.

For Kubernetes, match `VMRule.metadata.labels` and namespace to your `VMAlert` selectors. The
starting label `app.kubernetes.io/part-of: errotel` does not guarantee selection. Validate against
installed CRDs with `kubectl apply --dry-run=server`. A `VMAlertmanagerConfig` namespace matcher
requires a matching **alert label**; `VMRule.metadata.namespace` does not supply it. Manage native
Alertmanager config through your existing Secret/Helm/operator workflow. The exported native
fragment is not itself a `VMAlertmanagerConfig` manifest.

Errotel replicas remain stateless and need no shared volume. Rules, Alertmanager persistence and
HA configuration belong to the user's deployment. Replicated vmalert instances must produce
identical alert labels for Alertmanager deduplication and notify the HA receivers according to
their deployment configuration. Pending alert state may restart with vmalert unless its own
remoteWrite/remoteRead state restoration is configured. Errotel does not provision an HA cluster.

References: [VictoriaLogs + vmalert](https://docs.victoriametrics.com/victorialogs/vmalert/),
[VMAlert selectors](https://docs.victoriametrics.com/operator/resources/vmalert/),
[VMRule](https://docs.victoriametrics.com/operator/resources/vmrule/),
[VMAlertmanagerConfig](https://docs.victoriametrics.com/operator/resources/vmalertmanagerconfig/),
[Telegram receiver](https://prometheus.io/docs/alerting/latest/configuration/#telegram_config).

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

## Read API, OpenAPI and ogen

```sh
make generate  # public schema + ogen Go server/client + frontend client
make build-server
```

`ogen v1.20.3` generates handlers, request/response validation, security interfaces,
routing and Go client under `services/errotel/internal/oas`. The production chi
router mounts this generated server behind the peer auth guard. All required
read operations and the histogram extension use generated handlers. `packages/api` uses the same public
OpenAPI with `@hey-api/openapi-ts 0.64.0` / `client-fetch 0.10.0`, as in iam.

The public OpenAPI is 3.1. `scripts/openapi-go.mjs` produces an ignored build-only
3.0 projection for ogen: const becomes an enum, and recursive arbitrary user JSON
uses ogen's raw JSON value. This is a generator compatibility adapter; the original
wire schema and `protocol.ts` are unchanged. Detail bodies are validated separately
against the complete original runtime JSON Schema before exposing state.

Required routes (all require `Authorization: Bearer ...`):

- `GET /api/v1/capabilities`
- `POST /api/v1/investigate` (one occurrence with trace and related evidence)
- `POST /api/v1/facets` (observed service/environment/release values)
- `POST /api/v1/occurrences/search`
- `POST /api/v1/occurrences/histogram`
- `POST /api/v1/alerts/prepare` (configuration export)
- `GET /api/v1/occurrences/{ref}`
- `POST /api/v1/occurrences/{ref}/related`
- `GET /api/v1/traces/{traceId}`

Use `openapi/openapi.json` for exact request/response shapes. Search takes absolute
nanosecond strings, an exclusive end, allowlisted filters and a bounded page size.
It reads small index fields. Detail reads the envelope and stored fields. Locators
and cursors are validated stateless values, never authorization credentials or raw
queries. Search cursors bind to the normalized request and configuration revision.
VM data arriving or expiring between pages can change results; pagination is not a
persistent database snapshot.

Unknown versions, malformed payloads and index mismatch retain the readable
exception with explicit warnings. Exact retry event IDs are deduplicated; conflicting
bodies are warned about on detail. Flat stored fields are not advertised as the
original Resource. Related logs require explicit relation evidence (`same_span`,
`same_trace`, `same_runtime`, or `time_window`); temporal neighbors are not causes.
Trace retrieval is independent. Grouping, snapshot diff and metrics queries are
currently disabled in capabilities.

### Agent discovery over HTTP

The running server serves `/agent.md` and `/openapi.json` directly from embedded
build artifacts, even if VM is unavailable or no UI directory is installed. Public
documentation contains no configured source names, endpoints, credentials or data.
Root HTML/HTTP links advertise the documents. Every `/api/` operation still requires
Bearer authentication. Vite proxies documentation routes alongside `/api` in dev.

Capabilities include a server clock in nanoseconds, supported filter operators and
fields, facet fields, and pagination/range limits. `POST /api/v1/facets` accepts
`field: service|environment|release`, `range`, optional `filter`, literal `prefix`,
`pageSize` (default 50) and `cursor`. It returns `value`, `errorCount`,
`lastSeenUnixNano`, `nextCursor` and cache/completeness metadata. All supplied filters
apply, including the requested field's own filter. Empty strings represent empty or
absent stored metadata. Values describe exceptions observed within this range, not
an inventory or application availability. Release/commit/build IDs remain application
attributes; ErrOtel does not infer a Git SHA or manage their lifecycle.

Aggregation runs in VictoriaLogs without returning Body. Counts deduplicate SDK
IDs within each facet value and include ordinary OTel exceptions. Conflicting
copies with different values may contribute to multiple buckets, so summing such
buckets is not a global unique count. Sorting is descending count then ascending
value. Cursor keys bind source/mapping revision, normalized query, absolute range
and page size. Pagination can change with ingestion/retention, just like search.
The usual timeout, cancellation, query-budget, peer-auth and memory-cache rules
apply; partial/failure responses are never cached as empty successes.

The UI **API / Agent** dialog previews and copies a token-free instruction with the
selected occurrence ref or the applied search's filters and an absolute time range.
Supply `ERROTEL_TOKEN` separately through the agent's secret environment. The base
URL can be changed to one reachable by the agent, and must not contain credentials,
query parameters or fragments. The dialog never receives the auth token. There is
no MCP server in this version. Under **Add filter**, service/environment/release
values load on demand; selecting one changes the shared query and supports Undo.

The published guide explains the investigation sequence, ambiguity, missing traces,
partial responses, large payload handling and treating telemetry as untrusted data.
`TestPublishedDiscoveryWorkflow` exercises the HTTP workflow against Testcontainers
using the served OpenAPI, without importing a generated API client. The browser test
checks real VM suggestions, Undo and copied scope without secrets. These are
protocol/workflow tests, not an evaluation of a separate LLM's reasoning quality.

### One request for an investigation agent

`POST /api/v1/investigate` accepts exactly one selector:

```json
{ "ref": "<occurrence ref from search or UI URL>" }
```

```json
{
  "eventId": "<SDK event UUID>",
  "range": { "startUnixNano": "<absolute start>", "endUnixNano": "<exclusive end>" }
}
```

```json
{
  "search": {
    "range": { "startUnixNano": "<absolute start>", "endUnixNano": "<exclusive end>" },
    "filter": { "op": "and", "children": [
      { "op": "eq", "field": "service", "value": "checkout-web" },
      { "op": "contains", "field": "message", "value": "Payment failed" }
    ] }
  },
  "relatedPageSize": 20
}
```

The search selector picks the newest matching occurrence with the same deterministic
tie order as search, and exposes `selection.hasMoreMatches` on complete searches.
It does not accept a cursor/pageSize. Its AST is the same allowlisted filter API
used by the UI. An eventId requires a bounded range because the locator timestamp
is not encoded in the UUID; `ref` already contains it. This avoids unbounded VM
scans. Empty results return 404; failed selection/detail reads return a proper
upstream error, never an empty success.

Example against the local synthetic stack, assuming `ERROTEL_TOKEN` is supplied
in your shell environment (the token is not part of the JSON):

```sh
python3 - <<'PY'
import json, os, time, urllib.request
end = time.time_ns()
body = {"search": {"range": {"startUnixNano": str(end - 900_000_000_000),
                              "endUnixNano": str(end)}}}
request = urllib.request.Request("http://127.0.0.1:18080/api/v1/investigate",
    data=json.dumps(body).encode(), headers={"Content-Type": "application/json",
    "Authorization": "Bearer " + os.environ["ERROTEL_TOKEN"]})
with urllib.request.urlopen(request) as response:
    print(response.read().decode())
PY
```

The response contains `occurrence` (original exception, stack, validated state and
history), `trace.result` (normalized spans), `relatedLogs.result` and per-component
cache/fetch metadata. Trace and logs load concurrently after the occurrence. Logs
use same-trace evidence when possible, otherwise same-runtime, otherwise a bounded
service/time window; with no correlation keys/service they are not queried.
The default is 20 related rows, configurable up to the server page-size limit;
`partial`/`row_limit` explicitly indicates additional rows. Temporal proximity is
never presented as a cause. Conflict warnings disable correlation reads.

A missing or unavailable trace cannot erase the occurrence. `status: complete`
means the requested reads completed without warnings, not that all spans were
recorded or a root cause was proven: trace completeness remains `unknown` or
`partial`. Missing trace context has reason `trace_context_absent`. An unavailable,
not-configured or missing requested trace produces `status: partial`. Selection
partialness is explicit; no-match partial selection is an error. All nested
payload warnings remain visible. Treat every telemetry string as untrusted data,
including instructions an agent might encounter inside state, stack, or logs.
This operation has no aggregate cache; each component reports its own freshness,
and authentication runs before every request, including cache hits.

## Configuration, authentication and cache

`config.example.yaml` describes host configuration; `deploy/local.yaml` is the
container equivalent. Run `./bin/errotel -config /etc/errotel/config.yaml`. Configuration
can be overridden with structconf's `ERROTEL_` environment prefix. The fixed token
comes from the environment variable named by `token_env` (`APP_DEBUG_API_TOKEN`).

VM endpoints and field mappings are server configuration only. `logs.base_url`
points at the VL root; traces supports a root or configured `/select/jaeger` base
(including a reverse-proxy prefix). `headers_env` names an environment variable
containing an upstream headers JSON object, e.g. a VM read credential. It never
passes through frontend configuration. The server refuses UI-supplied upstream URLs,
credentials, headers, tenants or raw LogsQL. No secret or telemetry body is logged
by the backend by default.

Default field mapping includes `_msg` for Body, `_time`, `_stream_id`, `trace_id`,
`span_id`, `severity_number`, `service.name`, `deployment.environment.name`,
`service.version`, standard `exception.*` and `app.debug.*`. Override individual
logical names under `fields` when your pipeline renames attributes. Source identity,
mapping and credential/configuration revision participate in cache keys.

Auth hashes secrets and compares digests in constant time. Failed guesses are
limited per peer, with a bounded peer table; correct tokens remain usable. Forwarded
addresses are used only through configured `trusted_proxies` CIDRs. Every data API,
including a cache hit, passes the auth guard. The UI keeps the token in
memory of the current tab only; no bundle, URL or browser storage token.

The memory cache has TTL, total byte budget and max-entry budget. Oversized responses
are returned whole without caching. Timeouts, failures and partial responses are
not cached as empty success. Negative related results use a short TTL. Response
headers expose `X-Errotel-Cache`, `X-Errotel-Fetched-At`, and cache age when present.
Queries have timeout/cancellation, concurrency and row budgets. `/healthz/readiness`
and `/healthz/liveness` use xprobe; xshutdown manages signal-driven HTTP shutdown.

The Docker image builds and serves `app/dist` at `/opt/errotel/ui`. A standalone
binary serves the directory configured by `ui_dir`; run `yarn build` before using
`app/dist`. Supply backend configuration and secrets at runtime. Frontend assets
contain no API token. Opening a shared occurrence URL after restart reads VM again;
a page reload asks for the token because no browser storage is used.

## OTLP, CORS and CSP

Recording is browser → SDK → **user OTLP pipeline** → VictoriaLogs. Reading is
browser UI → Errotel → VM. Errotel has no ingest, upload or blob endpoint.

The local Collector is an example of the user's pipeline. Its HTTP receiver enables
CORS for the local UI, browser test server and fixture example loopback origins, and exporters forward standard protobuf
to VM. Collector sending queues are disabled in this synthetic configuration.
Production pipeline operators must configure allowed browser origins and headers,
TLS and any OTLP-specific credentials independently of the Errotel read token. Add
the collector origin to the application's CSP `connect-src`. Do not weaken CSP or
add the Errotel server to the SDK's write path to work around OTLP CORS.

A successful ingest HTTP response is not proof of a successful future query.
VictoriaTraces v0.11.0 delays its trace ID index with `insert.indexFlushInterval`
(default 20s); a fresh trace can temporarily return not_found. VL reads are also
polled in integration tests to allow upstream visibility after ingestion.

**Verified upstream limit:** VictoriaLogs v1.52.0 has a hard 2 MiB stored-record
limit, including fields, regardless of an increased `insert.maxLineSizeBytes`.
A real >2 MiB seed was rejected despite HTTP success. The SDK adds no size cap,
truncation, chunks or uploads. Successful round-trip tests use 1 MiB payloads;
SDK/NDJSON tests separately exercise larger values. Arbitrarily large one-record
snapshots cannot be promised with this VM backend. See the
[official VL size limit](https://docs.victoriametrics.com/victorialogs/faq/#what-length-a-log-record-is-expected-to-have).

## Checks

```sh
yarn test                       # SDK, query semantics and contract fixtures
make test-go                    # Go unit tests with race detector
make test-integration           # isolated Testcontainers VM stack, real protobuf + ogen client
yarn playwright install chromium
yarn test:browser               # real browser SDK → Collector → VM → API → UI, process restart
make lint-go                    # strict Go lint copied/adapted from komeet
```

The browser suite starts the local Compose VM/Collector services, compiles the Go
server and production UI, runs its own process on 18581 and reopens exactly the same occurrence URL
after restarting that process. Each run uses unique synthetic service names. It
also checks malformed/unsupported data and indexes, conflicts, native handlers, auth, paging,
large uncached bodies, safe UI rendering, available/unavailable trace, filter/time
Undo/Redo and docking the occurrence without losing expanded state. Testcontainers creates its
own ephemeral VM containers and removes them on exit.

```sh
yarn lint                       # Biome, including app
yarn typecheck                  # SDK + UI
yarn typecheck:core              # example, contract and browser test types
yarn build                      # generated TS client, SDK, production UI
yarn run check                  # lint + types + unit tests + Go race tests
```

Fixtures are synthetic, created from the contract, and are not evidence of an
actual VM round-trip. Vitest fixture checks and real Docker/browser tests are
separate commands. The browser test explicitly named `UI response fixtures` injects
partial/cache/failure API responses only to test rendering; it is not a VM round-trip.
The native-handler browser test also checks in-browser SDK behavior without VM.
The durable browser test closes a real offline Chromium profile after its IndexedDB
commit, reopens that profile, sends through the real protobuf exporter/Collector,
and checks VM → investigation API → UI → server restart. `outbox.spec.ts` separately
uses native IndexedDB plus a fixture exporter to exercise eviction, byte budgets,
leases, expiry, retries, corruption, recursion, and unavailable storage; those
fixture transport checks are not a VM round-trip.
Docker and Chromium are required for the latter; absence is an
explicit test failure, not a fixture fallback.

Pinned integration versions: VictoriaLogs **1.52.0**, VictoriaTraces **0.11.0**,
VictoriaMetrics **1.151.0**, OTel Collector **0.147.0** (VM and Collector images pinned
by digest). Browser OTel API **1.9.1**, logs API/SDK/protobuf exporter **0.222.0**,
resources and trace SDK **2.11.0**, trace protobuf exporter **0.222.0**.

The alert integration test creates its own Docker network and pinned **vmalert 1.151.0** /
**Alertmanager 0.32.1** containers. It seeds duplicate/conflicting SDK IDs, vanilla exceptions and
an ERROR-only row, executes the exported LogsQL against VictoriaLogs, checks threshold boundaries,
origin filters and injection literals, runs `vmalert -dryRun` and `amtool check-config`, and observes
the real fired alert at the isolated Alertmanager with an inert receiver. It never sends Telegram.
The browser alert-generator test uses the actual SDK/search/preview API and downloads generated YAML.
The separate `alert preview response fixtures` test injects partial/cache/failure responses only
to verify rendering; it is not evidence of a VM round-trip.
No Kubernetes API is used by these tests; installed CRD selection and real Telegram delivery remain
deployment checks. To run only the evaluator integration:

```sh
cd services/errotel
go test -race -tags=integration ./tests/integration -run TestExportedAlert -count=1 -v
```

## CI and releases

The workflow follows the neighboring `gopherex/iam` and `gopherex/ws-proto`
projects: `master` pushes and pull requests run CI; an annotated `vX.Y.Z` tag
runs the same CI before publication. `make release` offers a version selection,
updates both packages and the UI's workspace dependencies, validates locally,
creates a `chore(release)` commit when needed, then atomically pushes master and
the tag. It requires a clean working tree and refuses existing or older versions.
Tags and published package versions are immutable; there is no force-republish.

```sh
yarn install --frozen-lockfile
make ci                         # generation drift, lint, types, race/unit, tarball consumers
make ci-vm                      # Vite dev smoke + Docker/Testcontainers + browser round-trip
make release-plan VERSION=0.1.0 # inspect only; no local/remote mutations
make release                    # interactive version and confirmation
make release VERSION=0.1.0       # explicit stable version, with confirmation
make release-artifacts VERSION=0.1.0 # local archives; requires matching package versions
```

GitHub Actions publishes:

- `ghcr.io/gopherex/errotel:X.Y.Z` for Linux amd64/arm64, containing the Go server
  and built UI. `latest` advances after image and both package jobs succeed.
- `@gopherex/errotel-sdk` and `@gopherex/errotel-api` at the same version to
  `https://npm.pkg.github.com`. The private UI workspace is shipped with the
  server, not published as an npm package.
- A GitHub Release with SDK/API tarballs, Linux/macOS amd64/arm64 server archives,
  built UI, example external config, OpenAPI, agent guide, licenses and SHA256SUMS.

Publication uses the repository's automatic `GITHUB_TOKEN` with narrowly scoped
`packages: write` / `contents: write` permissions; no npmjs token or long-lived
publish PAT is required. Actions and organization policy must allow package
creation. Package visibility and access are controlled in GitHub package settings;
check these after first publication, especially for anonymous container pulls.
The `repository` metadata associates both npm packages with this repository.
GitHub Packages installation requires a read-authorized token, including for
public npm packages. Put registry configuration in your consuming project's
`.npmrc`, with the token supplied through its environment:

```ini
@gopherex:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
yarn add @gopherex/errotel-sdk @opentelemetry/api
# Optional read API client:
yarn add @gopherex/errotel-api
```

The package names replace the development-only `@errotel/sdk` / `@errotel/api`
names to use the repository owner's GitHub Packages namespace. Workspace installs
in this checkout need no registry token. Package tarballs include only compiled
code, types, README and MIT license, and are tested from an isolated consumer
before publishing. Generated API imports support Node ESM and browser bundlers.

For a server archive, verify `sha256sum --ignore-missing -c SHA256SUMS`, extract the archive and
start from its directory. Set `APP_DEBUG_API_TOKEN` in the process environment,
edit `config.yaml` for your own VM endpoints and run `./errotel -config config.yaml`.
Its `ui_dir: ./ui` is relative to the current working directory. The image instead
uses `/etc/errotel/config.yaml` with `ui_dir: /opt/errotel/ui`; mount this config
and pass the token at runtime. No secrets are part of the frontend build.

GitHub/npm/container publication is not one atomic transaction. On a partial
release, inspect the failed job and use GitHub's **Re-run failed jobs**; successful
package jobs must not republish their immutable version. A failed atomic Git push
leaves the local release commit/tag intact: fix the cause and retry the same
`git push --atomic origin HEAD:refs/heads/master refs/tags/vX.Y.Z` after confirming
the remote refs. Do not recreate published tags. Cross-platform archives are
cross-compiled; native runtime smoke testing runs on Linux amd64.

The UI dev server resolves SDK/API workspace sources directly; `cd app && yarn dev`
needs only `yarn install --frozen-lockfile` at the workspace root, not a previous
package build. Production builds and published consumers use package exports.
