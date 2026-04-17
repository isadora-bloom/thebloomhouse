# Gmail OAuth Flow (GAP-13)

The Bloom House connects a venue's Gmail inbox so the Agent can read inquiries
and draft replies. This document describes the OAuth flow, required env vars,
and the redirect URIs registered with Google.

## Routes

- `GET  /api/auth/gmail?returnTo=/some/path`
  Generates a Google consent URL, stores CSRF state + returnTo in an HttpOnly
  signed cookie, and 302s the browser to Google. Requires a logged-in platform
  user (coordinator / manager / org_admin / super_admin). Anonymous users are
  bounced to `/login?redirect=...`.

- `GET  /api/auth/gmail/callback`
  OAuth redirect target. Validates the CSRF state cookie, exchanges the code
  for tokens via `google-auth-library`, fetches the connected email address
  from `https://www.googleapis.com/oauth2/v2/userinfo`, and upserts a row in
  `gmail_connections`. First connection for a venue is marked
  `is_primary = true`. Redirects back to `returnTo` with
  `?gmail=connected&email=...` on success or `?gmail=error&reason=<code>` on
  failure.

- `POST /api/auth/gmail/disconnect` — body `{ connectionId }`
  Verifies the connection belongs to the caller's venue, best-effort revokes
  the refresh token at `https://oauth2.googleapis.com/revoke`, then updates
  the row to `status = 'disconnected'`, `sync_enabled = false`, and
  `is_primary = false`. The row is kept (not deleted) so history is preserved.
  If the disconnected row was the primary, promotes the oldest remaining
  active row to primary.

## Scopes

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/userinfo.email`

`access_type=offline` and `prompt=consent` are always set so we always receive
a refresh token.

## Env vars

- `GOOGLE_CLIENT_ID` — required
- `GOOGLE_CLIENT_SECRET` — required. If missing or still set to the
  `PASTE_YOUR_NEW_CLIENT_SECRET_HERE` placeholder, the flow surfaces a clear
  `?gmail=error&reason=not_configured` instead of crashing.
- `GOOGLE_OAUTH_REDIRECT_URI` — optional override. If unset we compute
  `${origin}/api/auth/gmail/callback`.

## Registered redirect URIs

Add these in Google Cloud Console (Credentials → OAuth 2.0 client):

- `http://localhost:3000/api/auth/gmail/callback`
- `https://bloomhouse.ai/api/auth/gmail/callback`

## Error reason codes

Returned as `?gmail=error&reason=<code>`:

- `access_denied` — user declined on Google's consent screen
- `not_configured` — `GOOGLE_CLIENT_SECRET` missing or placeholder
- `bad_state` — CSRF state cookie missing / mismatched / stale
- `no_code` — Google called back without a `code` param
- `auth_mismatch` — the user who started the flow is not the user finishing it
- `token_exchange_failed` — Google rejected the authorization code
- `no_access_token` / `no_refresh_token` — token response was incomplete
- `db_write_failed` — Supabase upsert into `gmail_connections` failed
- `google_error` — other upstream error from Google

## UI integration

`/onboarding` and `/agent/settings` both:

1. Link "Connect Gmail" buttons to
   `/api/auth/gmail?returnTo=<current-path>`.
2. On mount, read `?gmail=connected|error` from the URL, show a toast / banner,
   and then `window.history.replaceState` to clean the URL.
3. List connected accounts from `gmail_connections` (via
   `GET /api/agent/gmail`) with a "Disconnect" button that POSTs to
   `/api/auth/gmail/disconnect`.
