/**
 * Build a contract from a booked wedding's own figures.
 *
 * The read is deliberately narrow. Four rows: the wedding (package, money,
 * date, guests), its wedding_details (the hours and the check-in times
 * migration 390 restored), the venue's config (name, coordinator, currency,
 * and the template blob), and the couple's names from `people`. Nothing is
 * invented and nothing is inferred; a figure the venue has not recorded
 * renders as "to be confirmed" rather than as a zero.
 *
 * Everything that lands on the page is frozen into
 * `contracts.generated_from` at the same moment. A wedding's guest count
 * moves; a contract that has been sent must not.
 *
 * The row that comes out sits in the same `contracts` table as the couple's
 * uploads, with kind='generated' and status='draft', so the couple's
 * library, the coordinator's walkthrough section, the search on both, and
 * the assistant's contract library all pick it up with no new reader.
 *
 * No model is called anywhere in this file.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { writeOrLog } from '@/lib/db/write-or-log'
import { redactError } from '@/lib/observability/redact'
import {
  DEFAULT_CONTRACT_TEMPLATE,
  parseContractTemplate,
  renderContract,
  renderContractHtml,
  renderContractText,
  TEMPLATE_FLAG_KEY,
  type ContractPackageSnapshot,
  type ContractTemplate,
  type RenderedContract,
} from './templates'
import { contractBlocks, renderPdf } from './pdf'

/** The storage bucket the couple's uploads already use (migration 028). */
export const CONTRACTS_BUCKET = 'contracts'

type Db = SupabaseClient

export type GenerateFailure =
  | 'wedding_not_found'
  | 'not_booked'
  | 'storage_failed'
  | 'insert_failed'

export interface GenerateResult {
  ok: boolean
  contractId?: string
  failure?: GenerateFailure
  message?: string
  snapshot?: ContractPackageSnapshot
  html?: string
}

// ---------------------------------------------------------------------------
// Reading the figures
// ---------------------------------------------------------------------------

/** Statuses that mean the couple has actually booked. */
const BOOKED_STATUSES = ['contracted', 'booked', 'completed']

function nullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function nullableText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/**
 * "Chloe and Ryan" from the two partner rows, in role order, skipping
 * anyone merged away. Falls back to whichever half exists, and to a plain
 * "the couple" when neither does, because a contract addressed to an empty
 * string is worse than one addressed generically.
 */
export function joinCoupleNames(
  people: Array<{ role?: string | null; first_name?: string | null; last_name?: string | null }>,
): string {
  const byRole = (role: string) =>
    people.find((p) => p.role === role)
  const name = (p: { first_name?: string | null; last_name?: string | null } | undefined) => {
    if (!p) return null
    const full = [p.first_name, p.last_name].filter((s) => !!s?.trim()).join(' ').trim()
    return full === '' ? null : full
  }
  const a = name(byRole('partner1'))
  const b = name(byRole('partner2'))
  if (a && b) return `${a} and ${b}`
  return a ?? b ?? 'the couple'
}

export interface SnapshotLoad {
  ok: boolean
  failure?: GenerateFailure
  venueId?: string
  snapshot?: ContractPackageSnapshot
  template?: ContractTemplate
}

/**
 * Read everything a contract needs for one wedding.
 *
 * Exported so the preview path and the generate path read exactly the
 * same thing. A preview that came from a different query would be a
 * preview of a different document.
 */
