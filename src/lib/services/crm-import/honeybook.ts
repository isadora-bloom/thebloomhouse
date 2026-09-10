/**
 * HoneyBook adapter (T5-Rixey, follow-up to T5-followup-Y / Pattern I).
 *
 * Real implementation. Promoted from scaffold by Stream FF so Rixey
 * Manor's HoneyBook export can be backfilled into Bloom on Day-3 of
 * the onboarding-project flow without going through the generic-csv
 * mapping ceremony.
 *
 * HoneyBook export format (Path 1 — Project / Lead CSV)
 * ------------------------------------------------------
 * The coordinator exports from:
 *   HoneyBook → Settings → Reports → Projects → Export as CSV
 *
 * Typical headers (Q1 2026 export — case-insensitive matching, with
 * common variants accepted):
 *
 *   Project Name      → couple identifier ("First Last Wedding" or
 *                       "First & First Last Wedding"). We split into
 *                       partner1 / partner2 names.
 *   Project Type      → e.g. Wedding / Event (informational; not stored)
 *   Project Date      → wedding_date  (variants: Event Date, Date)
 *   Project Status    → maps into weddings.status (see STATUS_MAP)
 *   Client Name       → primary partner1 name (overrides Project-Name parse
 *                       if provided)
 *   Client Email      → people.email + partner1_email
 *   Client Phone      → people.phone + partner1_phone
 *   Total             → booking_value (parsed "$4,500.00" → 450000 cents)
 *                       (variants: Project Value, Total Project Cost,
 *                       Contract Value/Amount/Total)
 *   Paid              → amount_paid (cents)
 *   Deposit           → deposit_amount (cents; variants: Retainer)
 *   Tax               → tax_amount (cents; variants: Sales Tax)
 *   Gratuity          → gratuity_amount (cents; variants: Tip, Service Charge)
 *   Refunded          → refunded_amount (cents)
 *   Guest Count       → guest_count_estimate (variants: Guests,
 *                       Headcount, Pax, Attendance)
 *   Package           → package_name (variants: Tier, Collection)
 *   Balance           → informational; not stored (derivable from
 *                       booking_value − amount_paid)
 *   Source            → weddings.source (mapped via SOURCE_ALIASES);
 *                       original string preserved in source_detail
 *                       (variants: Lead Source)
 *   Inquiry Date      → weddings.inquiry_date
 *                       (variants: Created Date, Created)
 *   Booking Date      → weddings.booked_at  (variants: Booked Date,
 *                       Contract Signed Date)
 *   Tags              → concatenated into weddings.notes (no tags column)
 *   Notes             → weddings.notes
 *
 * Non-couple project contacts (W20, 2026-09-09)
 * ----------------------------------------------
 * The "Booked Client" report is one row per PERSON, grouped by Project
 * Name. Two rows are the couple. A third or fourth is whoever else was
 * on the file — a mother, a father, a planner, the aunt paying the
 * invoice. They used to be counted in a warning and dropped.
 *
 * They now come out of parse() as `related_contacts` on the row, and
 * `commitNormalisedRows` routes each through linkSignal's Agent branch:
 * their own `couples` row at lifecycle_state='agent', an
 * `agent_couple_links` row joining them to the couple, and the role on
 * `wedding_relationships`. See IDENTITY-FIRST-ARCHITECTURE.md §1.
 *
 * Role comes from the columns the export actually has:
 *   Company non-empty          → 'planner'
 *   name reads as a business   → 'planner'
 *   surname matches a partner  → 'parent'   (no gender in the file, so
 *                                            'parent' is as precise as
 *                                            the data honestly gets)
 *   otherwise                  → 'other'
 *
 * Path 3 (per-project Activity Log CSV) is intentionally NOT supported in
 * this first cut — that flow requires the coordinator to export each
 * project individually and stitch them together. Defer.
 *
 * Tested against HoneyBook export format Q1 2026; if columns rename,
 * update the column-name regex variants in `findColumn()`.
 *
 * Status mapping (HoneyBook → weddings.status enum)
 * -------------------------------------------------
 *   Inquiry / New / Lead              → 'inquiry'
 *   Tour Scheduled                    → 'tour_scheduled'
 *   Tour Completed                    → 'tour_completed'
 *   Proposal / Proposal Sent          → 'proposal_sent'
 *   Booked / Contracted /
 *     Signed Contract / Active        → 'booked'
 *   Completed / Done                  → 'completed'
 *   Cancelled / Canceled              → 'cancelled'
 *   Lost / Closed Lost / Archived     → 'lost'  (also creates a lost_deals
 *                                                row with reason_category=
 *                                                'other' so downstream
 *                                                lost-deal queries see it)
 *
 * Source attribution (T5-Rixey-TT adapter-as-facts refactor, 2026-05-02)
 * ----------------------------------------------------------------------
 * HoneyBook is a CRM (scheduling + invoicing + workflows) — it is NOT
 * an acquisition channel. The previous version of this adapter wrote
 * `weddings.source = 'honeybook'` (or canonicalised the free-text
 * "Lead Source" column to the restricted enum). That short-circuited
 * the lead-source-derivation chain: the Calendly Q7 "where did you
 * hear about us?" answer or the inbound-email-domain analysis would
 * have produced a real first-touch (the_knot / wedding_wire / referral),
 * but a non-NULL `weddings.source = 'honeybook'` made the chain skip
 * the row.
 *
 * New contract: this adapter writes FACTS only.
 *   - `weddings.crm_source = 'honeybook'`  (factual: which CRM)
 *   - `weddings.source_detail` keeps the raw "Source" cell verbatim
 *     so the coordinator's hand-typed value isn't lost
 *   - `weddings.source = NULL` always — the lead-source-derivation
 *     cron decides the real first-touch from Q7 / web-form / email-
 *     domain / UTM in priority order
 *
 * If the HoneyBook "Source" cell happens to encode a real channel
 * (e.g. coordinator typed "The Knot"), the value is also dropped into
 * `interactions.extracted_identity.hear_source` on a synthetic per-row
 * interaction so the derivation chain Priority-2 can pick it up. Per
 * Stream-TT design.
 *
 * Confidence + provenance
 * -----------------------
 * Every wedding/person/lost_deal we insert is tagged
 *   confidence_flag = 'imported_medium'
 *   crm_source      = 'honeybook'
 * per migrations 137 + 172.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CrmAdapter,
  AdapterConfig,
  ParseResult,
  PreviewResult,
  NormalisedLeadRow,
  NormalisedInteractionRow,
  CommitResult,
  NormalisedLostDealRow,
  NormalisedRelatedContactRow,
} from './index'
// commitNormalisedRows is intentionally NOT imported here at the top level.
// honeybook.ts ↔ index.ts are circular: index imports honeybookAdapter;
// honeybook imports commitNormalisedRows. A top-level import causes a TDZ
// error under ESM/tsx. Lazy import inside commitHoneybook() below is safe
// because it's only called at runtime, never at module-init time.
import { parseCsvRows } from '@/lib/services/brain-dump/csv-shape'
import { type Cents, asDollars, dollarsToCents } from '@/lib/types/monetary'

// ---------------------------------------------------------------------------
// Column-name detection (case-insensitive, accepts common variants)
// ---------------------------------------------------------------------------

interface ColumnSpec {
  key: string
  variants: RegExp[]
  required?: boolean
}

// Header variants cover both the classic HoneyBook "Projects" export
// AND the "Booked projects" report shape (First Name / Last Name /
// Email / Total Booked Value / Project Creation Date / Project
// Source / Booked Date — one row per person).
const COLUMNS: ColumnSpec[] = [
  { key: 'project_name',  variants: [/^project\s*name$/i, /^name$/i],                    required: true },
  { key: 'project_type',  variants: [/^project\s*type$/i, /^type$/i] },
  { key: 'project_date',  variants: [/^project\s*date$/i, /^event\s*date$/i, /^wedding\s*date$/i, /^date$/i], required: true },
  { key: 'project_status',variants: [/^project\s*status$/i, /^status$/i, /^lead\s*status$/i] },
  { key: 'client_name',   variants: [/^client\s*name$/i, /^primary\s*client(\s*name)?$/i, /^full\s*name$/i] },
  { key: 'first_name',    variants: [/^first\s*name$/i, /^client\s*first\s*name$/i] },
  { key: 'last_name',     variants: [/^last\s*name$/i, /^client\s*last\s*name$/i, /^surname$/i] },
  { key: 'client_email',  variants: [/^client\s*email$/i, /^email$/i, /^primary\s*email$/i],     required: true },
  { key: 'client_phone',  variants: [/^client\s*phone$/i, /^phone$/i, /^primary\s*phone$/i] },
  { key: 'total',         variants: [/^total$/i, /^total\s*project\s*cost$/i, /^project\s*value$/i, /^total\s*invoiced$/i, /^total\s*booked\s*value$/i, /^booked\s*value$/i, /^contract\s*(value|amount|total)$/i] },
  { key: 'paid',          variants: [/^paid$/i, /^total\s*paid$/i, /^amount\s*paid$/i] },
  { key: 'deposit',       variants: [/^deposit$/i, /^deposit\s*amount$/i, /^retainer$/i, /^retainer\s*amount$/i] },
  { key: 'tax',           variants: [/^tax$/i, /^tax\s*amount$/i, /^sales\s*tax$/i] },
  { key: 'gratuity',      variants: [/^gratuity$/i, /^gratuity\s*amount$/i, /^tip$/i, /^service\s*charge$/i] },
  { key: 'refunded',      variants: [/^refund(ed)?$/i, /^refund(ed)?\s*amount$/i, /^amount\s*refunded$/i] },
  { key: 'balance',       variants: [/^balance$/i, /^outstanding(\s*balance)?$/i] },
  { key: 'guest_count',   variants: [/^guest\s*count$/i, /^guests$/i, /^head\s*count$/i, /^headcount$/i, /^(no\.?|number)\s*of\s*guests$/i, /^pax$/i, /^attendance$/i] },
  { key: 'package',       variants: [/^package(\s*name)?$/i, /^tier$/i, /^collection$/i, /^package\s*tier$/i] },
  { key: 'source',        variants: [/^source$/i, /^lead\s*source$/i, /^project\s*source$/i, /^how\s*did\s*you\s*hear/i] },
  { key: 'inquiry_date',  variants: [/^inquiry\s*date$/i, /^created\s*date$/i, /^created$/i, /^date\s*created$/i, /^project\s*creation\s*date$/i, /^creation\s*date$/i] },
  { key: 'booking_date',  variants: [/^booking\s*date$/i, /^booked\s*date$/i, /^date\s*booked$/i, /^booked\s*on$/i, /^contract\s*signed\s*date$/i] },
  { key: 'tags',          variants: [/^tags$/i] },
  { key: 'notes',         variants: [/^notes$/i, /^internal\s*notes$/i, /^description$/i] },
  // Present on the real Rixey "Booked Client" export. Blank for a
  // couple; filled for anyone on the project in a professional
  // capacity, which is the strongest planner signal the file carries.
  { key: 'company',       variants: [/^company$/i, /^business(\s*name)?$/i, /^organi[sz]ation$/i] },
]

interface ColumnIndex {
  /** map of canonical key → column index in the CSV header row, or -1 if absent */
  byKey: Record<string, number>
  /** required keys that we couldn't find */
  missingRequired: string[]
}

