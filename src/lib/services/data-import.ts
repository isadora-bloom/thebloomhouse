/**
 * Bloom House: Data Import Service
 *
 * Imports parsed data rows into the correct Supabase tables based on
 * the detected data type. Each importer handles deduplication, validation,
 * and returns a structured result.
 */

import { createServiceClient } from '@/lib/supabase/service'
import type { DataType, ColumnMapping } from './data-detection'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportResult {
  success: boolean
  imported: number
  skipped: number
  errors: string[]
  details: string // human-readable summary
}

type Row = Record<string, string>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply column mapping to a row: remap keys from source → target */
function applyMapping(row: Row, mapping: ColumnMapping): Row {
  const mapped: Row = {}
  for (const [sourceCol, value] of Object.entries(row)) {
    const targetCol = mapping[sourceCol]
    if (targetCol) {
      mapped[targetCol] = value
    }
  }
  return mapped
}

/** Parse rows from 2D array with headers into Record objects */
export function rowsToRecords(rows: string[][], headers: string[]): Row[] {
  return rows.map((row) => {
    const record: Row = {}
    headers.forEach((header, i) => {
      if (header && i < row.length) {
        record[header] = row[i]
      }
    })
    return record
  })
}

/** Try to parse a date from various formats into YYYY-MM-DD */
function parseDate(value: string): string | null {
  if (!value || !value.trim()) return null
  const cleaned = value.trim()

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned

  // MM/DD/YYYY or M/D/YYYY
  const slashMatch = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (slashMatch) {
    const [, m, d, y] = slashMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // Try native Date parsing as last resort
  const parsed = new Date(cleaned)
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0]
  }

  return null
}

