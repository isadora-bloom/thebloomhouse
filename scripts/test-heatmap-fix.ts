/**
 * Pure-function tests for the heat-map fix patterns (2026-05-01).
 *
 * Covers:
 *   - NOT_INTERESTED_PATTERNS detect realistic decline language
 *   - TOUR_CANCEL_PATTERNS detect plain-email cancellation language
 *   - Patterns DON'T match neutral / positive language
 *
 * The dedup logic itself is exercised at integration time (dedup-fire-
 * once-events.ts) and through the email-pipeline / signal-inference
 * write paths.
 *
 * Run with: npx tsx scripts/test-heatmap-fix.ts
 */

import {
  NOT_INTERESTED_PATTERNS,
  TOUR_CANCEL_PATTERNS,
  TOUR_REQUEST_PATTERNS,
} from '../src/lib/services/attribution/signal-inference'

let pass = 0
let fail = 0

function assertMatches(text: string, patterns: RegExp[], shouldMatch: boolean, label: string): void {
  const matched = patterns.some((r) => r.test(text))
  if (matched === shouldMatch) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${label}\n  text: ${text.slice(0, 100)}\n  expected match=${shouldMatch}, got match=${matched}`)
  }
}

// ---------------------------------------------------------------------------
// 1. NOT_INTERESTED_PATTERNS — should match decline language
// ---------------------------------------------------------------------------

assertMatches('Unfortunately, we have decided to go with another venue. Thank you so much for your time!', NOT_INTERESTED_PATTERNS, true, 'going with another venue')
assertMatches("We're going in a different direction with the wedding.", NOT_INTERESTED_PATTERNS, true, 'going in a different direction')
assertMatches("Thanks for everything, but we've decided not to move forward.", NOT_INTERESTED_PATTERNS, true, 'decided not to move forward')
assertMatches("We won't be moving forward with you.", NOT_INTERESTED_PATTERNS, true, "won't be moving forward")
assertMatches("We've decided to pause our wedding planning.", NOT_INTERESTED_PATTERNS, true, 'decided to pause')
assertMatches("Putting things on hold for now, will reach out if that changes.", NOT_INTERESTED_PATTERNS, true, 'put on hold')
assertMatches("We're no longer interested in your venue.", NOT_INTERESTED_PATTERNS, true, 'no longer interested')
assertMatches("Going with another option, thanks.", NOT_INTERESTED_PATTERNS, true, 'another option')
assertMatches("Please cancel our inquiry — we found something else.", NOT_INTERESTED_PATTERNS, true, 'cancel our inquiry')
assertMatches("Please remove us from consideration.", NOT_INTERESTED_PATTERNS, true, 'remove from consideration')
assertMatches("We've found another venue that fit better.", NOT_INTERESTED_PATTERNS, true, 'found another venue')
assertMatches("Thanks but we chose our venue elsewhere.", NOT_INTERESTED_PATTERNS, true, 'chose elsewhere')

// Should NOT match — these are positive / neutral / coordination
assertMatches("We're so excited to move forward with you!", NOT_INTERESTED_PATTERNS, false, 'positive: excited to move forward')
assertMatches("Thanks so much, we'll be in touch shortly.", NOT_INTERESTED_PATTERNS, false, 'neutral: in touch')
assertMatches("We need to reschedule the tour for next week.", NOT_INTERESTED_PATTERNS, false, 'reschedule (NOT cancel/decline)')
assertMatches("Hi! Looking forward to seeing the venue.", NOT_INTERESTED_PATTERNS, false, 'positive: looking forward')

// ---------------------------------------------------------------------------
// 2. TOUR_CANCEL_PATTERNS — should match cancellation language
// ---------------------------------------------------------------------------

assertMatches("We need to cancel our tour on Saturday.", TOUR_CANCEL_PATTERNS, true, 'need to cancel our tour')
assertMatches("I have to cancel my tour, family emergency.", TOUR_CANCEL_PATTERNS, true, 'have to cancel my tour')
assertMatches("We won't be able to make the tour this weekend.", TOUR_CANCEL_PATTERNS, true, "won't be able to make the tour")
assertMatches("I can't attend the tour at 2pm Sunday.", TOUR_CANCEL_PATTERNS, true, "can't attend the tour")
assertMatches("Our tour has been cancelled.", TOUR_CANCEL_PATTERNS, true, 'has been cancelled')
assertMatches("Please cancel our tour.", TOUR_CANCEL_PATTERNS, true, 'please cancel our tour')

// Reschedule is NOT a cancel — should not fire (the parser routes
// reschedules to tour_rescheduled separately)
assertMatches("Can we reschedule our tour for next week?", TOUR_CANCEL_PATTERNS, false, 'reschedule (not cancel)')
assertMatches("We need to move our tour to a different day.", TOUR_CANCEL_PATTERNS, false, 'move (not cancel)')

// Pure tour requests should NOT match cancel
assertMatches("We'd love to schedule a tour!", TOUR_CANCEL_PATTERNS, false, 'tour request (not cancel)')

// ---------------------------------------------------------------------------
// 3. TOUR_REQUEST_PATTERNS — sanity check existing patterns still work
// ---------------------------------------------------------------------------

assertMatches("We'd love to tour the venue.", TOUR_REQUEST_PATTERNS, true, 'love to tour')
assertMatches("Can we come see your space?", TOUR_REQUEST_PATTERNS, true, 'can we come see')
assertMatches("Please cancel our tour.", TOUR_REQUEST_PATTERNS, false, 'cancel should NOT fire tour-request')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
