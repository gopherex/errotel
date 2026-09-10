# Investigation UI and alert configuration

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

Query syntax and visual behavior are specified in [docs/query-language.md](../docs/query-language.md).
`Ctrl/Cmd+Z` (including Russian keyboard layout) undoes text edits, filter actions and histogram/time selections in their
original order. `Ctrl/Cmd+Shift+Z` and `Ctrl+Y` redo. Toolbar buttons expose the same
history. Other inputs keep native text undo. `Ctrl/Cmd+Enter` runs the query;
`Escape` outside input/dialog controls closes the occurrence. Query history is local
to the mounted search screen; reload does not persist the undo stack.

Presentation uses Mantine 9.6.1, TanStack Table 8.21.3, CodeMirror 6, uPlot 1.6.32
and react-resizable-panels 4.12.4. HyperDX's MIT HyperJson and TimelineChart are
vendored at commit `fda038d630ef66963d90399648dc7d107c0ca69f`, with relative import,
formatting and safe string-rendering adaptations. Sources, changes and copyright
are in [NOTICE](../app/src/vendor/hyperdx/NOTICE.md); distributed notices are served at
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

