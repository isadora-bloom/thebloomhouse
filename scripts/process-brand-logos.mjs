/**
 * Brand-logo processor.
 *
 * Reads B&W source PNGs and produces colored, transparent-background
 * variants for use across the bloom-house platform AND the
 * thebloomhouse-website marketing repo.
 *
 * Doctrine
 * --------
 * Source files are black ink on white background. We compute each output
 * pixel's alpha as (255 - source luminance) × source alpha, then fill RGB
 * with the target color. This preserves anti-aliased edges (mid-grey
 * source pixels become mid-alpha target pixels) and turns the white
 * background into transparency without a hard threshold artifact.
 *
 * Usage:
 *   node scripts/process-brand-logos.mjs [SOURCE_DIR]
 *
 * SOURCE_DIR defaults to "C:/Users/Ismar/Downloads/BLOOM HOUSE (4)".
 * Inputs expected: 1.png (horizontal lockup), 2.png (vertical w/ URL),
 * 3.png (icon only).
 *
 * Outputs go to both repos. Re-run is idempotent.
 */

import sharp from 'sharp'
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Brand colors. Sage is the primary brand color per bloom-house CLAUDE.md.
const COLORS = {
  black: [0, 0, 0],
  sage: [0x7d, 0x84, 0x71], // #7D8471
  // Lighter sage — blend with warm-white (#FDFAF6) so it stays on-palette
  // instead of being a generic light gray. ~55% sage + 45% bg.
  'sage-light': [0xb8, 0xbd, 0xb1],
  white: [255, 255, 255],
}

const REPOS = {
  bloomHouse: 'C:/Users/Ismar/bloom-house/public/brand',
  website: 'C:/Users/Ismar/thebloomhouse-website/public/images',
}

const SOURCE_DIR = process.argv[2] ?? 'C:/Users/Ismar/Downloads/BLOOM HOUSE (4)'

/**
 * Produce a recolored, transparent-background buffer from a B&W source.
 * Returns { buffer, width, height } so callers can pipe to Sharp again.
 */
async function recolor(srcPath, color, opts = {}) {
  const [tr, tg, tb] = color
  const trimThreshold = opts.trimThreshold ?? 250
  // 1. Load + ensure alpha + trim near-white edges.
  let pipeline = sharp(srcPath).ensureAlpha()
  try {
    pipeline = pipeline.trim({ background: { r: 255, g: 255, b: 255, alpha: 1 }, threshold: 5 })
  } catch {
    // Older Sharp signature.
    pipeline = sharp(srcPath).ensureAlpha().trim(10)
  }
  const { data, info } = await pipeline
    .raw()
    .toBuffer({ resolveWithObject: true })

  // 2. Walk pixels, compute new alpha from darkness.
  const out = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i += 4) {
    const sr = data[i]
    const sg = data[i + 1]
    const sb = data[i + 2]
    const sa = data[i + 3]
    // Average luminance. Logo is monochrome so simple mean is fine.
    const lum = (sr + sg + sb) / 3
    // Background → transparent; black ink → opaque target color.
    const darkness = Math.max(0, Math.min(1, (trimThreshold - lum) / trimThreshold))
    const newAlpha = Math.round((sa / 255) * darkness * 255)
    out[i] = tr
    out[i + 1] = tg
    out[i + 2] = tb
    out[i + 3] = newAlpha
  }
  return { buffer: out, width: info.width, height: info.height }
}

async function writePng({ buffer, width, height }, outPath, { maxWidth } = {}) {
  await fs.mkdir(dirname(outPath), { recursive: true })
  let pipeline = sharp(buffer, { raw: { width, height, channels: 4 } })
  if (maxWidth && width > maxWidth) {
    pipeline = pipeline.resize({ width: maxWidth })
  }
  await pipeline.png({ compressionLevel: 9 }).toFile(outPath)
  const stat = await fs.stat(outPath)
  return { path: outPath, bytes: stat.size }
}

async function ensureSourceExists(name) {
  const p = resolve(SOURCE_DIR, name)
  await fs.access(p)
  return p
}

async function main() {
  console.log(`SOURCE_DIR: ${SOURCE_DIR}`)
  const sources = {
    wordmark: await ensureSourceExists('1.png'), // horizontal lockup
    vertical: await ensureSourceExists('2.png'), // vertical w/ URL
    icon: await ensureSourceExists('3.png'), // icon only
  }

  const results = []

  // 1. Wordmark (horizontal). Replaces existing wordmark-*.png /
  //    logo-*.png in both repos.
  for (const colorName of Object.keys(COLORS)) {
    const recolored = await recolor(sources.wordmark, COLORS[colorName])
    // bloom-house naming
    results.push(
      await writePng(recolored, `${REPOS.bloomHouse}/wordmark-${colorName}.png`, {
        maxWidth: 1600,
      }),
    )
    // sage-sm: same content, smaller export for the couple portal.
    if (colorName === 'sage') {
      results.push(
        await writePng(recolored, `${REPOS.bloomHouse}/wordmark-sage-sm.png`, {
          maxWidth: 600,
        }),
      )
    }
    // website naming uses "logo-" instead of "wordmark-".
    const websiteName =
      colorName === 'sage-light' ? 'logo-sage-light' : `logo-${colorName}`
    results.push(
      await writePng(recolored, `${REPOS.website}/${websiteName}.png`, {
        maxWidth: 1600,
      }),
    )
  }

  // 2. Icon (just the thumbprint). Replaces existing icon-*.png.
  for (const colorName of Object.keys(COLORS)) {
    const recolored = await recolor(sources.icon, COLORS[colorName])
    results.push(
      await writePng(recolored, `${REPOS.bloomHouse}/icon-${colorName}.png`, {
        maxWidth: 512,
      }),
    )
    results.push(
      await writePng(recolored, `${REPOS.website}/icon-${colorName}.png`, {
        maxWidth: 512,
      }),
    )
  }

  // 3. Vertical lockup (icon + wordmark + URL). New variant. Useful for
  //    TBH Report covers, login splash, marketing-site hero. Skip the
  //    'white' variant for the website (light bg only there).
  for (const colorName of Object.keys(COLORS)) {
    const recolored = await recolor(sources.vertical, COLORS[colorName])
    results.push(
      await writePng(
        recolored,
        `${REPOS.bloomHouse}/lockup-vertical-${colorName}.png`,
        { maxWidth: 800 },
      ),
    )
    results.push(
      await writePng(
        recolored,
        `${REPOS.website}/lockup-vertical-${colorName}.png`,
        { maxWidth: 800 },
      ),
    )
  }

  // Summary
  for (const r of results) {
    const kb = Math.round(r.bytes / 1024)
    console.log(`  ${kb}KB\t${r.path}`)
  }
  console.log(`\nWrote ${results.length} files.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