function indexColumns(header: string[]): ColumnIndex {
  const byKey: Record<string, number> = {}
  const missingRequired: string[] = []
  for (const spec of COLUMNS) {
    let foundAt = -1
    for (let i = 0; i < header.length; i++) {
      const h = (header[i] ?? '').trim()
      if (spec.variants.some((re) => re.test(h))) {
        foundAt = i
        break
      }
    }
    byKey[spec.key] = foundAt
    if (spec.required && foundAt === -1) missingRequired.push(spec.key)
  }
  return { byKey, missingRequired }
}

// ---------------------------------------------------------------------------
// Status enum mapping
// ---------------------------------------------------------------------------

type WeddingStatus = NormalisedLeadRow['status']

const STATUS_MAP: Record<string, WeddingStatus> = {
  'inquiry': 'inquiry',
  'new': 'inquiry',
  'lead': 'inquiry',
  'tour scheduled': 'tour_scheduled',
  'tour_scheduled': 'tour_scheduled',
  'tour completed': 'tour_completed',
  'tour_completed': 'tour_completed',
  'proposal': 'proposal_sent',
  'proposal sent': 'proposal_sent',
  'proposal_sent': 'proposal_sent',
  'booked': 'booked',
  'contracted': 'booked',
  'signed contract': 'booked',
  'signed_contract': 'booked',
  'active': 'booked',
  'paid': 'booked',
  'completed': 'completed',
  'done': 'completed',
  'cancelled': 'cancelled',
  'canceled': 'cancelled',
  'lost': 'lost',
  'closed lost': 'lost',
  'closed_lost': 'lost',
  'archived': 'lost',
}

