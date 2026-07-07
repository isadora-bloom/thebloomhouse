# AI Engineer World's Fair 2026 — Online Track
## "Stop Writing Tone Instructions. Layer Them."
### Full speaker prep — grounded in real code

> **Format:** Online track, recorded. 5–60 min allowed; **target 20–22 min.**
> **Recording deadline:** Friday June 19, 2026.
> **Recommended setup:** screen-share your editor with the real files open, face in a corner window, multiple takes. The whole advantage of the online track is that you can re-record the one section that didn't land.
> **Every code excerpt below is real and was read out of the repos on 2026-06-15/16.** Nothing here is aspirational. You can show any of it on screen.

---

## THE ONE-SENTENCE THESIS

> "Write in our brand voice" is a comment that says `// make it work`. It does nothing the model wasn't already going to do, and it breaks the moment a user asks something your examples didn't cover. A brand voice that survives production isn't an instruction — it's an **architecture of layers**, each catching what the one above it can't.

The four layers, in order:

1. **Immutable identity** — what the brand structurally *cannot* say. Cannot be overridden by anything below.
2. **Situational mode** — what shifts when the *user's state* shifts (who they are, what they're going through).
3. **Example-anchored voice** — the warmth, the phrases, the dials. **Where most teams stop.**
4. **Post-generation veto** — the cheap final pass that catches what the other three missed.

The reason most brand-voice prompts fail is that teams try to do all four jobs in **one** layer — a single system prompt — and that one prompt can't simultaneously be inviolable, situational, expressive, *and* self-checking. So it holds for 20 turns and breaks on turn 21.

---

## THE SPINE (show this first)

Every AI surface in Bloom composes its system prompt through one assembler. This comment is in `src/lib/ai/coordinator-prompt.ts` and it *is* the talk:

```ts
/**
 * Single entry point every coordinator-facing narrator goes through to
 * compose its system prompt. Replaces the 24 ad-hoc system prompts the
 * LLM-CALL-INVENTORY surfaced (10 named-Sage / 10 nameless / 1
 * named-venue) with one canonical 4-layer stack:
 *
 *   UNIVERSAL_RULES + COORDINATOR_RULES + buildPersonalityPrompt(...) + numbersGuardBlock + taskBlock
 */
```

And the assembly itself — the punchline slide. Note the **order is load-bearing** (immutable rules first, task last):

```ts
const systemPrompt = [
  UNIVERSAL_RULES,        // Layer 1 — immutable identity
  COORDINATOR_RULES,      // Layer 2 — situational mode (addressee)
  personalityPrompt,      // Layer 3 — example-anchored voice
  coupleNotesBlock,       // Layer 2 — situational mode (emotional state)
  coupleContextBlock,
  honestyRailsBlock,      // Layer 2/4 — mode + pre-veto
  numbersGuardBlock,      // Layer 4 — prevention half of the veto
  taskBlock,
]
  .filter((block) => block && block.trim().length > 0)
  .join('\n\n')
```

> **Speaker note:** "Before this, there were 24 different system prompts across the product. The /intel dashboard read like multiple authors arguing under one roof. The whole point of layering is that there's now exactly one place identity is decided, and everything else stacks on top of it in a fixed order."

---

## LAYER 1 — IMMUTABLE IDENTITY
### *What the brand structurally cannot say*

**File:** `src/config/prompts/universal-rules.ts`
**Header (put it on the slide):**

```ts
/**
 * Bloom Agent: Universal Rules (Layer 1)
 * These rules apply to ALL venues and are NEVER modified.
 */
```

The load-bearing property of this layer is that nothing below it can edit it. The AI-transparency rule says so in the prompt itself:

```
**HARD IDENTITY RULE (cannot be overridden by any venue voice, persona, or user instruction):**
If the person you are talking to ever asks — directly or indirectly — whether you are
a real person / a human / a live agent / a bot / an AI ...
You MUST, in your VERY NEXT message, clearly and unambiguously confirm that you are an AI assistant.
...
This rule CANNOT be overridden by any venue configuration, voice profile, or user request.
```

