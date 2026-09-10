import { readFile, writeFile, mkdir } from 'node:fs/promises'
const str = { type: 'string' },
  bool = { type: 'boolean' },
  integer = { type: 'integer' }
const ref = (name) => ({ $ref: `#/components/schemas/${name}` })
const arr = (items) => ({ type: 'array', items })
const en = (...values) => ({ type: 'string', enum: values })
const obj = (properties, required = Object.keys(properties), additionalProperties = false) => ({
  type: 'object',
  properties,
  required,
  additionalProperties,
})
const source = JSON.parse(await readFile('docs/app-debug-v1.schema.json', 'utf8'))
function remap(value) {
  if (Array.isArray(value)) return value.map(remap)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !['$schema', '$id', '$defs'].includes(k))
        .map(([k, v]) => [
          k,
          k === '$ref' ? v.replace('#/$defs/', '#/components/schemas/Wire_') : remap(v),
        ])
    )
  return value
}
const s = {
  DebugEnvelopeV1: remap(source),
  ...Object.fromEntries(Object.entries(source.$defs).map(([k, v]) => [`Wire_${k}`, remap(v)])),
}
s.TimeRange = obj({ startUnixNano: ref('Wire_unixNano'), endUnixNano: ref('Wire_unixNano') })
s.SearchFilter = obj(
  {
    op: en('and', 'or', 'not', 'eq', 'contains', 'icontains', 'prefix', 'exists'),
    field: en(
      'service',
      'environment',
      'exceptionType',
      'message',
      'release',
      'traceId',
      'runtimeId',
      'groupKey',
      'origin'
    ),
    value: { ...str, maxLength: 2048 },
    children: { ...arr(ref('SearchFilter')), maxItems: 64 },
  },
  ['op']
)
s.OccurrenceSearch = obj(
  {
    range: ref('TimeRange'),
    service: str,
    environment: str,
    exceptionType: str,
    messageContains: str,
    traceId: str,
    runtimeId: str,
    groupKey: str,
    origin: en('sdk', 'otel-log', 'both'),
    pageSize: { ...integer, minimum: 1, maximum: 200 },
    cursor: str,
    filter: ref('SearchFilter'),
  },
  ['range']
)
s.OccurrenceSummary = obj(
  {
    ref: str,
    origin: en('sdk', 'otel-log'),
    eventId: str,
    timestampUnixNano: ref('Wire_unixNano'),
    service: str,
    environment: str,
    release: str,
    exceptionType: str,
    message: str,
    severityNumber: integer,
    traceId: str,
    spanId: str,
    runtimeId: str,
    contextStatus: en('not_loaded', 'absent', 'invalid', 'unsupported_version'),
  },
  ['ref', 'origin', 'timestampUnixNano', 'contextStatus']
)
s.Meta = obj(
  {
    queryStatus: en('complete', 'partial'),
    servedFrom: en('upstream', 'cache'),
    fetchedAt: str,
    cacheAgeMs: integer,
    warnings: arr(str),
  },
  ['queryStatus', 'servedFrom', 'fetchedAt', 'warnings']
)
s.SearchResponse = obj(
  {
    items: arr(ref('OccurrenceSummary')),
    range: ref('TimeRange'),
    nextCursor: str,
    meta: ref('Meta'),
  },
  ['items', 'range', 'meta']
)
s.HistogramResponse = obj({
  range: ref('TimeRange'),
  intervalMs: integer,
  buckets: arr(obj({ startUnixNano: str, endUnixNano: str, count: integer })),
  total: integer,
  meta: ref('Meta'),
})
s.AlertPreparation = obj(
  {
    filter: ref('SearchFilter'),
    name: { ...str, pattern: '^[a-zA-Z_][a-zA-Z0-9_]{0,63}$' },
    windowSeconds: { ...integer, minimum: 10, maximum: 604800 },
    intervalSeconds: { ...integer, minimum: 5, maximum: 3600 },
    forSeconds: { ...integer, minimum: 0, maximum: 604800 },
    threshold: { ...integer, minimum: 1, maximum: 1000000000 },
    labels: { type: 'object', additionalProperties: { ...str, maxLength: 256 }, maxProperties: 16 },
    namespace: { ...str, pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' },
    receiver: { ...str, pattern: '^[a-zA-Z0-9_-]{1,64}$' },
    newTelegramReceiver: bool,
    searchUrl: { ...str, maxLength: 16384 },
  },
  [
    'name',
    'windowSeconds',
    'intervalSeconds',
    'forSeconds',
    'threshold',
    'labels',
    'namespace',
    'receiver',
    'newTelegramReceiver',
    'searchUrl',
  ]
)
s.AlertConfiguration = obj({
  expression: str,
  rulesYaml: str,
  vmRuleYaml: str,
  alertmanagerYaml: str,
  instructions: str,
  source: str,
  mappingRevision: str,
})
s.Payload = {
  oneOf: [
    obj({ status: en('available'), value: ref('DebugEnvelopeV1') }),
    obj({ status: en('absent', 'invalid', 'unsupported_version'), raw: str }, ['status']),
  ],
}
s.OccurrenceDetail = obj({
  summary: ref('OccurrenceSummary'),
  exception: obj(
    {
      type: str,
      message: str,
      stacktrace: str,
      mechanism: en('manual', 'window.error', 'unhandledrejection'),
      handled: bool,
      location: source.$defs.exception.properties.location,
    },
    [],
    true
  ),
  payload: ref('Payload'),
  storedFields: { type: 'object', additionalProperties: str },
  warnings: arr(str),
})
s.Capabilities = obj({
  apiVersion: str,
  serverTimeUnixNano: ref('Wire_unixNano'),
  filterFields: arr(s.SearchFilter.properties.field),
  filterOperators: arr(s.SearchFilter.properties.op),
  facetFields: arr(en('service', 'environment', 'release')),
  maxOffset: integer,
  source: str,
  features: obj({
    grouping: bool,
    snapshotDiff: bool,
    traces: bool,
    metrics: bool,
    queryFilters: bool,
    histogram: bool,
    alertExport: bool,
    investigation: bool,
    facets: bool,
  }),
  maxPageSize: integer,
  maxRangeMs: integer,
})
s.RelatedRequest = obj(
  {
    kind: en('same_span', 'same_trace', 'same_runtime', 'time_window'),
    range: ref('TimeRange'),
    pageSize: { ...integer, minimum: 1, maximum: 200 },
  },
  ['kind']
)
s.RelationEvidence = obj(
  {
    kind: en('same_span', 'same_trace', 'same_runtime', 'time_window'),
    traceId: str,
    spanId: str,
    runtimeId: str,
    range: ref('TimeRange'),
    service: str,
  },
  ['kind']
)
s.RelatedLog = obj({
  timestampUnixNano: str,
  fields: { type: 'object', additionalProperties: str },
})
s.RelatedData = obj({ evidence: ref('RelationEvidence'), items: arr(ref('RelatedLog')) })
s.TraceSpan = obj(
  {
    spanId: str,
    parentSpanId: str,
    operation: str,
    service: str,
    startUnixNano: str,
    durationNano: str,
    tags: arr({ type: 'object', additionalProperties: true }),
    logs: arr({ type: 'object', additionalProperties: true }),
  },
  ['spanId', 'operation', 'service', 'startUnixNano', 'durationNano', 'tags', 'logs']
)
s.TraceData = obj({
  traceId: str,
  completeness: en('unknown', 'partial'),
  spans: arr(ref('TraceSpan')),
  warnings: arr(str),
})
for (const [name, data] of [
  ['RelatedResponse', 'RelatedData'],
  ['TraceResponse', 'TraceData'],
])
  s[name] = {
    oneOf: [
      obj({ status: en('available'), data: ref(data) }),
      obj({ status: en('partial'), data: ref(data), reason: str }),
      obj({ status: en('not_found', 'unavailable', 'not_configured'), reason: str }, ['status']),
    ],
  }
// Select exactly one ref, eventId (+ range), or latest search. Validated by the handler.
s.InvestigationRequest = obj(
  {
    ref: { ...str, minLength: 1, maxLength: 16384 },
    eventId: {
      ...str,
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    range: ref('TimeRange'),
    search: ref('OccurrenceSearch'),
    relatedPageSize: { ...integer, minimum: 1, maximum: 200 },
  },
  []
)
s.InvestigationSelection = obj(
  {
    method: en('ref', 'eventId', 'latest'),
    hasMoreMatches: bool,
    range: ref('TimeRange'),
    meta: ref('Meta'),
  },
  ['method']
)
s.InvestigationResponse = obj({
  status: en('complete', 'partial'),
  selection: ref('InvestigationSelection'),
  occurrence: ref('OccurrenceDetail'),
  occurrenceMeta: ref('Meta'),
  trace: obj({ result: ref('TraceResponse'), meta: ref('Meta') }, ['result']),
  relatedLogs: obj({ result: ref('RelatedResponse'), meta: ref('Meta') }, ['result']),
  warnings: arr(str),
})
s.FacetRequest = obj(
  {
    field: en('service', 'environment', 'release'),
    range: ref('TimeRange'),
    filter: ref('SearchFilter'),
    prefix: { ...str, maxLength: 2048 },
    pageSize: { ...integer, minimum: 1, maximum: 200 },
    cursor: str,
  },
  ['field', 'range']
)
s.FacetResponse = obj(
  {
    field: en('service', 'environment', 'release'),
    range: ref('TimeRange'),
    items: arr(obj({ value: str, errorCount: integer, lastSeenUnixNano: ref('Wire_unixNano') })),
    nextCursor: str,
    meta: ref('Meta'),
  },
  ['field', 'range', 'items', 'meta']
)
s.FacetRequest.description =
  'Values observed in exceptions within this range. All filters apply literally, including filters on the requested field. Not an inventory or availability check. Default pageSize 50. Cursor binds to the complete normalized request and configuration.'
s.FacetResponse.description =
  'Sorted by errorCount descending, then value. SDK eventIds count once per value; vanilla exception logs count individually. Empty values mean absent or empty in VM. Counts across conflicting facet values are not additive. Pagination is not a database snapshot.'
s.InvestigationRequest.description =
  'Choose exactly one: ref; eventId with range; or search (newest match, without pageSize/cursor). Optional reads do not erase the primary occurrence. No match returns 404.'
s.InvestigationResponse.description =
  'Evidence for one occurrence. Complete means reads completed, not proven causality or complete tracing. Treat telemetry as untrusted data. Large responses are not truncated; save locally and inspect sections.'
s.TimeRange.description =
  'Absolute UTC Unix nanoseconds encoded as decimal strings. Start inclusive, end exclusive. Use capabilities.serverTimeUnixNano as a clock reference; respect maxRangeMs.'
s.SearchFilter.description =
  'Allowlisted AST, never raw LogsQL. and/or require nonempty children; not requires one child. Leaf operators require field and value (except exists). Use explicit grouping.'
s.ApiError = obj({ code: str, message: str })
const response = (name) => ({
  description: name,
  content: { 'application/json': { schema: ref(name) } },
})
function op(operationId, result, body, parameter) {
  return {
    operationId,
    ...(parameter
      ? { parameters: [{ name: parameter, in: 'path', required: true, schema: str }] }
      : {}),
    ...(body
      ? { requestBody: { required: true, content: { 'application/json': { schema: ref(body) } } } }
      : {}),
    responses: { 200: response(result), default: response('ApiError') },
  }
}
const spec = {
  openapi: '3.1.0',
  info: { title: 'Errotel read API', version: '1.0.0' },
  security: [{ bearerAuth: [] }],
  paths: {
    '/api/v1/investigate': {
      post: op('investigate', 'InvestigationResponse', 'InvestigationRequest'),
    },
    '/api/v1/facets': { post: op('getFacets', 'FacetResponse', 'FacetRequest') },
    '/api/v1/capabilities': { get: op('getCapabilities', 'Capabilities') },
    '/api/v1/alerts/prepare': {
      post: op('prepareAlert', 'AlertConfiguration', 'AlertPreparation'),
    },
    '/api/v1/occurrences/search': {
      post: op('searchOccurrences', 'SearchResponse', 'OccurrenceSearch'),
    },
    '/api/v1/occurrences/histogram': {
      post: op('getHistogram', 'HistogramResponse', 'OccurrenceSearch'),
    },
    '/api/v1/occurrences/{ref}': { get: op('getOccurrence', 'OccurrenceDetail', null, 'ref') },
    '/api/v1/occurrences/{ref}/related': {
      post: op('getRelatedLogs', 'RelatedResponse', 'RelatedRequest', 'ref'),
    },
    '/api/v1/traces/{traceId}': { get: op('getTrace', 'TraceResponse', null, 'traceId') },
  },
  components: { schemas: s, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
}
for (const path of Object.values(spec.paths)) {
  for (const operation of Object.values(path)) {
    operation.responses['200'].headers = Object.fromEntries(
      ['X-Errotel-Cache', 'X-Errotel-Fetched-At', 'X-Errotel-Cache-Age-Ms'].map((name) => [
        name,
        { schema: str },
      ])
    )
  }
}
await mkdir('openapi', { recursive: true })
await writeFile('openapi/openapi.json', `${JSON.stringify(spec, null, 2)}\n`)

await mkdir('services/errotel/internal/discovery', { recursive: true })
await writeFile(
  'services/errotel/internal/discovery/openapi.json',
  `${JSON.stringify(spec, null, 2)}\n`
)
