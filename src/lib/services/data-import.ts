/**
 * Bloom House: Data Import Service
 *
 * Imports parsed data rows into the correct Supabase tables based on
 * the detected data type. Each importer handles deduplication, validation,
 * and returns a structured result.
 *
 * Supports 24 data types covering all venue intelligence and operational tables.
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

/** Parse a datetime string into ISO format */
function parseDatetime(value: string): string | null {
  if (!value || !value.trim()) return null
  const cleaned = value.trim()

  const parsed = new Date(cleaned)
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString()
  }

  // Try date-only and append midnight
  const dateOnly = parseDate(cleaned)
  if (dateOnly) return `${dateOnly}T00:00:00.000Z`

  return null
}

/** Parse a number, stripping $ and commas */
function parseNumber(value: string): number | null {
  if (!value || !value.trim()) return null
  const cleaned = value.replace(/[$,\s]/g, '')
  const num = parseFloat(cleaned)
  return isNaN(num) ? null : num
}

/** Parse an integer */
function parseInt_(value: string): number | null {
  const num = parseNumber(value)
  if (num === null) return null
  return Math.round(num)
}

/** Split a full name into first + last */
function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

/** Parse boolean from various string formats */
function parseBool(value: string): boolean {
  return ['yes', 'true', '1', 'y', 'x', 'checked'].includes(
    (value || '').toLowerCase().trim()
  )
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
        plus_one: parseBool(row.plus_one || ''),
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
        is_preferred: parseBool(row.is_preferred || ''),
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
// Import: Campaigns → campaigns
// ---------------------------------------------------------------------------

export async function importCampaigns(
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

      const name = (row.name || '').trim()
      if (!name) {
        errors.push(`Row ${i + 1}: No campaign name, skipping`)
        skipped++
        continue
      }

      // Dedup by name
      const { data: existing } = await supabase
        .from('campaigns')
        .select('id')
        .eq('venue_id', venueId)
        .ilike('name', name)
        .limit(1)

      if (existing && existing.length > 0) {
        errors.push(`Row ${i + 1}: Campaign "${name}" already exists, skipping`)
        skipped++
        continue
      }

      const spend = parseNumber(row.spend || '')
      const inquiries = parseInt_(row.inquiries_attributed || '')
      const bookings = parseInt_(row.bookings_attributed || '')
      const revenue = parseNumber(row.revenue_attributed || '')

      // Auto-compute derived fields
      const costPerInquiry = spend && inquiries ? spend / inquiries : null
      const costPerBooking = spend && bookings ? spend / bookings : null
      const roiRatio = spend && revenue ? revenue / spend : null

      const { error } = await supabase.from('campaigns').insert({
        venue_id: venueId,
        name,
        channel: row.channel || null,
        start_date: parseDate(row.start_date || ''),
        end_date: parseDate(row.end_date || ''),
        spend: spend || 0,
        inquiries_attributed: inquiries || 0,
        tours_attributed: parseInt_(row.tours_attributed || '') || 0,
        bookings_attributed: bookings || 0,
        revenue_attributed: revenue || 0,
        cost_per_inquiry: costPerInquiry,
        cost_per_booking: costPerBooking,
        roi_ratio: roiRatio,
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
    details: `${imported} campaign${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Social Posts → social_posts
// ---------------------------------------------------------------------------

export async function importSocialPosts(
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

      // Normalize platform
      const rawPlatform = (row.platform || '').toLowerCase().trim()
      let platform: string | null = null
      if (['instagram', 'ig', 'insta'].includes(rawPlatform)) platform = 'instagram'
      else if (['facebook', 'fb'].includes(rawPlatform)) platform = 'facebook'
      else if (['tiktok', 'tik tok', 'tt'].includes(rawPlatform)) platform = 'tiktok'
      else if (['pinterest', 'pin'].includes(rawPlatform)) platform = 'pinterest'
      else if (['youtube', 'yt'].includes(rawPlatform)) platform = 'youtube'

      if (!platform) {
        errors.push(`Row ${i + 1}: Unknown platform "${rawPlatform}", skipping`)
        skipped++
        continue
      }

      const { error } = await supabase.from('social_posts').insert({
        venue_id: venueId,
        platform,
        posted_at: parseDatetime(row.posted_at || '') || new Date().toISOString(),
        caption: row.caption || null,
        post_url: row.post_url || null,
        likes: parseInt_(row.likes || '') || 0,
        comments: parseInt_(row.comments || '') || 0,
        shares: parseInt_(row.shares || '') || 0,
        reach: parseInt_(row.reach || '') || 0,
        impressions: parseInt_(row.impressions || '') || 0,
        saves: parseInt_(row.saves || '') || 0,
        website_clicks: parseInt_(row.website_clicks || '') || 0,
        engagement_rate: parseNumber(row.engagement_rate || ''),
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
    details: `${imported} social post${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Reviews → reviews + review_language
// ---------------------------------------------------------------------------

export async function importReviews(
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

      const rating = parseInt_(row.rating || '')
      const body = (row.body || '').trim()

      if (!rating || rating < 1 || rating > 5) {
        errors.push(`Row ${i + 1}: Invalid or missing rating, skipping`)
        skipped++
        continue
      }
      if (!body) {
        errors.push(`Row ${i + 1}: No review text, skipping`)
        skipped++
        continue
      }

      // Normalize source
      const rawSource = (row.source || '').toLowerCase().trim()
      let source = 'other'
      if (['google', 'google maps', 'gmb'].includes(rawSource)) source = 'google'
      else if (['the knot', 'theknot', 'knot'].includes(rawSource)) source = 'the_knot'
      else if (['weddingwire', 'wedding wire', 'ww'].includes(rawSource)) source = 'wedding_wire'
      else if (['yelp'].includes(rawSource)) source = 'yelp'
      else if (['facebook', 'fb'].includes(rawSource)) source = 'facebook'

      const reviewDate = parseDate(row.review_date || '') || new Date().toISOString().split('T')[0]

      // Dedup: same source + reviewer + date
      const reviewerName = (row.reviewer_name || '').trim()
      if (reviewerName) {
        const { data: existing } = await supabase
          .from('reviews')
          .select('id')
          .eq('venue_id', venueId)
          .eq('source', source)
          .ilike('reviewer_name', reviewerName)
          .eq('review_date', reviewDate)
          .limit(1)

        if (existing && existing.length > 0) {
          errors.push(`Row ${i + 1}: Review by "${reviewerName}" on ${reviewDate} already exists, skipping`)
          skipped++
          continue
        }
      }

      const { error } = await supabase.from('reviews').insert({
        venue_id: venueId,
        source,
        reviewer_name: reviewerName || null,
        rating,
        title: row.title || null,
        body,
        review_date: reviewDate,
        response_text: row.response_text || null,
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
    details: `${imported} review${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Lost Deals → lost_deals
// ---------------------------------------------------------------------------

export async function importLostDeals(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  const validReasons = [
    'no_response', 'pricing', 'competitor', 'date_unavailable',
    'ghosted', 'changed_plans', 'venue_mismatch', 'budget_change', 'other',
  ]
  const validStages = ['inquiry', 'tour', 'hold', 'contract']

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      // Normalize reason category
      const rawReason = (row.reason_category || '').toLowerCase().trim().replace(/\s+/g, '_')
      const reasonCategory = validReasons.includes(rawReason) ? rawReason : 'other'

      // Normalize stage
      const rawStage = (row.lost_at_stage || '').toLowerCase().trim()
      const lostAtStage = validStages.includes(rawStage) ? rawStage : null

      const { error } = await supabase.from('lost_deals').insert({
        venue_id: venueId,
        lost_at_stage: lostAtStage,
        reason_category: reasonCategory,
        reason_detail: row.reason_detail || row.couple_name || null,
        competitor_name: row.competitor_name || null,
        lost_at: parseDatetime(row.lost_at || ''),
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
    details: `${imported} lost deal${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Competitor Info → stored as notes (no direct table insert for
// venue-level market intelligence; logged as knowledge_base entries)
// ---------------------------------------------------------------------------

export async function importCompetitorInfo(
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

      const competitorName = (row.competitor_name || '').trim()
      if (!competitorName) {
        errors.push(`Row ${i + 1}: No competitor name, skipping`)
        skipped++
        continue
      }

      // Store as knowledge base entry for Sage to reference
      const answer = [
        row.pricing ? `Pricing: ${row.pricing}` : '',
        row.features ? `Features: ${row.features}` : '',
        row.notes ? `Notes: ${row.notes}` : '',
        row.region ? `Region: ${row.region}` : '',
      ].filter(Boolean).join('. ')

      const { error } = await supabase.from('knowledge_base').insert({
        venue_id: venueId,
        category: 'competitor',
        question: `What do we know about ${competitorName}?`,
        answer: answer || `Competitor venue: ${competitorName}`,
        keywords: [competitorName.toLowerCase(), 'competitor', 'market'],
        source: 'csv',
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
    details: `${imported} competitor record${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Budget Payments → budget_payments
// ---------------------------------------------------------------------------

export async function importBudgetPayments(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string,
  weddingId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  // Load budget items for this wedding to match by name
  const { data: budgetItems } = await supabase
    .from('budget_items')
    .select('id, item_name')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)

  const itemsByName = new Map(
    (budgetItems || []).map((item) => [item.item_name.toLowerCase(), item.id])
  )

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      const amount = parseNumber(row.amount || '')
      if (amount === null) {
        errors.push(`Row ${i + 1}: No amount, skipping`)
        skipped++
        continue
      }

      // Try to match budget item by name
      const itemName = (row.budget_item_name || '').trim().toLowerCase()
      let budgetItemId = itemName ? itemsByName.get(itemName) : undefined

      // If no match, create the budget item
      if (!budgetItemId && itemName) {
        const { data: newItem } = await supabase
          .from('budget_items')
          .insert({
            venue_id: venueId,
            wedding_id: weddingId,
            category: 'Other',
            item_name: row.budget_item_name || 'Unnamed',
            budgeted: 0,
            committed: 0,
          })
          .select('id')
          .single()

        if (newItem) {
          budgetItemId = newItem.id
          itemsByName.set(itemName, newItem.id)
        }
      }

      if (!budgetItemId) {
        errors.push(`Row ${i + 1}: Could not match or create budget item, skipping`)
        skipped++
        continue
      }

      const { error } = await supabase.from('budget_payments').insert({
        budget_item_id: budgetItemId,
        venue_id: venueId,
        wedding_id: weddingId,
        amount,
        payment_date: parseDate(row.payment_date || ''),
        payment_method: row.payment_method || null,
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
    details: `${imported} payment${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Bar Recipes → bar_recipes
// ---------------------------------------------------------------------------

export async function importBarRecipes(
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

      const cocktailName = (row.cocktail_name || '').trim()
      if (!cocktailName) {
        errors.push(`Row ${i + 1}: No cocktail name, skipping`)
        skipped++
        continue
      }

      // Parse ingredients — try JSON first, then treat as comma-separated list
      let ingredients: unknown[] = []
      const rawIngredients = (row.ingredients || '').trim()
      if (rawIngredients) {
        try {
          ingredients = JSON.parse(rawIngredients)
        } catch {
          // Comma-separated string
          ingredients = rawIngredients.split(',').map((s) => s.trim()).filter(Boolean)
        }
      }

      const { error } = await supabase.from('bar_recipes').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        cocktail_name: cocktailName,
        ingredients: JSON.stringify(ingredients),
        instructions: row.instructions || null,
        servings: parseInt_(row.servings || ''),
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
    details: `${imported} recipe${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Meal Options → guest_meal_options
// ---------------------------------------------------------------------------

export async function importMealOptions(
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

      const optionName = (row.option_name || '').trim()
      if (!optionName) {
        errors.push(`Row ${i + 1}: No option name, skipping`)
        skipped++
        continue
      }

      const { error } = await supabase.from('guest_meal_options').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        option_name: optionName,
        description: row.description || null,
        is_default: parseBool(row.is_default || ''),
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
    details: `${imported} meal option${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Guest Care Notes → guest_care_notes
// ---------------------------------------------------------------------------

export async function importGuestCare(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string,
  weddingId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  const validCareTypes = ['mobility', 'dietary', 'family', 'vip', 'medical', 'other']

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      const guestName = (row.guest_name || '').trim()
      if (!guestName) {
        errors.push(`Row ${i + 1}: No guest name, skipping`)
        skipped++
        continue
      }

      const rawType = (row.care_type || '').toLowerCase().trim()
      const careType = validCareTypes.includes(rawType) ? rawType : 'other'

      const { error } = await supabase.from('guest_care_notes').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        guest_name: guestName,
        care_type: careType,
        note: row.note || null,
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
    details: `${imported} care note${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Wedding Party → wedding_party
// ---------------------------------------------------------------------------

export async function importWeddingParty(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string,
  weddingId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  const validRoles = [
    'maid_of_honor', 'best_man', 'bridesmaid', 'groomsman',
    'flower_girl', 'ring_bearer', 'other',
  ]
  const validSides = ['bride', 'groom']

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      const name = (row.name || '').trim()
      if (!name) {
        errors.push(`Row ${i + 1}: No name, skipping`)
        skipped++
        continue
      }

      // Normalize role
      const rawRole = (row.role || '').toLowerCase().trim().replace(/\s+/g, '_')
      const role = validRoles.includes(rawRole) ? rawRole : 'other'

      // Normalize side
      const rawSide = (row.side || '').toLowerCase().trim()
      const side = validSides.includes(rawSide) ? rawSide : null

      const { error } = await supabase.from('wedding_party').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        name,
        role,
        side,
        relationship: row.relationship || null,
        bio: row.bio || null,
        sort_order: i,
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
    details: `${imported} party member${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Staff Roster → staffing_assignments
// ---------------------------------------------------------------------------

export async function importStaffRoster(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string,
  weddingId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  const validRoles = ['bartender', 'server', 'runner', 'line_cook', 'coordinator', 'other']

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      // Normalize role
      const rawRole = (row.role || '').toLowerCase().trim().replace(/\s+/g, '_')
      const role = validRoles.includes(rawRole) ? rawRole : 'other'

      const { error } = await supabase.from('staffing_assignments').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        role,
        person_name: row.person_name || null,
        count: parseInt_(row.count || '') || 1,
        hourly_rate: parseNumber(row.hourly_rate || ''),
        hours: parseNumber(row.hours || ''),
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
    details: `${imported} staff assignment${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Room Assignments → bedroom_assignments
// ---------------------------------------------------------------------------

export async function importRoomAssignments(
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

      const roomName = (row.room_name || '').trim()
      if (!roomName) {
        errors.push(`Row ${i + 1}: No room name, skipping`)
        skipped++
        continue
      }

      // Parse guests — comma-separated or JSON array
      let guests: string[] = []
      const rawGuests = (row.guests || '').trim()
      if (rawGuests) {
        try {
          guests = JSON.parse(rawGuests)
        } catch {
          guests = rawGuests.split(',').map((s) => s.trim()).filter(Boolean)
        }
      }

      const { error } = await supabase.from('bedroom_assignments').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        room_name: roomName,
        room_description: row.room_description || null,
        guests,
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
    details: `${imported} room assignment${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Shuttle Schedule → shuttle_schedule
// ---------------------------------------------------------------------------

export async function importShuttleSchedule(
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

      const routeName = (row.route_name || '').trim()
      if (!routeName) {
        errors.push(`Row ${i + 1}: No route name, skipping`)
        skipped++
        continue
      }

      const { error } = await supabase.from('shuttle_schedule').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        route_name: routeName,
        pickup_location: row.pickup_location || null,
        dropoff_location: row.dropoff_location || null,
        departure_time: parseDatetime(row.departure_time || ''),
        capacity: parseInt_(row.capacity || ''),
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
    details: `${imported} shuttle route${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Decor Items → decor_inventory
// ---------------------------------------------------------------------------

export async function importDecorItems(
  rows: Row[],
  mapping: ColumnMapping,
  venueId: string,
  weddingId: string
): Promise<ImportResult> {
  const supabase = createServiceClient()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  const validCategories = ['ceremony', 'reception', 'tables', 'entrance', 'other']
  const validSources = ['borrow', 'personal', 'vendor', 'diy']

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = applyMapping(rows[i], mapping)

      const itemName = (row.item_name || '').trim()
      if (!itemName) {
        errors.push(`Row ${i + 1}: No item name, skipping`)
        skipped++
        continue
      }

      const rawCategory = (row.category || '').toLowerCase().trim()
      const category = validCategories.includes(rawCategory) ? rawCategory : 'other'

      const rawSource = (row.source || '').toLowerCase().trim()
      const source = validSources.includes(rawSource) ? rawSource : null

      const { error } = await supabase.from('decor_inventory').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        item_name: itemName,
        category,
        quantity: parseInt_(row.quantity || '') || 1,
        source,
        vendor_name: row.vendor_name || null,
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
    details: `${imported} decor item${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Checklist Items → checklist_items
// ---------------------------------------------------------------------------

export async function importChecklistItems(
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

      const title = (row.title || '').trim()
      if (!title) {
        errors.push(`Row ${i + 1}: No title, skipping`)
        skipped++
        continue
      }

      const { error } = await supabase.from('checklist_items').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        title,
        description: row.description || null,
        due_date: parseDate(row.due_date || ''),
        category: row.category || null,
        is_completed: parseBool(row.is_completed || ''),
        sort_order: i,
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
    details: `${imported} checklist item${imported !== 1 ? 's' : ''} imported.${
      skipped > 0 ? ` ${skipped} skipped.` : ''
    }`,
  }
}

// ---------------------------------------------------------------------------
// Import: Knowledge Base → knowledge_base
// ---------------------------------------------------------------------------

export async function importKnowledgeBase(
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

      const question = (row.question || '').trim()
      const answer = (row.answer || '').trim()

      if (!question || !answer) {
        errors.push(`Row ${i + 1}: Missing question or answer, skipping`)
        skipped++
        continue
      }

      // Dedup: check for same question
      const { data: existing } = await supabase
        .from('knowledge_base')
        .select('id')
        .eq('venue_id', venueId)
        .ilike('question', question)
        .limit(1)

      if (existing && existing.length > 0) {
        errors.push(`Row ${i + 1}: Question already exists, skipping`)
        skipped++
        continue
      }

      // Parse keywords — comma-separated or JSON array
      let keywords: string[] = []
      const rawKeywords = (row.keywords || '').trim()
      if (rawKeywords) {
        try {
          keywords = JSON.parse(rawKeywords)
        } catch {
          keywords = rawKeywords.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        }
      }

      const { error } = await supabase.from('knowledge_base').insert({
        venue_id: venueId,
        category: row.category || null,
        question,
        answer,
        keywords,
        source: 'csv',
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
    details: `${imported} KB entr${imported !== 1 ? 'ies' : 'y'} imported.${
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
  const weddingId = options?.weddingId

  // Helper for types that require a weddingId
  const requireWedding = (): ImportResult | null => {
    if (!weddingId) {
      return {
        success: false,
        imported: 0,
        skipped: rows.length,
        errors: ['This data type requires a wedding to be selected first.'],
        details: 'Import failed: no wedding selected.',
      }
    }
    return null
  }

  switch (type) {
    case 'client_list':
      return importClientList(rows, mapping, venueId)

    case 'guest_list': {
      const err = requireWedding()
      if (err) return err
      return importGuestList(rows, mapping, venueId, weddingId!)
    }

    case 'advertising_spend':
      return importAdvertisingSpend(rows, mapping, venueId)

    case 'invoice':
      return importInvoice(rows, mapping, venueId, weddingId)

    case 'vendor_list':
      return importVendorList(rows, mapping, venueId)

    case 'tour_records':
      return importTourRecords(rows, mapping, venueId)

    case 'historical_weddings':
      return importHistoricalWeddings(rows, mapping, venueId)

    // Intelligence types
    case 'campaigns':
      return importCampaigns(rows, mapping, venueId)

    case 'social_posts':
      return importSocialPosts(rows, mapping, venueId)

    case 'reviews':
      return importReviews(rows, mapping, venueId)

    case 'lost_deals':
      return importLostDeals(rows, mapping, venueId)

    case 'competitor_info':
      return importCompetitorInfo(rows, mapping, venueId)

    // Operational types (all require weddingId)
    case 'budget_payments': {
      const err = requireWedding()
      if (err) return err
      return importBudgetPayments(rows, mapping, venueId, weddingId!)
    }

    case 'bar_recipes': {
      const err = requireWedding()
      if (err) return err
      return importBarRecipes(rows, mapping, venueId, weddingId!)
    }

    case 'meal_options': {
      const err = requireWedding()
      if (err) return err
      return importMealOptions(rows, mapping, venueId, weddingId!)
    }

    case 'guest_care': {
      const err = requireWedding()
      if (err) return err
      return importGuestCare(rows, mapping, venueId, weddingId!)
    }

    case 'wedding_party': {
      const err = requireWedding()
      if (err) return err
      return importWeddingParty(rows, mapping, venueId, weddingId!)
    }

    case 'staff_roster': {
      const err = requireWedding()
      if (err) return err
      return importStaffRoster(rows, mapping, venueId, weddingId!)
    }

    case 'room_assignments': {
      const err = requireWedding()
      if (err) return err
      return importRoomAssignments(rows, mapping, venueId, weddingId!)
    }

    case 'shuttle_schedule': {
      const err = requireWedding()
      if (err) return err
      return importShuttleSchedule(rows, mapping, venueId, weddingId!)
    }

    case 'decor_items': {
      const err = requireWedding()
      if (err) return err
      return importDecorItems(rows, mapping, venueId, weddingId!)
    }

    case 'checklist_items': {
      const err = requireWedding()
      if (err) return err
      return importChecklistItems(rows, mapping, venueId, weddingId!)
    }

    // Venue-level knowledge
    case 'knowledge_base':
      return importKnowledgeBase(rows, mapping, venueId)

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
