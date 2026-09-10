/**
 * Non-couple project contacts → Agent-class people on the spine.
 * W20, 2026-09-09.
 *
 * The problem this closes
 * -----------------------
 * A HoneyBook project export is one row per person. Two rows sharing a
 * Project Name are the couple; a third or fourth is whoever else was on
 * the file. In Rixey's five exports that is 31 real humans across 281
 * projects: mothers, fathers, an aunt, a house concierge. Every one of
 * them used to end up in a parse warning and nowhere else, which means
 * when the mother rings the venue or emails about the rehearsal, nothing
 * on the spine knows she belongs to that couple.
 *
 * The doctrine has a class for exactly this person
 * ------------------------------------------------
 * IDENTITY-FIRST-ARCHITECTURE.md §1: an Agent is "a real human acting on
 * behalf of one or more couples (planner, parent, coordinator)", kept
 * separate from the couple list because a planner with twelve weddings a
 * year carries more signal than any single couple, and reducing them to
 * a fragment destroys it. Migration 346 shipped the storage
 * (`couples.lifecycle_state='agent'` plus `agent_couple_links`) and
 * nothing had ever written to it.
 *
 * What this module does
 * ---------------------
 * For each contact, in order:
 *
 *   1. Refuse the row if the wedding it hangs off was rolled back
 *      mid-import.
 *   2. Stamp the recurring-CSV dedup marker (`crm_import_rows`, migration
 *      335) keyed on the contact's stable external_id. If the marker
 *      cannot be written we SKIP the contact and record why. We never
 *      carry on and import them again on the next upload — that is the
 *      swallowed-dedup rule, and it is the reason a re-uploaded export
 *      does not double every mother in the venue.
 *   3. Hand the contact to `linkSignal` with `agent_context` set. The
 *      Agent branch (identity/agent-link.ts) is the only writer: it mints
 *      the agent's own couples row, joins it to the couple through
 *      agent_couple_links, and records the role on wedding_relationships.
 *   4. Finalise the dedup marker with the outcome.
 *
 * Nothing here inserts into `people` or `couples` directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CrmSource,
  NormalisedRelatedContactRow,
  RelatedContactsSummary,
} from './index'

/** One queued contact plus the couple context the row loop already knew. */
export interface PendingRelatedContact {
  contact: NormalisedRelatedContactRow
  /** Legacy weddings.id the contact's project resolved to. */
  weddingId: string
  /** Project name, for provenance in the touchpoint payload. */
  rowSourceId: string | null
  /** yyyy-mm-dd, used to anchor the touchpoint on the couple's timeline. */
  weddingDate: string | null
}

/** Coordinator-readable label for a contact. Never blank. */
function labelFor(contact: NormalisedRelatedContactRow): string {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
  return name || contact.email || `row ${contact.source_row ?? '?'}`
}

/**
 * The export gives no per-contact date. Anchor the touchpoint to the
 * wedding date when there is one, so the agent's record sits on the
 * couple's timeline rather than on import day.
 */
