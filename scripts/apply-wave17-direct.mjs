// Apply Wave 17 migration 284 (disagreement_findings) by splitting the
// SQL into individual statements and running them sequentially via
// exec_sql. Strips outer BEGIN/COMMIT so the schema-cache reload notify
// at the bottom fires reliably.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

let raw = readFileSync('supabase/migrations/284_disagreement_findings.sql', 'utf8')
raw = raw.replace(/^\s*BEGIN\s*;\s*/m, '').replace(/\s*COMMIT\s*;\s*$/m, '')

const statements = []
let buf = ''
let inDollar = false
for (let i = 0; i < raw.length; i++) {
  const ch = raw[i]
  const next2 = raw.slice(i, i + 2)
  if (next2 === '$$') {
    inDollar = !inDollar
    buf += '$$'
    i++
    continue
  }
  if (ch === ';' && !inDollar) {
    const s = buf.trim()
    if (s.length > 0 && !s.startsWith('--')) statements.push(s + ';')
    buf = ''
    continue
  }
  buf += ch
}
if (buf.trim().length > 0) statements.push(buf.trim())

console.log(`=== Applying ${statements.length} statements ===`)
let appliedCount = 0
for (const s of statements) {
  const head = s.slice(0, 60).replace(/\s+/g, ' ')
  const { error } = await sb.rpc('exec_sql', { sql: s })
  if (error) {
    console.log('  FAIL on:', head)
    console.log('         ', error.message)
    process.exit(1)
  }
  appliedCount++
}
console.log(`  ${appliedCount} applied`)

console.log('\n=== Forcing schema cache reload ===')
await sb.rpc('exec_sql', { sql: `NOTIFY pgrst, 'reload schema';` })
await new Promise((r) => setTimeout(r, 5000))

console.log('=== Verifying ===')
const checks = ['disagreement_findings', 'disagreement_jobs']
for (const t of checks) {
  const { error } = await sb.from(t).select('id', { count: 'exact', head: true })
  console.log('  ' + t + ':', error?.message ?? 'OK')
}

console.log('\nDone.')
