// Shared by venue-freeze.ts and the middleware. Kept apart so the
// middleware doesn't pull the service-role client into its bundle.

/** Message prefix raised by trg_venue_freeze (migration 417). */
export const VENUE_FROZEN_CODE = 'venue_frozen'

/** SQLSTATE the trigger raises. PostgREST turns PTxxx into HTTP xxx. */
export const VENUE_FROZEN_SQLSTATE = 'PT402'

export const VENUE_FROZEN_MESSAGE =
  "This venue's free trial has ended, so the account is read-only. Choose a plan in Settings, Billing to pick up where you left off."
