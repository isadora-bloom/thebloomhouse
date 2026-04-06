import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI, callAIJson, callAIVision } from '@/lib/ai/client'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/couple/contracts
// Full CRUD + AI analysis pipeline for couple-uploaded contracts
// ---------------------------------------------------------------------------

// ---- GET — list contracts for this couple's wedding ----
export async function GET() {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()

    const { data: contracts, error } = await supabase
      .from('contracts')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('created_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({ contracts: contracts ?? [] })
  } catch (error) {
    return serverError(error)
  }
}

// ---- POST — create contract record or run AI analysis ----
export async function POST(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { action } = body

    // ---- Action: analyze — run AI extraction on a contract ----
    if (action === 'analyze') {
      return handleAnalyze(body, auth)
    }

    // ---- Action: ask — Q&A about a contract ----
    if (action === 'ask') {
      return handleAsk(body, auth)
    }

    // ---- Default: create a new contract record ----
    return handleCreate(body, auth)
  } catch (error) {
    return serverError(error)
  }
}

// ---- DELETE — remove contract + file from storage ----
export async function DELETE(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { contractId } = body

    if (!contractId) return badRequest('Missing contractId')

    const supabase = createServiceClient()

    // Get contract to find storage path
    const { data: contract } = await supabase
      .from('contracts')
      .select('storage_path')
      .eq('id', contractId)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .single()

    if (!contract) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 })
    }

    // Remove file from storage if it exists
    if (contract.storage_path) {
      await supabase.storage
        .from('contracts')
        .remove([contract.storage_path])
    }

    // Delete the record
    const { error } = await supabase
      .from('contracts')
      .delete()
      .eq('id', contractId)
      .eq('venue_id', auth.venueId)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error) {
    return serverError(error)
  }
}

// ---------------------------------------------------------------------------
// Handler: Create contract record
// ---------------------------------------------------------------------------
async function handleCreate(
  body: {
    filename: string
    fileType: string
    storagePath?: string
    fileUrl?: string
    vendorId?: string
    vendorName?: string
  },
  auth: { venueId: string; weddingId: string }
) {
  const { filename, fileType, storagePath, fileUrl, vendorId, vendorName } = body

  if (!filename) return badRequest('Missing filename')
  if (!fileType) return badRequest('Missing fileType')

  const supabase = createServiceClient()

  const { data: contract, error } = await supabase
    .from('contracts')
    .insert({
      venue_id: auth.venueId,
      wedding_id: auth.weddingId,
      filename,
      file_type: fileType,
      storage_path: storagePath ?? null,
      file_url: fileUrl ?? null,
      vendor_id: vendorId ?? null,
      vendor_name: vendorName ?? null,
      status: 'uploaded',
    })
    .select('*')
    .single()

  if (error) throw error

  return NextResponse.json({ contract })
}

