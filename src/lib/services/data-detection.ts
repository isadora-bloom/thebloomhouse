/**
 * Bloom House: AI Data Detection Service
 *
 * Analyzes uploaded data (CSV text, pasted content, or extracted document
 * text) and classifies it into a known data type. Uses AI for classification
 * and column mapping, with CSV parsing built in.
 *
 * Supports 24 data types covering all venue intelligence and operational tables.
 */

import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DataType =
  // Existing — core import types
  | 'client_list'           // → weddings + people
  | 'guest_list'            // → guest_list
  | 'advertising_spend'     // → marketing_spend
  | 'invoice'               // → budget_items
  | 'vendor_list'           // → vendor_recommendations
  | 'tour_records'          // → tours
  | 'historical_weddings'   // → weddings (completed)
  // Intelligence tables
  | 'campaigns'             // → campaigns (with ROI data)
  | 'social_posts'          // → social_posts
  | 'reviews'               // → reviews + review_language
  | 'lost_deals'            // → lost_deals
  | 'competitor_info'       // → market_intelligence (competitive notes)
  // Operational tables
  | 'budget_payments'       // → budget_payments
  | 'bar_recipes'           // → bar_recipes
  | 'meal_options'          // → guest_meal_options
  | 'guest_care'            // → guest_care_notes
  | 'wedding_party'         // → wedding_party
  | 'staff_roster'          // → staffing_assignments
  | 'room_assignments'      // → bedroom_assignments
  | 'shuttle_schedule'      // → shuttle_schedule
  | 'decor_items'           // → decor_inventory
  | 'checklist_items'       // → checklist_items
  | 'knowledge_base'        // → knowledge_base (FAQ import)
  // Catch-all
  | 'unknown'

/** Which types require a wedding to be selected before import */
export const WEDDING_REQUIRED_TYPES: DataType[] = [
  'guest_list',
  'budget_payments',
  'bar_recipes',
  'meal_options',
  'guest_care',
  'wedding_party',
  'staff_roster',
  'room_assignments',
  'shuttle_schedule',
  'decor_items',
  'checklist_items',
]

/** Grouped categories for UI display */
export interface DataTypeGroup {
  label: string
  types: DataType[]
}

export const DATA_TYPE_GROUPS: DataTypeGroup[] = [
  {
    label: 'Leads & Sales',
    types: ['client_list', 'historical_weddings', 'tour_records', 'lost_deals'],
  },
  {
    label: 'Marketing',
    types: ['advertising_spend', 'campaigns', 'social_posts'],
  },
  {
    label: 'Reviews',
    types: ['reviews'],
  },
  {
    label: 'Operations',
    types: ['guest_list', 'wedding_party', 'meal_options', 'guest_care', 'checklist_items'],
  },
  {
    label: 'Logistics',
    types: ['staff_roster', 'room_assignments', 'shuttle_schedule', 'decor_items'],
  },
  {
    label: 'Finance',
    types: ['invoice', 'budget_payments', 'bar_recipes'],
  },
  {
    label: 'Vendors & Knowledge',
    types: ['vendor_list', 'knowledge_base', 'competitor_info'],
  },
]

/** All importable data types (excludes 'unknown') */
export const ALL_DATA_TYPES: DataType[] = DATA_TYPE_GROUPS.flatMap((g) => g.types)

export interface DetectionResult {
  type: DataType
  confidence: number       // 0-1
  columns: string[]        // detected column headers
  rowCount: number
  preview: string[][]      // first 5 rows (including header row)
  description: string      // human-readable description of what was detected
}

export interface ColumnMapping {
  [sourceColumn: string]: string // maps source header → target DB column
}

// ---------------------------------------------------------------------------
// CSV Parsing — handles quoted fields, commas in values, CRLF/LF
// ---------------------------------------------------------------------------

