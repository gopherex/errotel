# HTTP API and agent integration

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