export async function loadPackageSnapshot(
  weddingId: string,
  db: Db = createServiceClient(),
  now: Date = new Date(),
): Promise<SnapshotLoad> {
  // Rows come back through an untyped `Record` on purpose. The generated
  // database types are not wired into this client, and a multi-column
  // select string leaves supabase-js inferring an error shape instead of a
  // row. Every field is read through a narrowing helper below, so an
  // absent column is a null rather than a crash.
  const { data: weddingRow } = await db
    .from('weddings')
    .select(
      'id, venue_id, status, wedding_date, event_code, guest_count_estimate, ' +
        'booking_value, deposit_amount, amount_paid, tax_amount, gratuity_amount, package_name',
    )
    .eq('id', weddingId)
    .maybeSingle()

  const wedding = weddingRow as unknown as Record<string, unknown> | null
  if (!wedding) return { ok: false, failure: 'wedding_not_found' }

  const venueId = wedding.venue_id as string

  if (!BOOKED_STATUSES.includes(String(wedding.status))) {
    return { ok: false, failure: 'not_booked', venueId }
  }

  const [
    { data: detailsRow },
    { data: configRow },
    { data: venueRow },
    { data: peopleRows },
  ] = await Promise.all([
      db
        .from('wedding_details')
        .select(
          'contract_checkin, contract_checkout, contract_wedding_hours, ' +
            'contract_rehearsal_hours, contract_max_wedding, contract_max_rehearsal, contract_overnights',
        )
        .eq('wedding_id', weddingId)
        .eq('venue_id', venueId)
        .maybeSingle(),
      db
        .from('venue_config')
        .select(
          'business_name, coordinator_name, coordinator_email, coordinator_phone, currency, feature_flags',
        )
        .eq('venue_id', venueId)
        .maybeSingle(),
      db.from('venues').select('name').eq('id', venueId).maybeSingle(),
      db
        .from('people')
        .select('role, first_name, last_name')
        .eq('wedding_id', weddingId)
        .in('role', ['partner1', 'partner2'])
        .is('merged_into_id', null),
    ])

  const details = detailsRow as unknown as Record<string, unknown> | null
  const config = configRow as unknown as Record<string, unknown> | null
  const venue = venueRow as unknown as Record<string, unknown> | null
  const people = (peopleRows ?? []) as unknown as Array<{
    role?: string | null
    first_name?: string | null
    last_name?: string | null
  }>

  const flags = (config?.feature_flags ?? {}) as Record<string, unknown>
  const template = parseContractTemplate(flags[TEMPLATE_FLAG_KEY])

  const snapshot: ContractPackageSnapshot = {
    venueName:
      nullableText(config?.business_name) ?? nullableText(venue?.name) ?? 'the venue',
    coordinatorName: nullableText(config?.coordinator_name),
    coordinatorEmail: nullableText(config?.coordinator_email),
    coordinatorPhone: nullableText(config?.coordinator_phone),
    currency: nullableText(config?.currency) ?? 'USD',

    coupleNames: joinCoupleNames(people),
    weddingDate: nullableText(wedding.wedding_date),
    eventCode: nullableText(wedding.event_code),
    guestCount: nullableNumber(wedding.guest_count_estimate),

    packageName: nullableText(wedding.package_name),
    totalCents: nullableNumber(wedding.booking_value),
    depositCents: nullableNumber(wedding.deposit_amount),
    paidCents: nullableNumber(wedding.amount_paid),
    taxCents: nullableNumber(wedding.tax_amount),
    gratuityCents: nullableNumber(wedding.gratuity_amount),

    checkIn: nullableText(details?.contract_checkin),
    checkOut: nullableText(details?.contract_checkout),
    weddingHours: nullableText(details?.contract_wedding_hours),
    rehearsalHours: nullableText(details?.contract_rehearsal_hours),
    maxWeddingGuests: nullableNumber(details?.contract_max_wedding),
    maxRehearsalGuests: nullableNumber(details?.contract_max_rehearsal),
    overnights: nullableNumber(details?.contract_overnights),

    generatedAt: now.toISOString(),
  }

  return { ok: true, venueId, snapshot, template }
}

// ---------------------------------------------------------------------------
// What gets frozen on the row
// ---------------------------------------------------------------------------

/**
 * The shape of `contracts.generated_from`.
 *
 * The figures AND the template that was used, because re-rendering needs
 * both and a venue editing their template next month must not change the
 * wording of a contract somebody already signed. The couple's signing page
 * re-renders from this, so what they read is what was sent, not what the
 * template says today.
 */
export interface GeneratedFrom {
  snapshot: ContractPackageSnapshot
  template: ContractTemplate
}

/**
 * Read the frozen blob back, defensively. A row written before this shape
 * existed, or one whose jsonb is half a snapshot, comes back null so the
 * caller can say "we cannot show this" rather than render a contract with
 * blanks where the money was.
 */
