// Edge-case tests for normalizeSource. Run with:
//   npx tsx scripts/test-normalize-source.mts
//
// Pure-function unit tests — no DB, no server. Locks in the alias table
// against regression. If you change the canonical list or aliases in
// src/lib/services/normalize-source.ts, update this script alongside so
// the expected outputs stay in sync.
import { normalizeSource, isCanonicalSource, CANONICAL_SOURCES } from '../src/lib/services/normalize-source'

type Case = { input: string | null | undefined; expected: string; reason: string }

const cases: Case[] = [
  // Null/undefined/empty
  { input: null, expected: 'other', reason: 'null' },
  { input: undefined, expected: 'other', reason: 'undefined' },
  { input: '', expected: 'other', reason: 'empty string' },
  { input: '   ', expected: 'other', reason: 'whitespace only' },
  { input: '\t\n', expected: 'other', reason: 'tabs + newlines' },

  // Already canonical — pass through
  { input: 'the_knot', expected: 'the_knot', reason: 'canonical passes through' },
  { input: 'wedding_wire', expected: 'wedding_wire', reason: 'canonical snake passes through' },
  { input: 'venue_calculator', expected: 'venue_calculator', reason: 'canonical venue_calculator' },
  { input: 'vendor_referral', expected: 'vendor_referral', reason: 'canonical vendor_referral' },

  // Common aliases
  { input: 'theknot', expected: 'the_knot', reason: 'theknot -> the_knot' },
  { input: 'The Knot', expected: 'the_knot', reason: '"The Knot" with space + case' },
  { input: 'THE KNOT', expected: 'the_knot', reason: 'upper case' },
  { input: 'knot', expected: 'the_knot', reason: 'knot -> the_knot' },
  { input: 'weddingwire', expected: 'wedding_wire', reason: 'weddingwire -> wedding_wire (F2 canonical switch)' },
  { input: 'WeddingWire', expected: 'wedding_wire', reason: 'case variant' },
  { input: 'Wedding Wire', expected: 'wedding_wire', reason: 'with space' },
  { input: 'ww', expected: 'wedding_wire', reason: 'abbreviation' },

  // Compound drift
  { input: 'website_calculator', expected: 'venue_calculator', reason: 'recent alias' },
  { input: 'pricing_calculator', expected: 'venue_calculator', reason: 'pricing alias' },
  { input: 'interactive_calculator', expected: 'venue_calculator', reason: 'interactive alias' },
  { input: 'our_website', expected: 'website', reason: 'our_website -> website' },
  { input: 'website_form', expected: 'website', reason: 'website_form -> website' },

  // Direct aliases
  { input: 'email', expected: 'direct', reason: 'email -> direct' },
  { input: 'direct_email', expected: 'direct', reason: 'direct_email -> direct' },
  { input: 'phone', expected: 'direct', reason: 'phone -> direct' },

  // Unknown falls through to other
  { input: 'some_random_string', expected: 'other', reason: 'unknown -> other' },
  { input: 'zzzz', expected: 'other', reason: 'nonsense -> other' },
  { input: 'instagram ads brand awareness', expected: 'other', reason: 'long unknown string -> other' },

  // Punctuation collapse
  { input: 'the--knot', expected: 'the_knot', reason: 'double dashes collapse' },
  { input: 'the...knot', expected: 'the_knot', reason: 'dots collapse' },
  { input: 'the_knot.com', expected: 'the_knot', reason: '.com suffix collapses to alias' },

  // Unicode — not in alias table, should fall to 'other'
  { input: 'the_knöt', expected: 'other', reason: 'unicode letter breaks ascii-only match' },

  // Very long string (still normalized + looked up)
  { input: 'x'.repeat(500) + '_the_knot', expected: 'other', reason: 'padding kills alias match' },

  // IG / insta
  { input: 'ig', expected: 'instagram', reason: 'ig abbreviation' },
  { input: 'IG', expected: 'instagram', reason: 'IG upper' },
  { input: 'insta', expected: 'instagram', reason: 'insta alias' },

  // Google family
  { input: 'google_analytics', expected: 'google', reason: 'google_analytics -> google' },
  { input: 'adwords', expected: 'google_ads', reason: 'legacy adwords -> google_ads' },
  { input: 'GMB', expected: 'google_business', reason: 'GMB -> google_business' },

  // Vendor / referral
  { input: 'vendor', expected: 'vendor_referral', reason: 'vendor -> vendor_referral' },
  { input: 'friend', expected: 'other', reason: 'friend not in alias table (note: extraction.ts has it but normalize-source does not)' },

  // Walk-in variants
  { input: 'walkin', expected: 'walk_in', reason: 'walkin alias' },
  { input: 'walk-in', expected: 'walk_in', reason: 'hyphenated alias' },
  { input: 'Walk In', expected: 'walk_in', reason: 'space + case' },
]

let pass = 0
let fail = 0
const failures: string[] = []
for (const c of cases) {
  const got = normalizeSource(c.input)
  const ok = got === c.expected
  if (ok) pass++
  else {
    fail++
    failures.push(`  [FAIL] input=${JSON.stringify(c.input)} expected=${c.expected} got=${got}   (${c.reason})`)
  }
}

console.log(`normalizeSource: ${pass}/${pass + fail} passed`)
for (const f of failures) console.log(f)

// Bonus: isCanonicalSource
const isCanPass = isCanonicalSource('the_knot') && !isCanonicalSource('theknot')
console.log(`isCanonicalSource: ${isCanPass ? 'PASS' : 'FAIL'}`)

// Confirm CANONICAL_SOURCES stays stable (exact length sanity)
console.log(`CANONICAL_SOURCES size: ${CANONICAL_SOURCES.length} (expected 20)`)

process.exit(fail > 0 ? 1 : 0)
