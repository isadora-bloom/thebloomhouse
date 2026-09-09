// ============================================================================
// Schema truth check: every `.from('table')` in src and every literal
// `.select('a, b, c')` column list, compared against the LIVE database schema.
//
// Why: types.ts is a placeholder and the clients are untyped, so a table or
// column that never existed (or was renamed) is a runtime 400/null, never a
// compile error. The July portal work found the website builder saving to
// seven columns that did not exist. This makes that class visible.
//
// Input: a JSON map { table: [columns] } of the live schema. Produce it with
// the PostgREST OpenAPI document (read-only):
//   node -e "..." (see NOVEMBER-PLAN.md) or pass --schema <file>.
// Default path: %TEMP%/live-schema.json.
//
// Read-only. Never connects to the database itself.
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const argSchema = process.argv.indexOf('--schema')
const schemaPath = argSchema > -1 ? process.argv[argSchema + 1] : join(process.env.TEMP ?? '/tmp', 'live-schema.json')
const live = JSON.parse(readFileSync(schemaPath, 'utf8'))
const liveTables = new Set(Object.keys(live))
const BACKSLASH = String.fromCharCode(92)
const norm = (p) => p.split(BACKSLASH).join('/')

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) { if (!/node_modules|\.next|__tests__/.test(f)) walk(p, out) }
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)) out.push(p)
  }
  return out
}

const files = walk('src')
const tableHits = new Map()
const colHits = []
const fromRe = /\.from\(\s*['"`]([a-zA-Z0-9_]+)['"`]\s*\)/g
const selRe = /\.from\(\s*['"`]([a-zA-Z0-9_]+)['"`]\s*\)[\s\S]{0,160}?\.select\(\s*['"`]([^'"`]+)['"`]/g

for (const f of files) {
  const src = readFileSync(f, 'utf8')
  let m
  while ((m = fromRe.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length
    const arr = tableHits.get(m[1]) ?? []
    arr.push(`${norm(f)}:${line}`)
    tableHits.set(m[1], arr)
  }
  while ((m = selRe.exec(src))) {
    const t = m[1]
    if (!liveTables.has(t)) continue
    const line = src.slice(0, m.index).split('\n').length
    let depth = 0, cur = ''
    const parts = []
    for (const ch of m[2]) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
    }
    parts.push(cur)
    for (let p of parts) {
      p = p.trim()
      if (!p || p === '*' || p.includes('(') || p.includes(':') || p.includes('!')) continue
      const col = p.split(/\s/)[0].replace(/^"|"$/g, '')
      if (!/^[a-z_][a-z0-9_]*$/i.test(col)) continue
      if (!live[t].includes(col)) colHits.push({ table: t, col, at: `${norm(f)}:${line}` })
    }
  }
}

const missingTables = [...tableHits.entries()].filter(([t]) => !liveTables.has(t)).sort((a, b) => b[1].length - a[1].length)
console.log(`Tables referenced in src: ${tableHits.size}; live tables: ${liveTables.size}`)
console.log(`\n== ${missingTables.length} tables referenced in code that do NOT exist in the live DB ==`)
for (const [t, refs] of missingTables) console.log(`  ${t.padEnd(36)} ${String(refs.length).padStart(3)} refs  e.g. ${refs[0]}`)

const byTable = new Map()
for (const h of colHits) {
  const a = byTable.get(h.table) ?? new Map()
  a.set(h.col, [...(a.get(h.col) ?? []), h.at])
  byTable.set(h.table, a)
}
console.log(`\n== ${colHits.length} literal select() columns that do NOT exist on their live table ==`)
for (const [t, cols] of [...byTable.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  ${t}:`)
  for (const [c, ats] of cols) console.log(`     .${c.padEnd(30)} ${String(ats.length).padStart(2)}x  ${ats[0]}`)
}
