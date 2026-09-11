/**
 * W25 (NOVEMBER-PLAN.md wave 3) — "ask for the key" on the web-form /
 * calculator CSV adapter. HANDLE-IDENTITY-SPEC.md §4: the cheapest
 * reliable way to join a person's Instagram to their inquiry is to ask
 * them. This tests the optional instagram/tiktok columns on
 * `webFormAdapter.parse()` — pure CSV parsing, no database.
 */
import { describe, it, expect } from 'vitest'
import { webFormAdapter } from '../web-form'
import type { AdapterConfig, NormalisedInteractionRow } from '../index'

function extractedIdentityOf(row: {
  interactions?: NormalisedInteractionRow[]
}): Record<string, unknown> | null | undefined {
  return row.interactions?.[0]?.extracted_identity
}

describe('webFormAdapter — handle capture (Wave 3)', () => {
  it('calculator_submissions: a well-formed Instagram handle lands normalised on extracted_identity.handles', async () => {
    const csvText = [
      'id,created_at,p1_name,p1_email,wedding_date,guests,instagram',
      '1,2026-06-01,Rosie Hoyle,rosie@example.com,2027-06-20,120,@Rosie.Hoyle',
    ].join('\n')

    const result = await webFormAdapter.parse({
      csvText,
      formProvider: 'calculator_submissions',
    } as AdapterConfig)

    expect(result.ok).toBe(true)
    expect(result.rows).toHaveLength(1)
    const ei = extractedIdentityOf(result.rows[0])
    expect(ei?.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('calculator_submissions: a profile URL in the instagram column normalises to the path segment', async () => {
    const csvText = [
      'id,created_at,p1_name,p1_email,wedding_date,guests,instagram',
      '1,2026-06-01,Rosie Hoyle,rosie@example.com,2027-06-20,120,https://instagram.com/rosie.hoyle/',
    ].join('\n')

    const result = await webFormAdapter.parse({
      csvText,
      formProvider: 'calculator_submissions',
    } as AdapterConfig)

    const ei = extractedIdentityOf(result.rows[0])
    expect(ei?.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('contact_submissions: malformed handle input is dropped, never stored, and warned about', async () => {
    const csvText = [
      'id,created_at,name,email,message,instagram',
      '1,2026-06-01,Rosie Hoyle,rosie@example.com,Hi there,not a handle at all!!',
    ].join('\n')

    const result = await webFormAdapter.parse({
      csvText,
      formProvider: 'contact_submissions',
    } as AdapterConfig)

    expect(result.ok).toBe(true)
    const ei = extractedIdentityOf(result.rows[0])
    expect(ei?.handles).toBeUndefined()
    expect(result.warnings.some((w) => w.includes('dropped') && w.includes('handle'))).toBe(true)
  })

  it('no instagram column present: extracted_identity carries no handles key at all', async () => {
    const csvText = [
      'id,created_at,name,email,message',
      '1,2026-06-01,Rosie Hoyle,rosie@example.com,Hi there',
    ].join('\n')

    const result = await webFormAdapter.parse({
      csvText,
      formProvider: 'contact_submissions',
    } as AdapterConfig)

    const ei = extractedIdentityOf(result.rows[0])
    expect(ei?.handles).toBeUndefined()
  })

  it('rixey_calculator hint: coordinator can still supply an instagramColumn override', async () => {
    const csvText = [
      'Received,Partner One Name,Partner One Email,IG Handle',
      '2026-06-01,Rosie Hoyle,rosie@example.com,@rosie.hoyle',
    ].join('\n')

    const result = await webFormAdapter.parse({
      csvText,
      formProvider: 'rixey_calculator',
      hintOverrides: { instagramColumn: 'IG Handle' },
    } as AdapterConfig)

    const ei = extractedIdentityOf(result.rows[0])
    expect(ei?.handles).toEqual({ instagram: 'rosie.hoyle' })
  })
})
