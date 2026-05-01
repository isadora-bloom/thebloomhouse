/**
 * One-shot script: update doctrine-compliance.yaml cell statuses to
 * reflect what the recent Tier 0 + Tier 1 + Repair J/K/L/M/N commits
 * actually closed. Run once, then delete (or keep for the next batch).
 *
 * Why a script instead of inline Edit: 22 cells × 4 lines per edit
 * = error-prone manual work. A script is auditable, reversible, and
 * idempotent.
 *
 * Usage: npx tsx scripts/update-doctrine-cells.ts
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const YAML_PATH = join(process.cwd(), 'doctrine-compliance.yaml')

// Cell ID → new status. Notes are appended via a separate map below
// so the script stays readable.
const STATUS_UPDATES: Record<string, string> = {
  'INV-7.3': 'enforced',
  'ANTI-2.6.4': 'enforced',
  'INV-4.4-A': 'enforced',
  'INV-7.4': 'enforced',
  'INV-8.5.5': 'enforced',
  'STAGE-10.2.6': 'enforced',
  'STAGE-10.2.10': 'enforced',
  'STAGE-10.2.14': 'enforced',
  'STAGE-10.2.17': 'enforced',
  'ARCH-10.3': 'enforced',
  'INV-12.3': 'enforced',
  'INV-13': 'enforced',
  'INV-14': 'enforced',
  'INV-15': 'enforced',
  'INV-16': 'enforced',
  'OPS-21.3.3': 'partial',
  'OPS-21.3.5': 'partial',
  'OPS-21.4.2': 'enforced',
  'OPS-21.4.3': 'enforced',
  'OPS-21.5.2': 'enforced',
  'OPS-21.5.6-C': 'enforced',
  'OPS-22.1': 'enforced',
  'OPS-22.2': 'enforced',
}

const yaml = readFileSync(YAML_PATH, 'utf-8')
const lines = yaml.split('\n')

let updated = 0
const skipped: string[] = []
const seen = new Set<string>()

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  // Match `- id: SOMETHING`
  const idMatch = line.match(/^- id:\s+([A-Z\-0-9._]+)\s*$/)
  if (!idMatch) continue

  const cellId = idMatch[1]
  if (!STATUS_UPDATES[cellId]) continue
  if (seen.has(cellId)) continue
  seen.add(cellId)

  // Next line should be `  status: <something>`
  const nextLine = lines[i + 1]
  const statusMatch = nextLine?.match(/^(\s+)status:\s+(.+)$/)
  if (!statusMatch) {
    skipped.push(`${cellId}: status line not on next line`)
    continue
  }

  const indent = statusMatch[1]
  const oldStatus = statusMatch[2].trim()
  const newStatus = STATUS_UPDATES[cellId]

  if (oldStatus === newStatus) {
    skipped.push(`${cellId}: already ${newStatus}`)
    continue
  }

  lines[i + 1] = `${indent}status: ${newStatus}`
  console.log(`  ${cellId}: ${oldStatus} → ${newStatus}`)
  updated++
}

const missingCells: string[] = []
for (const cellId of Object.keys(STATUS_UPDATES)) {
  if (!seen.has(cellId)) {
    missingCells.push(cellId)
  }
}

writeFileSync(YAML_PATH, lines.join('\n'), 'utf-8')

console.log(`\nUpdated ${updated} cells.`)
if (skipped.length > 0) {
  console.log(`Skipped: ${skipped.join('; ')}`)
}
if (missingCells.length > 0) {
  console.log(`Missing from YAML (didn't exist as own line): ${missingCells.join(', ')}`)
}
