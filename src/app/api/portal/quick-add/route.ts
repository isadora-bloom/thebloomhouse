import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { callAIJson, callAIVision } from '@/lib/ai/client'
import {
  detectDataType,
  mapColumns,
  parseDelimited,
  parseJSON,
  parseVCF,
  type DataType,
  type DetectionResult,
} from '@/lib/services/data-detection'
import { importData, rowsToRecords } from '@/lib/services/data-import'

// ---------------------------------------------------------------------------
// POST /api/portal/quick-add — Analyze uploaded file / pasted data
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/**
 * Accepted file extensions and how to handle them.
 * 'text'   — read as UTF-8 text, parse as CSV/TSV
 * 'json'   — read as UTF-8 text, parse as JSON
 * 'vcf'    — read as UTF-8 text, parse as VCF contacts
 * 'vision' — use AI vision to extract tabular data
 * 'xlsx'   — not natively supported; extract what we can or ask user to save as CSV
 * 'docx'   — extract text content from XML inside the ZIP
 * 'url'    — Google Sheets URL (pasted data only)
 */
type FileStrategy = 'text' | 'json' | 'vcf' | 'vision' | 'xlsx' | 'docx'

function getFileStrategy(fileName: string, mimeType: string): FileStrategy {
  const ext = fileName.split('.').pop()?.toLowerCase()

  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'text'
  if (ext === 'json') return 'json'
  if (ext === 'vcf') return 'vcf'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsb' || ext === 'ods') return 'xlsx'
  if (ext === 'docx') return 'docx'
  if (ext === 'pdf' || mimeType.startsWith('image/')) return 'vision'

  // Fallback by MIME type
  if (mimeType === 'application/json') return 'json'
  if (mimeType === 'text/vcard' || mimeType === 'text/x-vcard') return 'vcf'
  if (mimeType.includes('spreadsheetml') || mimeType.includes('ms-excel')) return 'xlsx'
  if (mimeType.includes('wordprocessingml') || mimeType.includes('msword')) return 'docx'

  return 'text' // last resort — try reading as text
}

/**
 * Try to extract text from a DOCX file by reading the XML inside.
 * DOCX is a ZIP containing word/document.xml.
 * We do a simple regex extraction of text nodes — no external library needed.
 */
async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  // DOCX files are ZIP archives. The PK header is 0x504B.
  // We look for the word/document.xml file content directly via string matching.
  const uint8 = new Uint8Array(buffer)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(uint8)

  // Find XML content between <w:t> tags
  const textMatches = text.match(/<w:t[^>]*>([^<]*)<\/w:t>/g)
  if (!textMatches || textMatches.length === 0) {
    // Fallback: return whatever text we can find
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  // Extract text content, joining with spaces
  const extracted = textMatches
    .map((match) => {
      const inner = match.replace(/<[^>]*>/g, '')
      return inner
    })
    .join(' ')

  return extracted
}

/**
 * Check if pasted data looks like a Google Sheets URL.
 */
function isGoogleSheetsUrl(text: string): boolean {
  return /docs\.google\.com\/spreadsheets/.test(text.trim())
}

/**
 * Pull the spreadsheet id + optional gid out of a Google Sheets URL.
 * Returns null if we can't recognise it.
 */
