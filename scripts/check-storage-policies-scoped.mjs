#!/usr/bin/env node
/**
 * Guard: a storage.objects policy may not scope on bucket_id alone.
 *
 * WHY THIS EXISTS
 * ---------------
 * Migration 028 created five buckets with `bucket_id = '<name>'` as the
 * entire predicate, for the anon role, on all four verbs. Migrations 084
 * and 270 did the authenticated version for brain-dump and crm-imports.
 * Migration 097 did it again for day-of-media, anon SELECT included. Each
 * one was written as "lock it to this bucket" and each one actually says
 * "every caller of this role may read, overwrite and delete every
 * object in this bucket, whoever uploaded it". Migration 225 closed the
 * table-level version of the same mistake and did not touch storage;
 * migration 411 closes storage.
 *
 * A bucket is a tenant boundary only if the policy says which folder the
 * caller owns. In this repo that means a `storage.foldername(name)`
 * predicate resolving the first (or, for day-of-media, the second) path
 * segment to a venue or a wedding the caller may access.
 *
 * WHAT IT CHECKS
 * --------------
 * Every CREATE POLICY on storage.objects across supabase/migrations/*.sql.
 * A policy is a violation when its predicate mentions bucket_id and does
 * not mention storage.foldername. A violation is forgiven when a LATER
 * migration drops that policy name, because history is allowed to contain
 * the mistake it later fixes. Migration 411's dynamic sweep counts as a
 * drop for every policy name it can reach, and is recognised as such.
 *
 * Pure static analysis. No database. Runs in CI.
 *
 * Usage:
 *   node scripts/check-storage-policies-scoped.mjs
 *   node scripts/check-storage-policies-scoped.mjs --report   (print, exit 0)
 *
 * Exit 0 = clean. Exit 1 = a bucket-id-only policy survives.
 *
 * Companion: scripts/check-live-policies.mjs reads the same thing from a
 * live database, which is the only way to catch a policy added by hand in
 * the dashboard. This one catches the next migration that reaches for the
 * old pattern.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const MIG_DIR = join(REPO_ROOT, 'supabase', 'migrations')
const REPORT = process.argv.includes('--report')

if (!existsSync(MIG_DIR)) {
  console.log('check-storage-policies-scoped: no supabase/migrations dir. Skipping.')
  process.exit(0)
}

const files = readdirSync(MIG_DIR)
  .filter((f) => /^\d+_.*\.sql$/i.test(f))
  .sort()

/**
 * Policies whose predicate is genuinely bucket-wide on purpose. Each
 * needs the bucket to carry no per-tenant data at all, and a reason.
 */
const ALLOWLIST = new Map([
  // ['some_policy_name', 'why this bucket has no tenant boundary'],
])

// ---------------------------------------------------------------------------
// Pass 1 — collect every CREATE POLICY on storage.objects, in file order.
// ---------------------------------------------------------------------------

/** @type {Array<{file: string, name: string, body: string}>} */
const created = []
/** @type {Map<string, string>} policy name -> first file that drops it */
const droppedIn = new Map()
/** Files whose sweep drops every policy mentioning a bucket id. */
const sweepFiles = []

const CREATE_RE =
  /create\s+policy\s+"?([A-Za-z0-9_]+)"?\s+on\s+storage\.objects([\s\S]*?)(?=;|\$s\$|create\s+policy|drop\s+policy|$)/gi
const DROP_RE = /drop\s+policy\s+(?:if\s+exists\s+)?"?([A-Za-z0-9_]+)"?\s+on\s+storage\.objects/gi

for (const f of files) {
  const text = readFileSync(join(MIG_DIR, f), 'utf8')
  if (!/storage\.objects/i.test(text)) continue

  for (const m of text.matchAll(CREATE_RE)) {
    created.push({ file: f, name: m[1], body: m[2] })
  }
  for (const m of text.matchAll(DROP_RE)) {
    if (!droppedIn.has(m[1])) droppedIn.set(m[1], f)
  }
  // A dynamic sweep: a loop that drops policies on storage.objects by
  // name from pg_policies. Migration 411 is the one in tree.
  if (
    /pg_policies/i.test(text)
    && /tablename\s*=\s*'objects'/i.test(text)
    && /drop\s+policy\s+if\s+exists\s+%I\s+on\s+storage\.objects/i.test(text)
  ) {
    sweepFiles.push(f)
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — judge each policy.
// ---------------------------------------------------------------------------

const violations = []

for (const p of created) {
  if (ALLOWLIST.has(p.name)) continue
  const mentionsBucket = /\bbucket_id\b/i.test(p.body)
  const mentionsFolder = /storage\.foldername/i.test(p.body)
  if (!mentionsBucket || mentionsFolder) continue

  // Forgiven when a later migration drops it by name, or when a later
  // migration sweeps every bucket-mentioning policy off storage.objects.
  const dropFile = droppedIn.get(p.name)
  const droppedLater = dropFile && dropFile > p.file
  const sweptLater = sweepFiles.some((s) => s > p.file)
  if (droppedLater || sweptLater) continue

  violations.push(p)
}

console.log(
  `check-storage-policies-scoped: ${created.length} storage.objects policies across `
    + `${files.length} migrations · ${sweepFiles.length} sweep(s) · ${violations.length} unscoped and never dropped.`,
)

if (violations.length === 0) {
  console.log('OK — every surviving storage.objects policy scopes on a path folder, not just the bucket.')
  process.exit(0)
}

const log = REPORT ? console.log : console.error
log('\nstorage.objects policies scoped on bucket_id alone (every caller of that role gets every object):\n')
for (const v of violations) {
  log(`  ${v.file}  ${v.name}`)
}
log(
  '\nA bucket is not a tenant boundary. Add a `(storage.foldername(name))[1]` predicate\n'
    + 'resolving to a venue or wedding the caller may access, the way migration 411 does,\n'
    + 'or drop the policy in a later migration. If a bucket genuinely holds nothing\n'
    + 'per-tenant, add its policy to ALLOWLIST in this script with the reason.\n',
)

process.exit(REPORT ? 0 : 1)
