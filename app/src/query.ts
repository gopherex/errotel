import lucene from '@hyperdx/lucene'
import type { OccurrenceSearch, SearchFilter, TimeRange } from '@gopherex/errotel-api'

export const fields = {
  service: 'service',
  environment: 'environment',
  type: 'exceptionType',
  message: 'message',
  message_exact: 'message',
  release: 'release',
  trace_id: 'traceId',
  runtime_id: 'runtimeId',
  group_key: 'groupKey',
  origin: 'origin',
} as const
export type QueryField = keyof typeof fields
export type QueryDocument = { time: { from: string; to: string }; filter?: SearchFilter }
export const initialQuery = 'time:[now-15m TO now}'

type Node = {
  left?: Node
  right?: Node
  operator?: string
  start?: string
  parenthesized?: boolean
  field?: string
  term?: string
  quoted?: boolean
  regex?: boolean
  prefix?: string
  similarity?: number
  proximity?: number
  boost?: number
  term_min?: string
  term_max?: string
  inclusive?: string
}
type Expression = SearchFilter | { op: 'time'; from: string; to: string }

function fail(message: string): never {
  throw new Error(message)
}

function decodeTerm(node: Node): string {
  const term = node.term ?? ''
  if (!node.quoted) return term.replace(/\\(.)/gs, '$1')
  try {
    return JSON.parse(`"${term}"`) as string
  } catch {
    return fail('Invalid string escape. Use double quotes and JSON escapes.')
  }
}

function leaf(node: Node, field: string): Expression {
  if (node.regex || node.boost != null || node.proximity != null || node.similarity != null)
    fail('Regular expressions, boosts and fuzzy search are not supported.')
  if (field === 'time') {
    if (!node.term_min || !node.term_max || node.inclusive !== 'left')
      fail('Use time:[now-15m TO now} or time:[ISO-start TO ISO-end}. The end is exclusive.')
    return { op: 'time', from: node.term_min, to: node.term_max }
  }
  if (node.term_min != null) fail('Ranges are supported only for time.')
  if (!Object.hasOwn(fields, field)) fail(`Unknown field: ${field}`)
  const value = decodeTerm(node)
  if (new TextEncoder().encode(value).length > 2048)
    fail('A filter value can be at most 2048 bytes.')
  const mapped = fields[field as QueryField]
  let result: SearchFilter
  const wildcards = node.quoted ? '' : (node.term ?? '').replace(/\\./gs, '')
  if (!node.quoted && node.term === '*') result = { op: 'exists', field: mapped }
  else if (!node.quoted && /[*?]/.test(wildcards)) {
    if (wildcards.includes('?') || !wildcards.endsWith('*') || wildcards.slice(0, -1).includes('*'))
      fail('Only a trailing prefix wildcard is supported. Quote literal * and ? characters.')
    result = { op: 'prefix', field: mapped, value: value.slice(0, -1) }
  } else result = { op: field === 'message' ? 'icontains' : 'eq', field: mapped, value }
  if (mapped === 'origin' && (result.op !== 'eq' || !['sdk', 'otel-log'].includes(value)))
    fail('Origin must be sdk or otel-log.')
  if (node.prefix && !['-', '+', '!'].includes(node.prefix)) fail('Unsupported prefix.')
  return node.prefix === '-' || node.prefix === '!' ? { op: 'not', children: [result] } : result
}

function group(op: 'and' | 'or' | 'not', expressions: Expression[]): SearchFilter {
  if (expressions.some((item) => item.op === 'time'))
    fail('Time must be one global range joined with AND.')
  return {
    op,
    children: (expressions as SearchFilter[]).flatMap((item) =>
      op !== 'not' && item.op === op ? (item.children ?? []) : [item]
    ),
  }
}

function operator(value?: string): 'and' | 'or' {
  return value === 'OR' || value === 'OR NOT' || value === '||' ? 'or' : 'and'
}

function parseNode(
  node: Node,
  inherited: string,
  depth: number,
  times: QueryDocument['time'][]
): Expression | undefined {
  if (depth > 128) fail('Query is too deeply nested.')
  const timeCount = times.length
  const field = node.field && node.field !== '<implicit>' ? node.field : inherited
  if (!node.left) return leaf(node, field)
  // Explicit grouping avoids Lucene parser's surprising mixed-operator precedence.
  if (
    node.right?.operator &&
    !node.right.parenthesized &&
    operator(node.operator) !== operator(node.right.operator)
  )
    fail('Add parentheses when combining AND and OR.')
  const left = parseNode(node.left, field, depth + 1, times)
  if (!node.right) {
    if (node.start) {
      if (times.length > timeCount) fail('Time must be one global range joined with AND.')
      return group('not', left ? [left] : [])
    }
    return left
  }
  const right = parseNode(node.right, field, depth + 1, times)
  const op = operator(node.operator)
  const parts: Expression[] = []
  for (const [index, part] of [left, right].entries()) {
    if (!part) continue
    const negated = index === 1 && ['NOT', 'AND NOT', 'OR NOT'].includes(node.operator ?? '')
    if (part.op === 'time' && op === 'and' && !negated && !node.start) {
      times.push({ from: part.from, to: part.to })
    } else parts.push(negated ? group('not', [part]) : part)
  }
  // A time extracted from a child is forbidden underneath OR/NOT too.
  if ((op === 'or' || node.start) && times.length > timeCount)
    fail('Time must be one global range joined with AND.')
  const result = parts.length > 1 ? group(op, parts) : parts[0]
  return node.start && result ? group('not', [result]) : result
}

