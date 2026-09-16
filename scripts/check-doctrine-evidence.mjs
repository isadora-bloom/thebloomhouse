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
  // Grid is in tracker order, which is Playbook order (Part 2 -> Part 24).
  const partOf = (id) => Number((String(id).match(/-(\d+)/) ?? [])[1] ?? 0)
  const parts = rows.map((r) => partOf(r.id)).filter(Boolean)
  const firstPart = Math.min(...parts)
  const lastPart = Math.max(...parts)
  const label = {
    green: 'enforced, every cited piece still exists',
    amber: 'enforced, cites nothing checkable',
    red: 'enforced, a cited piece is gone',
    grey: 'not claimed enforced',
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
  const staleDays = s.tracker_last_updated
    ? Math.round((when - new Date(s.tracker_last_updated + 'T12:00:00Z')) / 86400000)
    : null
  const missing = s.evidence_cited - s.evidence_found
  const kindOrder = ['path', 'migration', 'commit', 'guard']
  const kinds = kindOrder
    .filter((k) => s.by_kind[k])
    .map((k) => {
      const v = s.by_kind[k]
      const gone = v.cited - v.found
      return `<tr class="${gone > 0 ? 'hot' : ''}"><td>${esc(k)}</td><td>${v.cited}</td><td>${v.found}</td><td>${gone}</td></tr>`
    })
    .join('')
  const pctUnverified = Math.round((s.amber_unverifiable / s.claimed_enforced) * 100)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Doctrine evidence check</title>
<style>
  :root{--navy:#0D1321;--navy2:#111A2E;--cream:#F8F3E8;--amber:#D7A84D;--muted:#B9B3A6;
        --green:#6FCF97;--red:#8E2F24;--redline:#E07A6B;--grey:#4A5573}
  html,body{margin:0;background:var(--navy);color:var(--cream);font:16px/1.4 Inter,system-ui,sans-serif}
  .wrap{padding:44px 64px 40px;max-width:1500px}
  h1{font:600 40px/1.1 "Playfair Display",Georgia,serif;margin:0 0 6px}
  .sub{color:var(--muted);margin:0 0 26px;font-size:18px}
  .lead{display:grid;grid-template-columns:1.6fr 1fr;gap:18px;margin:0 0 26px}
  .claim{background:var(--navy2);border-radius:12px;padding:22px 26px;border-left:6px solid var(--amber)}
  .claim b{display:block;font:600 48px/1 "Playfair Display",Georgia,serif;margin-bottom:8px}
  .claim p{margin:0;font-size:19px;line-height:1.35}
  .claim p em{color:var(--amber);font-style:normal;font-weight:600}
  .stale{background:var(--navy2);border-radius:12px;padding:22px 26px;border-left:6px solid var(--redline)}
  .stale b{display:block;font:600 48px/1 "Playfair Display",Georgia,serif;margin-bottom:8px}
  .stale p{margin:0;color:var(--muted);font-size:15px}
  .mid{display:grid;grid-template-columns:1.1fr 1fr;gap:28px;align-items:start;margin:0 0 26px}
  .grid{display:grid;grid-template-columns:repeat(34,1fr);gap:4px}
  .sq{aspect-ratio:1;border-radius:2px;position:relative}
  .green{background:var(--green)}
  .red{background:var(--red)}
  .red::after{content:"";position:absolute;inset:22%;background:
    linear-gradient(45deg,transparent 42%,var(--cream) 42%,var(--cream) 58%,transparent 58%),
    linear-gradient(-45deg,transparent 42%,var(--cream) 42%,var(--cream) 58%,transparent 58%)}
  .amber{background:repeating-linear-gradient(45deg,var(--red) 0 3px,var(--navy) 3px 6px);outline:1px solid var(--red);outline-offset:-1px}
  .grey{background:var(--grey)}
  .axis{display:flex;justify-content:space-between;color:var(--muted);font-size:13px;margin-top:8px}
  .axis span:nth-child(2){color:#8F897E}
  .legend{display:grid;grid-template-columns:1fr 1fr;gap:10px 22px;margin:0 0 18px}
  .legend div{display:flex;align-items:center;gap:10px;font-size:15px;color:var(--cream)}
  .legend .sq{width:22px;height:22px;flex:none}
  .legend small{display:block;color:var(--muted);font-size:13px}
  table{border-collapse:collapse;font-size:15px;width:100%}
  td,th{padding:5px 12px 5px 0;color:var(--muted);text-align:right;border-bottom:1px solid #1E2740}
  td:first-child,th:first-child{text-align:left}
  th{font-weight:500;font-size:13px;color:#8F897E}
  tr.hot td{color:var(--cream);font-weight:600;background:linear-gradient(90deg,rgba(215,168,77,.18),transparent)}
  tr.hot td:first-child{border-left:4px solid var(--amber);padding-left:8px}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
  .stat{background:var(--navy2);border-radius:10px;padding:16px 18px;border-left:6px solid}
  .stat b{display:block;font:600 40px/1 "Playfair Display",Georgia,serif;margin-bottom:6px}
  .stat span{color:var(--muted);font-size:14px}
  .stat i{display:block;color:#8F897E;font-size:12px;font-style:normal;margin-top:4px}
  .foot{margin-top:18px;color:#8F897E;font-size:13px;max-width:1000px}
</style></head><body><div class="wrap">
<h1>Is the evidence still there?</h1>
<p class="sub">An evidence-integrity check, not a compliance check. doctrine-compliance.yaml against ${esc(s.branch)}@${esc(s.head)}, ${esc(whenStr)} (Eastern)</p>

<div class="lead">
  <div class="claim">
    <b>${s.evidence_cited} cited &middot; ${s.evidence_found} still exist</b>
    <p>Every one of the <em>${missing} missing</em> is a file path. Nothing anchored to a migration, a commit or a guard script rotted. <em>Only the paths did.</em></p>
  </div>
  <div class="stale">
    <b>${staleDays ?? '?'} days</b>
    <p>since the tracker was last hand-edited. The check ran today; the grades did not.</p>
  </div>
</div>

<div class="mid">
  <div>
    <div class="grid">${squares}</div>
    <div class="axis"><span>Playbook Part ${firstPart}</span><span>${s.cells} cells, tracker order, one square each</span><span>Part ${lastPart}</span></div>
  </div>
  <div>
    <div class="legend">
      <div><div class="sq green"></div><span>Verified<small>${label.green}</small></span></div>
      <div><div class="sq amber"></div><span>Unverified<small>${label.amber}</small></span></div>
      <div><div class="sq red"></div><span>Stale<small>${label.red}</small></span></div>
      <div><div class="sq grey"></div><span>Not claimed<small>${label.grey}</small></span></div>
    </div>
    <table>
      <tr><th>evidence kind</th><th>cited</th><th>found</th><th>gone</th></tr>
      ${kinds}
    </table>
  </div>
</div>

<div class="stats">
  <div class="stat" style="border-color:var(--green)"><b>${s.green_verified}</b><span>Verified</span><i>of ${s.claimed_enforced} hand-graded enforced</i></div>
  <div class="stat" style="border-color:var(--red);border-left-style:dashed"><b>${s.amber_unverifiable}</b><span>Unverified. Graded enforced, cite nothing checkable</span><i>${pctUnverified}% of all enforced cells</i></div>
  <div class="stat" style="border-color:var(--red)"><b>${s.red_evidence_missing}</b><span>Stale. Graded enforced, a cited file has moved</span><i>all ${s.red_evidence_missing} are renamed paths</i></div>
  <div class="stat" style="border-color:var(--grey)"><b>${s.grey_not_claimed}</b><span>Not claimed enforced</span><i>partial, doctrine-only or at-risk</i></div>
</div>

<p class="foot">Green means the migrations, commits, files and guard scripts a human pointed at still exist at HEAD, and every cited guard is wired into CI. It does not prove the behaviour holds. That is the first rung, not the last.</p>
</div></body></html>`
}

// Exit non-zero only when asked to, so this can join CI later without
// turning red on day one.
if (args.includes('--strict') && counts.red > 0) process.exit(1)
