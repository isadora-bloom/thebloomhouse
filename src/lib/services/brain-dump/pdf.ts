/**
 * Brain-dump PDF text extraction.
 *
 * Coordinators occasionally drop a PDF into the brain-dump (a vendor
 * brochure, a draft contract, a venue checklist, an invoice). The
 * route reads the bytes, runs them through this extractor, and feeds
 * the extracted text into the regular text classifier so the entry
 * routes the same way a paste would.
 *
 * Implementation note (2026-05-08):
 * pdf-parse 2.x ships pdfjs-dist 4.x, which requires browser DOM
 * globals (DOMMatrix, Path2D, ImageData, OffscreenCanvas, Worker)
 * that Node serverless does not provide. A polyfill stub-class
 * approach worked for some PDFs but still threw "DOMMatrix is not
 * defined" on others when pdfjs hit a code path that touched a
 * static method or prototype the stub did not cover.
 *
 * Switched to `unpdf` which is a purpose-built fork of pdfjs designed
 * specifically for serverless Node and has zero dependency on browser
 * DOM globals. Smaller bundle, faster cold start, and no polyfill
 * surface to drift over time.
 *
 * Caps:
 *   - 10 MB on the input PDF.
 *   - 50 KB on the extracted text (truncated when longer so we don't
 *     spam a 200-page brochure into Claude's context).
 *
 * Never throws: failures return ok=false with a reason so the brain-
 * dump route can degrade gracefully (turn into a clarification
 * asking the coordinator to paste text instead).
 */

export const PDF_SIZE_CAP_BYTES = 10 * 1024 * 1024 // 10MB
export const PDF_TEXT_CAP_CHARS = 50_000

export interface PdfExtractResult {
  ok: boolean
  /** Page count when known. */
  pages: number | null
  /** Extracted plain text, capped at PDF_TEXT_CAP_CHARS. */
  text: string
  /** Whether truncation was applied. */
  truncated: boolean
  /** Bytes processed (post-cap). */
  bytes: number
  /** Failure reason when ok=false. */
  reason?: string
}

export async function extractPdfText(buffer: Buffer): Promise<PdfExtractResult> {
  if (!buffer || buffer.length === 0) {
    return { ok: false, pages: null, text: '', truncated: false, bytes: 0, reason: 'empty buffer' }
  }
  if (buffer.length > PDF_SIZE_CAP_BYTES) {
    return {
      ok: false,
      pages: null,
      text: '',
      truncated: false,
      bytes: buffer.length,
      reason: `pdf exceeds ${PDF_SIZE_CAP_BYTES} byte cap`,
    }
  }

  try {
    // Dynamic import keeps the heavy pdfjs-fork bundle out of cold
    // starts on routes that never touch a PDF.
    const { extractText, getDocumentProxy } = await import('unpdf')

    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const doc = await getDocumentProxy(data)
    const result = await extractText(doc, { mergePages: true })
    const totalPages: number | null =
      typeof result.totalPages === 'number' ? result.totalPages : null

    // unpdf returns text as either a string (mergePages: true) or a
    // string[] (one entry per page). We requested merged so it is the
    // string path, but defend against both.
    const rawText = Array.isArray(result.text)
      ? result.text.join('\n\n')
      : (result.text ?? '')

    // Normalise whitespace: PDFs emit a lot of NBSP and mixed line
    // breaks. Collapse runs of whitespace to single spaces so the
    // classifier doesn't choke on noise. Keep \n as a sentinel so
    // paragraph boundaries survive.
    let text = rawText
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    let truncated = false
    if (text.length > PDF_TEXT_CAP_CHARS) {
      text = text.slice(0, PDF_TEXT_CAP_CHARS) + '\n... (truncated)'
      truncated = true
    }

    return {
      ok: true,
      pages: totalPages,
      text,
      truncated,
      bytes: buffer.length,
    }
  } catch (err) {
    return {
      ok: false,
      pages: null,
      text: '',
      truncated: false,
      bytes: buffer.length,
      reason: (err as Error).message ?? 'unpdf failed',
    }
  }
}