export function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  let currentRow: string[] = []
  let currentField = ''
  let inQuotes = false
  let i = 0

  while (i < lines.length) {
    const char = lines[i]

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote (double quote)
        if (i + 1 < lines.length && lines[i + 1] === '"') {
          currentField += '"'
          i += 2
          continue
        }
        // End of quoted field
        inQuotes = false
        i++
        continue
      }
      currentField += char
      i++
    } else {
      if (char === '"') {
        inQuotes = true
        i++
      } else if (char === ',') {
        currentRow.push(currentField.trim())
        currentField = ''
        i++
      } else if (char === '\n') {
        currentRow.push(currentField.trim())
        currentField = ''
        if (currentRow.some((cell) => cell !== '')) {
          rows.push(currentRow)
        }
        currentRow = []
        i++
      } else {
        currentField += char
        i++
      }
    }
  }

  // Final field and row
  currentRow.push(currentField.trim())
  if (currentRow.some((cell) => cell !== '')) {
    rows.push(currentRow)
  }

  return rows
}

/**
 * Detect tab-separated data and convert to standard rows
 */
export function parseTSV(text: string): string[][] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.split('\t').map((cell) => cell.trim()))
}

/**
 * Auto-detect delimiter and parse
 */
export function parseDelimited(text: string): string[][] {
  const firstLine = text.split(/\r?\n/)[0] || ''
  const tabCount = (firstLine.match(/\t/g) || []).length
  const commaCount = (firstLine.match(/,/g) || []).length

  if (tabCount > commaCount && tabCount >= 2) {
    return parseTSV(text)
  }
  return parseCSV(text)
}

/**
 * Parse a JSON string into CSV-like rows (header row + data rows).
 * Handles both arrays of objects and arrays of arrays.
 */
export function parseJSON(text: string): string[][] {
  const parsed = JSON.parse(text)

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return []

    // Array of objects — extract headers from first object
    if (typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
      const headers = Object.keys(parsed[0])
      const rows: string[][] = [headers]
      for (const item of parsed) {
        rows.push(headers.map((h) => String(item[h] ?? '')))
      }
      return rows
    }

    // Array of arrays — first row is headers
    if (Array.isArray(parsed[0])) {
      return parsed.map((row: unknown[]) => row.map((cell) => String(cell ?? '')))
    }
  }

  throw new Error('JSON must be an array of objects or an array of arrays')
}

/**
 * Parse VCF (vCard) contact files into rows.
 * Each vCard becomes a row with: Name, Email, Phone, Organization, Title
 */
export function parseVCF(text: string): string[][] {
  const headers = ['Name', 'Email', 'Phone', 'Organization', 'Title', 'Website']
  const rows: string[][] = [headers]

  const cards = text.split('BEGIN:VCARD').filter((c) => c.includes('END:VCARD'))

  for (const card of cards) {
    const lines = card.split(/\r?\n/)
    let name = ''
    let email = ''
    let phone = ''
    let org = ''
    let title = ''
    let website = ''

    for (const line of lines) {
      const upper = line.toUpperCase()
      if (upper.startsWith('FN:') || upper.startsWith('FN;')) {
        name = line.split(':').slice(1).join(':').trim()
      } else if (upper.startsWith('EMAIL') && line.includes(':')) {
        email = line.split(':').slice(1).join(':').trim()
      } else if ((upper.startsWith('TEL') || upper.startsWith('PHONE')) && line.includes(':')) {
        phone = line.split(':').slice(1).join(':').trim()
      } else if (upper.startsWith('ORG') && line.includes(':')) {
        org = line.split(':').slice(1).join(':').replace(/;/g, ' ').trim()
      } else if (upper.startsWith('TITLE') && line.includes(':')) {
        title = line.split(':').slice(1).join(':').trim()
      } else if (upper.startsWith('URL') && line.includes(':')) {
        website = line.split(':').slice(1).join(':').trim()
      }
    }

    if (name || email) {
      rows.push([name, email, phone, org, title, website])
    }
  }

  return rows
}

// ---------------------------------------------------------------------------
// AI Data Type Detection
// ---------------------------------------------------------------------------

interface AIDetectionResponse {
  type: DataType
  confidence: number
  description: string
}

