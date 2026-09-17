// SessionStart hook: prints the most recent diary entries so every Claude Code
// session starts knowing what Isadora and Phil did lately. Whatever this prints
// is added to the session's context. See diary/README.md.
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAYS = 3
const diaryDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'diary')

try {
  const entries = readdirSync(diaryDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(f))
    .sort()

  // Last three dates that have any entries, not the last three calendar days,
  // so a weekend off doesn't leave the session with nothing.
  const dates = [...new Set(entries.map((f) => f.slice(0, 10)))].slice(-DAYS)
  const recent = entries.filter((f) => dates.includes(f.slice(0, 10)))

  if (recent.length === 0) process.exit(0)

  const today = new Date().toISOString().slice(0, 10)
  console.log(`# Work diary, last ${dates.length} day(s) with entries (today is ${today})\n`)
  console.log('Write today\'s highlights to diary/<date>-<your git first name>.md as work lands. Rules in CLAUDE.md.\n')
  for (const f of recent) {
    console.log(`--- diary/${f} ---`)
    console.log(readFileSync(join(diaryDir, f), 'utf8').trim())
    console.log()
  }
} catch {
  // Never block a session over the diary.
  process.exit(0)
}
