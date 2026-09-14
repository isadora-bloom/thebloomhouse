/**
 * Document text reaching Sage is derived server-side, and the message is
 * capped. 2026-09-14 security review, item 1.
 *
 * Source assertions rather than a live route call: exercising POST needs
 * the plan gate, the demo-token cookie, couple auth, the rate limiter and
 * Supabase, and standing all five up would test the fakes. What matters
 * here is narrow and structural — the body field is gone, the text comes
 * from a row the couple owns, and both inputs have a ceiling.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const ROUTE = readFileSync('src/app/api/portal/sage/route.ts', 'utf8')
const CLIENT = readFileSync('src/app/_couple-pages/chat/page.tsx', 'utf8')
const BRAIN = readFileSync('src/lib/services/brain/sage.ts', 'utf8')

describe('portal sage route file context', () => {
  it('does not destructure fileContext out of the request body', () => {
    const destructure = ROUTE.match(/const \{[^}]*\} = body/)?.[0] ?? ''
    expect(destructure).not.toContain('fileContext')
    expect(destructure).toContain('contractId')
  })

  it('starts the resolved context empty rather than from the body', () => {
    expect(ROUTE).toContain("let resolvedFileContext = ''")
    expect(ROUTE).not.toContain('fileContext || ')
  })

  it('reads the contract scoped to both the venue and the wedding', () => {
    const block = ROUTE.slice(ROUTE.indexOf(".from('contracts')"))
    const query = block.slice(0, 400)
    expect(query).toContain(".eq('id', contractId.trim())")
    expect(query).toContain(".eq('venue_id', venueId)")
    expect(query).toContain(".eq('wedding_id', weddingId)")
  })

  it('will not extract a file that is not under this wedding’s storage prefix', () => {
    expect(ROUTE).toContain('/contracts/${weddingId}/')
    expect(ROUTE).toContain('fileUrlOwnedByCouple')
  })

  it('says out loud when an old client still posts fileContext', () => {
    expect(ROUTE).toContain('body.fileContext !== undefined')
  })

  it('caps the message and says the number in the refusal', () => {
    expect(ROUTE).toContain('const MAX_MESSAGE_CHARS = 4000')
    expect(ROUTE).toMatch(/message\.length > MAX_MESSAGE_CHARS/)
    expect(ROUTE).toContain('max ${MAX_MESSAGE_CHARS} characters')
    // A 400, not a silent truncation: half a question gets a wrong answer.
    const guard = ROUTE.slice(ROUTE.indexOf('message.length > MAX_MESSAGE_CHARS'))
    expect(guard.slice(0, 400)).toContain('status: 400')
  })

  it('caps the derived document text before it reaches the prompt', () => {
    expect(ROUTE).toContain('const MAX_FILE_CONTEXT_CHARS = 12000')
    expect(ROUTE).toContain('resolvedFileContext.length > MAX_FILE_CONTEXT_CHARS')
  })
})

describe('couple chat client', () => {
  it('sends the contract id, not the contract text', () => {
    expect(CLIENT).toContain('contractId,')
    expect(CLIENT).not.toContain('fileContext,')
    expect(CLIENT).not.toContain('contractContext.extractedText.slice')
  })
})

describe('sage brain', () => {
  it('wraps the document in the untrusted-data envelope', () => {
    const block = BRAIN.slice(BRAIN.indexOf('let fileContextBlock'))
    expect(block.slice(0, 600)).toContain("wrapFileContext(fileContext, 'attached_document')")
  })
})