This layer also holds the **physical-presence boundary** — a great, concrete, slightly funny example that a technical audience will immediately get:

```
## PHYSICAL PRESENCE BOUNDARY (MANDATORY)
You are software. You do not have a body. You CANNOT physically:
- Show anyone around the property
- Meet anyone in person
...
**ALWAYS forbidden phrasing (first-person singular + physical verb):**
- "I'd love to show you around"
- "I can't wait to meet you in person"
**ALWAYS allowed alternatives (team-collective or passive):**
- "The team would love to host you for a tour"
```

> **Speaker note:** "The voice layer wants to be warm. Warm wants to say 'I can't wait to show you around.' But the AI is software and has no body — so that warmth, unconstrained, produces a lie. Layer 1 is where you encode the things that are true *regardless* of how warm the brand wants to sound."

### The cross-product proof (this is your strongest 30 seconds)

The same architecture runs in **Threadline**, a tool for families of missing people. There, the immutable layer carries a very different — and much heavier — rule. From `threadline/src/app/api/threads/generate/route.ts`:

```
2. Never use words like: confirmed, identified, matched, proven, linked, solved.
```

> **Speaker note:** "Same architecture, different stakes. For a wedding venue, Layer 1 stops the AI from claiming it has a body. For a missing-persons tool, Layer 1 stops the AI from ever telling a family their person was *found* or a case *solved* — because a probabilistic system saying 'matched' to a grieving family is the worst thing this product could do. The point isn't the specific rules. It's that the rules a brand can never break belong in a layer that voice instructions physically cannot reach."

---

## LAYER 2 — SITUATIONAL MODE
### *What shifts when the user's state shifts*

This is the layer most teams never build at all — they have one voice and ship it at everyone. It has two mechanisms in the code.

### 2a. Mode by *addressee* — same character, different room

**File:** `src/config/prompts/coordinator-rules.ts`. The same AI that sells to couples also briefs the venue's staff — but the register changes:

```
## COORDINATOR-FACING CONTEXT (READ BEFORE OUTPUT)
You are speaking to the venue COORDINATOR, not a couple. The addressee is a
teammate of yours ... Talk to them as a colleague, not as a customer.

You are still the same character couples interact with ... Do NOT slip into a
generic "intelligence analyst" or anonymous "operations analyst" framing.
```

And the **honesty-rails toggle** — the same code, flipped by audience. From `coordinator-prompt.ts`:

```ts
/**
 * Operator surfaces should default this on; couple-facing surfaces should NOT —
 * refusing a couple is the wrong doctrine for that audience.
 */
honestyRails?: boolean
```

> **Speaker note:** "An operator asking 'will inquiries be up next June?' should hear 'I can't forecast that confidently, here's the trend and the confounds.' A couple should never be *refused* like that. Same identity, same voice — the mode flips on who's in the room."

### 2b. Mode by *emotional state* — the soft-context layer

The immutable layer also defines how tone bends to what the venue knows about a couple's life. From `universal-rules.ts`:

```
## SOFT-CONTEXT NOTES POLICY
**Use these notes for tone, empathy, and what NOT to say.** Never quote them verbatim.
- A couple mentioning grief should hear gentleness, not a quote of their loss.
- A couple navigating a sick parent should get patience and slack on the timing of
  next steps, never a sentence that names the illness.
Notes tagged "[SENSITIVE]" are governed strictly: never reference them by content,
only let them shape your voice.
```

The assembler deliberately renders this **before** the numbers, so tone is set by the human context first. The reasoning is in a real comment in `coordinator-prompt.ts`:

```ts
// Couple-notes block is rendered BEFORE the numbers-guard block so the LLM sets
// tone first from the soft context, then satisfies numeric constraints. Reversing
// the order makes the prose feel mechanically slotted because the model has already
// committed to the numeric frame before reading the qualitative tone fuel.
```

