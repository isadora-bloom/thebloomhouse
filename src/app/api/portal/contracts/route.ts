import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { callAI, callAIVision } from '@/lib/ai/client'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List contracts for a wedding
//   ?weddingId=UUID (required)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const weddingId = searchParams.get('weddingId')

    if (!weddingId) {
      return NextResponse.json(
        { error: 'Missing weddingId query parameter' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const { data: contracts, error } = await supabase
      .from('contracts')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ contracts: contracts ?? [] })
  } catch (err) {
    console.error('[api/portal/contracts] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Create a contract record
//   Body: { weddingId, filename, fileType, storagePath? }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { weddingId, filename, fileType, storagePath } = body

    if (!weddingId || typeof weddingId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid weddingId' },
        { status: 400 }
      )
    }

    if (!filename || typeof filename !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid filename' },
        { status: 400 }
      )
    }

    if (!fileType || typeof fileType !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid fileType' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const { data: contract, error } = await supabase
      .from('contracts')
      .insert({
        venue_id: auth.venueId,
        wedding_id: weddingId,
        filename,
        file_type: fileType,
        storage_path: storagePath ?? null,
        status: 'uploaded',
      })
      .select('*')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ contract })
  } catch (err) {
    console.error('[api/portal/contracts] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PATCH — Update extracted text / run AI analysis on a contract
//   Body: {
//     contractId: string,
//     extractedText?: string,
//     imageBase64?: string,        (for image-based contracts)
//     mediaType?: string           (image/jpeg, image/png, etc.)
//   }
//
//   If extractedText is provided, runs text-based AI analysis.
//   If imageBase64 is provided, runs vision-based AI analysis.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { contractId, extractedText, imageBase64, mediaType } = body

    if (!contractId || typeof contractId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid contractId' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Update extracted text if provided
    if (extractedText && typeof extractedText === 'string') {
      await supabase
        .from('contracts')
        .update({
          extracted_text: extractedText,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contractId)
        .eq('venue_id', auth.venueId)
    }

    // Run AI analysis
    const analysisPrompt = `You are a contract analysis assistant for a wedding venue.
Extract key details from this contract/document:
- Payment terms and amounts
- Important dates and deadlines
- Cancellation policy
- Special conditions or clauses
- Guest count commitments
- Vendor obligations

Return a structured summary with the key points.`

    let analysis: string | null = null

    if (imageBase64 && typeof imageBase64 === 'string') {
      // Vision-based analysis for image contracts
      const validMediaTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
      const resolvedMediaType = validMediaTypes.includes(mediaType as typeof validMediaTypes[number])
        ? (mediaType as typeof validMediaTypes[number])
        : 'image/jpeg'

      const result = await callAIVision({
        systemPrompt: analysisPrompt,
        userPrompt: 'Analyze this contract document and extract the key details.',
        imageBase64,
        mediaType: resolvedMediaType,
        maxTokens: 2000,
        venueId: auth.venueId,
        taskType: 'contract_analysis_vision',
      })

      analysis = result.text
    } else if (extractedText && typeof extractedText === 'string') {
      // Text-based analysis
      const result = await callAI({
        systemPrompt: analysisPrompt,
        userPrompt: extractedText,
        maxTokens: 2000,
        venueId: auth.venueId,
        taskType: 'contract_analysis_text',
      })

      analysis = result.text
    }

    // Store analysis result
    if (analysis) {
      await supabase
        .from('contracts')
        .update({
          ai_analysis: analysis,
          status: 'analyzed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', contractId)
        .eq('venue_id', auth.venueId)
    }

    return NextResponse.json({
      success: true,
      analysis: analysis ?? null,
    })
  } catch (err) {
    console.error('[api/portal/contracts] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
