# ErrOtel

ErrOtel records browser exceptions with application state and history, then makes them
available for investigation in a web UI or through an HTTP API. It uses your existing
VictoriaLogs and VictoriaTraces. The Go service serves the built UI itself.

```text
Recording: browser → @gopherex/errotel-sdk → your OTLP pipeline → VictoriaLogs
Reading:   UI or agent → ErrOtel read API → VictoriaLogs / VictoriaTraces
```

The SDK does not know the ErrOtel server address. The server has no ingest endpoint,
database, persistent cache or background index. Restarting it does not lose occurrences:
the same link reads the data again from VM, while VM retention determines availability.
VictoriaTraces is optional. VictoriaMetrics can be configured, but investigation does
not automatically query metrics. Service health/metrics described below monitor ErrOtel itself.

## Try it locally

Requires Docker Compose. The stack uses pinned images and synthetic data, independently
of production telemetry:

```sh
git clone https://github.com/gopherex/errotel.git
cd errotel
docker compose up --build -d
```

Open **http://127.0.0.1:18080** and enter `local-synthetic-only`. This token is a local
example; production must supply its own secret. Open **Test errors** in the header:
the modal uses the real browser SDK and OTLP protobuf exporters, sends state/history
and a three-span trace, stays open for repeated sends and reports exporter results.
Open an occurrence and its **Trace** tab to investigate it. Newly written traces may
take roughly 20 seconds to become searchable in the pinned VictoriaTraces version.

| Local component | Address |
| --- | --- |
| UI and read API | `http://127.0.0.1:18080` |
| Probes and Prometheus scrape | `http://127.0.0.1:18081/healthz/readiness`, `/metrics` |
| Collector OTLP/HTTP | `http://127.0.0.1:14318/v1/logs`, `/v1/traces`, `/v1/metrics` |
| VictoriaLogs | `http://127.0.0.1:19428` |
| VictoriaTraces | `http://127.0.0.1:20428` |
| VictoriaMetrics | `http://127.0.0.1:18428` |

All published ports bind to loopback. `docker compose down` stops the stack and retains
VM volumes. ErrOtel needs no volume for application data. The local Collector also
receives the read service's own logs, traces and metrics; browser data remains a separate pipeline producer.

## Install the service

