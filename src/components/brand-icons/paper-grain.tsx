/**
 * Paper-grain texture overlay.
 *
 * A subtle SVG noise pattern at low opacity that makes any surface
 * read as "printed on something" rather than "rendered on a screen."
 * The visual difference is small per-pixel but the cumulative effect
 * is the single biggest tell separating editorial brand work from
 * AI-built UIs.
 *
 * Drop inside any element with a defined width/height. Positioned
 * absolute so it composites over whatever's underneath without
 * affecting layout. Uses feTurbulence for procedural noise — no
 * raster asset to ship.
 *
 * Usage:
 *   <div className="relative">
 *     ...
 *     <PaperGrain />
 *   </div>
 *
 * Or for a stronger / weaker effect:
 *   <PaperGrain opacity={0.04} />  // subtle
 *   <PaperGrain opacity={0.10} />  // stronger
 */

interface PaperGrainProps {
  /** 0-1. Default 0.06 — enough to feel textured, not enough to compete with content. */
  opacity?: number
  /** Pattern scale; lower = finer grain. Default 0.85. */
  scale?: number
  className?: string
}

export function PaperGrain({
  opacity = 0.06,
  scale = 0.85,
  className = '',
}: PaperGrainProps) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-0 ${className}`}
      style={{ opacity }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="100%"
        height="100%"
        preserveAspectRatio="none"
      >
        <filter id="paperGrainNoise">
          <feTurbulence
            type="fractalNoise"
            baseFrequency={scale}
            numOctaves="2"
            stitchTiles="stitch"
          />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0.7 0"
          />
        </filter>
        <rect width="100%" height="100%" filter="url(#paperGrainNoise)" />
      </svg>
    </div>
  )
}
