import { test } from '@playwright/test'

/**
 * §2 Gmail OAuth — NEEDS BUILDING
 *
 * Blocked on: missing /api/auth/gmail/callback route.
 *
 * Requirements to implement:
 *  - OAuth initiation route that redirects to Google consent screen with
 *    scopes gmail.modify, gmail.send.
 *  - Callback route /api/auth/gmail/callback that exchanges code for
 *    tokens and stores them in venue_config.gmail_tokens (jsonb).
 *  - Token-refresh flow (refresh_token → access_token) on expiry.
 *  - Disconnect flow that clears gmail_tokens.
 *  - UI entry point in /settings that shows connect/disconnect status.
 */

test.describe.skip('§2 Gmail OAuth (GAP: /api/auth/gmail/callback missing)', () => {
  test('Gmail connect flow stores tokens in venue_config', () => {})
  test('refresh_token is used when access_token expires', () => {})
  test('disconnect clears venue_config.gmail_tokens', () => {})
})