function occurredAtFor(weddingDate: string | null): string {
  if (weddingDate) {
    const d = new Date(`${weddingDate}T00:00:00Z`)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

export async function commitRelatedContacts(args: {
  supabase: SupabaseClient
  venueId: string
  crmSource: CrmSource
  pending: PendingRelatedContact[]
  /** Weddings that survived the row loop. A contact whose wedding was
   *  rolled back is skipped rather than left pointing at nothing. */
  survivingWeddings: Set<string>
}): Promise<RelatedContactsSummary> {
  const { supabase, venueId, crmSource, pending, survivingWeddings } = args
  const summary: RelatedContactsSummary = {
    seen: pending.length,
    created: 0,
    linked: 0,
    rolesRecorded: 0,
    skipped: [],
  }
  if (pending.length === 0) return summary

  const { classifyImportRow, recordResolution } = await import('./import-rows')
  const { linkSignal } = await import(
    '@/lib/services/identity/forwards-linker'
  )

  for (const item of pending) {
    const { contact, weddingId } = item
    const label = labelFor(contact)

    if (!survivingWeddings.has(weddingId)) {
      summary.skipped.push({ contact: label, reason: 'wedding_row_rolled_back' })
      continue
    }

    // Dedup marker FIRST. A failure here means we cannot tell a first
    // import from a fifth, so we write nothing at all for this contact.
    let importRowId: string | null = null
    try {
      const classified = await classifyImportRow({
        supabase,
        venueId,
        // adapter-source-justified: crm_import_rows.source (which importer's ledger this fingerprint lives in), not a weddings.source attribution write.
        source: 'honeybook',
        identity: {
          externalId: contact.external_id ?? null,
          email: contact.email ?? null,
          phone: contact.phone ?? null,
          fullName: label,
          weddingDate: item.weddingDate,
        },
        state: {
          extras: {
            role: contact.role,
            email: contact.email ?? null,
            phone: contact.phone ?? null,
            wedding_id: weddingId,
          },
        },
        rowData: {
          kind: 'related_contact',
          project: item.rowSourceId,
          wedding_id: weddingId,
          ...(contact.raw_row ?? {}),
        },
      })
      if (classified.state === 'unchanged') {
        summary.skipped.push({ contact: label, reason: 'already_imported' })
        continue
      }
      importRowId = classified.importRowId
    } catch (err) {
      summary.skipped.push({
        contact: label,
        reason:
          'processed_marker_failed: '
          + (err instanceof Error ? err.message : 'unknown'),
      })
      continue
    }

    const fullName =
      [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null

    try {
      const linkResult = await linkSignal({
        supabase,
        venueId,
        signal: {
          external_id:
            contact.external_id
            ?? `honeybook:contact:${weddingId}:${contact.source_row ?? 0}`,
          channel: 'honeybook',
          action_type: 'crm_related_contact',
          occurred_at: occurredAtFor(item.weddingDate),
          signal_tier: 'medium',
          identity_hint: fullName ?? contact.email ?? null,
          primary_name: fullName,
          primary_email: contact.email ?? null,
          primary_phone: contact.phone ?? null,
          raw_payload: {
            provider: 'honeybook',
            kind: 'related_contact',
            role: contact.role,
            role_detail: contact.role_detail ?? null,
            project: item.rowSourceId,
            crm_import_row_id: importRowId,
            source_row: contact.source_row ?? null,
          },
          agent_context: {
            role: contact.role,
            relationship_detail: contact.role_detail ?? null,
            for_legacy_wedding_id: weddingId,
            // The venue's own CRM says who is on the file. That is a
            // record, not an inference.
            link_source: 'operator_confirmed',
            role_source: 'csv_import',
          },
        },
        // adapter-source-justified: factual provenance label for linkSignal telemetry (which importer produced the signal), not a weddings.source attribution write.
        source: `crm_import:${crmSource}`,
      })

      const agent = linkResult.agent_link
      if (agent?.created) summary.created += 1
      if (agent?.role_recorded) summary.rolesRecorded += 1
      if (agent?.linked) {
        summary.linked += 1
      } else {
        summary.skipped.push({
          contact: label,
          reason: agent?.skipped_reason || linkResult.reason || 'not_linked',
        })
      }

      if (importRowId) {
        await recordResolution({
          supabase,
          importRowId,
          resolution: agent?.linked ? 'attached_strong' : 'flagged',
          resolvedWeddingId: weddingId,
          reason:
            `related_contact role=${contact.role} `
            + `agent=${agent?.agent_couple_id ?? 'none'}`,
        })
      }
    } catch (err) {
      summary.skipped.push({
        contact: label,
        reason: 'link_failed: ' + (err instanceof Error ? err.message : 'unknown'),
      })
    }
  }

  return summary
}
