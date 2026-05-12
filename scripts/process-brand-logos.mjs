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
    // 3.png is NOT a clean icon — it's the TBH sub-brand stamp:
    // thumbprint + "T B H" vertical letters + thebloomhouse.ai URL.
    // Routed to its own filename so the platform can surface it as
    // a TBH-specific mark (TBH Report cover, sub-brand chips, etc).
    tbhStamp: await ensureSourceExists('3.png'),
    // 5.png is the bold-stroke bare thumbprint — used as the DEFAULT
    // icon because bold strokes survive downsample to favicon scale
    // without the curves disappearing.
    icon: await ensureSourceExists('5.png'),
    iconThin: await ensureSourceExists('4.png'), // bare thumbprint, thin stroke
    iconBold: await ensureSourceExists('5.png'), // alias of icon, kept for clarity
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

  // 2b. Icon stroke-weight variants. The thin version reads elegantly
  //     at large sizes (hero, splash); the bold version holds up at
  //     32-pixel favicon sizes where thin lines disappear. Default
  //     `icon-*.png` from source 3 sits in the middle and remains the
  //     base name. Sized smaller (256px) — they're contextual.
  for (const [variantSuffix, src] of [
    ['thin', sources.iconThin],
    ['bold', sources.iconBold],
  ]) {
    for (const colorName of Object.keys(COLORS)) {
      const recolored = await recolor(src, COLORS[colorName])
      results.push(
        await writePng(
          recolored,
          `${REPOS.bloomHouse}/icon-${variantSuffix}-${colorName}.png`,
          { maxWidth: 256 },
        ),
      )
      results.push(
        await writePng(
          recolored,
          `${REPOS.website}/icon-${variantSuffix}-${colorName}.png`,
          { maxWidth: 256 },
        ),
      )
    }
  }

  // 2c. Favicons. The bold black icon at 256px is what the browser
  //     downscales; bold strokes survive the downsample to 32×32 better
  //     than the medium stroke does. Replaces /favicon.png at the root
  //     of both repos.
  {
    const faviconSource = await recolor(sources.iconBold, COLORS.black)
    results.push(
      await writePng(faviconSource, `C:/Users/Ismar/bloom-house/public/favicon.png`, {
        maxWidth: 256,
      }),
    )
    results.push(
      await writePng(
        faviconSource,
        `C:/Users/Ismar/thebloomhouse-website/public/favicon.png`,
        { maxWidth: 256 },
      ),
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

  // 3b. TBH stamp — the thumbprint + "T B H" vertical letters +
  //     thebloomhouse.ai URL composite from source 3.png. Used as a
  //     sub-brand mark on TBH Reports + TBH Score surfaces. NOT the
  //     same as icon-* (which is the bare thumbprint).
  for (const colorName of Object.keys(COLORS)) {
    const recolored = await recolor(sources.tbhStamp, COLORS[colorName])
    results.push(
      await writePng(
        recolored,
        `${REPOS.bloomHouse}/tbh-stamp-${colorName}.png`,
        { maxWidth: 512 },
      ),
    )
    results.push(
      await writePng(
        recolored,
        `${REPOS.website}/tbh-stamp-${colorName}.png`,
        { maxWidth: 512 },
      ),
    )
  }

  // 4. OG image — 1200×630 with the sage vertical lockup centered on
  //    warm-white. Used as the social-card preview when the website
  //    is shared on Twitter/LinkedIn/iMessage. Pure composite, no
  //    extra text overlay needed (the lockup already includes the
  //    URL + tagline).
  {
    const sageVerticalRecolored = await recolor(
      sources.vertical,
      COLORS.sage,
    )
    // Convert raw → PNG buffer for compositing.
    const sageVerticalPng = await sharp(sageVerticalRecolored.buffer, {
      raw: {
        width: sageVerticalRecolored.width,
        height: sageVerticalRecolored.height,
        channels: 4,
      },
    })
      .resize({ height: 500, fit: 'inside' })
      .png()
      .toBuffer()

    const ogImage = await sharp({
      create: {
        width: 1200,
        height: 630,
        channels: 4,
        background: { r: 0xfd, g: 0xfa, b: 0xf6, alpha: 1 }, // warm-white
      },
    })
      .composite([{ input: sageVerticalPng, gravity: 'center' }])
      .png({ compressionLevel: 9 })
      .toBuffer()

    for (const dest of [
      `${REPOS.bloomHouse}/og-image.png`,
      `${REPOS.website}/og-image.png`,
    ]) {
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.writeFile(dest, ogImage)
      const stat = await fs.stat(dest)
      results.push({ path: dest, bytes: stat.size })
    }
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
