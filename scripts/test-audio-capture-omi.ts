/**
 * Pure-function tests for the OMI audio-capture adapter (T2-E Phase 2).
 *
 * Verifies:
 *   - extractSessionId pulls session_id from realistic OMI payloads
 *   - parseSegments normalises is_user / speaker / start / end into
 *     the NormalizedSegment shape, scrubs empty text rows, rounds
 *     float seconds to integer ms
 *   - speakerNormalised follows is_user → host/visitor/unknown
 *   - Empty / malformed payloads return [] (caller acks 200)
 *
 * Run with: npx tsx scripts/test-audio-capture-omi.ts
 */

import { omiAdapter } from '../src/lib/services/audio-capture/adapters/omi-adapter'
import type { NormalizedSegment } from '../src/lib/services/audio-capture/types'

let pass = 0
let fail = 0

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

// ---------------------------------------------------------------------------
// 1. extractSessionId
// ---------------------------------------------------------------------------

assertEq(
  omiAdapter.extractSessionId({ session_id: 'abc-123', segments: [] }),
  'abc-123',
  'extractSessionId pulls string',
)
assertEq(omiAdapter.extractSessionId({ session_id: '' }), null, 'empty string → null')
assertEq(omiAdapter.extractSessionId({}), null, 'missing key → null')
assertEq(omiAdapter.extractSessionId(null), null, 'null payload → null')
assertEq(omiAdapter.extractSessionId({ session_id: 12345 }), null, 'number is not a session_id')

// ---------------------------------------------------------------------------
// 2. parseSegments — basic shape
// ---------------------------------------------------------------------------

const basic = omiAdapter.parseSegments({
  session_id: 'abc',
  segments: [
    { text: 'Welcome to Hawthorne Manor', is_user: true, start: 0.0, end: 2.5, speaker: 'speaker_0' },
    { text: 'Thanks so much for having us', is_user: false, start: 3.0, end: 5.2, speaker: 'speaker_1' },
  ],
})

assertEq(basic.length, 2, 'two segments parsed')
assertEq(basic[0].text, 'Welcome to Hawthorne Manor', 'segment 0 text')
assertEq(basic[0].speaker, 'speaker_0', 'segment 0 speaker raw')
assertEq(basic[0].speakerNormalised, 'host', 'is_user=true → host')
assertEq(basic[0].isUser, true, 'is_user preserved as bool')
assertEq(basic[0].startMs, 0, 'start 0.0s → 0 ms')
assertEq(basic[0].endMs, 2500, 'end 2.5s → 2500 ms')
assertEq(basic[1].speakerNormalised, 'visitor', 'is_user=false → visitor')
assertEq(basic[1].startMs, 3000, 'start 3.0s → 3000 ms')
assertEq(basic[1].endMs, 5200, 'end 5.2s → 5200 ms')

// ---------------------------------------------------------------------------
// 3. Empty text scrubbed
// ---------------------------------------------------------------------------

const withEmpty = omiAdapter.parseSegments({
  session_id: 'x',
  segments: [
    { text: 'Real text' },
    { text: '   ' },          // whitespace-only
    { text: '' },              // empty
    { text: 'Another real one' },
  ],
})
assertEq(withEmpty.length, 2, 'whitespace + empty segments dropped')
assertEq(withEmpty[0].text, 'Real text', 'first kept')
assertEq(withEmpty[1].text, 'Another real one', 'second kept')

// ---------------------------------------------------------------------------
// 4. is_user absent → unknown
// ---------------------------------------------------------------------------

const noUserFlag = omiAdapter.parseSegments({
  session_id: 'x',
  segments: [{ text: 'Hello', speaker: 'speaker_2' }],
})
assertEq(noUserFlag[0].speakerNormalised, 'unknown', 'no is_user → unknown')
assertEq(noUserFlag[0].isUser, null, 'no is_user → null')
assertEq(noUserFlag[0].speaker, 'speaker_2', 'speaker raw preserved')

// ---------------------------------------------------------------------------
// 5. Missing timing → null
// ---------------------------------------------------------------------------

const noTiming = omiAdapter.parseSegments({
  session_id: 'x',
  segments: [{ text: 'No timestamps' }],
})
assertEq(noTiming[0].startMs, null, 'missing start → null')
assertEq(noTiming[0].endMs, null, 'missing end → null')

// ---------------------------------------------------------------------------
// 6. Malformed payloads
// ---------------------------------------------------------------------------

assertEq(omiAdapter.parseSegments(null).length, 0, 'null → empty')
assertEq(omiAdapter.parseSegments(undefined).length, 0, 'undefined → empty')
assertEq(omiAdapter.parseSegments({}).length, 0, '{} → empty')
assertEq(omiAdapter.parseSegments({ segments: 'not-an-array' }).length, 0, 'segments not-an-array → empty')
assertEq(omiAdapter.parseSegments({ segments: [] }).length, 0, 'empty segments → empty')

// ---------------------------------------------------------------------------
// 7. providerKey
// ---------------------------------------------------------------------------

assertEq(omiAdapter.providerKey, 'omi', 'providerKey is omi')

// ---------------------------------------------------------------------------
// 8. metadata captures forensic raw fields
// ---------------------------------------------------------------------------

const meta = omiAdapter.parseSegments({
  session_id: 'x',
  segments: [{ text: 'hi', speaker: 'speaker_0', is_user: true }],
})
const m = meta[0].metadata as { speaker_raw?: unknown; is_user_raw?: unknown }
if (m.speaker_raw === 'speaker_0' && m.is_user_raw === true) pass++
else { fail++; console.error('FAIL: metadata raw capture', JSON.stringify(meta[0].metadata)) }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
