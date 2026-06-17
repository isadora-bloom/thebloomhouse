#!/usr/bin/env node
// Dev helper: run SQL on the TEST-BRANCH via the Supabase Management API.
// Reads token + branch ref from .env.test; REFUSES prod. SQL from a file arg
// (preferred — no shell quoting) or a literal string.
//
// HARDENED 2026-06-17 after a Management-API incident turned timeouts into a
// confusing cascade: the old version called JSON.parse() on the response
// unconditionally, so a 504 (which returns an HTML error page, not JSON) made
// node CRASH with an unhandled SyntaxError ("Unexpected token '<'") + a libuv
// UV_HANDLE_CLOSING assertion — no status, no body, no signal that it was a
// gateway timeout. That opaque failure invited blind retries, each of which
// left another stuck connection on a small branch. This version:
//   - sets a client-side timeout (AbortController; BRANCH_SQL_TIMEOUT_MS, def 30s)
//   - reads the body as TEXT, then tries JSON — never crashes on non-JSON
//   - on a 5xx / timeout, says plainly it's likely the control-plane being
//     degraded (check status.supabase.com) and exits non-zero WITHOUT retrying
//   - exit codes: 0 ok · 1 SQL/HTTP/timeout error · 2 misuse (prod / no SQL)
//
// It deliberately does NOT auto-split the SQL on ';' — migrations contain
// dollar-quoted plpgsql ($$ ... $$) that a naive split would corrupt. Run heavy
// or backfill-bearing migrations through the dashboard SQL editor (no 20s
// Management-API statement cap), not this helper.
//
// Usage:
//   node scripts/branch-sql.mjs path/to/file.sql
//   node scripts/branch-sql.mjs "select 1;"
import { readFileSync, existsSync } from 'node:fs'

const env = {}
for (const l of readFileSync('.env.test', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
const url = env.NEXT_PUBLIC_SUPABASE_URL || ''
const ref = (url.match(/https:\/\/([a-z0-9]+)\.supabase/) || [])[1]
if (!ref || url.includes('jsxxgwprxuqgcauzlxcb')) {
  console.error('REFUSE: .env.test points at prod or has no branch ref.')
  process.exit(2)
}
if (!env.SUPABASE_ACCESS_TOKEN) {
  console.error('REFUSE: no SUPABASE_ACCESS_TOKEN in .env.test.')
  process.exit(2)
}

const arg = process.argv[2]
if (!arg) {
  console.error('Usage: node scripts/branch-sql.mjs <file.sql | "SQL string">')
  process.exit(2)
}
const sql = existsSync(arg) ? readFileSync(arg, 'utf8') : arg
if (!sql.trim()) { console.error('REFUSE: empty SQL.'); process.exit(2) }

const TIMEOUT_MS = Number(env.BRANCH_SQL_TIMEOUT_MS || process.env.BRANCH_SQL_TIMEOUT_MS || 30_000)

// NOTE: we set process.exitCode and RETURN rather than calling process.exit().
// On Windows, process.exit() while undici's fetch socket is mid-close triggers a
// libuv "UV_HANDLE_CLOSING" assertion (exit 127). Letting main() return lets the
// event loop drain the socket cleanly, so the real exit code survives.
async function main() {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  let res, bodyText
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.SUPABASE_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
      signal: ac.signal,
    })
    bodyText = await res.text()
  } catch (e) {
    if (e?.name === 'AbortError') {
      console.error(`TIMEOUT after ${TIMEOUT_MS}ms — no response from the Management API.`)
      console.error('Likely the control-plane is degraded (check https://status.supabase.com) OR a prior')
      console.error('heavy statement is still holding a lock on the branch. Do NOT blind-retry — wait/diagnose.')
    } else {
      console.error(`NETWORK ERROR: ${String(e?.message || e)}`)
    }
    process.exitCode = 1
    return
  } finally {
    clearTimeout(timer)
  }

  console.log('status', res.status)

  // Parse defensively — a 5xx returns an HTML error page, not JSON.
  let json = null
  try { json = JSON.parse(bodyText) } catch { /* non-JSON (HTML error page) */ }

  if (!res.ok) {
    if (res.status >= 500) {
      console.error('Management API 5xx — control-plane degraded/timeout, NOT a SQL error.')
      console.error('Check https://status.supabase.com. The query may or may not have run server-side;')
      console.error('verify state with a separate read before retrying. Do NOT hammer (stuck connections pile up).')
    }
    console.error(json ? JSON.stringify(json, null, 2) : bodyText.slice(0, 400))
    process.exitCode = 1
    return
  }

  // 2xx but Postgres-level error is returned in the JSON body.
  if (json && (json.error || json.message)) {
    console.error('SQL error:', JSON.stringify(json, null, 2))
    process.exitCode = 1
    return
  }
  console.log(json !== null ? JSON.stringify(json, null, 2) : bodyText.slice(0, 400))
}

await main()
