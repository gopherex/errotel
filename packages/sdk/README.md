# @gopherex/errotel-sdk

Browser exception capture with immutable diagnostic state and history through
OpenTelemetry logs. Importing the package does not install listeners or send data.

Install from GitHub Packages using Yarn; configure the `@gopherex` registry and a
read token as described in the [project README](https://github.com/gopherex/errotel#readme).

```ts
import { createOtlpClient } from '@gopherex/errotel-sdk/otlp'
```

The core entry uses an existing LoggerProvider; `/otlp` offers an owned provider
and OTLP/HTTP protobuf exporter. `/protocol` is a type-only entry point.
The SDK sends to your OTLP pipeline, independently of the ErrOtel read server.
See the project README for initialization, state sources, lifecycle, optional
IndexedDB persistence, CORS/CSP and delivery limitations.


`/browser` provides opt-in fetch/XHR/navigation breadcrumbs and a React error-handler
helper without a React runtime dependency. Core options include `sanitize`,
`filter`, `rateLimit`, and bounded automatic exception causes. `client.stats()` and
`client.outbox.stats()` expose capture and delivery diagnostics without user data.
See the [SDK guide](https://github.com/gopherex/errotel/blob/master/docs/sdk.md) for
policies, wire compatibility, trace context, lifecycle and browser tests.