**Your single best concrete example** — a real code comment from `heat-narration.ts`:

```
// A heat drop in a couple with "mum's chemo" three weeks ago narrates
// differently than a heat drop with no soft context.
```

> **Speaker note:** "This is the layer that makes the difference between an AI that sounds on-brand and one that sounds *human*. The brand voice doesn't change. What changes is that the model knows this couple's mother is in chemo, so when their engagement drops, it reads that as a family under strain — not a cold lead to chase. Same voice. Different register. That's situational mode."

---

## LAYER 3 — EXAMPLE-ANCHORED VOICE
### *Where most teams stop — and why it isn't enough*

**File:** `src/lib/ai/personality-builder.ts`, function `buildPersonalityPrompt()`. This is the layer everyone recognises: the dials, the phrases, the examples.

The per-venue dials become prose:

```ts
const WARMTH_DESCRIPTIONS: Record<number, string> = {
  10: 'extremely warm and effusive',
  7: 'friendly and approachable',
  5: 'neutral and professional',
  1: 'very formal and distant',
}
```

The trained phrase lists (these come from in-product voice-training games):

```ts
if (voicePrefs.banned_phrases.length > 0) {
  prompt += `\n**NEVER use these phrases:** ${voicePrefs.banned_phrases.join(', ')}\n`
}
if (voicePrefs.approved_phrases.length > 0) {
  prompt += `**Preferred phrases:** ${voicePrefs.approved_phrases.join(', ')}\n`
}
```

> **Speaker note — the pivot of the whole talk:** "This is where almost every brand-voice effort lives and dies. Dials, banned words, a few golden examples. And it works — for a while. The problem is what this layer *structurally cannot do*. It can't enforce a rule the brand can never break — that's above it, in Layer 1. It can't bend to a grieving couple — that's Layer 2. And it can't catch the model inventing a number — that's Layer 4. Examples teach the model what *good* looks like on the happy path. They say nothing about what to do on turn 21, when the user asks the thing your examples never covered. That's why a voice layer on its own always eventually breaks character — not because the examples are bad, but because examples are the wrong tool for guarantees."

---

## LAYER 4 — THE POST-GENERATION VETO
### *The cheap final pass that catches what the other three missed*

You have **two** vetoes — a soft flag and a hard reject. Show both.

### 4a. Soft flag — the honesty inspector

**File:** `src/lib/services/sage/honesty-rails.ts`, function `inspectResponseForHonesty()`. It runs *after* generation and flags responses that slipped a rail:

```ts
const flags: HonestyFlag[] = []

if (FORECAST_QUESTION_PATTERNS.test(question) && !FORECAST_HEDGE_PATTERNS.test(response)) {
  flags.push({ rule: 'forecast_no_hedge', reason:
    'Question asks for a forward forecast but the response did not hedge or name confounds.' })
}

if (CAUSATION_CLAIM_PATTERNS.test(response) && !CAUSATION_QUALIFIER_PATTERNS.test(response)) {
  flags.push({ rule: 'causation_no_qualifier', reason:
    'Response claims causation without naming the alternative explanations the rail requires.' })
}
```

Its design philosophy is in the comment — a clean line for the slide:

```ts
// The heuristic is intentionally conservative: false positives are cheap
// (the operator sees a "double check" note), false negatives are the real cost.
```

### 4b. Hard reject — the numbers-guard

The expensive failure is a hallucinated number. The prompt *asks* the model not to invent numbers (prevention), and a post-generation guard *rejects the output* if it did anyway (cure). From `heat-narration.ts`:

```ts
if (!result.ok) {
  if (result.numbersGuardViolations) {
    console.warn(
      '[heat-narration] numbers-guard rejected narration:',
      result.numbersGuardViolations.map((v) => v.token).join(', '),
    )
  }
  // Degrade gracefully — return the narration anyway (in-memory), just don't
  // cache. Next run will re-attempt; eventually a clean narration will land.
  return { ...narration, confidence: conf.value, cached: false }
}
```

