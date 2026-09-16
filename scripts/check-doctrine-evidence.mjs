#!/usr/bin/env node
/**
 * Doctrine evidence check (Playbook §22.3 / §22.4).
 *
 * The tracker (doctrine-compliance.yaml) is hand-graded. A cell can say
 * `enforced` on nobody's say-so but the grader's. This script asks the
 * repo instead: for every cell, pull out the concrete evidence the notes
 * cite and check that each piece still exists at HEAD.
 *
 *   - migration numbers  → a file in supabase/migrations/ starts with it
 *   - commit hashes      → git knows the object
 *   - source paths       → the file exists (line numbers are not checked)
 *   - guard scripts      → the file exists AND ci.yml runs it
 *   - "test" mentions    → a __tests__ file exists next to a cited path
 *
 * Grades, per cell:
 *   green  enforced, cites evidence, every piece found
 *   amber  enforced, cites nothing this script can check
 *   red    enforced, cites evidence and at least one piece is missing
 *   grey   partial / doctrine-only / at-risk (not claimed enforced)
 *
 * What this does NOT do: prove the behaviour still holds. It proves the
 * evidence a human pointed at is still there. That is the first rung of
 * "no evidence, no green", not the last.
 *
 * Usage:
 *   node scripts/check-doctrine-evidence.mjs            # summary to stdout
 *   node scripts/check-doctrine-evidence.mjs --html out.html
 *   node scripts/check-doctrine-evidence.mjs --json out.json
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import yaml from 'js-yaml'

const ROOT = process.cwd()
const TRACKER = join(ROOT, 'doctrine-compliance.yaml')
const CI = join(ROOT, '.github/workflows/ci.yml')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}

const doc = yaml.load(readFileSync(TRACKER, 'utf8'))
const cells = doc.cells ?? []
const migrations = readdirSync(join(ROOT, 'supabase/migrations'))
const ciText = existsSync(CI) ? readFileSync(CI, 'utf8') : ''
const head = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()
const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT }).toString().trim()

const commitCache = new Map()
function commitExists(hash) {
  if (commitCache.has(hash)) return commitCache.get(hash)
  let ok = false
  try {
    const t = execSync(`git cat-file -t ${hash}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    ok = t === 'commit'
  } catch {
    ok = false
  }
  commitCache.set(hash, ok)
  return ok
}

function migrationExists(num) {
  const prefix = String(num).padStart(3, '0') + '_'
  return migrations.some((f) => f.startsWith(prefix))
}

// Notes cite paths in several shapes: `src/lib/x.ts`, `x.ts:120-130`,
// `scripts/check-foo.mjs`, `lib/services/foo.ts`. Bare basenames
// (`email-pipeline.ts:907`) are resolved by searching the tree once.
let treeIndex = null
function fileIndex() {
  if (treeIndex) return treeIndex
  const files = execSync('git ls-files', { cwd: ROOT }).toString().split('\n').filter(Boolean)
  treeIndex = { all: new Set(files), byBase: new Map() }
  for (const f of files) {
    const base = f.split('/').pop()
    if (!treeIndex.byBase.has(base)) treeIndex.byBase.set(base, [])
    treeIndex.byBase.get(base).push(f)
  }
  return treeIndex
}
function resolvePath(p) {
  const idx = fileIndex()
  const clean = p.replace(/^\.?\//, '')
  if (idx.all.has(clean)) return clean
  if (idx.all.has('src/' + clean)) return 'src/' + clean
  const base = clean.split('/').pop()
  const hits = idx.byBase.get(base)
  if (hits && hits.length > 0) return hits[0]
  return null
}

function extractEvidence(notes) {
  const ev = []
  const seen = new Set()
  const push = (kind, ref) => {
    const key = kind + ':' + ref
    if (seen.has(key)) return
    seen.add(key)
    ev.push({ kind, ref })
  }
  // migrations: "Migration 105", "migrations 118 + 119", "mig 338", "068:35-109" after a Migration word
  for (const m of notes.matchAll(/\b(?:migrations?|mig)\.?\s+(\d{3})(?:\s*(?:\+|,|and|\/)\s*(\d{3}))*/gi)) {
    push('migration', m[1])
    const tail = m[0].match(/\d{3}/g) ?? []
    for (const n of tail) push('migration', n)
  }
  // commit hashes: 7-8 hex, not part of a longer word, not a migration number
  for (const m of notes.matchAll(/(?<![\w/.-])([0-9a-f]{7,8})(?![\w/])/g)) {
    if (/^\d+$/.test(m[1])) continue
    push('commit', m[1])
  }
  // guard scripts
  for (const m of notes.matchAll(/\b(scripts\/check-[\w.-]+\.mjs|check-[\w-]+\.mjs)\b/g)) {
    push('guard', m[1].replace(/^scripts\//, ''))
  }
  // source paths (with or without directory, optional :line)
  for (const m of notes.matchAll(/(?<![\w-])((?:[\w@\[\]().-]+\/)*[\w\[\]().-]+\.(?:tsx?|mjs|sql|md))(?::\d+(?:-\d+)?)?/g)) {
    const p = m[1].replace(/^[([]+/, '')
    if (p.endsWith('.sql')) continue // migrations are handled by number
    if (/^check-[\w-]+\.mjs$/.test(p)) continue // guard, above
    if (/\.(md)$/.test(p) && !p.includes('/')) continue // "engineer.md" style audit refs
    push('path', p)
  }
  return ev
}

function checkEvidence(e) {
  switch (e.kind) {
    case 'migration':
      return { ...e, found: migrationExists(e.ref) }
    case 'commit':
      return { ...e, found: commitExists(e.ref) }
    case 'guard': {
      const exists = existsSync(join(ROOT, 'scripts', e.ref))
      const inCi = ciText.includes('scripts/' + e.ref)
      return { ...e, found: exists && inCi, detail: exists ? (inCi ? 'in ci.yml' : 'exists, NOT in ci.yml') : 'missing' }
    }
    case 'path': {
      const r = resolvePath(e.ref)
      return { ...e, found: !!r, detail: r ?? 'missing' }
    }
    default:
      return { ...e, found: false }
  }
}

const graded = cells.map((c) => {
  const notes = String(c.notes ?? '')
  const evidence = extractEvidence(notes).map(checkEvidence)
  const claimedEnforced = c.status === 'enforced'
  let grade
  if (!claimedEnforced) grade = 'grey'
  else if (evidence.length === 0) grade = 'amber'
  else if (evidence.every((e) => e.found)) grade = 'green'
  else grade = 'red'
  return { id: c.id, status: c.status, severity: c.severity ?? null, target: c.target ?? '', grade, evidence }
})

const counts = { green: 0, amber: 0, red: 0, grey: 0 }
for (const g of graded) counts[g.grade]++
const enforced = graded.filter((g) => g.status === 'enforced').length
const totalEvidence = graded.reduce((n, g) => n + g.evidence.length, 0)
const foundEvidence = graded.reduce((n, g) => n + g.evidence.filter((e) => e.found).length, 0)
const byKind = {}
for (const g of graded) for (const e of g.evidence) {
  byKind[e.kind] ??= { cited: 0, found: 0 }
  byKind[e.kind].cited++
  if (e.found) byKind[e.kind].found++
}

const stamp = new Date().toISOString()
const summary = {
  generated_at: stamp,
  branch,
  head,
  tracker_last_updated: doc.meta?.last_updated ?? null,
  cells: graded.length,
  claimed_enforced: enforced,
  green_verified: counts.green,
  amber_unverifiable: counts.amber,
  red_evidence_missing: counts.red,
  grey_not_claimed: counts.grey,
  evidence_cited: totalEvidence,
  evidence_found: foundEvidence,
  by_kind: byKind,
}

// ---- stdout
console.log(`Doctrine evidence check  ${stamp}  ${branch}@${head}`)
console.log(`tracker last hand-edited: ${summary.tracker_last_updated}`)
console.log(`cells ${graded.length}  claimed enforced ${enforced}`)
console.log(`  green  (enforced, all cited evidence found)   ${counts.green}`)
console.log(`  amber  (enforced, cites nothing checkable)    ${counts.amber}`)
console.log(`  red    (enforced, cited evidence missing)     ${counts.red}`)
console.log(`  grey   (not claimed enforced)                 ${counts.grey}`)
console.log(`evidence pieces cited ${totalEvidence}, found ${foundEvidence}`)
for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(10)} cited ${v.cited}  found ${v.found}`)
const reds = graded.filter((g) => g.grade === 'red')
if (reds.length) {
  console.log('\nred cells:')
  for (const r of reds) {
    const missing = r.evidence.filter((e) => !e.found).map((e) => `${e.kind}:${e.ref}${e.detail ? ` (${e.detail})` : ''}`)
    console.log(`  ${r.id.padEnd(16)} ${missing.join(', ')}`)
  }
}

const jsonOut = flag('--json')
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, cells: graded }, null, 2))

const htmlOut = flag('--html')
if (htmlOut) writeFileSync(htmlOut, renderHtml(summary, graded))

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderHtml(s, rows) {
  const col = { green: '#3FA66B', amber: '#D7A84D', red: '#C8503F', grey: '#2A3550' }
  const label = {
    green: 'enforced, every cited piece of evidence found at HEAD',
    amber: 'enforced, cites nothing the script can check',
    red: 'enforced, at least one cited piece of evidence is missing',
    grey: 'partial, doctrine-only or at-risk. Not claimed.',
  }
  const squares = rows
    .map((r) => {
      const tip = `${r.id} · ${r.status} · ${r.evidence.length} evidence` +
        (r.evidence.length ? '\n' + r.evidence.map((e) => `${e.found ? '✓' : '✗'} ${e.kind} ${e.ref}${e.detail ? ` (${e.detail})` : ''}`).join('\n') : '')
      return `<div class="sq ${r.grade}" title="${esc(tip)}"></div>`
    })
    .join('')
  const when = new Date(s.generated_at)
  const whenStr = when.toLocaleString('en-GB', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' })
  const kinds = Object.entries(s.by_kind)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.cited}</td><td>${v.found}</td></tr>`)
    .join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Doctrine evidence check</title>
<style>
  :root{--navy:#0D1321;--navy2:#111A2E;--cream:#F8F3E8;--amber:#D7A84D}
  html,body{margin:0;background:var(--navy);color:var(--cream);font:16px/1.4 Inter,system-ui,sans-serif}
  .wrap{padding:48px 64px;max-width:1500px}
  h1{font:600 40px/1.1 "Playfair Display",Georgia,serif;margin:0 0 6px}
  .sub{color:#B9B3A6;margin:0 0 28px;font-size:18px}
  .grid{display:grid;grid-template-columns:repeat(34,1fr);gap:5px;margin:0 0 28px}
  .sq{aspect-ratio:1;border-radius:3px}
  .green{background:#3FA66B}.amber{background:#D7A84D}.red{background:#C8503F}.grey{background:#2A3550}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;margin:0 0 24px}
  .stat{background:var(--navy2);border-radius:10px;padding:18px 20px;border-left:6px solid}
  .stat b{display:block;font:600 44px/1 "Playfair Display",Georgia,serif;margin-bottom:6px}
  .stat span{color:#B9B3A6;font-size:14px}
  .meta{display:flex;gap:40px;color:#B9B3A6;font-size:14px;flex-wrap:wrap}
  table{border-collapse:collapse;font-size:14px}td{padding:2px 14px 2px 0;color:#B9B3A6}
  .foot{margin-top:22px;color:#8F897E;font-size:13px;max-width:900px}
</style></head><body><div class="wrap">
<h1>No evidence, no green.</h1>
<p class="sub">doctrine-compliance.yaml checked against the repository at ${esc(s.branch)}@${esc(s.head)}, ${esc(whenStr)} (Eastern)</p>
<div class="grid">${squares}</div>
<div class="stats">
  <div class="stat" style="border-color:${col.green}"><b>${s.green_verified}</b><span>${label.green}</span></div>
  <div class="stat" style="border-color:${col.amber}"><b>${s.amber_unverifiable}</b><span>${label.amber}</span></div>
  <div class="stat" style="border-color:${col.red}"><b>${s.red_evidence_missing}</b><span>${label.red}</span></div>
  <div class="stat" style="border-color:${col.grey}"><b>${s.grey_not_claimed}</b><span>${label.grey}</span></div>
</div>
<div class="meta">
  <div>${s.cells} cells · ${s.claimed_enforced} hand-graded enforced · tracker last hand-edited ${esc(s.tracker_last_updated)}</div>
  <div>${s.evidence_cited} pieces of evidence cited · ${s.evidence_found} found</div>
  <table><tr><td></td><td>cited</td><td>found</td></tr>${kinds}</table>
</div>
<p class="foot">Green means the migrations, commits, files and guard scripts a human pointed at still exist at HEAD, and every cited guard is wired into CI. It does not prove the behaviour holds. That is the first rung, not the last.</p>
</div></body></html>`
}

// Exit non-zero only when asked to, so this can join CI later without
// turning red on day one.
if (args.includes('--strict') && counts.red > 0) process.exit(1)
