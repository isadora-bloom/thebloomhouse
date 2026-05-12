/**
 * scripts/test-instagram-parser.ts
 *
 * Unit-tests parseInstagramFollowersText without touching the DB.
 * Exercises all three paste shapes documented in the parser module.
 */

import { parseInstagramFollowersText } from '../src/lib/services/social/parsers/instagram-followers'

interface Case {
  name: string
  input: string
  expectMin?: number
  expectExact?: number
  assertContains?: string[]
}

const CASES: Case[] = [
  {
    name: 'Shape 1: one handle per line (JS snippet output)',
    input: 'rosie.hoyle\njen_bee\nmconn\nrosalie_hoyle_92\n',
    expectExact: 4,
    assertContains: ['rosie.hoyle', 'jen_bee', 'mconn', 'rosalie_hoyle_92'],
  },
  {
    name: 'Shape 2 (multi-line): handle on a line, display-name on next',
    input:
      'rosie.hoyle\nRosie Hoyle\nFollowed by jen_bee and 3 others\njen_bee\nJen Bee\n',
    expectMin: 2,
    assertContains: ['rosie.hoyle', 'jen_bee'],
  },
  {
    name: 'Shape 2 (inline): handle + display name + "Followed by ..."',
    input: 'rosie.hoyle  Rosie Hoyle  Followed by jen_bee\n',
    expectExact: 1,
    assertContains: ['rosie.hoyle'],
  },
  {
    name: 'Shape 3: tab-separated',
    input: 'rosie.hoyle\tRosie Hoyle\njen_bee\tJen Bee\n',
    expectExact: 2,
    assertContains: ['rosie.hoyle', 'jen_bee'],
  },
  {
    name: 'Dedup: duplicate handle in same paste',
    input: 'rosie.hoyle\nrosie.hoyle\njen_bee\n',
    expectExact: 2,
  },
  {
    name: 'Filters URL-shaped tokens',
    input: 'rosie.hoyle\nexample.com\nshould.io\n',
    expectExact: 1,
    assertContains: ['rosie.hoyle'],
  },
  {
    name: 'Strips leading @',
    input: '@rosie.hoyle\n@jen_bee\n',
    expectExact: 2,
    assertContains: ['rosie.hoyle', 'jen_bee'],
  },
  {
    name: '50-handle synthetic batch',
    input: Array.from({ length: 50 }, (_, i) =>
      `test_user_${(i + 1).toString().padStart(3, '0')}`,
    ).join('\n'),
    expectExact: 50,
  },
]

let failed = 0
for (const c of CASES) {
  const out = parseInstagramFollowersText(c.input)
  const handles = out.map((o) => o.handle)
  let ok = true
  if (c.expectExact !== undefined && out.length !== c.expectExact) {
    console.log(`FAIL ${c.name}: expected exactly ${c.expectExact}, got ${out.length} (${handles.join(', ')})`)
    ok = false
  }
  if (c.expectMin !== undefined && out.length < c.expectMin) {
    console.log(`FAIL ${c.name}: expected >= ${c.expectMin}, got ${out.length}`)
    ok = false
  }
  if (c.assertContains) {
    for (const h of c.assertContains) {
      if (!handles.includes(h)) {
        console.log(`FAIL ${c.name}: missing handle ${h} (got: ${handles.join(', ')})`)
        ok = false
      }
    }
  }
  if (ok) console.log(`PASS ${c.name} -> ${out.length} rows`)
  else failed += 1
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${CASES.length} parser cases passed.`)
