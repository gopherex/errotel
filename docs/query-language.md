# Investigation query language

The text query is the shared representation of filters and time. The frontend parses
it to an allowlisted filter tree; the server validates that tree independently and
compiles it to LogsQL using its configured field mapping. Raw query text, upstream
URLs and credentials are never sent as executable upstream queries.

## Syntax

```text
time:[now-15m TO now} AND service:"checkout" AND (type:"TypeError" OR type:"RangeError")
time:[2026-09-10T10:00:00Z TO 2026-09-10T11:00:00Z} AND NOT environment:"dev"
time:[now-1h TO now} AND "payment failed" AND trace_id:*
time:[now-24h TO now} AND service:web*
```

There must be exactly one global `time:[from TO to}` joined with AND. The end is
exclusive. Time inside OR or NOT is rejected. `now` and `now-Nms/s/m/h/d` are
resolved once per execution; search and histogram receive identical absolute
nanosecond ranges. Refresh resolves relative time again. UTC ISO timestamps ending
in Z preserve up to nine fractional digits. The default maximum range is 31 days;
the server's configured limit is authoritative.

AND, OR, NOT and parentheses are supported, including `type:(A OR B)`. Adjacent
terms mean AND. Mixed AND/OR requires explicit parentheses, avoiding reliance on
Lucene's precedence. This is a documented subset parsed with @hyperdx/lucene 3.1.1,
not a promise of compatibility with every Lucene, SQL or LogsQL query.

| Field | Matching |
| --- | --- |
| service | Exact service name |
| environment | Exact environment |
| type | Exact exception type |
| message, unqualified text | Case-insensitive literal substring of exception message |
| message_exact | Exact exception message |
| release | Exact service version |
| trace_id, runtime_id, group_key | Exact indexed identifier |
| origin | `sdk` or `otel-log` |

Double-quoted values use JSON escapes and preserve case, empty strings, Unicode,
dotted keys, quotes and backslashes. Quoted `"*"` is a literal asterisk. An unquoted
trailing `*` is a case-sensitive prefix match. `field:*` means a **nonempty stored
field**: VictoriaLogs does not distinguish missing fields from empty field strings.
Consequently `field:""` also matches absent stored values. This storage limitation
does not apply to JSON state inside a valid envelope.

Regular expressions, fuzzy search, boosts, arbitrary fields, SQL/pipelines and
snapshot-state predicates are rejected. Limits: 16 KiB query text (UTF-16 editor
units), 2048 UTF-8 bytes per value, 64 filter-tree nodes, depth 12. Search reads
index fields only; it never silently loads all state bodies for filtering.

## Visual editing and history

Adding a filter ANDs it with the existing expression, retaining OR groups. Include
and Exclude on table fields and the filter popover use the same operation. Removing
a chip deletes that expression node and simplifies its parent. Parentheses and
operators remain visible both as text and as grouped controls.

A time preset replaces the global range. Dragging the histogram replaces it with
an absolute UTC range, leaving the other filters intact. The selection has millisecond
pointer precision and is clamped to the original nanosecond boundaries. The chart
then reaggregates for the selected interval; Ctrl+Z returns to the previous range.

CodeMirror owns a single in-memory undo history. Each button/time action is one
isolated transaction; normal typing uses editor grouping. Ctrl/Cmd+Z, redo shortcuts
and toolbar buttons operate on this same history. Other text inputs keep their
native undo. Invalid drafts do not execute and retain the previous results with an
explicit warning. Valid queries execute after a short debounce or Run query. A failed
new query displays its error and does not relabel old data as its result.

Queries and selected locators are shareable in the hash URL. Tokens and undo history
are not persisted. Docking/resizing/fullscreen preserve the selected occurrence and
expanded JSON. This version's query undo does not undo pane layout or JSON expansion.

## Compatible read API extension

The SDK envelope and original `docs/protocol.ts`/JSON Schema remain unchanged.
`openapi/openapi.json` is the source for the extended generated read client/server:

- `OccurrenceSearch.filter` optionally carries a recursive `SearchFilter` with
  `and`, `or`, `not`, `eq`, `contains`, `icontains`, `prefix`, `exists`. Leaves have
  allowlisted `field` and, except exists, `value`; groups have `children`.
- Existing flat search filters remain supported and are ANDed with the tree.
- `POST /api/v1/occurrences/histogram` accepts the same filters and absolute range,
  without a pagination cursor. It returns `range`, `intervalMs`, `buckets`, `total`
  and the usual response `meta`. `features.queryFilters` and `features.histogram`
  advertise support. All requests, including cache hits, require the Bearer token.

The histogram counts the full matching range in VictoriaLogs, not the loaded table
page. SDK event IDs are deduplicated within that range before time bucketing; an
ordinary OTEL exception counts as its stored log occurrence. Conflicting SDK bodies
are diagnosed on detail, not by fetching every payload for the chart. As with search,
the histogram describes the current VM read; arrivals/expiry between requests can
change results. Partial responses are labeled, unknown empty buckets are not drawn
as confirmed zero, and failures are not cached as empty success.

Search merges by descending timestamp, retaining each upstream branch's natural
sort order for ties; SDK entries precede vanilla entries with the same time. This
keeps top-k pagination consistent with [VictoriaLogs natural sorting](https://docs.victoriametrics.com/victorialogs/logsql/#sort-pipe).
