/**
 * Pipeline-stage simulator harness (OPS-21.1.1-B).
 *
 * Per Playbook OPS-21.1.1-B: "every pipeline stage unit-tested +
 * handoff tests with a per-stage simulateInput / assertOutput interface."
 *
 * Pre-this-file the only pipeline tests were Playwright e2e (slow,
 * required full Supabase + Gmail OAuth) and inline TypeScript scripts
 * that each redeclared their own setup harness. This module provides
 * the missing primitive: a typed simulator that takes a stage input,
 * runs the stage in isolation, and lets the caller assert on the
 * output.
 *
 * Stages currently supported (extend as more pure stages are isolated):
 *   - normalize-source: classifier output + raw email → canonical source
 *   - signal-inference: interaction body → engagement_events list
 *   - heat-mapping:     engagement_events → composite heat score
 *   - bloom-number:     wedding row → formatted client code
 *
 * Usage:
 *   import { simulateStage, assertEqDeep } from './stage-simulator'
 *   const out = simulateStage('normalize-source', { rawSource: 'instagram_dm', classifierOutput: { source: 'instagram' } })
 *   assertEqDeep(out, 'instagram', 'instagram_dm should normalize to instagram')
 */

export interface StageRunContext {
  /** Wall-clock at simulation. Stage may use this for date math. */
  now: Date
}

export type StageInput = Record<string, unknown>
export type StageOutput = unknown

/**
 * Stage registry. Each entry is a pure function: (input, ctx) → output.
 * Adding a stage requires NO test-runner change — drop it in the map
 * and the harness picks it up.
 */
export interface StageHandler<I extends StageInput = StageInput, O = unknown> {
  (input: I, ctx: StageRunContext): O | Promise<O>
}

const STAGE_REGISTRY: Record<string, StageHandler> = {}

export function registerStage<I extends StageInput, O>(name: string, handler: StageHandler<I, O>): void {
  STAGE_REGISTRY[name] = handler as StageHandler
}

export async function simulateStage<O = unknown>(
  name: string,
  input: StageInput,
  ctx: Partial<StageRunContext> = {},
): Promise<O> {
  const handler = STAGE_REGISTRY[name]
  if (!handler) {
    throw new Error(`Unknown stage '${name}'. Did you forget to registerStage()?`)
  }
  const fullCtx: StageRunContext = { now: ctx.now ?? new Date() }
  return (await handler(input, fullCtx)) as O
}

/** Deep-equal assertion that prints the diff on failure. */
export function assertEqDeep(actual: unknown, expected: unknown, label: string): boolean {
  const a = JSON.stringify(actual, null, 2)
  const e = JSON.stringify(expected, null, 2)
  if (a === e) {
    console.log(`  ✓ ${label}`)
    return true
  }
  console.error(`  ✗ ${label}`)
  console.error(`    actual:   ${a}`)
  console.error(`    expected: ${e}`)
  return false
}

/** Sample handoff assertion: stage A's output must match stage B's
 *  expected input shape. The harness doesn't enforce types at runtime
 *  (TypeScript does that statically), but it CAN check key presence. */
export function assertHandoffShape(
  upstreamOutput: unknown,
  downstreamRequiredKeys: string[],
  label: string,
): boolean {
  if (!upstreamOutput || typeof upstreamOutput !== 'object') {
    console.error(`  ✗ ${label} — upstream output is not an object`)
    return false
  }
  const obj = upstreamOutput as Record<string, unknown>
  const missing = downstreamRequiredKeys.filter((k) => !(k in obj))
  if (missing.length > 0) {
    console.error(`  ✗ ${label} — downstream needs keys: ${missing.join(', ')}`)
    return false
  }
  console.log(`  ✓ ${label}`)
  return true
}

// Test-only re-exports for harness's own self-test.
export const __test__ = {
  STAGE_REGISTRY,
  reset(): void {
    for (const k of Object.keys(STAGE_REGISTRY)) delete STAGE_REGISTRY[k]
  },
}
