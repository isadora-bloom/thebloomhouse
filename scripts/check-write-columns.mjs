/**
 * Fields a couple page writes that are not columns on the table.
 *
 * Postgres rejects the whole statement on the first unknown column, so every hit
 * here is a save that cannot succeed. There is no error in the console anyone
 * reads, no half-save: the couple fills the form in, presses save, and nothing
 * is stored. On the read side the same mismatch comes back undefined and renders
 * blank, so a page can look empty rather than broken.
 *
 * The 18 Sep sweep found ten of these across six pages. rehearsal_dinner was the
 * worst: 41 fields written, 34 of them not columns, every save since the page
 * was built. They share an origin — the Rixey parity port brought the forms and
 * left some columns behind — which is exactly why this wants a guard rather than
 * a one-off fix.
 *
 * Columns come from src/lib/supabase/types.generated.ts, so this runs in CI with
 * no database. Regenerate the types after a migration or this will lag behind.
 *
 *   node scripts/check-write-columns.mjs
 *   node scripts/check-write-columns.mjs --max 0
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const maxIdx = argv.indexOf('--max')
const MAX = maxIdx > -1 ? Number(argv[maxIdx + 1]) : null

const types = readFileSync('src/lib/supabase/types.generated.ts', 'utf8')

function columnsOf(table) {
  const at = types.indexOf(`      ${table}: {`)
  if (at === -1) return null
  const rowStart = types.indexOf('Row: {', at)
  const rowEnd = types.indexOf('        }', rowStart)
  if (rowStart === -1 || rowEnd === -1) return null
  // The character class has to allow digits: partner1_name is a column.
  return [...types.slice(rowStart, rowEnd).matchAll(/^\s+([a-z0-9_]+):/gm)]
    .map((m) => m[1])
    .filter((c) => c !== 'Row')
}

/**
 * Keys at the top level of the object literal starting at `braceAt`.
 *
 * Only its own level: a nested object is a value, not a set of column names.
 */
function literalKeys(src, braceAt) {
  let depth = 0
  let end = braceAt
  for (let i = braceAt; i < Math.min(src.length, braceAt + 6000); i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  const keys = []
  let d = 0
  for (const line of src.slice(braceAt + 1, end).split('\n')) {
    if (d === 0) {
      const m = line.match(/^\s*([a-z0-9_]+)\s*:/i)
      if (m) keys.push(m[1])
    }
    for (const ch of line) {
      if ('({['.includes(ch)) d++
      else if (')}]'.includes(ch)) d--
    }
  }
  return [...new Set(keys)]
}

/**
 * Every write site, with the keys it sends.
 *
 * Two things this has to get right, because earlier versions got each of them
 * wrong and reported a comfortable number:
 *
 *   - The write must belong to the same chain as the `.from()`. Scanning a fixed
 *     number of characters ran past the semicolon and paired a read on one table
 *     with the next statement's write to another.
 *   - The payload is often a variable, not an inline literal. Only understanding
 *     the inline form hid the rehearsal dinner page entirely, which is the worst
 *     case in the codebase.
 */
function writeSites(src) {
  const out = []
  for (const m of src.matchAll(/\.from\(\s*['"`]([a-z0-9_]+)['"`]\s*\)/g)) {
    const rest = src.slice(m.index + m[0].length)
    const nextFrom = rest.search(/\.from\(/)
    const chain = nextFrom === -1 ? rest.slice(0, 3000) : rest.slice(0, nextFrom)
    const op = chain.match(/\.(insert|update|upsert)\(\s*(\{|[A-Za-z_$][\w$]*)/)
    if (!op) continue

    let keys = null
    if (op[2] === '{') {
      keys = literalKeys(src, m.index + m[0].length + chain.indexOf(op[0]) + op[0].length - 1)
    } else {
      const decls = [...src.matchAll(new RegExp(`const ${op[2]}(?::[^=]*)? = \\{`, 'g'))]
      const nearest = decls.filter((d) => d.index < m.index).pop() ?? decls[0]
      if (nearest) keys = literalKeys(src, nearest.index + nearest[0].length - 1)
    }
    if (keys?.length) {
      out.push({ table: m[1], keys, line: src.slice(0, m.index).split('\n').length })
    }
  }
  return out
}

const dir = 'src/app/_couple-pages'
const findings = []
for (const d of readdirSync(dir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue
  for (const f of readdirSync(join(dir, d.name))) {
    if (!f.endsWith('.tsx')) continue
    const src = readFileSync(join(dir, d.name, f), 'utf8').replace(/\r\n/g, '\n')
    for (const site of writeSites(src)) {
      const cols = columnsOf(site.table)
      if (!cols) continue
      const phantom = site.keys.filter((k) => !cols.includes(k))
      if (phantom.length) findings.push({ page: `${d.name}/${f}`, ...site, phantom })
    }
  }
}

console.log(`Couple-page write sites sending a field that is not a column: ${findings.length}\n`)
for (const f of findings) {
  console.log(`  ${f.page}:${f.line}  ${f.table}`)
  console.log(`      ${f.phantom.join(', ')}`)
}

if (findings.length) {
  console.log(`
Each of these is a save that cannot succeed. Either the page has the wrong name
for a column that exists, in which case fix the page, or the feature was built
without its columns, in which case add them and regenerate the types:

  npx supabase gen types typescript --project-id <id> > src/lib/supabase/types.generated.ts

Pick the direction by what the data and the other readers already use, not by
which side was written first.`)
}

if (MAX !== null && findings.length > MAX) {
  console.error(`\nFAIL: ${findings.length} write sites cannot succeed, over the ceiling of ${MAX}.`)
  process.exit(1)
}
