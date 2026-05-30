#!/usr/bin/env node
// Dev helper: run SQL on the TEST-BRANCH via the Supabase Management API.
// Reads token + branch ref from .env.test; REFUSES prod. SQL from a file arg
// (preferred — no shell quoting) or a literal string. Used to apply the
// partner-reconciliation migration to the branch + verification queries.
import { readFileSync, existsSync } from 'node:fs'
const env = {}
for (const l of readFileSync('.env.test', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2] }
const url = env.NEXT_PUBLIC_SUPABASE_URL || ''
const ref = (url.match(/https:\/\/([a-z0-9]+)\.supabase/) || [])[1]
if (!ref || url.includes('jsxxgwprxuqgcauzlxcb')) { console.error('REFUSE: prod or no branch ref'); process.exit(2) }
const arg = process.argv[2]
const sql = arg && existsSync(arg) ? readFileSync(arg, 'utf8') : arg
const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST', headers: { Authorization: 'Bearer ' + env.SUPABASE_ACCESS_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
})
console.log('status', r.status)
console.log(JSON.stringify(await r.json(), null, 2))