export async function detectDataType(
  content: string,
  venueId?: string
): Promise<DetectionResult> {
  // Parse rows first
  const rows = parseDelimited(content)
  const headers = rows[0] || []
  const dataRows = rows.slice(1)

  // Build a preview of the first 5 rows
  const preview = rows.slice(0, 6) // header + 5 data rows

  // Truncate content for AI to avoid token overuse — send headers + first 10 rows
  const sampleForAI = rows
    .slice(0, 11)
    .map((row) => row.join(' | '))
    .join('\n')

  const detection = await callAIJson<AIDetectionResponse>({
    systemPrompt: `You are a data classification system for a wedding venue management platform.

Analyze the provided data sample (headers + first few rows) and determine what type of venue data it is.

Possible types:
- "client_list" — couples/clients with names, emails, wedding dates, phone numbers
- "guest_list" — individual guest names, RSVP status, meal preferences, dietary info (belongs to one wedding)
- "advertising_spend" — marketing sources, dollar amounts, time periods (monthly spend tracking)
- "invoice" — vendor name, amount, date, description, line items (budget items)
- "vendor_list" — vendor names, types (photographer, caterer, etc.), contact info
- "tour_records" — couple names, tour dates, outcomes, notes
- "historical_weddings" — past weddings with dates, revenue, guest counts, status
- "campaigns" — advertising campaigns with campaign name, channel/platform, spend/budget, leads/inquiries generated, bookings attributed, revenue, start/end dates, ROI data
- "social_posts" — social media posts with platform (Instagram/TikTok/Facebook), date posted, caption/text, likes, comments, shares, reach, engagement rate
- "reviews" — customer reviews with rating/stars (1-5), reviewer name, review text/body, source (Google/Knot/WeddingWire), date
- "lost_deals" — lost sales/deals with couple name, reason for loss, competitor name, deal value, date lost, stage lost at
- "competitor_info" — competitive intelligence with competitor venue names, pricing, features, notes
- "budget_payments" — payment records with amount, date, payment method, linked to budget items
- "bar_recipes" — cocktail/drink recipes with name, ingredients, instructions, servings
- "meal_options" — meal/entree options for guests with option name, description, default flag
- "guest_care" — special care notes for guests with guest name, care type (mobility/dietary/VIP/medical), note
- "wedding_party" — bridal party members with name, role (bridesmaid/groomsman/etc.), side (bride/groom), relationship, bio
- "staff_roster" — staff/labor assignments with role, person name, count, hourly rate, hours
- "room_assignments" — bedroom/room assignments with room name, description, guest names
- "shuttle_schedule" — shuttle/transport schedule with route name, pickup/dropoff locations, departure time, capacity
- "decor_items" — decor/decoration inventory with item name, category, quantity, source, vendor, notes
- "checklist_items" — to-do/checklist items with title, description, due date, category, completion status
- "knowledge_base" — FAQ/knowledge base entries with category, question, answer, keywords
- "unknown" — cannot determine

Return JSON: { "type": "<type>", "confidence": <0-1>, "description": "<1-sentence description>" }

Look at column names and data patterns. Be decisive — if it's plausibly a client list, call it that.
A list of names + emails + dates is a client list, not a guest list.
A guest list typically has RSVP, meals, dietary, table assignments, and belongs to one wedding.
Campaigns are different from advertising_spend: campaigns have names, channels, and attribution metrics; ad spend is simpler monthly amounts.
Reviews always have ratings (1-5 stars) and review text.
Social posts always have platform names and engagement metrics.`,
    userPrompt: `Headers and sample rows:\n${sampleForAI}`,
    maxTokens: 500,
    temperature: 0.1,
    venueId,
    taskType: 'data_detection',
  })

  return {
    type: detection.type,
    confidence: detection.confidence,
    columns: headers,
    rowCount: dataRows.length,
    preview,
    description: detection.description,
  }
}

// ---------------------------------------------------------------------------
// AI Column Mapping
// ---------------------------------------------------------------------------

