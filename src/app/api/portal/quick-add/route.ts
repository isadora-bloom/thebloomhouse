import { NextRequest, NextResponse } from 'next/server'
import { callAIJson, callAIVision } from '@/lib/ai/client'
import {
  detectDataType,
  mapColumns,
  parseDelimited,
  type DataType,
  type DetectionResult,
} from '@/lib/services/data-detection'
import { importData, rowsToRecords } from '@/lib/services/data-import'

// ---------------------------------------------------------------------------
// POST /api/portal/quick-add — Analyze uploaded file / pasted data
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

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

    if (file) {
      fileName = file.name

      // Size check
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File too large. Maximum size is 10 MB (got ${(file.size / 1024 / 1024).toFixed(1)} MB).` },
          { status: 400 }
        )
      }

      const fileExt = file.name.split('.').pop()?.toLowerCase()

      if (fileExt === 'csv' || fileExt === 'tsv' || fileExt === 'txt') {
        content = await file.text()
      } else if (fileExt === 'pdf' || file.type.startsWith('image/')) {
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
      } else {
        // Try reading as text (xlsx will be garbled, but we try)
        content = await file.text()
      }
    } else if (pastedData) {
      content = pastedData.trim()
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