// ---------------------------------------------------------------------------
// Handler: AI Analysis Pipeline
// Step 1: Extract all text from the document
// Step 2: Extract structured planning notes as JSON
// Step 3: Store results and insert planning notes
// ---------------------------------------------------------------------------
async function handleAnalyze(
  body: { contractId: string; imageBase64?: string; mediaType?: string },
  auth: { venueId: string; weddingId: string }
) {
  const { contractId, imageBase64, mediaType } = body

  if (!contractId) return badRequest('Missing contractId')

  const supabase = createServiceClient()

  // Load the contract
  const { data: contract, error: fetchErr } = await supabase
    .from('contracts')
    .select('*')
    .eq('id', contractId)
    .eq('venue_id', auth.venueId)
    .eq('wedding_id', auth.weddingId)
    .single()

  if (fetchErr || !contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 })
  }

  // -----------------------------------------------------------------------
  // Step 1: Extract text from the document
  // -----------------------------------------------------------------------
  let extractedText = contract.extracted_text || ''

  if (!extractedText) {
    // Try to get text from the file
    if (imageBase64) {
      // Vision-based extraction for images
      const validMediaTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
      const resolvedMediaType = validMediaTypes.includes(mediaType as typeof validMediaTypes[number])
        ? (mediaType as typeof validMediaTypes[number])
        : 'image/jpeg'

      const extractResult = await callAIVision({
        systemPrompt: 'You are a document text extraction specialist. Extract ALL text from this document image exactly as it appears. Preserve formatting, line breaks, and structure. Include every word, number, date, and detail.',
        userPrompt: 'Extract the complete text from this document image. Include all text, headings, fine print, signatures, dates, and amounts.',
        imageBase64,
        mediaType: resolvedMediaType,
        maxTokens: 4000,
        venueId: auth.venueId,
        taskType: 'contract_text_extraction_vision',
      })

      extractedText = extractResult.text
    } else if (contract.storage_path) {
      // Try to download from storage and read as text
      const { data: fileData } = await supabase.storage
        .from('contracts')
        .download(contract.storage_path)

      if (fileData) {
        const fileType = contract.file_type || ''

        if (['jpg', 'jpeg', 'png', 'webp', 'image'].includes(fileType)) {
          // Convert to base64 for vision extraction
          const arrayBuffer = await fileData.arrayBuffer()
          const base64 = Buffer.from(arrayBuffer).toString('base64')
          const mType = fileType === 'png' ? 'image/png'
            : fileType === 'webp' ? 'image/webp'
            : 'image/jpeg'

          const extractResult = await callAIVision({
            systemPrompt: 'You are a document text extraction specialist. Extract ALL text from this document image exactly as it appears. Preserve formatting, line breaks, and structure.',
            userPrompt: 'Extract the complete text from this document image. Include all text, headings, fine print, signatures, dates, and amounts.',
            imageBase64: base64,
            mediaType: mType as 'image/jpeg' | 'image/png' | 'image/webp',
            maxTokens: 4000,
            venueId: auth.venueId,
            taskType: 'contract_text_extraction_vision',
          })

          extractedText = extractResult.text
        } else {
          // For PDFs and text documents, try to read as text
          const text = await fileData.text()
          if (text && text.length > 50) {
            extractedText = text
          } else {
            // PDF binary - ask AI to note this limitation
            const extractResult = await callAI({
              systemPrompt: 'You are a document analysis assistant.',
              userPrompt: `The document "${contract.filename}" was uploaded as a ${fileType} file but could not be read directly. Please note that PDF text extraction requires OCR or a PDF parser. The file has been stored but text extraction is limited to image-based documents at this time.`,
              maxTokens: 500,
              venueId: auth.venueId,
              taskType: 'contract_text_extraction_note',
            })
            extractedText = extractResult.text
          }
        }
      }
    }
  }

  if (!extractedText) {
    return NextResponse.json(
      { error: 'No text could be extracted. Please provide an image of the contract.' },
      { status: 400 }
    )
  }

  // -----------------------------------------------------------------------
  // Step 2: AI analysis — extract key terms and summary
  // -----------------------------------------------------------------------
  const analysisResult = await callAI({
    systemPrompt: `You are a wedding contract analysis specialist. Analyze the following contract text and provide a clear, structured summary. Focus on:
1. Payment schedule (deposits, installments, final payment)
2. Important dates and deadlines
3. Cancellation and refund policy
4. Liability and insurance requirements
5. Force majeure / act of god clauses
6. Overtime charges
7. Gratuity policies
8. Damage/security deposits
9. Guest count commitments or minimums
10. Special conditions or restrictions

Format your response as a clear summary with sections. Be specific about dollar amounts, percentages, and dates.`,
    userPrompt: `Analyze this wedding vendor contract:\n\n${extractedText.slice(0, 8000)}`,
    maxTokens: 2000,
    venueId: auth.venueId,
    taskType: 'contract_analysis',
  })

  // -----------------------------------------------------------------------
  // Step 3: Extract key terms list
  // -----------------------------------------------------------------------
  const KEY_TERMS = [
    'payment schedule', 'deposit', 'final payment', 'cancellation policy',
    'liability', 'force majeure', 'damage', 'insurance', 'gratuity',
    'overtime', 'refund', 'non-refundable', 'retainer', 'balance due',
    'minimum', 'maximum', 'guest count', 'indemnify', 'termination',
    'act of god', 'weather', 'rain plan', 'security deposit',
  ]

  const textLower = extractedText.toLowerCase()
  const foundTerms = KEY_TERMS.filter(term => textLower.includes(term))

  // -----------------------------------------------------------------------
  // Step 4: Extract structured planning notes
  // -----------------------------------------------------------------------
  let planningNotes: Array<{ category: string; content: string }> = []

  try {
    planningNotes = await callAIJson<Array<{ category: string; content: string }>>({
      systemPrompt: `Extract key planning details from this wedding vendor contract. Return a JSON array of objects.
Each object must have:
- "category": one of "vendor", "cost", "date", "policy", "note"
- "content": a concise, specific detail (include names, amounts, dates)

Include: vendor name and contact info, all dollar amounts with context, all dates and deadlines, cancellation terms, payment schedule, liability terms, overtime rates, gratuity requirements.
Return 5-15 items. Be specific and factual.`,
      userPrompt: extractedText.slice(0, 6000),
      maxTokens: 1500,
      venueId: auth.venueId,
      taskType: 'contract_planning_extraction',
    })
  } catch (err) {
    console.warn('[contracts/analyze] Planning notes extraction failed:', err)
    planningNotes = []
  }

  // -----------------------------------------------------------------------
  // Step 5: Update contract record
  // -----------------------------------------------------------------------
  await supabase
    .from('contracts')
    .update({
      extracted_text: extractedText,
      analysis: analysisResult.text,
      key_terms: foundTerms,
      analyzed_at: new Date().toISOString(),
      status: 'analyzed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', contractId)
    .eq('venue_id', auth.venueId)

  // -----------------------------------------------------------------------
  // Step 6: Insert planning notes
  // -----------------------------------------------------------------------
  if (planningNotes.length > 0) {
    const validCategories = ['vendor', 'cost', 'date', 'policy', 'note']
    const notesToInsert = planningNotes
      .filter(n => n.content && validCategories.includes(n.category))
      .map(n => ({
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
        category: n.category,
        content: n.content,
        source_message: `Contract: ${contract.filename}`,
        status: 'extracted',
      }))

    if (notesToInsert.length > 0) {
      await supabase.from('planning_notes').insert(notesToInsert)
    }
  }

  return NextResponse.json({
    success: true,
    analysis: analysisResult.text,
    keyTerms: foundTerms,
    extractedText: extractedText.slice(0, 500) + (extractedText.length > 500 ? '...' : ''),
    planningNotesCount: planningNotes.length,
  })
}

