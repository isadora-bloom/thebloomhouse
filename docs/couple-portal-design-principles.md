# Couple portal design principles

**Date:** 2026-05-08
**Owner:** Isadora Martin-Dye

The "weeknight 9pm couch" bar from A5. Three rules that govern every
couple-portal surface. New work passes these or it does not ship.

---

## 1. One-tap reach from What's Next

Every primary action a couple cares about must be reachable in one
tap from `/whats-next`. Today the page surfaces:

- Overdue checklist item -> /checklist
- Next due item -> /checklist
- Next payment -> /budget
- Recent venue message -> /messages
- Day-of view (in final week) -> /day-of

If a new feature surfaces a primary action (RSVP deadline, contract
needs signing, etc.), it gets a card on `/whats-next`. Secondary
actions stay on their respective pages but are NOT considered
"primary."

A primary action is one that has a deadline, a money implication, or
an unread venue communication. Browsing inspiration, looking at the
guest list, picking colors are not primary.

## 2. No more than two-line paragraphs in default view

Couples on the couch at 9pm do not read three-line paragraphs. They
scan. Default-view body copy on every page caps at 2 lines. Long
form (vendor contract, AI-generated explanation, terms) lives behind
an explicit "Read more" or expansion.

This applies to:

- Dashboard stat-card subtitles
- Empty-state copy
- Section subtitles in the sidebar
- Onboarding cards
- Help/info copy on settings pages

It does NOT apply to:

- Sage chat (conversational by nature)
- Couple-typed content (they wrote it; they decide length)
- Vendor profile body copy (sourced from the vendor)
- Educational reference docs (long-form by design)

## 3. Animations under 150ms

Tailwind's default `transition` duration is 150ms; most things are
already compliant. The exceptions to audit:

- `animate-pulse` on skeleton loaders -> Tailwind default 2s, intentional
- `animate-spin` on loaders -> Tailwind default 1s, intentional
- Any custom transition specifying `duration-200`, `duration-300`,
  `duration-500`, etc. -> review

Specifically banned:

- Page-transition fades > 200ms
- Modal-open animations > 200ms
- Hover-color shifts > 150ms
- Drag-drop feedback animations > 150ms (can feel sluggish)

Permitted longer-duration animations (with reason):

- Skeleton pulse (intentionally slow)
- Confetti / celebration moments (one-time, < 1.5s)
- Loading spinners (rotation, irrelevant to perceived speed)

---

## How this gets enforced

- New PRs that touch couple-portal pages should reference these rules
  in the description.
- Round-N verification audits will spot-check against these rules.
- A real coordinator-couple-walkthrough every quarter is the ultimate
  test.

## Surfaces audited 2026-05-08 against these rules

When this doc was committed, the recently-touched couple surfaces
were swept:

| Surface | One-tap | <=2-line copy | <150ms anim |
|---|---|---|---|
| `/whats-next` | n/a (it IS the source) | yes | yes |
| `/login` | irrelevant (pre-auth) | yes | yes (skeleton intentional) |
| `/checklist` | yes (linked from whats-next) | yes | yes |
| `/day-of` | yes (linked when in window) | yes | yes |
| Sidebar "What's next" link | yes | n/a | yes |
| AssignedToPicker popup | yes (one-click pick) | yes | yes |

Older surfaces that may not yet pass these rules are tracked as
follow-up audit items in the launch plan.