/** Parse a number, stripping $ and commas */
function parseNumber(value: string): number | null {
  if (!value || !value.trim()) return null
  const cleaned = value.replace(/[$,\s]/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}

/** Split a full name into first + last */
function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

// ---------------------------------------------------------------------------
// Import: Client List → weddings + people
// ---------------------------------------------------------------------------

export async function importClientList(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      // Parse names
      let firstName = row.first_name || ''
      let lastName = row.last_name || ''

      // If we have a combined "couple_name" or "name" but no first/last, split it
      if (!firstName && !lastName) {
        const rawName = rows[i]['Name'] || rows[i]['name'] || rows[i]['Couple Name'] || rows[i]['couple_name'] || ''
        if (rawName) {
          const split = splitName(rawName)
          firstName = split.first
          lastName = split.last
        }
      }

      const email = (row.email || '').trim().toLowerCase()
      const weddingDate = parseDate(row.wedding_date || '')
      const guestCount = parseNumber(row.guest_count_estimate || '')
      const bookingValue = parseNumber(row.booking_value || '')
      const source = row.source || null
      const notes = row.notes || null

      if (!firstName && !email) {
        errors.push(`Row ${i + 1}: No name or email found, skipping`)
        skipped++
        continue
      }

      // Dedup check: look for existing person with same email in this venue
      if (email) {
        const { data: existing } = await supabase
          .from('people')
          .select('id, wedding_id')
          .eq('venue_id', venueId)
          .eq('email', email)
          .limit(1)

        if (existing && existing.length > 0) {
          errors.push(`Row ${i + 1}: Email "${email}" already exists, skipping`)
          skipped++
          continue
        }
      }

      // Create wedding record
      const { data: wedding, error: weddingErr } = await supabase
        .from('weddings')
        .insert({
          venue_id: venueId,
          status: weddingDate && new Date(weddingDate) < new Date() ? 'completed' : 'inquiry',
          wedding_date: weddingDate,
          guest_count_estimate: guestCount,
          booking_value: bookingValue,
          source,
          notes,
        })
        .select('id')
        .single()

      if (weddingErr || !wedding) {
        errors.push(`Row ${i + 1}: Failed to create wedding — ${weddingErr?.message || 'unknown error'}`)
        skipped++
        continue
      }

      // Create partner1 record
      await supabase.from('people').insert({
        venue_id: venueId,
        wedding_id: wedding.id,
        role: 'partner1',
        first_name: firstName,
        last_name: lastName,
        email: email || null,
        phone: row.phone || null,
      })

      // Create partner2 if provided
      const partnerFirst = row.partner_first_name || ''
      const partnerLast = row.partner_last_name || ''
      if (partnerFirst) {
        await supabase.from('people').insert({
          venue_id: venueId,
          wedding_id: wedding.id,
          role: 'partner2',
          first_name: partnerFirst,
          last_name: partnerLast,
          email: row.partner_email || null,
        })
      }

      imported++
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`)
      skipped++
    }
  }

  return {
    success: errors.length === 0,
    imported,
    skipped,
    errors,
    details: `${imported} client${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Guest List → guest_list
// ---------------------------------------------------------------------------

export async function importGuestList(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string,
  weddingId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      let firstName = row.first_name || ''
      let lastName = row.last_name || ''

      if (!firstName && !lastName) {
        const rawName = rows[i]['Name'] || rows[i]['name'] || rows[i]['Guest Name'] || rows[i]['guest_name'] || ''
        if (rawName) {
          const split = splitName(rawName)
          firstName = split.first
          lastName = split.last
        }
      }

      if (!firstName && !lastName) {
        errors.push(`Row ${i + 1}: No name found, skipping`)
        skipped++
        continue
      }

      // Create person record
      const { data: person } = await supabase
        .from('people')
        .insert({
          venue_id: venueId,
          wedding_id: weddingId,
          role: 'guest',
          first_name: firstName,
          last_name: lastName,
          email: row.email || null,
        })
        .select('id')
        .single()

      // Normalize RSVP status
      const rawRsvp = (row.rsvp_status || '').toLowerCase().trim()
      let rsvpStatus = 'pending'
      if (['attending', 'yes', 'accepted', 'confirmed'].includes(rawRsvp)) rsvpStatus = 'attending'
      else if (['declined', 'no', 'not attending'].includes(rawRsvp)) rsvpStatus = 'declined'
      else if (['maybe', 'tentative', 'unsure'].includes(rawRsvp)) rsvpStatus = 'maybe'

      // Create guest_list record
      const { error: guestErr } = await supabase.from('guest_list').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        person_id: person?.id || null,
        group_name: row.group_name || null,
        rsvp_status: rsvpStatus,
        meal_preference: row.meal_preference || null,
        dietary_restrictions: row.dietary_restrictions || null,
        plus_one: ['yes', 'true', '1'].includes((row.plus_one || '').toLowerCase()),
        plus_one_name: row.plus_one_name || null,
        care_notes: row.care_notes || null,
      })

      if (guestErr) {
        errors.push(`Row ${i + 1}: ${guestErr.message}`)
        skipped++
        continue
      }

      imported++
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`)
      skipped++
    }
  }

  return {
    success: errors.length === 0,
    imported,
    skipped,
    errors,
    details: `${imported} guest${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Advertising Spend → marketing_spend
// ---------------------------------------------------------------------------

export async function importAdvertisingSpend(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      const source = (row.source || '').trim()
      const amount = parseNumber(row.amount || '')
      const month = parseDate(row.month || '')

      if (!source) {
        errors.push(`Row ${i + 1}: No source found, skipping`)
        skipped++
        continue
      }
      if (amount === null) {
        errors.push(`Row ${i + 1}: No amount found, skipping`)
        skipped++
        continue
      }

      const { error } = await supabase.from('marketing_spend').insert({
        venue_id: venueId,
        source,
        month: month || new Date().toISOString().split('T')[0],
        amount,
        notes: row.notes || null,
      })

      if (error) {
        errors.push(`Row ${i + 1}: ${error.message}`)
        skipped++
        continue
      }

      imported++
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`)
      skipped++
    }
  }

  return {
    success: errors.length === 0,
    imported,
    skipped,
    errors,
    details: `${imported} spend record${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Invoice → budget_items
// ---------------------------------------------------------------------------

export async function importInvoice(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string,
  weddingId?: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  // If no weddingId provided, try to find the most recent booked wedding
  let targetWeddingId = weddingId
  if (!targetWeddingId) {
    const { data: recent } = await supabase
      .from('weddings')
      .select('id')
      .eq('venue_id', venueId)
      .in('status', ['booked', 'inquiry'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    targetWeddingId = recent?.id
  }

  if (!targetWeddingId) {
    return {
      success: false,
      imported: 0,
      skipped: rows.length,
      errors: ['No wedding found to attach invoice items to. Create a wedding first or specify a wedding ID.'],
      details: 'Import failed: no target wedding found.',
    }
  }

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      const vendorName = (row.vendor_name || '').trim()
      const itemName = (row.item_name || vendorName || '').trim()
      const category = (row.category || 'Other').trim()
      const amount = parseNumber(row.amount || '')

      if (!itemName && !vendorName) {
        errors.push(`Row ${i + 1}: No vendor or item name, skipping`)
        skipped++
        continue
      }

      const { error } = await supabase.from('budget_items').insert({
        venue_id: venueId,
        wedding_id: targetWeddingId,
        category,
        item_name: itemName || 'Unnamed Item',
        budgeted: amount || 0,
        committed: amount || 0,
        vendor_name: vendorName || null,
        notes: row.notes || null,
        payment_due_date: parseDate(row.date || ''),
      })

      if (error) {
        errors.push(`Row ${i + 1}: ${error.message}`)
        skipped++
        continue
      }

      imported++
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`)
      skipped++
    }
  }

  return {
    success: errors.length === 0,
    imported,
    skipped,
    errors,
    details: `${imported} budget item${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Vendor List → vendor_recommendations
// ---------------------------------------------------------------------------

export async function importVendorList(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      const vendorName = (row.vendor_name || '').trim()
      if (!vendorName) {
        // Try raw row columns
        const rawName = rows[i]['Name'] || rows[i]['name'] || rows[i]['Vendor Name'] || rows[i]['vendor_name'] || ''
        if (!rawName.trim()) {
          errors.push(`Row ${i + 1}: No vendor name, skipping`)
          skipped++
          continue
        }
        row.vendor_name = rawName.trim()
      }

      // Dedup by name
      const { data: existing } = await supabase
        .from('vendor_recommendations')
        .select('id')
        .eq('venue_id', venueId)
        .ilike('vendor_name', row.vendor_name || vendorName)
        .limit(1)

      if (existing && existing.length > 0) {
        errors.push(`Row ${i + 1}: Vendor "${row.vendor_name || vendorName}" already exists, skipping`)
        skipped++
        continue
      }

      const { error } = await supabase.from('vendor_recommendations').insert({
        venue_id: venueId,
        vendor_name: row.vendor_name || vendorName,
        vendor_type: row.vendor_type || null,
        contact_email: row.contact_email || null,
        contact_phone: row.contact_phone || null,
        website_url: row.website_url || null,
        description: row.description || null,
        is_preferred: ['yes', 'true', '1', 'preferred'].includes(
          (row.is_preferred || '').toLowerCase()
        ),
      })

      if (error) {
        errors.push(`Row ${i + 1}: ${error.message}`)
        skipped++
        continue
      }

      imported++
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`)
      skipped++
    }
  }

  return {
    success: errors.length === 0,
    imported,
    skipped,
    errors,
    details: `${imported} vendor${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Tour Records → tours
// ---------------------------------------------------------------------------

export async function importTourRecords(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      const scheduledAt = parseDate(row.scheduled_at || '')

      // Normalize outcome
      const rawOutcome = (row.outcome || '').toLowerCase().trim()
      let outcome: string | null = null
      if (['completed', 'done', 'visited'].includes(rawOutcome)) outcome = 'completed'
      else if (['cancelled', 'canceled'].includes(rawOutcome)) outcome = 'cancelled'
      else if (['no_show', 'no show', 'noshow'].includes(rawOutcome)) outcome = 'no_show'
      else if (['rescheduled'].includes(rawOutcome)) outcome = 'rescheduled'

      // Normalize tour type
      const rawType = (row.tour_type || '').toLowerCase().trim()
      let tourType: string | null = null
      if (['in_person', 'in person', 'onsite', 'on-site'].includes(rawType)) tourType = 'in_person'
      else if (['virtual', 'video', 'zoom'].includes(rawType)) tourType = 'virtual'
      else if (['phone', 'call'].includes(rawType)) tourType = 'phone'

      const { error } = await supabase.from('tours').insert({
        venue_id: venueId,
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        tour_type: tourType,
        source: row.source || null,
        outcome,
        notes: row.notes || (row.couple_name ? `Couple: ${row.couple_name}` : null),
      })

      if (error) {
        errors.push(`Row ${i + 1}: ${error.message}`)
        skipped++
        continue
      }

      imported++
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`)
      skipped++
    }
  }

  return {
    success: errors.length === 0,
    imported,
    skipped,
    errors,
    details: `${imported} tour record${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Historical Weddings → weddings (status='completed')
// ---------------------------------------------------------------------------

export async function importHistoricalWeddings(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      const weddingDate = parseDate(row.wedding_date || '')
      const guestCount = parseNumber(row.guest_count || '')
      const bookingValue = parseNumber(row.booking_value || '')
      const coupleName = row.couple_name || ''

      if (!weddingDate && !coupleName) {
        errors.push(`Row ${i + 1}: No date or couple name, skipping`)
        skipped++
        continue
      }

      // Dedup: check for same date + venue
      if (weddingDate) {
        const { data: existing } = await supabase
          .from('weddings')
          .select('id')
          .eq('venue_id', venueId)
          .eq('wedding_date', weddingDate)
          .limit(1)

        if (existing && existing.length > 0) {
          errors.push(`Row ${i + 1}: Wedding on ${weddingDate} already exists, skipping`)
          skipped++
          continue
        }
      }

      // Determine status
      const rawStatus = (row.status || '').toLowerCase().trim()
      let status = 'completed'
      if (['booked', 'upcoming'].includes(rawStatus)) status = 'booked'
      else if (['cancelled', 'canceled'].includes(rawStatus)) status = 'cancelled'
      else if (['lost'].includes(rawStatus)) status = 'lost'

      const { data: wedding, error: weddingErr } = await supabase
        .from('weddings')
        .insert({
          venue_id: venueId,
          status,
          wedding_date: weddingDate,
          guest_count_estimate: guestCount,
          booking_value: bookingValue,
          source: row.source || null,
          notes: row.notes || null,
        })
        .select('id')
        .single()

      if (weddingErr || !wedding) {
        errors.push(`Row ${i + 1}: ${weddingErr?.message || 'Failed to create wedding'}`)
        skipped++
        continue
      }

      // Create person record if couple name provided
      if (coupleName) {
        const { first, last } = splitName(coupleName)
        await supabase.from('people').insert({
          venue_id: venueId,
          wedding_id: wedding.id,
          role: 'partner1',
          first_name: first,
          last_name: last,
        })
      }

      imported++
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`)
      skipped++
    }
  }

  return {
    success: errors.length === 0,
    imported,
    skipped,
    errors,
    details: `${imported} historical wedding${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import Router — dispatches to the correct importer
// ---------------------------------------------------------------------------

export async function importData(
  type: DataType,
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string,
  options?: { weddingId?: string }
): Promise<ImportResult> {
  switch (type) {
    case 'client_list':
      return importClientList(rows, mapping, venueId)
    case 'guest_list':
      if (!options?.weddingId) {
        return {
          success: false,
          imported: 0,
          skipped: rows.length,
          errors: ['Guest list import requires a wedding ID. Select a wedding first.'],
          details: 'Import failed: no wedding selected.',
        }
      }
      return importGuestList(rows, mapping, venueId, options.weddingId)
    case 'advertising_spend':
      return importAdvertisingSpend(rows, mapping, venueId)
    case 'invoice':
      return importInvoice(rows, mapping, venueId, options?.weddingId)
    case 'vendor_list':
      return importVendorList(rows, mapping, venueId)
    case 'tour_records':
      return importTourRecords(rows, mapping, venueId)
    case 'historical_weddings':
      return importHistoricalWeddings(rows, mapping, venueId)
    case 'unknown':
      return {
        success: false,
        imported: 0,
        skipped: rows.length,
        errors: ['Data type could not be determined. Please select the correct type manually.'],
        details: 'Import failed: unknown data type.',
      }
    default:
      return {
        success: false,
        imported: 0,
        skipped: rows.length,
        errors: [`Unsupported data type: ${type}`],
        details: `Import failed: unsupported type "${type}".`,
      }
  }
}