function mapStatus(raw: string | null | undefined): WeddingStatus {
  // Return null (not 'inquiry') when raw is absent so the caller's
  // bookingRaw fallback can fire: `mapStatus(x) ?? (bookingRaw ? 'booked' : null)`.
  // Returning 'inquiry' here short-circuits that ?? and silently imports every
  // "Booked projects" report row (which has no Status column) as inquiry.
  if (!raw) return null
  const key = raw.trim().toLowerCase()
  return STATUS_MAP[key] ?? null
}

// ---------------------------------------------------------------------------
// Source-channel canonicalisation (T5-Rixey-TT — scoped DOWN, not removed).
//
// The previous version returned a canonical enum value from the free-text
// "Source" cell and wrote it to `weddings.source`. That circumvented the
// lead-source-derivation chain: a typed "The Knot" or "Word of Mouth" got
// stamped immediately, blocking later signals (Q7, email-domain, UTM)
// from ever running for the row.
//
// New contract: this function still RECOGNISES known channels in the
// free-text — but the result feeds the synthetic interaction's
// `extracted_identity.hear_source` (which the lead-source-derivation
// Priority-2 reads), not `weddings.source` directly. Returning null
// means "I didn't recognise this string" — keep the raw value in
// source_detail and let derivation work from other signals.
// ---------------------------------------------------------------------------

function recogniseHearSource(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (/(the\s*knot|theknot)/.test(s)) return 'the_knot'
  if (/(wedding\s*wire|weddingwire)/.test(s)) return 'weddingwire'
  if (/(instagram|insta|\big\b)/.test(s)) return 'instagram'
  if (/(facebook|\bfb\b)/.test(s)) return 'facebook'
  if (/(pinterest)/.test(s)) return 'pinterest'
  if (/(tik[\s-]*tok)/.test(s)) return 'tiktok'
  if (/(google|search|seo|sem|ads?)/.test(s)) return 'google'
  if (/(referral|referred|word of mouth|wom|friend|family)/.test(s)) return 'referral'
  if (/(website|web\s*form|own\s*site|inquiry\s*form)/.test(s)) return 'website'
  if (/(walk[\s-]*in|drop[\s-]*in)/.test(s)) return 'walk_in'
  if (/(here\s*comes\s*the\s*guide)/.test(s)) return 'here_comes_the_guide'
  if (/(zola)/.test(s)) return 'zola'
  return null
}

// ---------------------------------------------------------------------------
// Money + date helpers
// ---------------------------------------------------------------------------

/** "$4,500.00" → 450000 (cents). Returns null if unparseable.
 *  T5-Rixey-RR fix #5: typed return surfaces the unit at call sites. */
function parseMoneyToCents(raw: string | null | undefined): Cents | null {
  if (raw == null) return null
  const cleaned = raw.replace(/[$,\s]/g, '').trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return dollarsToCents(asDollars(n))
}

/** Parse a guest-count cell. Conservative on purpose: only a clean
 *  single number ("120", "120 guests", "~120") or a clean range
 *  ("100-120" / "100 to 120" — takes the upper bound). Anything noisy
 *  (a date, a code, multiple unrelated numbers) returns null rather
 *  than guessing — a wrong large value would fail the importer's
 *  1-1000 pre-commit validation and atomically refuse the whole batch.
 *
 *  Capped at 1-1000 to match weddings.guest_count_estimate's DB
 *  constraint (migration 165) and validateAllRows in the crm-import
 *  route. A value outside that range can't be stored, so it returns
 *  null instead of a value the validator would reject. */