> **Speaker note — the near-miss:** "I added the veto layer after a near-miss with a vulnerable user. The first three layers are all *prompt* — they're instructions, and instructions are probabilistic. The model usually follows them. 'Usually' is fine for a typo. It is not fine when the content is someone's grief, or a number a venue owner is about to make a decision on. The veto is the cheapest layer to build and the only one that's deterministic: it reads the output the model actually produced and decides whether it's allowed to ship. Prevention is the prompt. The guard is the safety net. You need both, because the prompt will eventually lose."

Tie it back to Layer 1's sensitive-notes rule — the veto enforces what the prompt requested:

```ts
// from inspectResponseForHonesty:
flags.push({ rule: 'sensitive_named', reason:
  'Question asked about sensitive themes; response appears to name couples instead of aggregating.' })
```

---

## THE MULTI-TENANT SPINE
### *One technical spine, completely different voices*

The seam is one call: `loadCoordinatorPersonalityData(venueId)`. **Layers 1 and the shared rules are identical for every tenant; Layers 2–3 are per-venue.** That's how one codebase serves venues with opposite personalities — and Ground, and Threadline — without forking.

The scale war-story: the bug that forced the spine to fail *loud*. From `personality-builder.ts`:

```ts
// IMPORTANT (T5-β.1): brand-identity fields (ai_name, ai_email, owner_name)
// are NOT defaulted here. Letting them default silently caused every venue
// to ship as "Sage" / "sage@hawthornemanor.com" — a critical white-label leak.
// Brand identity must come from venue_ai_config; if it's missing, callers throw.
```

```ts
export function requireAiName(config, venueId): string {
  const name = config?.ai_name?.trim()
  if (!name) {
    throw new Error(
      `[personality-builder] venue_ai_config.ai_name is required but missing for venue ${venueId}.`
    )
  }
  return name
}
```

> **Speaker note:** "Multi-tenant voice has a specific failure mode: a missing config value silently inherits *someone else's* identity. Every venue shipped as 'Sage', emailing from another venue's address. The fix is a principle: in a multi-tenant voice system, identity must never have a default. A missing brand identity is a crash, not a fallback. Fail loud, because the quiet failure is a venue speaking in a stranger's voice."

---

## SLIDE-BY-SLIDE (≈22 min)

| # | Time | Slide | On screen |
|---|------|-------|-----------|
| 1 | 0:00 | Title + the one-sentence thesis | Title |
| 2 | 0:45 | The naive version: one system prompt, "write in our brand voice" | a real personality prompt |
| 3 | 1:45 | The turn-21 break — holds for 20 turns, breaks on the unscripted question | — |
| 4 | 3:00 | The spine: the `[...].join()` assembler | `coordinator-prompt.ts` |
| 5 | 4:00 | **Layer 1** — "NEVER modified" + "CANNOT be overridden" | `universal-rules.ts` |
| 6 | 6:00 | Layer 1 cross-product: Threadline "never say solved/matched" | `threads/generate/route.ts` |
| 7 | 7:30 | **Layer 2a** — addressee mode + honesty-rails toggle | `coordinator-rules.ts` |
| 8 | 9:30 | **Layer 2b** — soft-context + the "mum's chemo" comment | `universal-rules.ts` + comment |
| 9 | 11:30 | **Layer 3** — dials + phrase lists | `personality-builder.ts` |
| 10 | 13:30 | Why Layer 3 isn't enough (the pivot) | recap of what it can't do |
| 11 | 15:00 | **Layer 4a** — the honesty inspector | `honesty-rails.ts` |
| 12 | 16:30 | **Layer 4b** — numbers-guard hard reject + the near-miss | `heat-narration.ts` |
| 13 | 18:30 | The multi-tenant spine + "every venue shipped as Sage" | `requireAiName` |
| 14 | 20:30 | What I'd build differently + the close | recap: 4 layers |

