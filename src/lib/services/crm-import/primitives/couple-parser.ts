/**
 * Couple-parser primitive (T5-Rixey-GG / Stream GG).
 *
 * Parses a single CRM cell that contains one or more people into a
 * structured list of partners (1-2) + others (parents, planners, etc.).
 *
 * Why this exists
 * ---------------
 * Real Rixey HoneyBook export shipped a `Client Info` cell shaped like
 *   "Rebecca Werrell rebecca@x.com, Mike Chalhoub mike@y.com"
 * not the assumed separate `Client Email` column. Some rows include
 * parents:
 *   "Rebecca Werrell rebecca@x.com, Mike Butter (FOB) buttersfam@y.com"
 * Other CRMs hand us:
 *   - "Sarah Smith, James Lee"             (Aisle Planner)
 *   - "Mr. & Mrs. Pearson"                 (formal)
 *   - "Sarah & Mike Chen"                  (shared last name)
 *   - "Sarah Chen"                         (single partner)
 *   - "rebecca@x.com, mike@y.com"          (emails only, no names)
 *   - "Jacob cnading18@gmail.com"          (single partner with email)
 *
 * The parser canonicalises all of these to the same shape so downstream
 * `commitNormalisedRows` doesn't care which CRM produced the row.
 *
 * Role tagging
 * ------------
 * Any token wrapped in parentheses immediately after a name is treated
 * as a role marker:
 *   - MOB / MOG / MOP   → mother (of bride / groom / partner)
 *   - FOB / FOG / FOP   → father
 *   - Planner / Wedding Planner → planner
 *   - Coordinator      → coordinator
 *   - Photographer / DJ / Florist / etc. → vendor
 *   - Witness / Officiant / Best Man / Maid of Honour → wedding_party
 * Anything else parenthesised is preserved verbatim in `role_raw`.
 *
 * People without a role marker default to 'partner' UNTIL we already
 * have 2 partners, after which subsequent unmarked entries fall back to
 * 'other'. The first 2 partners win — a coordinator can re-assign in
 * the UI later.
 */

export type PersonRole =
  | 'partner'
  | 'parent_mother'
  | 'parent_father'
  | 'planner'
  | 'coordinator'
  | 'vendor'
  | 'wedding_party'
  | 'witness'
  | 'officiant'
  | 'other'

export interface ParsedPerson {
  name: string | null
  email: string | null
  phone: string | null
  role: PersonRole
  /** Original parenthesised role marker, if any. Useful for debugging. */
  role_raw: string | null
}

