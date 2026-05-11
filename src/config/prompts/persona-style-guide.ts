/**
 * Bloom House — shared persona / archetype style guide.
 *
 * Anchor docs:
 *   - PROMPT-BIAS-AUDIT.md (Wave 21) — "the persona-label anchoring cascade
 *     (couple-intel-derive → cohort-rollup → alumni-cohort → venue-thesis)
 *     is a single bug in four places. Recommend a shared persona-style-
 *     guide constant that EVERY persona-producing prompt imports, where
 *     the guide is shape-only ('2-4 words, evocative, grounded in cohort
 *     data') with zero specific examples."
 *   - feedback_measure_dont_assume.md — frame the system's job as MEASURE,
 *     not VALIDATE. The persona/archetype IS the measurement; pre-listing
 *     specific labels in the prompt biases the answer.
 *
 * What this constant does
 * -----------------------
 * Wave 22 patches the four persona-producing prompts to import a SHAPE-
 * ONLY style guide. The guide tells the LLM HOW the label should look
 * (length, register, grounded-ness) without telling it WHICH labels to
 * choose. This removes the priming cascade where "Heritage-Forward
 * Planner" and friends were re-appearing across surfaces because each
 * prompt's example list anchored to the same handful of names.
 *
 * Importers
 * ---------
 *   - couple-intel-derive.ts   (Wave 5A — per-couple persona)
 *   - cohort-rollup.ts          (Wave 5B — cohort voice_calibration)
 *   - alumni-cohort.ts          (Wave 14 — booked-couple archetypes)
 *   - venue-thesis.ts           (Wave 5D — venue archetype)
 *
 * Do NOT add specific persona / archetype example strings here. The
 * point of this file is the absence of examples. If a downstream consumer
 * needs example shapes for a UI placeholder, hard-code those in the UI,
 * not in the prompt.
 */

export const PERSONA_STYLE_GUIDE = `PERSONA / ARCHETYPE STYLE GUIDE (shape only)

- Length: 2-4 words. Evocative, not generic.
- Source: DISCOVERED from this couple's (or cohort's) signals — NOT
  picked from a pre-defined list. There is no enum. Two couples in
  similar circumstances may converge to similar labels; that's correct.
  Two couples in different circumstances should diverge — do not force
  uniformity.
- Register: capture the ARCHETYPE, not the demographic. Avoid labels
  that are just identity descriptors (age range / income bracket /
  ethnicity). Aim for what makes the couple's decision-making distinct.
- Domain language: use wedding-industry / venue-context vocabulary. Not
  generic CRM segment labels ("Premium Tier", "Value Customer"). The
  output reads to a venue coordinator, not a B2B SaaS analyst.
- No examples on purpose: this guide deliberately does not list
  candidate labels. Past iterations of these prompts shipped 5-8 example
  labels which the model then disproportionately reproduced in output.
  Let the data drive.
- Refusal: if signals are too thin to discover a label (single-couple
  evidence, contradictory themes, empty profile), refuse rather than
  fabricate. The refusal IS the signal.`