function parseGuestCount(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  const inRange = (n: number): number | null =>
    Number.isFinite(n) && n >= 1 && n <= 1000 ? n : null

  const range = trimmed.match(/^~?\s*(\d{1,5})\s*(?:[-–—]|to)\s*(\d{1,5})\b/i)
  if (range) {
    return inRange(Math.max(parseInt(range[1]!, 10), parseInt(range[2]!, 10)))
  }
  const single = trimmed.match(/^~?\s*(\d{1,5})\b/)
  if (single) return inRange(parseInt(single[1]!, 10))
  return null
}

function parseDateIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function parseDateYmd(raw: string | null | undefined): string | null {
  const iso = parseDateIso(raw)
  return iso ? iso.slice(0, 10) : null
}

// ---------------------------------------------------------------------------
// Project-Name parsing. HoneyBook coordinators routinely name projects
// like "Sarah Chen Wedding" or "Sarah & Mike Chen Wedding". Pull out
// partner1 + (optional) partner2 first/last names so we can populate the
// people table even when Client Name is missing or just one partner.
// ---------------------------------------------------------------------------

interface ParsedNames {
  partner1_first: string | null
  partner1_last: string | null
  partner2_first: string | null
  partner2_last: string | null
}

/**
 * Strip a trailing possessive `'s` / `’s` from each whitespace-separated
 * token. T5-Rixey-OO bug #5: "Rebecca and Mike's Wedding" survives the
 * trailing-"Wedding" strip but leaves "Mike's" as partner2_first_name.
 * The apostrophe-s on the second name is purely grammatical (it modifies
 * the now-stripped trailing "Wedding"); strip it from both partner
 * tokens AND from the full project-name string before splitting so the
 * fix is defensive against either order.
 */