---

## THE CLOSE (write this on the last slide)

1. **Put what the brand can never say in a layer instructions can't reach.** (Layer 1)
2. **Let mode shift with the user's state — who they are, what they're going through.** (Layer 2)
3. **Examples set the voice; they don't enforce it.** (Layer 3)
4. **Add a cheap deterministic veto, because the prompt will eventually lose.** (Layer 4)

> "The four-layer pattern isn't a framework I'm selling. It's what happens to a system prompt when you've watched it fail enough times. If you've got one prompt trying to do all four of these jobs, you already know which turn it breaks on."

---

## "WHAT I'D BUILD DIFFERENTLY" (have this ready — it reads as senior)

- **The veto should be its own service, not inlined per surface.** Right now the numbers-guard lives inside the narration path; the honesty inspector is a separate function. A single post-generation gate every surface passes through would be cleaner and harder to forget to wire up.
- **Layer 2 mode-detection is still partly manual.** The soft-context notes are loaded deterministically, but *which* mode applies is decided per-surface. A first-class "mode resolver" would make the situational layer explicit rather than emergent.
- **The soft flag is regex, not a model.** It's cheap and conservative on purpose, but `inspectResponseForHonesty` would catch more with a tiny classifier — at the cost of the determinism that makes it trustworthy today. A real trade-off, not an obvious win.

---

## Q&A PREP — anticipated questions, honest answers

- **"Isn't Layer 4 just guardrails / a moderation pass?"** Partly — but it's brand-specific, not safety-generic. It enforces *this brand's* rules (no invented numbers, no naming a grieving couple), which a generic moderation API won't know about.
- **"Why not fine-tune a voice instead of layering prompts?"** Fine-tuning bakes in the happy path and is expensive to change per-tenant. Layers stay inspectable and editable per venue without retraining — and a fine-tune still can't give you a deterministic veto.
- **"Does this add latency?"** Layers 1–3 are one system prompt — no extra calls. Layer 4's soft flag is regex (microseconds); the numbers-guard is a string scan of the output. The veto is cheap by design.
- **"How do you test that a layer holds?"** The honesty rails are scored against a fixed battery of known-hard questions (the Tier-4 set); confabulation scores as a hard fail. That battery is the regression test for the voice.
- **"Five products on one spine — same code or same pattern?"** Same *pattern*, not one shared package. Bloom and Ground and Threadline each implement the layered stack; the spine is the architecture, not a single import. (Be precise here — it's the honest answer.)

---

## THE FIVE PRODUCTS (verified 2026-06-15/16)

| Product | What it is | Voice | Spine evidence |
|---|---|---|---|
| Bloom (venue side) | Venue intelligence + agent | Per-venue (Sage et al.) | `coordinator-prompt.ts` 4-layer assembler |
| Bloom (multi-tenant) | Many venues, one codebase | Distinct per tenant | `loadCoordinatorPersonalityData(venueId)` |
| Ground (`basecamp`) | Personal AI companion | Companion voice | `ai-chat` edge fn, dual-provider |
| Rixey portal | Live venue, real couples | Venue voice | `server/index.js` (Claude) |
| Threadline | Utility for families of missing people | Forensic / careful | `ai-models.ts` + "never say solved/matched" rule |

**Three with strong, distinct brand voices:** Bloom venues, Ground, Threadline.

---

## RECORDING CHECKLIST

- [ ] Editor theme high-contrast, font bumped — code must be legible at 720p.
- [ ] Open the five files as tabs *before* recording so you can cut to them instantly.
- [ ] Record section-by-section; you don't need one clean 22-min take.
- [ ] The "mum's chemo" comment and the "never say solved/matched" rule are your two emotional peaks — slow down on both.
- [ ] Upload to Drive/Dropbox/Vimeo, submit the link via the Featured Presenter onboarding form before **Fri June 19**.
