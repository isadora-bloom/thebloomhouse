/**
 * Fixture loader for the crm-import adapter tests.
 *
 * The fixture CSVs under `./fixtures/` open with a `#`-prefixed
 * provenance comment ("RECONSTRUCTED, NOT CAPTURED...") for anyone
 * reading the file directly. The shared CSV parser
 * (`parseCsvRows` in `src/lib/services/brain-dump/csv-shape.ts`) has
 * no concept of comment lines, so this strips any leading `#` lines
 * before handing the text to an adapter's `parse()`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function loadFixtureCsv(filename: string): string {
  const raw = readFileSync(join(__dirname, 'fixtures', filename), 'utf8')
  const lines = raw.split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i]!.trim().startsWith('#')) i++
  return lines.slice(i).join('\n')
}
