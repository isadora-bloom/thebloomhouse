import { test } from '@playwright/test'

/**
 * §13 Push Notifications — NEEDS BUILDING
 *
 * GAP-03: Web push subscription flow + server-side notification dispatch
 * are not implemented.
 */

test.describe.skip('§13 Push notifications (GAP-03)', () => {
  test('couple can opt in to push; service worker registers subscription', () => {})
  test('coordinator-sent message triggers push to subscribed couple', () => {})
  test('VAPID keys present in env and accepted by browser push service', () => {})
})