export function parseQuery(text: string): QueryDocument {
  if (text.length > 16384) fail('Query is too long (maximum 16 KiB).')
  let parsed: Node
  try {
    // PEG's phrase grammar does not accept JSON escapes such as \n. Tokenize
    // every quoted literal first; positional placeholders cannot collide with
    // user strings because only generated, quoted terms are substituted back.
    const literals: string[] = []
    const input = text.replace(/"(?:\\.|[^"\\])*"/gs, (literal) => {
      const index = literals.push(JSON.parse(literal) as string) - 1
      return `"ERROTEL_LITERAL_${index}"`
    })
    parsed = lucene.parse(input) as Node
    const restore = (node: Node) => {
      if (node.quoted && node.term) {
        const index = /^ERROTEL_LITERAL_(\d+)$/.exec(node.term)
        if (index) node.term = JSON.stringify(literals[Number(index[1])]).slice(1, -1)
      }
      if (node.left) restore(node.left)
      if (node.right) restore(node.right)
    }
    restore(parsed)
  } catch {
    return fail('Incomplete query. Check quotes, parentheses and operators.')
  }
  const times: QueryDocument['time'][] = []
  const expression = parseNode(parsed, 'message', 0, times)
  if (expression?.op === 'time') times.push({ from: expression.from, to: expression.to })
  if (times.length !== 1) fail('Include exactly one time:[start TO end} range.')
  const filter = expression?.op === 'time' ? undefined : expression
  let count = 0
  function visit(node: SearchFilter, depth: number) {
    count++
    if (depth > 12) fail('Query nesting is limited to 12 levels.')
    node.children?.forEach((child) => {
      visit(child, depth + 1)
    })
  }
  if (filter) visit(filter, 0)
  if (count > 64) fail('Query is limited to 64 conditions and groups.')
  const result = { time: times[0], filter }
  resolveRange(result.time)
  return result
}

export function nanoISO(value: bigint): string {
  return (
    new Date(Number(value / 1_000_000_000n) * 1000).toISOString().slice(0, 19) +
    '.' +
    (value % 1_000_000_000n).toString().padStart(9, '0') +
    'Z'
  )
}

export function timeNano(value: string, now: number): bigint {
  const relative = /^now(?:-(\d+)(ms|s|m|h|d))?$/.exec(value)
  if (relative) {
    const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }
    const offset = Number(relative[1] ?? 0) * (units[relative[2]] ?? 1)
    if (!Number.isSafeInteger(offset)) fail('Invalid relative time.')
    return BigInt(now - offset) * 1_000_000n
  }
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (!iso) return fail('Use UTC ISO timestamps ending in Z, or now-15m / now-1h / now-1d.')
  const ms = Date.parse(`${iso[1]}Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== iso[1])
    fail('Invalid date.')
  return BigInt(ms) * 1_000_000n + BigInt((iso[2] ?? '').padEnd(9, '0'))
}

export function resolveRange(
  time: QueryDocument['time'],
  now = Date.now(),
  maxRangeMs = 31 * 86400_000
): TimeRange {
  const start = timeNano(time.from, now),
    end = timeNano(time.to, now)
  if (
    start < 0n ||
    end <= start ||
    end > 9223372036854775807n ||
    end - start > BigInt(maxRangeMs) * 1_000_000n
  )
    fail(`Choose a positive time range no longer than ${maxRangeMs / 86400_000} days.`)
  return { startUnixNano: String(start), endUnixNano: String(end) }
}

export function filterText(filter: SearchFilter): string {
  if (filter.op === 'not') return `NOT (${filterText(filter.children?.[0] as SearchFilter)})`
  if (filter.op === 'and' || filter.op === 'or')
    return `(${filter.children?.map(filterText).join(` ${filter.op.toUpperCase()} `)})`
  const field =
    filter.field === 'message' && filter.op === 'eq'
      ? 'message_exact'
      : Object.entries(fields).find(([, value]) => value === filter.field)?.[0]
  if (filter.op === 'exists') return `${field}:*`
  if (filter.op === 'prefix') {
    const value = (filter.value ?? '').replace(/([\s\\:"()[\]{}*?+!^~])/g, '\\$1')
    return `${field}:${value}*`
  }
  return `${field}:${JSON.stringify(filter.value ?? '')}`
}

export function printQuery(query: QueryDocument): string {
  return `time:[${query.time.from} TO ${query.time.to}}${query.filter ? ` AND ${filterText(query.filter)}` : ''}`
}

export function addFilter(
  query: QueryDocument,
  field: QueryField,
  value: string,
  exclude = false
): string {
  const condition: SearchFilter = {
    field: fields[field],
    op: field === 'message' ? 'icontains' : 'eq',
    value,
  }
  const added: SearchFilter = exclude ? { op: 'not', children: [condition] } : condition
  return printQuery({
    ...query,
    filter: query.filter ? { op: 'and', children: [query.filter, added] } : added,
  })
}

export function removeFilter(query: QueryDocument, path: number[]): string {
  function remove(node: SearchFilter, depth: number): SearchFilter | undefined {
    if (depth === path.length) return undefined
    const children =
      node.children?.flatMap((child, i) => {
        const next = i === path[depth] ? remove(child, depth + 1) : child
        return next ? [next] : []
      }) ?? []
    if (!children.length) return undefined
    return node.op !== 'not' && children.length === 1 ? children[0] : { ...node, children }
  }
  return printQuery({ ...query, filter: query.filter ? remove(query.filter, 0) : undefined })
}

export function searchRequest(
  query: QueryDocument,
  now: number,
  maxRangeMs: number
): OccurrenceSearch {
  return { range: resolveRange(query.time, now, maxRangeMs), filter: query.filter, pageSize: 50 }
}
