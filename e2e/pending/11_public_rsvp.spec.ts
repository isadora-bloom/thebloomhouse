import { test } from '@playwright/test'

/**
 * §11 Public RSVP Form — NEEDS BUILDING
 *
 * GAP-11: The public RSVP form (wedding website) is not implemented. When
 * a guest visits the couple's public wedding page, they should be able to
 * RSVP (accept/decline + meal choice + plus-one) without authentication,
 * and the submission should land on guests + rsvp_responses tables.
 */

test.describe.skip('§11 Public RSVP form (GAP-11)', () => {
  test('guest can RSVP yes on public wedding URL without logging in', () => {})
  test('RSVP submission creates rsvp_responses row with correct wedding_id', () => {})
  test('plus-one and meal choice are persisted', () => {})
  test('couple dashboard reflects new RSVP within a short poll', () => {})
})
