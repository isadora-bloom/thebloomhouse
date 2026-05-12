# State-change cascades

Pattern 2 from `BLOOM-PATTERNS-ZOOM-OUT.md`. Each cascade is the
"downstream effects" half of a state change. Same shape as
`src/lib/services/identity/cascade-on-enrichment.ts`:

- Fire-and-forget — never throws, errors go into the result + structured log
- Idempotent — safe to re-run
- Bounded latency — callers `void` the promise on hot paths

## Cascades

| Trigger | File | Fires from |
|---|---|---|
| Pricing changed | `on-pricing-change.ts` | `POST /api/onboarding/pricing-history` |
| AI personality changed | `on-personality-change.ts` | (TODO: wire from settings/personality save) |
| Marketing spend imported | `on-spend-import.ts` | `marketing-spend/ingest.ts` |
| Wedding marked lost | `on-lost-mark.ts` | trigger 307 + JS-side override route |
| Vendor added | `on-vendor-added.ts` | (stub — venue vendor table not consolidated) |
| New inquiry arrived | `on-new-inquiry.ts` | `email/pipeline.ts` post-INSERT |

## Wiring contract

```ts
void (async () => {
  try {
    const mod = await import('@/lib/services/cascades/on-pricing-change')
    await mod.triggerPricingCascade({ venueId, effectiveDate, supabase })
  } catch (err) {
    console.warn('[cascade/pricing] non-fatal:', err)
  }
})()
```

Dynamic import avoids circular deps. `console.warn` (not throw) keeps the
parent operation green.