Use a version from [GitHub Releases](https://github.com/gopherex/errotel/releases).
The image contains the server and UI for Linux amd64/arm64. Native archives also cover
macOS amd64/arm64. Native runtime tests run on Linux amd64; other targets are cross-compiled.

For Docker, copy [config.example.yaml](config.example.yaml), set `listen: 0.0.0.0:8080`,
`service.http.probe_addr: 0.0.0.0:8081`, `ui_dir: /opt/errotel/ui` and your VM endpoints.
Supply the API token through the process environment, not the YAML or frontend build:

```sh
# Set ERROTEL_VERSION to your release tag and APP_DEBUG_API_TOKEN through your secret mechanism.
docker run --rm --name errotel \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:8081:8081 \
  --env APP_DEBUG_API_TOKEN \
  --mount type=bind,src="$PWD/config.yaml",dst=/etc/errotel/config.yaml,readonly \
  ghcr.io/gopherex/errotel:"$ERROTEL_VERSION"
```

Choose the release tag you intend to deploy; an existing older image does not acquire
features from the current source tree. Pass upstream credentials and `OTEL_*` variables
with additional `--env` entries when needed. GitHub package visibility controls whether
registry login is required.

For a native archive, download the matching `errotel_X.Y.Z_OS_ARCH.tar.gz` and
`SHA256SUMS`, verify it, extract it, then run from that directory:

```sh
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf errotel_X.Y.Z_linux_amd64.tar.gz
# Edit config.yaml for your VM endpoints; ui_dir is already ./ui.
./errotel -version
./errotel -config config.yaml
```

The binary takes `-config` (YAML/JSON/TOML) and `-version` (JSON build metadata, no
configuration or token required). Relative `ui_dir` resolves from the working directory.
For systemd, use an unprivileged user, the extracted directory as `WorkingDirectory`,
`ExecStart=/opt/errotel/errotel -config /etc/errotel/config.yaml`, an `EnvironmentFile`
readable only by the service administrator, and `Restart=on-failure`.

For Kubernetes, run the same image/config with the token in a Secret, expose 8080 to
the ingress and keep 8081 internal. Each replica has its own bounded cache and instance ID;
there is no leader election, shared volume, session store or Redis. Configure:

```yaml
ports:
  - {name: http, containerPort: 8080}
  - {name: management, containerPort: 8081}
livenessProbe:
  httpGet: {path: /healthz/liveness, port: management}
readinessProbe:
  httpGet: {path: /healthz/readiness, port: management}
  timeoutSeconds: 3
terminationGracePeriodSeconds: 40
```

The management address must bind `0.0.0.0` inside the pod. The grace period should
cover HTTP drain plus telemetry shutdown. No Kubernetes components are required for
standalone Docker or binary deployments.

## Configure the read API

[config.example.yaml](config.example.yaml) lists defaults and external settings.
`structconf` also accepts nested environment overrides such as `ERROTEL_LOGS_BASE_URL`,
`ERROTEL_SERVICE_LOGGER_LEVEL` and `ERROTEL_SERVICE_HTTP_PROBE_ADDR`.

| Setting | Meaning |
| --- | --- |
| `listen`, `ui_dir` | API listener and built UI directory |
| `token_env` | Environment variable containing the fixed read token; default `APP_DEBUG_API_TOKEN` |
| `source` | Stable source identity used in responses and locators |
| `logs.base_url` | VictoriaLogs read root, including a configured proxy/tenant prefix |
| `traces.base_url` | Optional VictoriaTraces root or full `/select/jaeger` base |
| `metrics.base_url` | Optional VictoriaMetrics read root; not the service's telemetry exporter |
| `*.headers_env` | Name of an environment variable holding a JSON object of upstream headers |
| `fields` | Logical-to-stored field mapping for a pipeline that renamed attributes |
| `trusted_proxies` | CIDRs allowed to supply forwarded peer addresses |
| `queries` | Absolute range, page, row, concurrency and timeout budgets |
| `cache` | TTLs, total memory budget and maximum cache entry size |

For example, set `VM_LOGS_READ_HEADERS_JSON` to `{"Authorization":"Bearer ..."}`
in your secret manager and reference it from `logs.headers_env`. These credentials
are independent of the browser's OTLP credentials and ErrOtel's read token.

Default mappings include Body → `_msg`, time → `_time`, trace/span → `trace_id` /
`span_id`, `service.name`, `deployment.environment.name`, `service.version`,
`exception.*` and `app.debug.*`. Override only renamed fields. JSON state is decoded
from the envelope; dotted stored fields are never reconstructed into user state or
advertised as the original Resource.

All `/api/` operations authenticate before reading data or cache. Secrets are hashed
and compared in constant time. Failed guesses are rate-limited per peer using a bounded
table; forwarded IP is trusted only from configured proxies. Static UI and embedded
`/openapi.json` and `/agent.md` can be public. The UI keeps its token only in tab memory.

Cache entries have TTL and byte budgets. Oversized responses are returned whole without
caching. Upstream failures, timeouts and partial reads do not become cached empty successes.
Keys bind source/configuration/mapping revision, normalized query and absolute range.
The `X-Errotel-Cache`, `X-Errotel-Fetched-At` and cache-age headers expose freshness.

## Observe and operate ErrOtel

The service uses chi, xlog, xprobe and xshutdown, following the neighboring `gopherex/iam`
service conventions. Configuration and telemetry are runtime settings, not frontend variables.

```yaml
service:
  logger:
    level: info             # debug, info, warn, error
    format: json            # json or text
  http:
    probe_addr: 127.0.0.1:8081
    probe_timeout: 2s
    metrics_enabled: true
    read_timeout: 15s
    write_timeout: 30s
    shutdown_timeout: 15s
```

`/healthz/liveness` checks process lifecycle. `/healthz/readiness` performs a bounded,
authenticated read against the configured VictoriaLogs query endpoint, with an empty
epoch range and only the time field projected. It works when no errors exist and checks
read credentials, proxy path and the NDJSON response. Failed, partial or timed-out reads
make readiness fail; recovery makes it pass again. VictoriaTraces/metrics are optional
and do not gate readiness. A failed trace read is still explicitly unavailable in the API.

The default management listener is separate from API traffic. An empty `probe_addr`, or
one equal to `listen`, mounts probes and metrics on the API listener. Management endpoints
have no Bearer authentication: restrict this port with host firewall/network policy and
keep it off public ingress. With `metrics_enabled: false`, `/metrics` is absent; OTLP
metric export can still run. Liveness/readiness responses use xprobe's JSON status.

SIGINT/SIGTERM withdraw readiness, stop accepting requests, drain HTTP connections and
then flush/shut down owned OTel providers. HTTP and telemetry each have the configured
shutdown budget. A timed-out HTTP drain closes remaining connections. No application
telemetry body, query, credential or user-controlled URL is logged by default, even at debug.
Request logs carry a generated `request_id`, trace/span IDs, route template, status and duration.
Successful request logs use debug; failures use warn/error. Build service/version/commit/time
and a per-process instance ID appear in service logs.

Own service telemetry uses **OTLP/HTTP protobuf** and standard exporter settings:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
# Optional: percent-encoded standard OTel header values from your secret manager.
# OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20...
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
export OTEL_TRACES_SAMPLER=parentbased_traceidratio
export OTEL_TRACES_SAMPLER_ARG=0.1
./errotel -config /etc/errotel/config.yaml
```

Without an endpoint, no signal is pushed to localhost. Per-signal `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
`...LOGS_ENDPOINT`, `...METRICS_ENDPOINT` use complete paths. Exporter headers, timeout,
compression and TLS settings follow the [official OTLP HTTP configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/).
`OTEL_TRACES_EXPORTER=none`, `OTEL_LOGS_EXPORTER=none` and `OTEL_METRICS_EXPORTER=none`
disable the respective push exporter. `OTEL_SDK_DISABLED=true` disables all signals,
including scrape. Build metadata identifies the service resource; extra resource attributes
come from `OTEL_RESOURCE_ATTRIBUTES`. The server continues incoming W3C trace context and
propagates it to read upstreams; it does not forward caller baggage.

Prometheus and OTLP are readers of the same meter provider. `/metrics` exposes:

- `http_server_request_duration_seconds` and `http_server_active_requests` by bounded
  method/route/status labels, including auth failures and cache hits;
- `errotel_upstream_request_duration_seconds` by adapter/outcome, including read/parse failures;
- `errotel_cache_requests_total` by hit/miss/cache bypass/query-budget rejection, plus cache size/entry gauges;
- Go runtime and host metrics, resource/build information and `errotel_telemetry_errors_total`.

Exporter diagnostics increment the error counter and emit one generic stderr warning,
without recursively exporting the failure or printing potentially secret URLs. Route labels
use `/api/v1/occurrences/{ref}`, not actual locators. A standard Prometheus/vmagent scrape job
can target `errotel:8081` with `metrics_path: /metrics`; Kubernetes may use ServiceMonitor or
VMServiceScrape. Scrape and OTLP names may differ: VM's native OTLP ingestion preserves dotted
names/labels unless configured to use Prometheus naming. See [VM's OTLP integration](https://docs.victoriametrics.com/victoriametrics/integrations/opentelemetry/).

## Add the browser SDK

Packages are published to GitHub Packages. In the consuming project's `.npmrc`:

```ini
@gopherex:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use a read-authorized GitHub token through `NODE_AUTH_TOKEN`, including for public npm
packages. Workspace development in this repository does not need a registry token.

```sh
yarn add @gopherex/errotel-sdk @opentelemetry/api
```

```ts
import { createOtlpClient } from '@gopherex/errotel-sdk/otlp'

const errors = createOtlpClient({
  url: 'https://collector.example/v1/logs',
  resource: { 'service.name': 'checkout-web', 'service.version': 'your-build-id' },
  captureUnhandled: true,
  history: { enabled: true, maxEntries: 100, maxAgeMs: 30_000 },
})
const unregister = errors.registerState('checkout', { read: () => checkoutState })
errors.addBreadcrumb('payment.started', { orderId: 'demo-123' })
errors.recordState('checkout')
try {
  await pay()
} catch (error) {
  errors.captureException(error, { state: { operation: 'pay' } })
}
// On application teardown:
unregister()
await errors.shutdown()
```

If the application already owns an OTel LoggerProvider, use `createClient({loggerProvider})`
instead. Core never replaces global providers or shuts down a borrowed provider. Importing
the package installs no handlers and sends nothing. State snapshots are materialized
immediately; history and inline state remain independent. One successful capture attempts
one LogRecord with the standard exception attributes and native trace/span fields.

Configure the collector's CORS for your application's origin and headers, and add its
origin to your application's CSP `connect-src`. Use TLS and OTLP credentials separately
from the read API token. The UI's test modal also requires its collector origin in server
`ui_connect_origins`; arbitrary URLs inside recorded telemetry are never loaded.

Capture/flush do not acknowledge durable VM storage. A normal OTel batch queue is in memory;
a tab/process crash, network failure, queue overflow or upstream rejection can lose data.
The owned client optionally supports an IndexedDB outbox with bounded bytes/count/TTL,
retries and an explicit account namespace. It survives a browser restart after the IDB
commit, preserves event IDs and does not store exporter credentials. Eviction, lost commits,
HTTP partial rejection and exactly-once delivery remain limitations. See the complete
[SDK API, lifecycle and outbox guide](docs/sdk.md).

## Investigate through the UI or an agent

Search, quick filter buttons and the draggable frequency histogram share one visible query
and Ctrl/Cmd+Z history. The selected error opens below the table or docks right. Stacktrace,
registered sources, inline state and history are independent; large JSON stays collapsed.
Trace and related logs load on demand. Auto query applies edits; the separate refresh timer
repeats reads. Browser notifications work while the tab exists. Details and limitations are
in the [UI and alerts guide](docs/ui.md) and [query language](docs/query-language.md).

For an agent, supply the service URL and read token separately. `/agent.md` explains discovery
and investigation; `/openapi.json` is the public contract. `POST /api/v1/investigate` accepts a
known `ref`, an `eventId` with absolute range, or a search selector for the latest matching
error. One response includes the exception/state/history, available trace and related logs,
with per-component warnings and freshness. It distinguishes missing evidence, ambiguous
matches, unavailable upstreams and time proximity; it does not claim a proven root cause.
See [HTTP API examples](docs/http-api.md). The optional `@gopherex/errotel-api` package provides
a generated client; Go server routing and validation are generated with ogen.

**Configure alert** exports evaluator and Alertmanager configuration for the current filter.
The operator applies it using standalone binaries, Docker or Kubernetes. ErrOtel does not
store rules, run a Telegram bot or manage Alertmanager. This works with an existing Prometheus
Alertmanager, including one deployed by the VM operator. [Alert configuration instructions](docs/ui.md#external-alerts-export-configuration).

## Develop, test and release

The Yarn workspaces are `packages/api`, `packages/sdk` and `app`. The independent Go module
is `services/errotel`; `examples/browser` is a runnable fixture. Node **22.23.1**, Yarn
**1.22.22**, Go **1.26.7**, Biome **2.4.16** and golangci-lint **2.11.3** are pinned.
Dependencies use lockfiles and published modules, with no required sibling checkouts.

```sh
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile
yarn dev                         # or: cd app && yarn dev; API proxy → :18080
yarn example                     # or: cd examples/browser && yarn dev
make build                       # built UI/packages and server with ldflags metadata
make generate                    # protocol artifacts, OpenAPI, ogen and TS client
make ci                          # drift, lint, typecheck, unit/race, tarball consumers
make ci-vm                       # real service VM test, Testcontainers and browser E2E
make test-service                # real service logs/traces/metrics; local VM required
make release                     # iam-style numbered menu and final confirmation
```

`yarn dev` uses workspace sources and does not need an earlier build. The production binary
serves the built UI; for a host build run it with `ERROTEL_UI_DIR="$PWD/app/dist"` and the external
config. `make build-server VERSION=... COMMIT=... BUILD_TIME=...` injects metadata; raw `go build`
uses explicit dev/unknown defaults. Release archives and Docker images embed the release
version, commit and UTC build time. CI tests the packaged binary's `-version` output.

Unit tests use fixtures, including a real protobuf exporter with a local test receiver.
They are distinct from `make test-service` (real VL/VT/VM) and browser E2E (browser SDK →
Collector → VM → API → UI → server restart). The latter require Docker and Chromium and
fail explicitly when unavailable. `make ci-vm` downloads Chromium without invoking a system package manager; Ubuntu CI passes `PLAYWRIGHT_INSTALL_FLAGS=--with-deps`. [Test, seed and release details](docs/development.md).

Pinned test infrastructure: VictoriaLogs **1.52.0**, VictoriaTraces **0.11.0**,
VictoriaMetrics/vmalert **1.151.0**, Collector **0.147.0**, Alertmanager **0.32.1**.
Browser OTel API **1.9.1**, logs/protobuf exporter **0.222.0**, resource/trace SDK **2.11.0**.
Service OTel trace/metric SDK **1.46.0**, Prometheus exporter **0.68.0**, host/runtime **0.70.0**;
logs SDK/exporter **0.14.0** matches the published `xtrace/xlog` bridge **1.0.0**. Providers
are assembled directly to avoid the older resource schema hard-coded by `xtrace/sdk`.

## Limits and licenses

Original stacks and payloads are rendered as text/JSON, never HTML. Unknown/corrupt envelopes
remain visible with warnings; invalid state is not presented as trustworthy. Retry event IDs
are deduplicated; conflicting bodies produce a warning. There is no symbolication, replay,
issue workflow, arbitrary query editor, application database or multi-user authorization.

The pinned VictoriaLogs backend has a **2 MiB stored-record limit** including fields.
The SDK does not truncate, chunk or upload state separately; a successful HTTP response does
not prove that an oversized record was stored. Real E2E covers 1 MiB payloads, while larger
JSON/NDJSON handling is tested separately. [Official VL limit](https://docs.victoriametrics.com/victorialogs/faq/#what-length-a-log-record-is-expected-to-have).

ErrOtel is MIT licensed. UI components use Mantine, TanStack Table, CodeMirror, uPlot and
selected MIT HyperDX JSON/waterfall components. Vendored source, commit, changes and copyrights
are recorded in [HyperDX NOTICE](app/src/vendor/hyperdx/NOTICE.md) and distributed at
`/third-party-notices.txt`. No complete observability application is embedded.
