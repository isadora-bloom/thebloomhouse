/**
 * W20 — the HoneyBook adapter stops dropping the people on a project
 * who are not the couple.
 *
 * Fixture provenance
 * ------------------
 * The header is the real one from Rixey's five "Booked Client" exports
 * (verified 2026-09-09 against the files on disk):
 *
 *   First Name,Last Name,Email,Project Name,Project Type,Project Source,
 *   Project Creation Date,Project Date,Booked Date,Total Booked Value,
 *   Tax,Total Paid,Refunded Amount,Gratuity,Company
 *
 * The parent rows are the real shape too — "Katie Bubenhofer Benjamin
 * Lazo Wedding" really does carry Kurt and Sharon Bubenhofer alongside
 * the couple, and the old adapter warned about them and threw them away.
 * The planner row is SYNTHETIC: the Company column is present in every
 * real export but empty in all 281 rows, so no fixture on disk holds a
 * project with a planner. It is built here from the documented column so
 * the branch is covered.
 *
 * No network, no database. Parser only.
 */

import { describe, it, expect } from 'vitest'
import { honeybookAdapter } from '../honeybook'

const HEADER =
  'First Name,Last Name,Email,Project Name,Project Type,Project Source,'
  + 'Project Creation Date,Project Date,Booked Date,Total Booked Value,'
  + 'Tax,Total Paid,Refunded Amount,Gratuity,Company'

function row(
  first: string,
  last: string,
  email: string,
  project: string,
  company = '',
): string {
  return [
    first, last, email, project, 'Wedding', 'The Knot',
    '2024-03-05 00:04:47 UTC', '2025-06-14 00:00:00 UTC',
    '2024-03-08 19:32:47 UTC', '13250.00', '250.00', '4416.67', '0.00',
    '0.00', company,
  ].join(',')
}

/** Couple plus mother plus planner, all on one project. */
const CSV_WITH_FAMILY = [
  HEADER,
  row('Katie', 'Bubenhofer', 'katie.b@example.com', 'Katie Bubenhofer Benjamin Lazo Wedding'),
  row('Benjamin', 'Lazo', 'ben.lazo@example.com', 'Katie Bubenhofer Benjamin Lazo Wedding'),
  row('Sharon', 'Bubenhofer', 'bubenhofers@example.com', 'Katie Bubenhofer Benjamin Lazo Wedding'),
  row('Ivy', 'Lane', 'ivy@ivylaneevents.example', 'Katie Bubenhofer Benjamin Lazo Wedding', 'Ivy Lane Events'),
].join('\n')

async function parse(csv: string) {
  return honeybookAdapter.parse({ csvText: csv })
}

describe('honeybook adapter — non-couple project contacts', () => {
  it('keeps the couple as the couple and everyone else as related contacts', async () => {
    const res = await parse(CSV_WITH_FAMILY)
    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(1)

    const lead = res.rows[0]!
    expect(lead.partner1_first_name).toBe('Katie')
    expect(lead.partner2_first_name).toBe('Benjamin')

    const contacts = lead.related_contacts ?? []
    expect(contacts).toHaveLength(2)
    expect(contacts.map((c) => c.first_name).sort()).toEqual(['Ivy', 'Sharon'])
  })

  it('reads a shared surname as a parent, and says why', async () => {
    const res = await parse(CSV_WITH_FAMILY)
    const sharon = (res.rows[0]!.related_contacts ?? [])
      .find((c) => c.first_name === 'Sharon')!
    expect(sharon.role).toBe('parent')
    expect(sharon.role_detail).toContain('Bubenhofer')
    expect(sharon.email).toBe('bubenhofers@example.com')
  })

  it('reads a filled Company cell as a planner', async () => {
    const res = await parse(CSV_WITH_FAMILY)
    const ivy = (res.rows[0]!.related_contacts ?? [])
      .find((c) => c.first_name === 'Ivy')!
    expect(ivy.role).toBe('planner')
    expect(ivy.role_detail).toBe('Company: Ivy Lane Events')
  })

  it('falls back to "other" when the surname does not match and there is no company', async () => {
    const csv = [
      HEADER,
      row('Bria', 'Kelly', 'bria@example.com', "Bria and Iain's Wedding"),
      row('Iain', 'Kelly', 'iain@example.com', "Bria and Iain's Wedding"),
      row('Amy', 'Stewart', 'concierge@example.com', "Bria and Iain's Wedding"),
    ].join('\n')
    const contacts = (await parse(csv)).rows[0]!.related_contacts ?? []
    expect(contacts).toHaveLength(1)
    expect(contacts[0]!.role).toBe('other')
    expect(contacts[0]!.role_detail).toBeNull()
  })

  it('does not turn a partner listed twice into an agent', async () => {
    const csv = [
      HEADER,
      row('Katie', 'Bubenhofer', 'katie.b@example.com', 'Katie Bubenhofer Benjamin Lazo Wedding'),
      row('Benjamin', 'Lazo', 'ben.lazo@example.com', 'Katie Bubenhofer Benjamin Lazo Wedding'),
      row('Katie', 'Bubenhofer', 'katie.b@example.com', 'Katie Bubenhofer Benjamin Lazo Wedding'),
    ].join('\n')
    expect((await parse(csv)).rows[0]!.related_contacts ?? []).toHaveLength(0)
  })

  it('leaves a plain two-person project with no related contacts', async () => {
    const csv = [
      HEADER,
      row('Katie', 'Bubenhofer', 'katie.b@example.com', 'Katie Bubenhofer Benjamin Lazo Wedding'),
      row('Benjamin', 'Lazo', 'ben.lazo@example.com', 'Katie Bubenhofer Benjamin Lazo Wedding'),
    ].join('\n')
    expect((await parse(csv)).rows[0]!.related_contacts ?? []).toHaveLength(0)
  })

  it('gives each contact a stable external id, so a re-upload is the same key', async () => {
    const first = (await parse(CSV_WITH_FAMILY)).rows[0]!.related_contacts ?? []
    const second = (await parse(CSV_WITH_FAMILY)).rows[0]!.related_contacts ?? []
    expect(first.map((c) => c.external_id)).toEqual(second.map((c) => c.external_id))
    expect(first[0]!.external_id).toMatch(/^honeybook:contact:/)
    // The email is the key when there is one — a re-export that renames
    // the project must not mint the mother a second time.
    expect(first.find((c) => c.first_name === 'Sharon')!.external_id)
      .toContain('bubenhofers@example.com')
  })

  it('says in the warnings where the extra people went, not that they were dropped', async () => {
    const res = await parse(CSV_WITH_FAMILY)
    const joined = res.warnings.join(' | ')
    expect(joined).toContain('agents on the couple')
    expect(joined).not.toContain('not imported as')
  })

  it('counts them in the preview summary', async () => {
    const res = await parse(CSV_WITH_FAMILY)
    const preview = honeybookAdapter.preview(res.rows)
    const joined = preview.warnings.join(' | ')
    expect(joined).toContain('Other people on these projects: 2')
    expect(joined).toContain('parent=1')
    expect(joined).toContain('planner=1')
  })

  it('still parses the classic one-row-per-project export unchanged', async () => {
    const csv = [
      'Project Name,Project Type,Project Date,Project Status,Client Name,Client Email,Client Phone,Total',
      'Sarah Chen Wedding,Wedding,2026-09-12,Booked,Sarah Chen,sarah.chen@example.com,555-0101,"$8,500.00"',
    ].join('\n')
    const res = await parse(csv)
    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.related_contacts).toEqual([])
  })
})