const TARGET_COLUMNS: Record<DataType, string[]> = {
  client_list: [
    'first_name', 'last_name', 'partner_first_name', 'partner_last_name',
    'email', 'partner_email', 'phone', 'wedding_date', 'guest_count_estimate',
    'source', 'notes', 'booking_value',
  ],
  guest_list: [
    'first_name', 'last_name', 'email', 'group_name', 'rsvp_status',
    'meal_preference', 'dietary_restrictions', 'plus_one', 'plus_one_name',
    'care_notes',
  ],
  advertising_spend: [
    'source', 'month', 'amount', 'notes',
  ],
  invoice: [
    'vendor_name', 'category', 'item_name', 'amount', 'date', 'notes',
  ],
  vendor_list: [
    'vendor_name', 'vendor_type', 'contact_email', 'contact_phone',
    'website_url', 'description', 'is_preferred',
  ],
  tour_records: [
    'couple_name', 'scheduled_at', 'tour_type', 'source', 'outcome',
    'notes',
  ],
  historical_weddings: [
    'couple_name', 'wedding_date', 'guest_count', 'booking_value',
    'source', 'status', 'notes',
  ],
  // Intelligence types
  campaigns: [
    'name', 'channel', 'start_date', 'end_date', 'spend',
    'inquiries_attributed', 'tours_attributed', 'bookings_attributed',
    'revenue_attributed', 'notes',
  ],
  social_posts: [
    'platform', 'posted_at', 'caption', 'post_url',
    'likes', 'comments', 'shares', 'reach', 'impressions',
    'saves', 'website_clicks', 'engagement_rate',
  ],
  reviews: [
    'source', 'reviewer_name', 'rating', 'title', 'body',
    'review_date', 'response_text',
  ],
  lost_deals: [
    'couple_name', 'lost_at_stage', 'reason_category', 'reason_detail',
    'competitor_name', 'lost_at',
  ],
  competitor_info: [
    'competitor_name', 'region', 'pricing', 'features', 'notes',
  ],
  // Operational types
  budget_payments: [
    'budget_item_name', 'amount', 'payment_date', 'payment_method', 'notes',
  ],
  bar_recipes: [
    'cocktail_name', 'ingredients', 'instructions', 'servings',
  ],
  meal_options: [
    'option_name', 'description', 'is_default',
  ],
  guest_care: [
    'guest_name', 'care_type', 'note',
  ],
  wedding_party: [
    'name', 'role', 'side', 'relationship', 'bio',
  ],
  staff_roster: [
    'role', 'person_name', 'count', 'hourly_rate', 'hours', 'notes',
  ],
  room_assignments: [
    'room_name', 'room_description', 'guests', 'notes',
  ],
  shuttle_schedule: [
    'route_name', 'pickup_location', 'dropoff_location', 'departure_time',
    'capacity', 'notes',
  ],
  decor_items: [
    'item_name', 'category', 'quantity', 'source', 'vendor_name', 'notes',
  ],
  checklist_items: [
    'title', 'description', 'due_date', 'category', 'is_completed',
  ],
  knowledge_base: [
    'category', 'question', 'answer', 'keywords',
  ],
  unknown: [],
}

export async function mapColumns(
  headers: string[],
  targetType: DataType,
  venueId?: string
): Promise<ColumnMapping> {
  const targetCols = TARGET_COLUMNS[targetType]
  if (!targetCols || targetCols.length === 0) return {}

  const mapping = await callAIJson<ColumnMapping>({
    systemPrompt: `You are a column mapping system. Map source CSV column names to target database columns.

Target columns for type "${targetType}":
${targetCols.map((c) => `  - ${c}`).join('\n')}

Rules:
- Only map columns that have a clear match. Skip ambiguous ones.
- Return a JSON object: { "Source Column Name": "target_column_name", ... }
- If a source column doesn't match any target, omit it.
- Be smart about variants: "First Name", "First", "fname", "first_name" all map to "first_name".
- "Date", "Wedding Date", "Event Date" map to "wedding_date" for client_list.
- "Partner", "Partner Name", "Spouse" map to "partner_first_name".
- "Amount", "Cost", "Spend", "Budget" map to the money column.
- "Stars", "Rating", "Score" map to "rating" for reviews.
- "Platform", "Network", "Channel" map appropriately based on context.
- "Cocktail", "Drink", "Recipe Name" map to "cocktail_name".
- "Room", "Bedroom", "Suite" map to "room_name".
- "Route", "Bus", "Shuttle" map to "route_name".
- Return ONLY the mapping object, no extra keys.`,
    userPrompt: `Source columns: ${JSON.stringify(headers)}`,
    maxTokens: 500,
    temperature: 0.1,
    venueId,
    taskType: 'column_mapping',
  })

  return mapping
}