function stripTrailingPossessive(token: string): string {
  return token.replace(/['’][sS]$/u, '')
}

/**
 * Rixey's HoneyBook has held-date placeholders where the project_name
 * is JUST the package label ("Whole Weekend", "One Day", "Final
 * Walkthrough", "Vendor Meeting", "(Unknown) Day", etc.) — no couple
 * named yet. parseProjectName used to fall through to the single-
 * partner path on these, splitting "Whole Weekend" into partner1_first
 * = 'Whole', partner1_last = 'Weekend'. Combined with a real
 * client_email from the same CSV row, that minted weddings with real
 * gmails attached to bleed-named people.
 *
 * Token sets mirror FORM_BLEED_TOKENS in name-upgrade.ts. Both heads
 * AND tails must match (so a real surname like 'Day' in 'Sydney Day'
 * isn't filtered out — Sydney isn't in firstHeads).
 */
const PACKAGE_HEADS = new Set<string>([
  'whole', 'one', 'two', 'three', 'half', 'final', 'tour', 'pre',
  'post', 'service', 'meeting', 'booking', 'estimate', 'package',
  'day', 'night', 'pre-tour', 'phone', 'vendor', '(unknown)',
])
const PACKAGE_TAILS = new Set<string>([
  'weekend', 'weekday', 'day', 'night', 'walkthrough', 'meeting',
  'booking', 'call', 'tour', 'estimate', 'package', 'phone',
])

function isPackageOnlyName(raw: string): boolean {
  const tokens = raw.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (tokens.length !== 2) return false
  return PACKAGE_HEADS.has(tokens[0]!) && PACKAGE_TAILS.has(tokens[1]!)
}

function parseProjectName(raw: string | null): ParsedNames {
  const empty: ParsedNames = {
    partner1_first: null, partner1_last: null,
    partner2_first: null, partner2_last: null,
  }
  if (!raw) return empty
  // Strip trailing "Wedding" / "Event" / "Reception" tokens.
  let stripped = raw
    .trim()
    .replace(/\b(wedding|event|reception|ceremony|nuptials)\b\s*$/i, '')
    .trim()
  if (!stripped) return empty
  // Defensive: also strip a trailing possessive 's that the wedding-
  // word strip left dangling. e.g. "Rebecca and Mike's" → "Rebecca and Mike".
  stripped = stripTrailingPossessive(stripped).trim()

  // 2026-05-13. Refuse package-only project names like "Whole Weekend",
  // "One Day", "Vendor Meeting". These are HoneyBook placeholders for
  // held dates / planning slots / non-couple events — they're not names
  // and turning them into people rows is the root cause of the form-
  // bleed accumulation cron-cleaned every night. Return empty so the
  // wedding row gets minted without a partner1 from this CSV column;
  // a real signal (client_name field, follow-up email, contract) will
  // fill the names later.
  if (isPackageOnlyName(stripped)) return empty

  // Also catch the "(Unknown) Day" / "(Unknown) Weekend" shape where
  // the project name is a placeholder + package label.
  if (/^\(unknown\)\s+(day|weekend|walkthrough|meeting|tour|phone|night)$/i.test(stripped)) {
    return empty
  }

  // Two partners?  "Sarah & Mike Chen" / "Sarah and Mike Chen"
  const splitMatch = stripped.split(/\s+(?:&|and|\+)\s+/i)
  if (splitMatch.length === 2) {
    const [left, right] = splitMatch
    // Heuristic: shared last-name pattern → "Sarah" + "Mike Chen"
    // gives partner1_first=Sarah, partner2 first+last from right.
    // Strip possessive from each token in case the apostrophe-s landed
    // on a partner name and slipped past the whole-string strip above.
    const leftTokens = left.trim().split(/\s+/).map(stripTrailingPossessive).filter(Boolean)
    const rightTokens = right.trim().split(/\s+/).map(stripTrailingPossessive).filter(Boolean)
    const result: ParsedNames = { ...empty }
    if (leftTokens.length === 1 && rightTokens.length >= 2) {
      // Partner1 first only; partner2 first + last; partner1 inherits last
      result.partner1_first = leftTokens[0] ?? null
      result.partner2_first = rightTokens[0] ?? null
      result.partner2_last  = rightTokens.slice(1).join(' ')
      result.partner1_last  = result.partner2_last
    } else {
      // Independent full names.
      result.partner1_first = leftTokens[0] ?? null
      if (leftTokens.length > 1) result.partner1_last = leftTokens.slice(1).join(' ')
      result.partner2_first = rightTokens[0] ?? null
      if (rightTokens.length > 1) result.partner2_last = rightTokens.slice(1).join(' ')
    }
    return result
  }

  // Single partner. "Sarah Chen" / "Sarah". Take first + last.
  const tokens = stripped.split(/\s+/).map(stripTrailingPossessive).filter(Boolean)
  if (tokens.length === 1) {
    return { ...empty, partner1_first: tokens[0] ?? null }
  }
  return {
    ...empty,
    partner1_first: tokens[0] ?? null,
    partner1_last: tokens.slice(1).join(' '),
  }
}

// ---------------------------------------------------------------------------
// Non-couple project contacts (W20, 2026-09-09)
//
// A HoneyBook project export is one row per PERSON. Two rows sharing a
// Project Name are the couple. Three or four are the couple plus whoever
// else is on the file: a mother, a father, a planner, an aunt paying the
// invoice. Until now the adapter counted them in a warning and dropped
// them, which is how "Amy Stewart, lkahomeconcierge@gmail.com" ends up
// filed under "Bria and Iain's Wedding" and then nowhere.
//
// The identity doctrine calls these people Agents: a real human acting
// on behalf of a couple, whose calls and emails must still ingest and
// attach to that couple (IDENTITY-FIRST-ARCHITECTURE.md §1). So the
// adapter now emits them as `related_contacts` and the commit step
// routes each one through linkSignal's Agent branch.
//
// Role inference, in the order the export actually supports it. The
// file carries no gender and no "of the bride", so 'parent' is the most
// precise honest label for a surname match; the coordinator can sharpen
// it later on the relationships panel.
// ---------------------------------------------------------------------------

/** Words that mean the person is on the file professionally rather than
 *  as family. Matched against the Company cell and, failing that, the
 *  name itself (some exports put the firm in the Last Name column). */
const PLANNER_WORDS =
  /\b(event|events|planning|planner|weddings?|design|designs|co\.|company|llc|inc\.?|studio|concierge|coordination|coordinator|productions?)\b/i

function inferContactRole(args: {
  first: string | null
  last: string | null
  company: string | null
  partnerSurnames: string[]
}): { role: 'parent' | 'planner' | 'other'; detail: string | null } {
  const company = (args.company ?? '').trim()
  if (company) {
    return { role: 'planner', detail: `Company: ${company}` }
  }
  const fullName = [args.first, args.last].filter(Boolean).join(' ').trim()
  if (fullName && PLANNER_WORDS.test(fullName)) {
    return { role: 'planner', detail: `name reads as a business: ${fullName}` }
  }
  const last = (args.last ?? '').trim().toLowerCase()
  if (last && args.partnerSurnames.includes(last)) {
    return {
      role: 'parent',
      detail: `shares the surname ${args.last!.trim()} with the couple; `
        + `parent or close relative, not confirmed`,
    }
  }
  return { role: 'other', detail: null }
}

/** Stable per-contact key. Email when there is one, because that is what
 *  survives a re-export; otherwise the project plus the name, which is
 *  stable enough for the same file uploaded twice. */
function contactExternalId(
  projectName: string | null,
  email: string | null,
  fullName: string,
  csvRow: number,
): string {
  const slug = (projectName ?? 'unknown')
    .trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '')
    || 'unknown'
  if (email) return `honeybook:contact:${slug}:${email.trim().toLowerCase()}`
  const nameSlug = fullName.trim().toLowerCase().replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
  if (nameSlug) return `honeybook:contact:${slug}:${nameSlug}`
  return `honeybook:contact:${slug}:row${csvRow}`
}

/** "Sarah Chen" → ["Sarah", "Chen"]. */
function splitFullName(raw: string | null | undefined): { first: string | null; last: string | null } {
  if (!raw) return { first: null, last: null }
  // Strip trailing possessive 's on each token (T5-Rixey-OO #5 defence).
  const t = raw.trim().split(/\s+/).map(stripTrailingPossessive).filter(Boolean)
  if (t.length === 0) return { first: null, last: null }
  if (t.length === 1) return { first: t[0] ?? null, last: null }
  return { first: t[0] ?? null, last: t.slice(1).join(' ') }
}

// ---------------------------------------------------------------------------
// parse() — CSV → NormalisedLeadRow[]
// ---------------------------------------------------------------------------

async function parseHoneybook(config: AdapterConfig): Promise<ParseResult> {
  const errors: string[] = []
  const warnings: string[] = []

  if (!config.csvText || !config.csvText.trim()) {
    return { ok: false, rows: [], errors: ['csv content is empty'], warnings }
  }

  const csvRows = parseCsvRows(config.csvText)
  if (csvRows.length < 2) {
    return {
      ok: false, rows: [], warnings,
      errors: ['csv must have a header row and at least one data row'],
    }
  }

  const header = csvRows[0]
  const idx = indexColumns(header)
  if (idx.missingRequired.length > 0) {
    return {
      ok: false, rows: [], warnings,
      errors: [
        `HoneyBook export is missing required column(s): ${idx.missingRequired.join(', ')}. ` +
        `Expected headers like: Project Name, Project Date, Client Email. ` +
        `Re-export from HoneyBook (Settings → Reports → Projects → Export as CSV) ` +
        `and ensure all columns are included.`,
      ],
    }
  }

  const rows: NormalisedLeadRow[] = []
  // Header row, used to build the full header-keyed raw row so columns
  // with no HoneyBook alias are preserved (weddings.raw_import_row).
  const headerRow = (csvRows[0] ?? []).map((h) => (h ?? '').trim())
  const get = (data: string[], key: string): string | null => {
    const i = idx.byKey[key]
    if (i == null || i < 0) return null
    return (data[i] ?? '').trim() || null
  }

  // ---------------------------------------------------------------------
  // Pass 1 — read every CSV row into a per-PERSON record.
  //
  // A HoneyBook "Booked projects" export is ONE ROW PER PERSON: the two
  // partners of a wedding are separate rows that share the same Project
  // Name (and the same Project Date / Booked Date / Total). The classic
  // "Projects" export is one row per project. Either way, grouping by
  // Project Name in pass 2 yields one couple per wedding.
  // ---------------------------------------------------------------------
  interface PersonRow {
    csvRow: number
    projectName: string | null
    first: string | null
    last: string | null
    email: string | null
    phone: string | null
    rawRow: Record<string, unknown>
    projDate: string | null
    booking: string | null
    inquiry: string | null
    status: NormalisedLeadRow['status']
    statusRaw: string | null
    totalRaw: string | null
    paidRaw: string | null
    depositRaw: string | null
    taxRaw: string | null
    gratuityRaw: string | null
    refundedRaw: string | null
    guestRaw: string | null
    packageRaw: string | null
    sourceRaw: string | null
    tags: string | null
    notes: string | null
    company: string | null
  }

  const people: PersonRow[] = []
  for (let r = 1; r < csvRows.length; r++) {
    const data = csvRows[r]
    const projectName = get(data, 'project_name')
    const clientEmail = get(data, 'client_email')
    const projDate    = get(data, 'project_date')

    if (!projDate && !clientEmail && !projectName) {
      warnings.push(`row ${r}: skipped — no project date, email, or name`)
      continue
    }
    if (!clientEmail) {
      warnings.push(`row ${r}: missing Client Email — row imported without contact`)
    }

    // Person name: explicit First/Last columns, else split a single
    // Client Name / Full Name column.
    let first = get(data, 'first_name')
    let last  = get(data, 'last_name')
    if (!first && !last) {
      const single = get(data, 'client_name')
      if (single) {
        const cn = splitFullName(single)
        first = cn.first
        last = cn.last
      }
    }

    const bookingRaw = get(data, 'booking_date')
    const statusRaw  = get(data, 'project_status')
    people.push({
      csvRow: r,
      projectName,
      first,
      last,
      email: clientEmail,
      phone: get(data, 'client_phone'),
      rawRow: Object.fromEntries(
        headerRow.map((h, i) => [h || `col_${i}`, (data[i] ?? '').trim()]),
      ),
      projDate,
      booking: bookingRaw,
      inquiry: get(data, 'inquiry_date'),
      // No Status column but a Booked Date present ⇒ booked. Without
      // this a "Booked projects" report imports every couple as
      // 'inquiry' and they never reach the Weddings tab.
      status: mapStatus(statusRaw) ?? (bookingRaw ? 'booked' : null),
      statusRaw,
      totalRaw: get(data, 'total'),
      paidRaw: get(data, 'paid'),
      depositRaw: get(data, 'deposit'),
      taxRaw: get(data, 'tax'),
      gratuityRaw: get(data, 'gratuity'),
      refundedRaw: get(data, 'refunded'),
      guestRaw: get(data, 'guest_count'),
      packageRaw: get(data, 'package'),
      sourceRaw: get(data, 'source'),
      tags: get(data, 'tags'),
      notes: get(data, 'notes'),
      company: get(data, 'company'),
    })
  }

  // ---------------------------------------------------------------------
  // Pass 2 — group people by Project Name into couples, emit one
  // NormalisedLeadRow per wedding.
  // ---------------------------------------------------------------------
  const groups = new Map<string, PersonRow[]>()
  let noNameSeq = 0
  for (const p of people) {
    const key = p.projectName
      ? p.projectName.trim().toLowerCase()
      : `__no_project_${noNameSeq++}`
    const arr = groups.get(key) ?? []
    arr.push(p)
    groups.set(key, arr)
  }

  const normName = (s: string | null | undefined): string =>
    (s ?? '').trim().toLowerCase()

  for (const members of groups.values()) {
    // Representative value for a wedding-level field — the first
    // non-empty across the group's people (they should all agree).
    const pickRaw = (k: keyof PersonRow): string | null => {
      for (const m of members) {
        const v = m[k]
        if (typeof v === 'string' && v.trim()) return v
      }
      return null
    }
    const projectName = members.find((m) => m.projectName)?.projectName ?? null
    const fromProject = parseProjectName(projectName)

    // Assign the (up to) two partner slots. Match each person to a
    // partner first-name parsed out of the Project Name ("Suzi and
    // Jody's Wedding" ⇒ Suzi, Jody) so a 3-4 person group (couple +
    // parents) still picks the real couple. Falls back to the first
    // two rows when the names don't line up.
    let partner1: PersonRow | null = null
    let partner2: PersonRow | null = null
    const extras: PersonRow[] = []
    if (members.length === 1) {
      partner1 = members[0]!
    } else {
      const remaining = [...members]
      const claim = (expected: string): PersonRow | null => {
        if (!expected) return null
        const i = remaining.findIndex((m) => normName(m.first) === expected)
        return i >= 0 ? remaining.splice(i, 1)[0]! : null
      }
      partner1 = claim(normName(fromProject.partner1_first))
      partner2 = claim(normName(fromProject.partner2_first))
      if (!partner1 && remaining.length) partner1 = remaining.shift()!
      if (!partner2 && remaining.length) partner2 = remaining.shift()!
      extras.push(...remaining)
    }
    if (!partner1) continue

    // W20: the people on the project who are not the couple. Emitted as
    // related_contacts rather than warned about and dropped. The warning
    // stays, but it now says where they went.
    const relatedContacts: NormalisedRelatedContactRow[] = []
    if (extras.length > 0) {
      const partnerSurnames = [
        partner1.last,
        partner2?.last,
        fromProject.partner1_last,
        fromProject.partner2_last,
      ]
        .map((s) => (s ?? '').trim().toLowerCase())
        .filter(Boolean)
      const partnerEmails = new Set(
        [partner1.email, partner2?.email]
          .map((e) => (e ?? '').trim().toLowerCase())
          .filter(Boolean),
      )
      for (const e of extras) {
        const fullName = [e.first, e.last].filter(Boolean).join(' ').trim()
        const email = e.email?.trim() || null
        // Same human on two rows of the same project. Not an agent.
        if (email && partnerEmails.has(email.toLowerCase())) continue
        const { role, detail } = inferContactRole({
          first: e.first,
          last: e.last,
          company: e.company,
          partnerSurnames,
        })
        relatedContacts.push({
          first_name: e.first,
          last_name: e.last,
          email,
          phone: e.phone,
          role,
          role_detail: detail,
          external_id: contactExternalId(projectName, email, fullName, e.csvRow),
          source_row: e.csvRow,
          raw_row: e.rawRow,
        })
      }
      const extraNames = extras
        .map((e) => [e.first, e.last].filter(Boolean).join(' ') || `row ${e.csvRow}`)
        .join(', ')
      warnings.push(
        `"${projectName ?? '(no project name)'}": ${extras.length} extra ` +
        `${extras.length === 1 ? 'person' : 'people'} (${extraNames}) read as ` +
        `agents on the couple, not partners — couple read as ` +
        `${[partner1.first, partner2?.first].filter(Boolean).join(' & ') || partner1.first}`,
      )
    }

    const projDate = pickRaw('projDate')
    const booking  = pickRaw('booking')
    const inquiry  = pickRaw('inquiry')
    const sourceRaw = pickRaw('sourceRaw')
    const status = members.find((m) => m.status)?.status ?? null
    if (status == null && members.some((m) => m.statusRaw)) {
      warnings.push(
        `"${projectName ?? '(no project name)'}": unknown HoneyBook status — defaulting to 'inquiry'`,
      )
    }

    // Tags + notes — concatenate across the group.
    const noteParts: string[] = []
    for (const m of members) {
      if (m.tags) noteParts.push(`Tags: ${m.tags}`)
      if (m.notes) noteParts.push(m.notes)
    }
    const combinedNotes = noteParts.length > 0 ? noteParts.join('\n\n') : null

    // Lead-source provenance interaction (one per wedding).
    const recognisedHearSource = recogniseHearSource(sourceRaw)
    const adapterInteractions: NormalisedInteractionRow[] = []
    if (sourceRaw || recognisedHearSource) {
      const occurredAt =
        parseDateIso(inquiry) ?? parseDateIso(projDate) ?? new Date().toISOString()
      adapterInteractions.push({
        occurred_at: occurredAt,
        direction: 'inbound',
        type: 'meeting',
        subject: 'HoneyBook lead-source provenance',
        body: `provider:honeybook\nlead_source_raw:${sourceRaw ?? '(empty)'}`,
        extracted_identity: {
          provider: 'honeybook',
          hear_source_raw: sourceRaw,
          hear_source: recognisedHearSource,
        },
        // signal-class-justified: per-row override based on Q7-equivalent recognition
        signal_class: recognisedHearSource ? 'source' : 'crm',
        surface: 'crm_attribution',
      })
    }

    const lostAtIso =
      status === 'lost'
        ? (parseDateIso(booking) ?? parseDateIso(projDate) ?? new Date().toISOString())
        : null
    const lostDeal: NormalisedLostDealRow | null =
      status === 'lost'
        ? {
            lost_at: lostAtIso ?? new Date().toISOString(),
            lost_at_stage: null,
            reason_category: 'other',
            reason_detail: 'Imported from HoneyBook (no detail available).',
            competitor_name: null,
          }
        : null

    rows.push({
      source_id: projectName,
      partner1_first_name: partner1.first ?? fromProject.partner1_first,
      partner1_last_name: partner1.last ?? fromProject.partner1_last,
      partner1_email: partner1.email,
      partner1_phone: partner1.phone,
      // partner2 from the second person-row when the export splits a
      // couple across rows; else the second name parsed from the
      // Project Name.
      partner2_first_name: partner2?.first ?? fromProject.partner2_first,
      partner2_last_name: partner2?.last ?? fromProject.partner2_last,
      partner2_email: partner2?.email ?? null,
      partner2_phone: partner2?.phone ?? null,
      wedding_date: parseDateYmd(projDate),
      guest_count_estimate: parseGuestCount(pickRaw('guestRaw')),
      booking_value: parseMoneyToCents(pickRaw('totalRaw')),
      amount_paid: parseMoneyToCents(pickRaw('paidRaw')),
      deposit_amount: parseMoneyToCents(pickRaw('depositRaw')),
      tax_amount: parseMoneyToCents(pickRaw('taxRaw')),
      gratuity_amount: parseMoneyToCents(pickRaw('gratuityRaw')),
      refunded_amount: parseMoneyToCents(pickRaw('refundedRaw')),
      package_name: pickRaw('packageRaw'),
      raw_row: partner1.rawRow,
      status: status ?? 'inquiry',
      source: null,
      source_detail: sourceRaw,
      inquiry_date: parseDateIso(inquiry),
      booked_at: parseDateIso(booking),
      lost_at: lostAtIso,
      lost_reason: status === 'lost' ? 'other' : null,
      notes: combinedNotes,
      interactions: adapterInteractions,
      tours: [],
      lost_deal: lostDeal,
      related_contacts: relatedContacts,
    })
  }

  return { ok: errors.length === 0, rows, errors, warnings }
}

// ---------------------------------------------------------------------------
// preview() — summary plus first 50 rows
// ---------------------------------------------------------------------------

function previewHoneybook(rows: NormalisedLeadRow[]): PreviewResult {
  const warnings: string[] = []
  if (rows.length > 50) warnings.push(`only first 50 of ${rows.length} rows shown`)

  // Surface a summary in warnings (the UI displays warnings prominently
  // and there's no dedicated summary slot in PreviewResult).
  const byStatus = new Map<string, number>()
  let earliest: string | null = null
  let latest: string | null = null
  const sources = new Set<string>()
  const byRole = new Map<string, number>()
  let relatedTotal = 0
  for (const r of rows) {
    byStatus.set(r.status ?? 'inquiry', (byStatus.get(r.status ?? 'inquiry') ?? 0) + 1)
    for (const c of r.related_contacts ?? []) {
      relatedTotal += 1
      byRole.set(c.role, (byRole.get(c.role) ?? 0) + 1)
    }
    if (r.wedding_date) {
      if (!earliest || r.wedding_date < earliest) earliest = r.wedding_date
      if (!latest   || r.wedding_date > latest)   latest   = r.wedding_date
    }
    if (r.source_detail) sources.add(r.source_detail)
  }
  if (rows.length > 0) {
    const parts = Array.from(byStatus.entries()).map(([k, v]) => `${k}=${v}`).join(', ')
    warnings.push(`Summary — ${rows.length} rows (${parts})`)
    if (earliest && latest) warnings.push(`Date range: ${earliest} → ${latest}`)
    if (sources.size > 0)   warnings.push(`Distinct lead sources: ${sources.size}`)
    if (relatedTotal > 0) {
      const roleParts = Array.from(byRole.entries())
        .map(([k, v]) => `${k}=${v}`).join(', ')
      warnings.push(
        `Other people on these projects: ${relatedTotal} (${roleParts}) — `
        + `imported as agents linked to their couple, not as partners`,
      )
    }
  }

  return {
    rows: rows.slice(0, 50),
    total: rows.length,
    errors: [],
    warnings,
  }
}

// ---------------------------------------------------------------------------
// commit() — funnel through commitNormalisedRows so all adapters share the
// same row → DB shape. Stream CC's transaction wrapper (if landed) will
// call this; otherwise per-row inserts run.
// ---------------------------------------------------------------------------

async function commitHoneybook(args: {
  supabase: SupabaseClient
  venueId: string
  rows: NormalisedLeadRow[]
  /** §7 OPERATOR-BLOCK item 4 dry-run pass-through (flows via ...args). */
  preview?: boolean
}): Promise<CommitResult> {
  // T5-Rixey-BBB: HoneyBook is a CRM (not an acquisition channel).
  // Default per-row interaction class is 'crm'. The synthetic
  // hear-source interaction parseHoneybook produces (lines 458-477)
  // overrides this to 'source' on a per-row basis when the
  // coordinator-typed "Source" cell maps to a recognised channel.
  const { commitNormalisedRows } = await import('./index')
  return commitNormalisedRows({
    ...args,
    crmSource: 'honeybook',
    defaultInteractionSignalClass: 'crm',
  })
}

export const honeybookAdapter: CrmAdapter = {
  name: 'honeybook',
  label: 'HoneyBook',
  description:
    'Import a Projects CSV exported from HoneyBook (Settings → Reports → Projects → Export). ' +
    'Project Name, Project Date, and Client Email are required; status, total, source, ' +
    'inquiry/booking dates, tags, and notes are mapped automatically.',
  ready: true,
  parse: parseHoneybook,
  preview: previewHoneybook,
  commit: commitHoneybook,
}