export interface ParsedCouple {
  partners: ParsedPerson[]   // 0-2 entries
  others: ParsedPerson[]     // anyone else (parents, planners, vendors)
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PHONE_RE = /[+]?\d[\d\s().-]{6,}\d/g

const ROLE_MARKER_MAP: Array<[RegExp, PersonRole]> = [
  [/^(mob|mog|mop|mother(?:[\s-]*(?:of|to)[\s-]*(?:bride|groom|partner))?)$/i, 'parent_mother'],
  [/^(fob|fog|fop|father(?:[\s-]*(?:of|to)[\s-]*(?:bride|groom|partner))?)$/i, 'parent_father'],
  [/^(wedding\s*planner|planner)$/i, 'planner'],
  [/^(coordinator|day[\s-]*of[\s-]*coordinator|doc)$/i, 'coordinator'],
  [/^(photographer|dj|florist|caterer|baker|vendor|videographer|hair|make[\s-]*up)$/i, 'vendor'],
  [/^(maid\s*of\s*honou?r|moh|best\s*man|bridesmaid|groomsman|wedding\s*party|attendant)$/i, 'wedding_party'],
  [/^(witness)$/i, 'witness'],
  [/^(officiant|minister|priest|rabbi|celebrant)$/i, 'officiant'],
]

function classifyRoleMarker(raw: string | null): PersonRole {
  if (!raw) return 'partner'
  const trimmed = raw.replace(/[()]/g, '').trim()
  for (const [re, role] of ROLE_MARKER_MAP) {
    if (re.test(trimmed)) return role
  }
  return 'other'
}

/**
 * Strip a trailing possessive `'s` / `’s` (smart quote) from a single token.
 * Bug T5-Rixey-OO #5: project names like "Rebecca and Mike's Wedding"
 * survive the trailing-"Wedding" strip but leave the apostrophe-s glued
 * onto the second partner's first name. Apply at the token level so we
 * don't break legitimate apostrophes that sit inside names like O'Brien.
 */
function stripPossessive(token: string): string {
  return token.replace(/['’][sS]$/u, '')
}

/** Best-effort cleanup of a name token: trim, strip stray punctuation, fold whitespace. */
function tidyName(s: string): string | null {
  const t = s.replace(/\s+/g, ' ').trim()
  // Drop trailing punctuation but keep apostrophes / hyphens inside names.
  const stripped = t.replace(/^[,;.\s]+|[,;.\s]+$/g, '').trim()
  if (!stripped) return null
  // If it's literally an email (no separate name), don't pretend it's a name.
  if (EMAIL_RE.test(stripped) && stripped.split(/\s+/).length === 1) return null
  // Strip trailing possessive `'s` / `'S` / smart-quote `'s` from each
  // whitespace-separated token. "Mike's" → "Mike". Defensive against
  // upstream parsers that leave possessive-s glued onto the last
  // partner name when a trailing word ("Wedding") gets stripped first.
  const possessiveStripped = stripped
    .split(/\s+/)
    .map(stripPossessive)
    .filter(Boolean)
    .join(' ')
  return possessiveStripped || null
}

/**
 * Split the cell into per-person fragments. CRMs use comma OR
 * semicolon OR " and " between people. Quoted commas inside a name are
 * already stripped by the upstream CSV parser so we can split on plain
 * commas safely here.
 */
function splitPeopleFragments(cell: string): string[] {
  // Normalise " and " / " & " / " + " to a comma so we can split once.
  const collapsed = cell.replace(/\s+(?:and|&|\+)\s+/gi, ', ')
  return collapsed.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
}

/**
 * Parse a single fragment like "Mike Butter (FOB) buttersfam@x.com" into
 * a ParsedPerson. Returns null if the fragment is empty / unparseable.
 */
function parseFragment(fragment: string): ParsedPerson | null {
  if (!fragment) return null

  // Pull email(s) first — ParsedPerson holds at most one. If multiple
  // emails appear in one fragment we keep the first; the rest will get
  // dropped (rare in practice).
  const emails = fragment.match(EMAIL_RE) ?? []
  const email = emails[0] ?? null

  // Pull phone (loose match).
  const phones = fragment.match(PHONE_RE) ?? []
  const phone = phones[0] ?? null

  // Pull role marker — first parenthesised token.
  const roleMatch = fragment.match(/\(([^)]+)\)/)
  const roleRaw = roleMatch ? roleMatch[1].trim() : null
  const role = classifyRoleMarker(roleRaw)

  // Strip emails / phones / role markers from the fragment to leave
  // (hopefully) just the name.
  let nameRest = fragment
  for (const e of emails) nameRest = nameRest.replace(e, ' ')
  for (const p of phones) nameRest = nameRest.replace(p, ' ')
  if (roleMatch) nameRest = nameRest.replace(roleMatch[0], ' ')

  // Strip honorifics — they confuse the partner-1 / partner-2 split.
  nameRest = nameRest.replace(/\b(mr|mrs|ms|miss|mx|dr|sir|madam)\.?\s+/gi, ' ')

  const name = tidyName(nameRest)

  if (!name && !email && !phone) return null

  return { name, email, phone, role, role_raw: roleRaw }
}

/**
 * Parse a single cell representing one or more people.
 *
 * Behaviour:
 *   - Splits the cell on comma / semicolon / "and" / "&".
 *   - Each fragment becomes a ParsedPerson.
 *   - First two unmarked entries are partners; subsequent unmarked
 *     entries fall back to role='other'.
 *   - Marked entries (parents, planners, vendors, etc.) always go to
 *     `others`, even if `partners` has < 2 entries.
 *   - Special case: "Sarah & Mike Chen" — a single name containing an
 *     "&" with a shared surname collapses to two partners with the
 *     same last name. This is detected post-split: if exactly one
 *     fragment was produced AND the cell originally contained "&" /
 *     "and", we re-attempt as a shared-surname couple.
 */
export function parseCoupleFromCell(cell: string | null | undefined): ParsedCouple {
  const empty: ParsedCouple = { partners: [], others: [] }
  if (!cell) return empty
  const trimmed = cell.trim()
  if (!trimmed) return empty

  // Try shared-surname collapse FIRST so "Sarah & Mike Chen" doesn't
  // split into "Sarah" + "Mike Chen" via the comma-normalise path.
  const sharedSurname = trySharedSurname(trimmed)
  if (sharedSurname) return sharedSurname

  const fragments = splitPeopleFragments(trimmed)
  const parsed: ParsedPerson[] = []
  for (const f of fragments) {
    const p = parseFragment(f)
    if (p) parsed.push(p)
  }

  const partners: ParsedPerson[] = []
  const others: ParsedPerson[] = []
  for (const p of parsed) {
    if (p.role === 'partner') {
      if (partners.length < 2) {
        partners.push(p)
      } else {
        others.push({ ...p, role: 'other' })
      }
    } else {
      others.push(p)
    }
  }
  return { partners, others }
}

/**
 * Detect "Sarah & Mike Chen" / "Sarah and Mike Chen" patterns where one
 * surname is shared. Returns null if the cell doesn't fit the shape so
 * the caller can fall through to the normal split path.
 *
 * Heuristic:
 *   - Cell must contain exactly one "&" / " and " / " + " separator.
 *   - Left side is exactly ONE token (the first partner's first name).
 *   - Right side is two-or-more tokens (the second partner's first +
 *     the shared last).
 *   - No emails / phones / role markers in the left side.
 */
function trySharedSurname(cell: string): ParsedCouple | null {
  const sepMatch = cell.match(/\s+(?:&|and|\+)\s+/i)
  if (!sepMatch) return null
  // Reject cells with more than one separator — those are clearly a
  // multi-person comma-style list.
  const allSeps = cell.match(/\s+(?:&|and|\+)\s+/gi) ?? []
  if (allSeps.length !== 1) return null

  const idx = cell.indexOf(sepMatch[0])
  const left = cell.slice(0, idx).trim()
  const right = cell.slice(idx + sepMatch[0].length).trim()

  if (!left || !right) return null
  // Left must be a single bare first name (no email, no role marker).
  if (EMAIL_RE.test(left) || /\(/.test(left)) return null
  const leftTokens = left.split(/\s+/).filter(Boolean)
  if (leftTokens.length !== 1) return null

  // Right needs name + last (≥ 2 tokens) for shared-surname semantics.
  // Strip emails / phones / role markers from the right side first.
  const rightFragment = parseFragment(right)
  if (!rightFragment || !rightFragment.name) return null
  const rightTokens = rightFragment.name.split(/\s+/).filter(Boolean)
  if (rightTokens.length < 2) return null

  const sharedLast = rightTokens.slice(1).join(' ')
  const partner1: ParsedPerson = {
    name: `${leftTokens[0]} ${sharedLast}`,
    email: null,
    phone: null,
    role: 'partner',
    role_raw: null,
  }
  const partner2: ParsedPerson = {
    ...rightFragment,
    role: 'partner',
  }
  return { partners: [partner1, partner2], others: [] }
}

/**
 * Convenience helper for adapters that still want flat first/last
 * fields. Splits a "First Last" name into first / last components, with
 * "First Middle Last" collapsing the trailing tokens into last.
 */
export function splitFullName(name: string | null | undefined): {
  first: string | null
  last: string | null
} {
  if (!name) return { first: null, last: null }
  const tokens = name.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { first: null, last: null }
  if (tokens.length === 1) return { first: tokens[0]!, last: null }
  return { first: tokens[0]!, last: tokens.slice(1).join(' ') }
}
