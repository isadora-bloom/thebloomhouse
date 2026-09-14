/**
 * A very small PDF writer, for one job: turning a contract's plain text
 * into a file a couple can download and keep.
 *
 * Why not a library
 * -----------------
 * The repo already carries the scar from the other direction. Brain-dump
 * needs to READ PDFs and went pdf-parse -> pdfjs -> DOMMatrix polyfill ->
 * unpdf before it stopped throwing on serverless cold starts (see
 * src/lib/services/brain-dump/pdf.ts, which still installs the polyfill
 * belt-and-braces). pdfkit has its own version of that problem on Vercel:
 * it loads the base-14 AFM metrics from disk at require time, which needs
 * the fonts externalised from the bundle or it fails at runtime.
 *
 * What this file writes is a text-only document in one of the base-14
 * fonts, which the PDF spec says every reader already has. No font
 * embedding, no images, no compression, no disk reads, no globals. About
 * 200 lines against a dependency that would have to be configured around
 * the same deployment target twice.
 *
 * What it does not do: images, tables, colour, links, right-to-left text,
 * or anything outside Latin-1. Characters outside Latin-1 are transliterated
 * where there is an obvious equivalent and dropped otherwise, which is the
 * honest failure for a document whose whole point is to be legible.
 */

const PAGE_WIDTH = 595.28 // A4 at 72dpi
const PAGE_HEIGHT = 841.89
const MARGIN = 56
const BODY_SIZE = 10.5
const HEADING_SIZE = 12
const TITLE_SIZE = 18
const LINE_GAP = 1.45

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

/** Which of the two base-14 faces a line is set in. */
type Face = 'regular' | 'bold'

export interface PdfBlock {
  text: string
  face: Face
  size: number
  /** Extra space above this block, in points. */
  spaceBefore: number
}

// ---------------------------------------------------------------------------
// Text measurement
//
// Approximate Helvetica advances as a fraction of the font size. Exact AFM
// metrics would need the 315-glyph table this file exists to avoid; these
// buckets put the wrap point within a character or two, which is all a
// left-aligned paragraph needs.
// ---------------------------------------------------------------------------

const NARROW = new Set("iljtfI.,'\":;|!()[]{}`-".split(''))
const WIDE = new Set('mwMW@%'.split(''))

function charWidth(ch: string): number {
  if (ch === ' ') return 0.278
  if (NARROW.has(ch)) return 0.3
  if (WIDE.has(ch)) return 0.83
  if (ch >= '0' && ch <= '9') return 0.556
  if (ch >= 'A' && ch <= 'Z') return 0.68
  return 0.52
}

function measure(text: string, size: number, face: Face): number {
  let w = 0
  for (const ch of text) w += charWidth(ch)
  // Bold Helvetica runs a few percent wider than regular.
  return w * size * (face === 'bold' ? 1.06 : 1)
}

/** Break one paragraph into lines that fit the content width. */
export function wrapLine(text: string, size: number, face: Face): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (measure(candidate, size, face) <= CONTENT_WIDTH) {
      current = candidate
      continue
    }
    if (current !== '') lines.push(current)
    // A single word longer than the line gets hard-broken rather than
    // running off the page.
    if (measure(word, size, face) > CONTENT_WIDTH) {
      let chunk = ''
      for (const ch of word) {
        if (measure(chunk + ch, size, face) > CONTENT_WIDTH) {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk += ch
        }
      }
      current = chunk
    } else {
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const TRANSLITERATE: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  ' ': ' ',
  '•': '-',
  '€': 'EUR',
  '£': 'GBP',
}

