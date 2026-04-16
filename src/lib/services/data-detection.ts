/**
 * Bloom House: AI Data Detection Service
 *
 * Analyzes uploaded data (CSV text, pasted content, or extracted document
 * text) and classifies it into a known data type. Uses AI for classification
 * and column mapping, with CSV parsing built in.
 */

import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DataType =
  | 'client_list'          // couples with names, emails, dates
  | 'guest_list'           // guest names, RSVPs, meals
  | 'advertising_spend'    // source, amount, period
  | 'invoice'              // vendor, amount, date, description
  | 'vendor_list'          // vendor names, types, contacts
  | 'tour_records'         // couple name, date, outcome
  | 'historical_weddings'  // past weddings with dates, revenue
  | 'unknown'              // can't determine

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
- "guest_list" — individual guest names, RSVP status, meal preferences, dietary info
- "advertising_spend" — marketing sources, dollar amounts, time periods
- "invoice" — vendor name, amount, date, description, line items
- "vendor_list" — vendor names, types (photographer, caterer, etc.), contact info
- "tour_records" — couple names, tour dates, outcomes, notes
- "historical_weddings" — past weddings with dates, revenue, guest counts, status
- "unknown" — cannot determine

Return JSON: { "type": "<type>", "confidence": <0-1>, "description": "<1-sentence description>" }

Look at column names and data patterns. Be decisive — if it's plausibly a client list, call it that.
A list of names + emails + dates is a client list, not a guest list.
A guest list typically has RSVP, meals, dietary, table assignments, and belongs to one wedding.`,
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
- Return ONLY the mapping object, no extra keys.`,
    userPrompt: `Source columns: ${JSON.stringify(headers)}`,
    maxTokens: 500,
    temperature: 0.1,
    venueId,
    taskType: 'column_mapping',
  })

  return mapping
}
