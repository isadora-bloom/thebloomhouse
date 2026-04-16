import { NextRequest, NextResponse } from 'next/server'
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
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx'
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
          // XLSX is a binary format. We can't easily parse it without a library.
          // Try reading as text (will be garbled for real XLSX).
          // Warn the user to save as CSV instead.
          const rawText = await file.text()

          // Check if it looks like actual tabular data (old XLS can sometimes be TSV/HTML)
          const lines = rawText.split('\n').filter((l) => l.trim())
          if (lines.length > 1 && (lines[0].includes('\t') || lines[0].includes(','))) {
            // It might actually be a CSV with .xlsx extension, or an HTML table
            content = rawText
          } else {
            fileWarning = 'Excel files (.xlsx/.xls) cannot be parsed directly. Please save as CSV first, then re-upload. Attempting best-effort text extraction.'
            content = rawText.replace(/[^\x20-\x7E\t\n\r]/g, ' ').replace(/\s+/g, ' ').trim()

            if (content.length < 10) {
              return NextResponse.json({
                error: 'Cannot read Excel file directly. Please open it in Excel or Google Sheets and save as CSV (.csv), then upload the CSV.',
              }, { status: 400 })
            }
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

      // Check for Google Sheets URL
      if (isGoogleSheetsUrl(trimmed)) {
        return NextResponse.json({
          error: 'Google Sheets URL detected. To import from Google Sheets: open the sheet, go to File > Download > CSV (.csv), then upload the downloaded file. Direct Google Sheets API integration is coming soon.',
          isGoogleSheetsUrl: true,
        }, { status: 400 })
      }

      // Try parsing as JSON if it looks like JSON
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
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