/** Latin-1 only, with the common typographic characters folded in. */
export function toLatin1(text: string): string {
  let out = ''
  for (const ch of text) {
    const mapped = TRANSLITERATE[ch]
    if (mapped !== undefined) {
      out += mapped
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (code >= 32 && code <= 255) out += ch
    else if (ch === '\t') out += '    '
    // Anything else is dropped. A question mark would look like the
    // document is asking something.
  }
  return out
}

function escapeString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface Placed {
  text: string
  face: Face
  size: number
  y: number
}

function layout(blocks: PdfBlock[]): Placed[][] {
  const pages: Placed[][] = []
  let page: Placed[] = []
  let y = PAGE_HEIGHT - MARGIN

  const bottom = MARGIN + 24 // room for the page number

  for (const block of blocks) {
    const lines =
      block.text.trim() === '' ? [''] : wrapLine(toLatin1(block.text), block.size, block.face)
    let first = true
    for (const line of lines) {
      const lead = block.size * LINE_GAP
      const advance = (first ? block.spaceBefore : 0) + lead
      if (y - advance < bottom) {
        // The space-before is dropped at a page break: a heading that
        // lands at the top of a new page does not want 16pt of nothing
        // above it.
        pages.push(page)
        page = []
        y = PAGE_HEIGHT - MARGIN - lead
      } else {
        y -= advance
      }
      page.push({ text: line, face: block.face, size: block.size, y })
      first = false
    }
  }
  pages.push(page)
  return pages
}

function contentStream(placed: Placed[], pageNo: number, pageCount: number): string {
  const parts: string[] = []
  for (const item of placed) {
    if (item.text === '') continue
    const font = item.face === 'bold' ? '/F2' : '/F1'
    parts.push(
      `BT ${font} ${item.size} Tf 1 0 0 1 ${MARGIN.toFixed(2)} ${item.y.toFixed(2)} Tm (${escapeString(item.text)}) Tj ET`,
    )
  }
  const footer = `Page ${pageNo} of ${pageCount}`
  parts.push(
    `BT /F1 8 Tf 1 0 0 1 ${MARGIN.toFixed(2)} ${(MARGIN - 12).toFixed(2)} Tm (${escapeString(footer)}) Tj ET`,
  )
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * Turn a list of blocks into PDF bytes.
 *
 * Uncompressed, which makes a ten-page contract about 25 KB. That is
 * smaller than the flate implementation would be worth.
 */
export function renderPdf(blocks: PdfBlock[]): Uint8Array {
  const pages = layout(blocks)
  const pageCount = pages.length

  // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, then per page a page
  // object and a content stream.
  const firstPageObj = 5
  const objects: string[] = []

  const pageIds = pages.map((_, i) => firstPageObj + i * 2)

  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
  )
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')

  pages.forEach((placed, i) => {
    const pageId = pageIds[i]
    const contentId = pageId + 1
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    )
    const stream = contentStream(placed, i + 1, pageCount)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })

  const xrefStart = body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  const full = body + xref + trailer

  // Latin-1 bytes. Every string that reached here has been through
  // toLatin1, and the structural syntax is ASCII.
  const bytes = new Uint8Array(full.length)
  for (let i = 0; i < full.length; i++) bytes[i] = full.charCodeAt(i) & 0xff
  return bytes
}

/** Convenience: the block list a rendered contract turns into. */
export function contractBlocks(input: {
  title: string
  intro: string
  sections: { heading: string; lines: string[] }[]
  closing: string
}): PdfBlock[] {
  const blocks: PdfBlock[] = [
    { text: input.title, face: 'bold', size: TITLE_SIZE, spaceBefore: 0 },
    { text: input.intro, face: 'regular', size: BODY_SIZE, spaceBefore: 14 },
  ]
  for (const section of input.sections) {
    blocks.push({ text: section.heading, face: 'bold', size: HEADING_SIZE, spaceBefore: 16 })
    for (const line of section.lines) {
      if (line.trim() === '') continue
      blocks.push({ text: line, face: 'regular', size: BODY_SIZE, spaceBefore: 2 })
    }
  }
  blocks.push({ text: input.closing, face: 'regular', size: BODY_SIZE, spaceBefore: 20 })
  return blocks
}