function parseGoogleSheetsUrl(url: string): { id: string; gid: string | null } | null {
  const idMatch = url.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)
  if (!idMatch) return null
  const gidMatch = url.match(/[#?&]gid=(\d+)/)
  return { id: idMatch[1], gid: gidMatch?.[1] ?? null }
}

/**
 * Fetch a Google Sheet as CSV using the public export endpoint. Requires the
 * sheet to be shared as "Anyone with the link" (viewer) or fully public. If
 * the sheet is private, Google returns an HTML login page — we detect that
 * and surface a clear error.
 */
async function fetchGoogleSheetCsv(id: string, gid: string | null): Promise<string> {
  const gidParam = gid ? `&gid=${gid}` : ''
  const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gidParam}`

  const res = await fetch(exportUrl, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`Google Sheets returned HTTP ${res.status}. Make sure the sheet is shared as "Anyone with the link".`)
  }

  const text = await res.text()
  // Private sheets redirect to an HTML login page; catch that.
  if (text.trimStart().toLowerCase().startsWith('<!doctype html') || text.includes('<html')) {
    throw new Error('This Google Sheet is private. Share it as "Anyone with the link (Viewer)" and try again.')
  }
  return text
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const pastedData = formData.get('pastedData') as string | null
    const venueId = formData.get('venueId') as string
    const action = formData.get('action') as string // 'detect' | 'import'
    const overrideType = formData.get('overrideType') as string | null
    const weddingId = formData.get('weddingId') as string | null

    if (!venueId) {
      return NextResponse.json({ error: 'Missing venueId' }, { status: 400 })
    }

    // -----------------------------------------------------------------------
    // Step 1: Extract text content from the input
    // -----------------------------------------------------------------------

    let content: string
    let fileName: string | null = null
    let fileWarning: string | null = null

    if (file) {
      fileName = file.name

      // Size check
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File too large. Maximum size is 10 MB (got ${(file.size / 1024 / 1024).toFixed(1)} MB).` },
          { status: 400 }
        )
      }

      const strategy = getFileStrategy(file.name, file.type)

      switch (strategy) {
        case 'text': {
          content = await file.text()
          break
        }

        case 'json': {
          const rawText = await file.text()
          try {
            const rows = parseJSON(rawText)
            // Convert back to CSV for the standard pipeline
            content = rows.map((row) => row.map((cell) => {
              // Quote cells that contain commas or quotes
              if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
                return `"${cell.replace(/"/g, '""')}"`
              }
              return cell
            }).join(',')).join('\n')
          } catch {
            // If JSON parsing fails, try as plain text
            content = rawText
          }
          break
        }

        case 'vcf': {
          const rawText = await file.text()
          try {
            const rows = parseVCF(rawText)
            content = rows.map((row) => row.map((cell) => {
              if (cell.includes(',') || cell.includes('"')) {
                return `"${cell.replace(/"/g, '""')}"`
              }
              return cell
            }).join(',')).join('\n')
          } catch {
            content = rawText
          }
          break
        }

        case 'xlsx': {
          // Parse .xlsx / .xls / .ods via SheetJS. First sheet with data wins.
          try {
            const buffer = await file.arrayBuffer()
            const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' })

            // Find the first sheet that actually has rows
            let chosenSheetName: string | null = null
            let chosenCsv = ''
            for (const sheetName of workbook.SheetNames) {
              const sheet = workbook.Sheets[sheetName]
              const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
              if (csv.trim().length > 0) {
                chosenSheetName = sheetName
                chosenCsv = csv
                break
              }
            }

            if (!chosenCsv) {
              return NextResponse.json({
                error: 'Excel file is empty or contains no readable data.',
              }, { status: 400 })
            }

            content = chosenCsv
            if (workbook.SheetNames.length > 1) {
              fileWarning = `Workbook has ${workbook.SheetNames.length} sheets; imported "${chosenSheetName}". Split into separate files to import others.`
            }
          } catch (err) {
            return NextResponse.json({
              error: `Could not parse Excel file: ${err instanceof Error ? err.message : 'unknown error'}. Try saving as CSV.`,
            }, { status: 400 })
          }
          break
        }

        case 'docx': {
          const buffer = await file.arrayBuffer()
          const extractedText = await extractDocxText(buffer)

          if (!extractedText || extractedText.length < 10) {
            return NextResponse.json({
              error: 'Could not extract text from this Word document. Try copying the content and pasting it directly.',
            }, { status: 400 })
          }

          // Use AI to convert extracted text into CSV format
          const csvResult = await callAIJson<{ csv: string }>({
            systemPrompt: `You are a document data extractor. The user has uploaded a Word document containing venue/wedding data.
Convert the extracted text into clean CSV format. Identify the structure (table, list, form) and create appropriate headers.
Return JSON: { "csv": "<the CSV text with headers on the first line>" }
If the text contains tabular data, preserve all columns. If it's a list or form, create logical columns.`,
            userPrompt: `Extracted text from Word document "${file.name}":\n\n${extractedText.slice(0, 4000)}`,
            maxTokens: 4000,
            temperature: 0.1,
            venueId,
            taskType: 'document_extraction',
          })

          content = csvResult.csv || extractedText
          break
        }

        case 'vision': {
          // Use vision to extract text from PDFs and images
          const buffer = await file.arrayBuffer()
          const base64 = Buffer.from(buffer).toString('base64')
          const mediaType = file.type.startsWith('image/')
            ? (file.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif')
            : 'image/png' // PDF rendered as image fallback

          const extracted = await callAIVision({
            systemPrompt: `You are a document data extractor for a wedding venue management platform.

Extract ALL data from this document into a clean CSV format.
- If it's an invoice/receipt: extract vendor name, amounts, dates, line items.
  Format as CSV with headers: Vendor Name,Category,Item,Amount,Date,Notes
- If it's a list: extract all rows with their columns.
- If it's a form: extract field names as headers and values as a row.

Return ONLY the CSV text. No explanation, no markdown code blocks. Just raw CSV.`,
            userPrompt: `Extract all tabular/structured data from this document into CSV format. File name: ${file.name}`,
            imageBase64: base64,
            mediaType,
            maxTokens: 4000,
            venueId,
            taskType: 'document_extraction',
          })

          content = extracted.text.replace(/```csv\n?/g, '').replace(/```\n?/g, '').trim()
          break
        }

        default:
          content = await file.text()
      }
    } else if (pastedData) {
      const trimmed = pastedData.trim()

      // Google Sheets URL — fetch the sheet's CSV export directly
      if (isGoogleSheetsUrl(trimmed)) {
        const parsed = parseGoogleSheetsUrl(trimmed)
        if (!parsed) {
          return NextResponse.json({
            error: 'Could not extract the sheet ID from that Google Sheets URL.',
          }, { status: 400 })
        }
        try {
          content = await fetchGoogleSheetCsv(parsed.id, parsed.gid)
          fileName = `Google Sheet ${parsed.id}${parsed.gid ? ` (tab ${parsed.gid})` : ''}`
        } catch (err) {
          return NextResponse.json({
            error: err instanceof Error ? err.message : 'Failed to fetch Google Sheet.',
          }, { status: 400 })
        }
      }
      // Try parsing as JSON if it looks like JSON
      else if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const rows = parseJSON(trimmed)
          content = rows.map((row) => row.map((cell) => {
            if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
              return `"${cell.replace(/"/g, '""')}"`
            }
            return cell
          }).join(',')).join('\n')
        } catch {
          content = trimmed
        }
      } else {
        content = trimmed
      }
    } else {
      return NextResponse.json({ error: 'No data provided. Upload a file or paste data.' }, { status: 400 })
    }

    if (!content || content.trim().length < 5) {
      return NextResponse.json({ error: 'File appears to be empty or unreadable.' }, { status: 400 })
    }

    // -----------------------------------------------------------------------
    // Step 2: Detect data type (or use override)
    // -----------------------------------------------------------------------

    if (action === 'detect') {
      const detection = await detectDataType(content, venueId)
      return NextResponse.json({
        detection,
        content, // send back for the import step
        fileName,
        fileWarning,
      })
    }

    // -----------------------------------------------------------------------
    // Step 3: Import data
    // -----------------------------------------------------------------------

    if (action === 'import') {
      const dataType = (overrideType || formData.get('detectedType')) as DataType
      const rawContent = formData.get('content') as string | null

      const importContent = rawContent || content

      if (!dataType || dataType === 'unknown') {
        return NextResponse.json(
          { error: 'Cannot import unknown data type. Please select a type.' },
          { status: 400 }
        )
      }

      // Parse and map columns
      const rows = parseDelimited(importContent)
      const headers = rows[0] || []
      const dataRows = rows.slice(1)

      if (dataRows.length === 0) {
        return NextResponse.json({ error: 'No data rows found to import.' }, { status: 400 })
      }

      // Get column mapping from AI
      const mapping = await mapColumns(headers, dataType, venueId)

      // Convert to records
      const records = rowsToRecords(dataRows, headers)

      // Import
      const result = await importData(dataType, records, mapping, venueId, {
        weddingId: weddingId || undefined,
      })

      return NextResponse.json({ result })
    }

    return NextResponse.json({ error: 'Invalid action. Use "detect" or "import".' }, { status: 400 })
  } catch (err) {
    console.error('[QUICK-ADD ERROR]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
