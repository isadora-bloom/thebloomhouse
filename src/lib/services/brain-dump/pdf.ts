/**
 * Brain-dump PDF fast path (T5-ι.4).
 *
 * Coordinators occasionally drop a PDF into the brain-dump (a vendor
 * brochure, a draft contract, a venue checklist). Pre-fix the route
 * never read the PDF body — the entry was tagged inputType='pdf' and
 * routed to the text classifier with only the rawText (typically
 * empty). The classifier then either bounced ambiguous or filed it
 * as an opaque operational note.
 *
 * Post-fix: pdf-parse extracts plain text from the PDF, and the route
 * surfaces a propose-and-confirm with the extracted text summary
 * before routing through the regular text classifier.
 *
 * Caps:
 *   - 10MB on the input PDF (rejected upstream if file is bigger).
 *   - 50KB on the extracted text (truncated when longer — don't spam
 *     a 200-page brochure into Claude's context).
 *
 * pdf-parse runs in Node only (uses pdfjs-dist). The brain-dump
 * route is a Node route handler so this is safe; do not import this
 * module from edge / browser code.
 *
 * Polyfill note (2026-05-08):
 * pdf-parse 2.x ships pdfjs-dist 4.x, which references browser-only
 * globals (DOMMatrix, Path2D, ImageData) at module scope. Without a
 * polyfill the dynamic import throws "DOMMatrix is not defined" the
 * first time a PDF lands. We install no-op stand-ins on globalThis
 * BEFORE the pdfjs module is imported. They never get called for
 * text extraction; the pdfjs renderer code references them but only
 * uses them when rendering canvas, which we never trigger.
 */

function installBrowserGlobalsForPdfjs(): void {
  const g = globalThis as unknown as Record<string, unknown>
  if (typeof g.DOMMatrix === 'undefined') {
    class StubDOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
      constructor(_init?: unknown) {}
      multiply() { return this }
      translate() { return this }
      scale() { return this }
      rotate() { return this }
      invertSelf() { return this }
      transformPoint(p: { x?: number; y?: number; z?: number; w?: number }) {
        return { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0, w: p.w ?? 1 }
      }
    }
    g.DOMMatrix = StubDOMMatrix
  }
  if (typeof g.Path2D === 'undefined') {
    class StubPath2D {
      constructor(_init?: unknown) {}
      addPath() {}
      moveTo() {}
      lineTo() {}
      bezierCurveTo() {}
      quadraticCurveTo() {}
      arc() {}
      arcTo() {}
      ellipse() {}
      rect() {}
      closePath() {}
    }
    g.Path2D = StubPath2D
  }
  if (typeof g.ImageData === 'undefined') {
    class StubImageData {
      data: Uint8ClampedArray
      width: number
      height: number
      colorSpace = 'srgb' as const
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
        this.data = new Uint8ClampedArray(width * height * 4)
      }
    }
    g.ImageData = StubImageData
  }
}

installBrowserGlobalsForPdfjs()

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

/**
 * Extract text from a PDF buffer. Never throws — failures return
 * ok=false with a reason so the caller can degrade gracefully (let
 * the coordinator paste text manually).
 */
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

  // pdf-parse 2.x exposes a class API: new PDFParse({ data }).getText().
  // Imported dynamically so the heavy pdfjs-dist worker only loads
  // when a coordinator actually drops a PDF.
  let parser: { getText: () => Promise<{ text: string; total: number }>; destroy: () => Promise<void> } | null = null
  try {
    const mod = (await import('pdf-parse')) as unknown as {
      PDFParse: new (opts: { data: Uint8Array }) => {
        getText: () => Promise<{ text: string; total: number }>
        destroy: () => Promise<void>
      }
    }
    // pdf-parse takes a Uint8Array; a Node Buffer is a Uint8Array
    // subclass but cast explicitly to keep the type contract clean.
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    parser = new mod.PDFParse({ data })
    const result = await parser.getText()
    // Normalise whitespace: PDFs often emit a lot of NBSP ( ) and
    // mixed line breaks. Collapse runs of whitespace to single spaces
    // so the classifier doesn't choke on noise. Keep \n as a sentinel
    // so paragraph boundaries survive.
    let text = (result.text ?? '')
      .replace(/ /g, ' ')
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
      pages: result.total ?? null,
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
      reason: (err as Error).message ?? 'pdf-parse failed',
    }
  } finally {
    try { await parser?.destroy() } catch { /* ignore */ }
  }
}
