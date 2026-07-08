// ---------------------------------------------------------------------------
// battery-review-sheet.ts — render the latest battery run into a fillable
// operator review sheet.
//
// REMEDIATION-PLAN-2026-07-07.md R2: the operator-review half of the battery
// design (BLOOM-TEST-FINDINGS.md) never ran because reviewing meant digging
// through raw JSON. This script turns the newest battery-results/*.json into
// a markdown sheet with one section per operator-review question: the
// question, the answer, the judge's verdict, and a verdict box to fill in.
//
// USAGE
//   npx tsx scripts/battery-review-sheet.ts [path-to-results.json]
// Default: newest file in battery-results/. Output:
//   battery-results/review-sheet-<stamp>.md
// Paste completed verdicts into BLOOM-TEST-FINDINGS.md.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface ResultRow {
  id: string
  tier: number
  kind: string
  question: string
  answer: string
  score: number
  reason: string
  scorer?: string
  judgeConfidence?: number
  usedGroundTruth?: boolean
  operatorReview: boolean
  error?: string
}

function newestResults(): string {
  const dir = 'battery-results'
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  if (files.length === 0) {
    console.error('[review-sheet] no files in battery-results/. Run the battery first.')
    process.exit(1)
  }
  return join(dir, files[files.length - 1])
}

const path = process.argv[2] ?? newestResults()
const payload = JSON.parse(readFileSync(path, 'utf8')) as {
  venueName: string
  startedAt: string
  scorer?: string
  summary: { averageScore: number; tier4Minus3Count: number }
  results: ResultRow[]
}

const review = payload.results.filter((r) => r.operatorReview && !r.error)
const skipped = payload.results.filter((r) => r.error)

const fmt = (n: number) => (n > 0 ? `+${n}` : String(n))

const lines: string[] = [
  `# Battery operator review sheet`,
  ``,
  `- **Run:** ${path} (${payload.venueName}, ${payload.startedAt})`,
  `- **Scorer:** ${payload.scorer ?? 'regex (pre-R2)'} — avg ${payload.summary.averageScore}, Tier-4 −3s: ${payload.summary.tier4Minus3Count}`,
  `- **Your job:** for each question below, check the answer against what you know is true`,
  `  and fill in the verdict line. When done, paste the verdicts into BLOOM-TEST-FINDINGS.md.`,
  `  The two verdicts that change the gate: a refusal where you KNOW the data existed`,
  `  (downgrade to −1) and a confident number you KNOW is wrong (downgrade to −3).`,
  ``,
  `Questions to review: ${review.length}${skipped.length ? `  (${skipped.length} errored, not reviewable)` : ''}`,
  ``,
  `---`,
]

for (const r of review) {
  lines.push(
    ``,
    `## Q${r.id} (Tier ${r.tier}, ${r.kind}) — machine score ${fmt(r.score)}`,
    ``,
    `**Question:** ${r.question}`,
    ``,
    `**Machine verdict:** ${r.reason}` +
      (r.scorer === 'regex-fallback'
        ? ` ⚠ REGEX FALLBACK — weak score, review carefully`
        : r.usedGroundTruth
          ? ` (checked against ground truth, judge confidence ${r.judgeConfidence ?? '?'})`
          : ` (no ground truth available, judge confidence ${r.judgeConfidence ?? '?'})`),
    ``,
    `**Answer:**`,
    ``,
    '```',
    r.answer.length > 2500 ? r.answer.slice(0, 2500) + '\n…[truncated — full text in the JSON]' : r.answer,
    '```',
    ``,
    `**Operator verdict:** [ ] agree ${fmt(r.score)}   [ ] downgrade to −1 (data existed)   [ ] downgrade to −3 (wrong number)   [ ] other: ______`,
    ``,
    `**Notes:** `,
    ``,
    `---`,
  )
}

const stamp = payload.startedAt.replace(/[:.]/g, '-')
const out = join('battery-results', `review-sheet-${stamp}.md`)
writeFileSync(out, lines.join('\n'), 'utf8')
console.log(`review sheet written → ${out}  (${review.length} questions)`)
