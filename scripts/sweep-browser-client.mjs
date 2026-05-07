#!/usr/bin/env node
/**
 * One-shot sweep: replace local `createBrowserClient` + `getSupabase()`
 * helpers across the codebase with the canonical `createClient` from
 * `@/lib/supabase/client`. Lens 1 audit follow-up #74.
 *
 * Pattern matched:
 *   import { createBrowserClient } from '@supabase/ssr'
 *   ...
 *   function getSupabase() {
 *     return createBrowserClient(
 *       process.env.NEXT_PUBLIC_SUPABASE_URL!,
 *       process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
 *     )
 *   }
 *
 * Replaced with:
 *   import { createClient } from '@/lib/supabase/client'
 *
 * Then every getSupabase() call site becomes createClient().
 *
 * Files with non-standard shapes (module-level const supabase = ...,
 * server-side createServerClient) are SKIPPED — those need manual
 * review.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')

const candidates = execSync(
  `grep -rln "from '@supabase/ssr'" src --include="*.ts" --include="*.tsx"`,
  { cwd: repoRoot, encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f && !f.startsWith('src/lib/supabase/'))

// Greedy match from `function getSupabase() {` to its closing `}` on
// its own line. Works even when the function body has slight
// whitespace variation. We also confirm the body contains the two
// env-var references as a sanity check before substituting.
const STANDARD_HELPER_RE = /function\s+getSupabase\s*\(\)\s*\{[\s\S]*?\n\}/
const ENV_VAR_SANITY =
  /process\.env\.NEXT_PUBLIC_SUPABASE_URL.*process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/s

const IMPORT_RE = /^import \{ createBrowserClient \} from '@supabase\/ssr'\r?\n/m

let touched = 0
let skipped = 0

for (const rel of candidates) {
  const abs = path.join(repoRoot, rel)
  let src = readFileSync(abs, 'utf8')

  // Skip server-side files outright.
  if (src.includes('createServerClient')) {
    skipped++
    continue
  }

  // Skip files that don't have the standard getSupabase shape — those
  // use module-level const or are otherwise non-trivial.
  const helperMatch = src.match(STANDARD_HELPER_RE)
  if (!helperMatch || !IMPORT_RE.test(src) || !ENV_VAR_SANITY.test(helperMatch[0])) {
    skipped++
    continue
  }

  // 1. Replace the import.
  src = src.replace(
    IMPORT_RE,
    "import { createClient } from '@/lib/supabase/client'\n",
  )

  // 2. Remove the helper. Strip trailing blank line too.
  src = src.replace(STANDARD_HELPER_RE, '')
  src = src.replace(/\n{3,}/g, '\n\n')

  // 3. Replace call sites.
  src = src.replace(/\bgetSupabase\(\)/g, 'createClient()')

  writeFileSync(abs, src, 'utf8')
  touched++
  console.log('✓', rel)
}

console.log(`\nDone. Touched ${touched}, skipped ${skipped}.`)
