#!/usr/bin/env node
/**
 * Guard: a table that gains venue_id after migration 417 also gets the
 * trial-freeze trigger.
 *
 * Migration 417 put trg_venue_freeze on every table that had venue_id at
 * the time. A frozen venue (trial ended, no subscription) is refused every
 * write by that trigger. A table created later without it is a place a
 * frozen venue can still write, and nothing would show it.
 *
 * Rule: in any migration numbered above 417, a CREATE TABLE with a
 * venue_id column, or an ALTER TABLE ... ADD ... venue_id, must be
 * followed in the same file by
 *   CREATE TRIGGER trg_venue_freeze ... ON public.<table> ...
 *     EXECUTE FUNCTION public.enforce_venue_freeze()
 * or the table must be listed in EXEMPT below with a reason (logs and
 * account plumbing only, as in 417).
 *
 * Child tables that reach a venue through a parent (no venue_id of their
 * own) can't be found by a scan. Those use enforce_venue_freeze_via_parent;
 * see the list at the bottom of 417.
 *
 * Usage: node scripts/check-venue-freeze-coverage.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const MIG_DIR = join(REPO_ROOT, 'supabase', 'migrations')
const BASE = 417

const EXEMPT = new Map([
  // ['some_log_table', 'why it must stay writable for a frozen venue'],
])

const problems = []

for (const file of readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  const num = Number.parseInt(file, 10)
  if (!Number.isFinite(num) || num <= BASE) continue
  const sql = readFileSync(join(MIG_DIR, file), 'utf8').replace(/--[^\n]*/g, '')

  const tables = new Set()
  for (const m of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi,
  )) {
    if (/\bvenue_id\b/i.test(m[2])) tables.add(m[1].toLowerCase())
  }
  for (const m of sql.matchAll(
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?(\w+)"?\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?venue_id\b/gi,
  )) {
    tables.add(m[1].toLowerCase())
  }

  for (const table of tables) {
    if (EXEMPT.has(table)) continue
    const trigger = new RegExp(
      String.raw`create\s+trigger\s+trg_venue_freeze[\s\S]*?\bon\s+(?:public\.)?"?` +
        table +
        String.raw`"?\b[\s\S]*?enforce_venue_freeze\s*\(`,
      'i',
    )
    if (!trigger.test(sql)) problems.push(`${file}: ${table} has venue_id but no trg_venue_freeze`)
  }
}

if (problems.length > 0) {
  console.error('check-venue-freeze-coverage: tables a frozen venue could still write to:\n')
  for (const p of problems) console.error(`  ${p}`)
  console.error(
    '\nAdd, in the same migration:\n' +
      '  DROP TRIGGER IF EXISTS trg_venue_freeze ON public.<table>;\n' +
      '  CREATE TRIGGER trg_venue_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.<table>\n' +
      '    FOR EACH ROW EXECUTE FUNCTION public.enforce_venue_freeze();\n' +
      'or add the table to EXEMPT in this script with the reason.',
  )
  process.exit(1)
}

console.log('check-venue-freeze-coverage: ok')
