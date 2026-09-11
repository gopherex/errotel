# Changelog

## 1.0.3

- Add client-local `snapshot(options)` to the SDK core and owned OTLP client for
  application-delivered bug reports, with `DebugSnapshotV1` in the type-only
  `/protocol` entry. Snapshot reads do not emit, write to the outbox, run filters,
  consume capture budget or advance the runtime event sequence.
- Reuse capture state serialization, sanitization, retention and correlation;
  return detached JSON with history/source byte-budget diagnostics and a separate
  `stats().snapshots` counter. Exception wire version and schema remain unchanged.
- Cover parity, guards, privacy, byte budgets, detached data and outbox isolation
  in unit, published-package consumer and browser tests.