// ---------------------------------------------------------------------------
// Handler: Contract Q&A — ask a question about a specific contract
// ---------------------------------------------------------------------------
async function handleAsk(
  body: { contractId: string; question: string },
  auth: { venueId: string; weddingId: string }
) {
  const { contractId, question } = body

  if (!contractId) return badRequest('Missing contractId')
  if (!question) return badRequest('Missing question')

  const supabase = createServiceClient()

  // Load contract with extracted text
  const { data: contract } = await supabase
    .from('contracts')
    .select('filename, extracted_text, analysis, key_terms')
    .eq('id', contractId)
    .eq('venue_id', auth.venueId)
    .eq('wedding_id', auth.weddingId)
    .single()

  if (!contract || !contract.extracted_text) {
    return NextResponse.json(
      { error: 'Contract not found or not yet analyzed' },
      { status: 404 }
    )
  }

  const result = await callAI({
    systemPrompt: `You are a helpful wedding planning assistant answering questions about a vendor contract.

CONTRACT: "${contract.filename}"

EXTRACTED TEXT:
${contract.extracted_text.slice(0, 6000)}

${contract.analysis ? `\nAI ANALYSIS SUMMARY:\n${contract.analysis}` : ''}

Answer the couple's question based ONLY on what is in this contract. If the answer is not in the contract text, say so clearly. Be specific with dates, amounts, and terms. Keep your answer concise (2-4 sentences).`,
    userPrompt: question,
    maxTokens: 500,
    temperature: 0.2,
    venueId: auth.venueId,
    taskType: 'contract_qa',
  })

  return NextResponse.json({
    answer: result.text,
  })
}
