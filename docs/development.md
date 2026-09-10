# Development, tests and releases

## Checks

```sh
yarn test                       # SDK, query semantics and contract fixtures
make test-go                    # Go unit tests with race detector
make test-service               # own service → real VL/VT/VM + failure/recovery and shutdown
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
the tag. It requires a clean working tree. The menu matches `gopherex/iam`:
`1` bump version, `2` recreate last tag on HEAD (force), `3` cancel. Bump then
asks `1` major, `2` minor, `3` patch. With no tags the starting version is 0.0.0:
choose `1`, then `2` for the first 0.1.0 release. Final confirmation is `yes`.
Explicit-version bump releases refuse existing or older versions; recreation is
available through the separate interactive action and requires package versions
to match the tag. Like the neighboring projects, v2+ needs a Go module path change.

Recreation deletes and replaces the existing tag after confirmation. For npm
republishing, configure the optional `PACKAGES_TOKEN` secret with package read,
write and delete permissions, as in `gopherex/iam`. This workflow uses that PAT
for existing-version deletion and GITHUB_TOKEN for publication. Without it, first publication works,
but publishing an already existing version fails. The workflow replaces that
version when the PAT is configured and updates existing GitHub Release assets.
This development operation changes an already distributed version; use a bump
for normal production releases.

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
publish PAT is required for new versions. Actions and organization policy must allow package
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
package jobs need not be rerun; republishing them requires PACKAGES_TOKEN. A failed atomic Git push
leaves the local release commit/tag intact: fix the cause and retry the same
`git push --atomic origin HEAD:refs/heads/master refs/tags/vX.Y.Z` after confirming
the remote refs. Use the explicit recreate action only when you intend to replace a version. Cross-platform archives are
cross-compiled; native runtime smoke testing runs on Linux amd64.

The UI dev server resolves SDK/API workspace sources directly; `cd app && yarn dev`
needs only `yarn install --frozen-lockfile` at the workspace root, not a previous
package build. Production builds and published consumers use package exports.

The root `yarn typecheck` builds API/SDK declarations before checking the UI,
so `make ci` and `yarn run check` also work in a fresh checkout without `dist`.

Build metadata is injected by `make build-server`, release archives and the Docker release job. `errotel -version` prints service, version, commit and UTC build time. Local raw `go build` uses dev/unknown defaults. The service telemetry test starts two ephemeral listeners and exports real protobuf directly to local VM; its local fault proxy tests outage recovery. Unit tests use a protobuf test receiver and are not VM round-trips.
