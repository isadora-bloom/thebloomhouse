/**
 * Planning a guest-list CSV import against the guests already on file.
 *
 * The import used to be a flat insert. Re-importing the same file, which
 * is what anyone does after fixing three rows in a spreadsheet, doubled
 * the list, and on a 180-guest wedding that is not something you tidy up
 * by hand. Found while verifying the September parity audit, 2026-09-17.
 *
 * Two rules do most of the work here:
 *
 * One, an incoming row matches on email when it has one, and on first +
 * last name otherwise. Email is the stronger key, so it wins even when
 * the name differs (people change names; a row with the same address is
 * the same person). Two people genuinely called Sam Patel with no email
 * between them will collide, and that is the honest limit of a CSV.
 *
 * Two, an update only writes the columns the CSV actually supplied. This
 * is the part that would quietly cause damage otherwise: the insert
 * shape carries defaults (`rsvp_status: 'pending'`, `has_plus_one:
 * false`, `invitation_sent: false`), and applying those to an existing
 * row would reset an RSVP somebody had already given.
 */

/** A parsed CSV row, keyed by its original header text. */
export type IncomingRow = Record<string, string>

/** The subset of a stored guest needed to match against. */
export interface ExistingGuest {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

export interface GuestImportPlan {
  /** Fully-shaped rows for `.insert()`. */
  inserts: Record<string, unknown>[]
  /** Per-row patches for `.update()`, already narrowed to supplied columns. */
  updates: Array<{ id: string; fields: Record<string, unknown> }>
  /**
   * Rows that matched an existing guest but supplied nothing new, so
   * there is no reason to write them. Counted, not written.
   */
  unchanged: number
  /**
   * Later rows in the same file that collided with an earlier row. The
   * first wins; these are dropped so one file cannot double its own
   * guests.
   */
  duplicateRowsInFile: number
}

/** Map free-text RSVP values onto the app's statuses; null = leave alone. */
export function normaliseRsvp(value: string): string | null {
  const s = value.trim().toLowerCase()
  if (!s) return null
  if (['yes', 'y', 'attending', 'accepted', 'accept', 'confirmed', 'will attend', 'coming'].includes(s)) return 'attending'
  if (['no', 'n', 'declined', 'decline', 'not attending', 'regrets', 'cant attend', "can't attend", 'not coming'].includes(s)) return 'declined'
  if (['maybe', 'tentative', 'unsure'].includes(s)) return 'maybe'
  if (['pending', 'invited', 'no response', 'awaiting'].includes(s)) return 'pending'
  return null
}

function emailKey(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase()
  return e ? `e:${e}` : null
}

function nameKey(first: string | null | undefined, last: string | null | undefined): string | null {
  const f = (first ?? '').trim().toLowerCase()
  const l = (last ?? '').trim().toLowerCase()
  if (!f && !l) return null
  return `n:${f}|${l}`
}

/**
 * Turn one CSV row into the guest columns it supplies, resolving the two
 * synthetic headers (`_full_name`, `_plus_one`) on the way.
 *
 * Blank cells are left out rather than written as empty strings: an
 * empty cell in a spreadsheet means "nothing to say here", not "clear
 * what you have". Writing `''` into a typed column is also how you earn
 * a 22P02.
 */
export function fieldsFromRow(
  row: IncomingRow,
  mapping: Record<string, string>
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}

  for (const [header, column] of Object.entries(mapping)) {
    const raw = row[header]
    if (raw === undefined || raw === null) continue
    const value = String(raw).trim()
    if (!value) continue
    fields[column] = value
  }

  // A single "name" column becomes first + last, without overwriting
  // either if the file also had them separately.
  if (typeof fields._full_name === 'string') {
    const parts = fields._full_name.trim().split(/\s+/)
    if (!fields.first_name && parts.length) fields.first_name = parts[0]
    if (!fields.last_name && parts.length > 1) fields.last_name = parts.slice(1).join(' ')
    delete fields._full_name
  }

  // A plus-one column may hold a name or a yes/no. Either way it says
  // whether there is one, and a name is worth keeping.
  if (fields._plus_one !== undefined) {
    const s = String(fields._plus_one).trim()
    const lower = s.toLowerCase()
    const negative = ['no', 'n', 'false', '0', 'none'].includes(lower)
    const affirmativeOnly = ['yes', 'y', 'true', '1', '+1'].includes(lower)
    fields.has_plus_one = s !== '' && !negative
    if (fields.has_plus_one && !affirmativeOnly && !fields.plus_one_name) {
      fields.plus_one_name = s
    }
    delete fields._plus_one
  }

  if (typeof fields.rsvp_status === 'string') {
    const mapped = normaliseRsvp(fields.rsvp_status)
    if (mapped) fields.rsvp_status = mapped
    else delete fields.rsvp_status
  }

  return fields
}

/**
 * Decide, for every row in the file, whether it is a new guest, a patch
 * to one already on file, or nothing at all.
 */
export function planGuestImport(opts: {
  rows: IncomingRow[]
  mapping: Record<string, string>
  existing: ExistingGuest[]
  venueId: string
  weddingId: string
}): GuestImportPlan {
  const { rows, mapping, existing, venueId, weddingId } = opts

  const byEmail = new Map<string, ExistingGuest>()
  const byName = new Map<string, ExistingGuest>()
  for (const guest of existing) {
    const e = emailKey(guest.email)
    // First writer wins, so an existing duplicate pair stays stable
    // rather than flip-flopping between imports.
    if (e && !byEmail.has(e)) byEmail.set(e, guest)
    const n = nameKey(guest.first_name, guest.last_name)
    if (n && !byName.has(n)) byName.set(n, guest)
  }

  const plan: GuestImportPlan = {
    inserts: [],
    updates: [],
    unchanged: 0,
    duplicateRowsInFile: 0,
  }
  const claimed = new Set<string>()

  for (const row of rows) {
    const fields = fieldsFromRow(row, mapping)

    const e = emailKey(fields.email as string | undefined)
    const n = nameKey(fields.first_name as string | undefined, fields.last_name as string | undefined)

    // A row with neither a name nor an email is noise.
    if (!e && !n) continue

    const rowKey = e ?? n!
    if (claimed.has(rowKey)) {
      plan.duplicateRowsInFile++
      continue
    }
    claimed.add(rowKey)

    const match = (e ? byEmail.get(e) : undefined) ?? (n ? byName.get(n) : undefined)

    if (match) {
      // Only the columns this row actually supplied, so an existing RSVP,
      // meal choice or note survives a re-import.
      const patch: Record<string, unknown> = {}
      for (const [column, value] of Object.entries(fields)) {
        patch[column] = value
      }
      if (Object.keys(patch).length === 0) {
        plan.unchanged++
      } else {
        plan.updates.push({ id: match.id, fields: patch })
      }
      continue
    }

    plan.inserts.push({
      venue_id: venueId,
      wedding_id: weddingId,
      rsvp_status: 'pending',
      has_plus_one: false,
      invitation_sent: false,
      ...fields,
      // A guest has to be called something to be findable in the list.
      first_name: (fields.first_name as string | undefined) || 'Unknown',
    })
  }

  return plan
}

/**
 * How many rows in this file already exist, for the line shown in the
 * preview before anyone commits to the import.
 */
export function countMatches(opts: {
  rows: IncomingRow[]
  mapping: Record<string, string>
  existing: ExistingGuest[]
}): { matching: number; newGuests: number } {
  const plan = planGuestImport({ ...opts, venueId: '', weddingId: '' })
  return {
    matching: plan.updates.length + plan.unchanged,
    newGuests: plan.inserts.length,
  }
}
