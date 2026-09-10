# @gopherex/errotel-api

Generated TypeScript client and types for the ErrOtel HTTP read API. Works in
browser bundlers and Node ESM, without importing browser instrumentation.

```ts
import { createClient, getCapabilities } from '@gopherex/errotel-api'
const client = createClient({
  baseUrl: 'https://your-errotel.example',
  headers: { Authorization: `Bearer ${token}` },
})
const { data } = await getCapabilities({ client, throwOnError: true })
```

Keep tokens outside bundles, URLs and browser storage. The running service serves
`/agent.md` and `/openapi.json`. See the [project README](https://github.com/gopherex/errotel#readme)
for GitHub Packages installation and the investigation API.
