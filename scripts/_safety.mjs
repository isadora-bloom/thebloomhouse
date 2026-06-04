// Shared safety guard for destructive operator scripts (HARDENING-SCOPE Area 2).
//
// ESM module so it can be imported by BOTH .mjs scripts and .ts scripts run
// under tsx (`import { ... } from './_safety.mjs'`). Dependency-free on
// purpose — these guards must work even before node_modules is installed.
//
// Doctrine (matches scripts/branch-sql.mjs + the integration-test guards):
//   - Default to DRY-RUN. Writing requires an explicit `--apply` flag.
//   - Refuse the PROD project ref unless `--allow-prod` is ALSO passed.
//
// Usage in a script (after the Supabase URL is known):
//   import { parseSafetyFlags, assertNotProd, requireApply } from './_safety.mjs'
//   const { apply, allowProd } = parseSafetyFlags(process.argv)
//   assertNotProd(url, { allowProd })          // exits 0 if prod + !allowProd
//   if (!requireApply(apply, 'cleanup-foo')) { /* dry-run: print, skip writes */ }

// The production Supabase project ref. If a script's URL contains this and
// --allow-prod was not passed, we refuse (exit 0 so it reads as a clean skip,
// matching the integration-test "REFUSED" convention).
export const PROD_REF = 'jsxxgwprxuqgcauzlxcb'

/**
 * Parse the two safety flags from argv.
 * @param {string[]} argv typically process.argv
 * @returns {{ apply: boolean, allowProd: boolean }}
 */
export function parseSafetyFlags(argv = process.argv) {
  return {
    apply: argv.includes('--apply'),
    allowProd: argv.includes('--allow-prod'),
  }
}

/**
 * Refuse to run against PROD unless explicitly allowed.
 * Exits the process with code 0 (clean skip) when refusing.
 * @param {string} url the Supabase URL the script will write to
 * @param {{ allowProd?: boolean }} [opts]
 */
export function assertNotProd(url, { allowProd = false } = {}) {
  if (url && url.includes(PROD_REF) && !allowProd) {
    console.log('[safety] REFUSED — points at PROD; pass --allow-prod to override')
    process.exit(0)
  }
}

/**
 * Gate destructive writes behind --apply. In dry-run (no --apply) prints a
 * notice and returns false so the caller can skip the write section.
 * @param {boolean} apply whether --apply was passed
 * @param {string} label short script/operation label for the message
 * @returns {boolean} true when writes should proceed
 */
export function requireApply(apply, label) {
  if (!apply) {
    console.log(`[safety] DRY-RUN — no writes. Pass --apply to execute (${label}).`)
    return false
  }
  return true
}