export function readGeneratedFrom(raw: unknown): GeneratedFrom | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const snap = r.snapshot
  if (typeof snap !== 'object' || snap === null || Array.isArray(snap)) return null
  const s = snap as Record<string, unknown>
  if (typeof s.venueName !== 'string' || typeof s.coupleNames !== 'string') return null
  return {
    snapshot: snap as unknown as ContractPackageSnapshot,
    template: parseContractTemplate(r.template),
  }
}

/** Render without writing anything. The preview button's whole job. */
export function previewContract(
  template: ContractTemplate,
  snapshot: ContractPackageSnapshot,
): { doc: RenderedContract; html: string } {
  const doc = renderContract(template, snapshot)
  return { doc, html: renderContractHtml(doc) }
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

function fileNameFor(snapshot: ContractPackageSnapshot): string {
  const code = snapshot.eventCode ?? 'wedding'
  const safe = code.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${safe}-agreement.pdf`
}

/**
 * Build the contract, put the PDF in storage, and record the row.
 *
 * The order matters. Storage first, so a row never points at a file that
 * is not there; if the upload fails nothing is written at all and the
 * coordinator sees a failure rather than a contract they cannot open.
 */
export async function generateContract(input: {
  weddingId: string
  actorId?: string | null
  db?: Db
  now?: Date
}): Promise<GenerateResult> {
  const db = input.db ?? createServiceClient()
  const now = input.now ?? new Date()

  const load = await loadPackageSnapshot(input.weddingId, db, now)
  if (!load.ok || !load.snapshot || !load.venueId) {
    return {
      ok: false,
      failure: load.failure,
      message:
        load.failure === 'not_booked'
          ? 'Contracts are generated from a booked wedding. This one is not booked yet.'
          : 'That wedding could not be found.',
    }
  }

  const template = load.template ?? DEFAULT_CONTRACT_TEMPLATE
  const doc = renderContract(template, load.snapshot)
  const html = renderContractHtml(doc)
  const text = renderContractText(doc)
  const pdf = renderPdf(contractBlocks(doc))

  const filename = fileNameFor(load.snapshot)
  const storagePath = `${input.weddingId}/${now.getTime()}_${filename}`

  const { error: storageError } = await db.storage
    .from(CONTRACTS_BUCKET)
    .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true })

  if (storageError) {
    console.error('[contracts/generate] storage upload failed:', redactError(storageError))
    return {
      ok: false,
      failure: 'storage_failed',
      message: 'The contract was built but could not be saved. Try again in a moment.',
    }
  }

  // S5 (2026-09-14 audit item 6): this used to mint a one-year signed URL
  // and persist it in contracts.file_url. A signed URL is a bearer
  // credential; a year of it sitting in a column is a year of anyone who
  // can read that column holding the contract PDF itself, with no way to
  // revoke it. The storage path below is the durable reference, and the
  // read surfaces mint a 60-second URL when someone actually clicks.
  const { data, error } = await writeOrLog(
    db
      .from('contracts')
      .insert({
        venue_id: load.venueId,
        wedding_id: input.weddingId,
        filename,
        file_type: 'pdf',
        storage_path: storagePath,
        file_url: null,
        // The plain text goes in so the search on both contract surfaces
        // and the assistant's contract library find a generated contract
        // the same way they find an uploaded one.
        extracted_text: text,
        kind: 'generated',
        status: 'draft',
        template_key: template.key,
        generated_from: {
          snapshot: load.snapshot,
          template,
        } as unknown as Record<string, unknown>,
      })
      .select('id')
      .maybeSingle(),
    { op: 'contracts.generate', venueId: load.venueId, actor: input.actorId ?? 'coordinator' },
  )

  if (error || !data) {
    // The PDF is already in storage. Take it back out rather than leave an
    // orphan file nobody can reach.
    await db.storage.from(CONTRACTS_BUCKET).remove([storagePath])
    return {
      ok: false,
      failure: 'insert_failed',
      message: 'The contract could not be saved. Nothing was sent.',
    }
  }

  return {
    ok: true,
    contractId: (data as { id: string }).id,
    snapshot: load.snapshot,
    html,
  }
}
