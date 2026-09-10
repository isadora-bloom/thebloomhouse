# Handle identity spec (wave 3, 2026-09-09)

Why: the spine is sound, and social was bolted on beside it instead of into it. A follower,
a story viewer or a DM sender arrives as a handle, and a handle could not exist on the spine.
This spec makes the handle a first-class identifier and makes every social path use the one
writer. Subordinate to IDENTITY-FIRST-ARCHITECTURE.md and the constitution.

## 1. The identifier

- A handle is `(platform, handle)`. Never a bare string. `HandlePlatform` in
  `src/lib/services/identity/sources/types.ts` is the closed list.
- Normalised by `normalizeHandle()` in `src/lib/services/identity/handles.ts`: lower case,
  no leading `@`, profile URL reduced to its path segment, platform shape enforced, junk
  becomes null. Every adapter normalises before it hands a signal to the linker.
- Stored on `couples.handles` and `fragments.handles` (migration 398). `people.platform_handles`
  is legacy and stops being written; readers move to `couples.handles`.

## 2. Matching

- New cascade stage `handle_exact`: same platform, same normalised handle, one couple
  (excluding merged-away). Tier high. Sits after `exact_email` and the marketplace person ids,
  before `exact_full_name`. A handle match is deterministic evidence and beats a name score.
- Contradiction guard applies as before. A handle match with a strong-email contradiction
  demotes to the review queue, never fuses.
- Display name from a followers list is `primary_name` at tier low. It can corroborate, it
  cannot attach alone. Trigram similarity and "email local part contains handle" are removed
  as auto-bind paths. They may survive only as candidate-queue suggestions with a score.
- Fragment promotion: when a signal attaches to or mints a couple and carries handles, every
  unpromoted fragment in the venue with the same `(platform, handle)` is promoted onto that
  couple and its touchpoints re-anchored. Deterministic, no judge.

## 3. Time

- `first_seen_at`: earliest touchpoint on the couple, any channel. A handle-only signal sets
  it. Set once by the linker; a replay may move it earlier, never later.
- `point_zero_at`: unchanged. Name plus reachable address, inbound only, set once. A handle
  is not reachable. `first_seen_at <= point_zero_at` is an invariant the audit checks.
- The ribbon reads: first seen (as what, where), discovery touchpoints, point zero, then the
  known-couple history.

## 4. Sources

Every social path routes through `linkSignal`. No source binds to `people` directly.

| Source | Signal shape |
|---|---|
| Followers / story views / DM list paste or screenshot | one signal per handle: channel = platform, action_type = metric (`follow`, `story_view`, `dm`, `comment`, `tag`), `handles` set, `primary_name` = display name if shown, `occurred_at` back-derived from the relative age, `external_id` = `social:{platform}:{metric}:{handle}:{capture_date}` |
| Screenshot vision of comments and tags (tangential) | same shape; `tangential_signals` and `client_match_queue` retire in favour of `fragments` and `candidate_matches` |
| Inquiry form, calculator, Calendly "your Instagram" question | `handles` on the inquiry signal, so the join is made by the person, not inferred |
| Email signature and body | `handles` extracted by the existing identity extraction (LLM path), plus a deterministic parse of `instagram.com/<x>` style profile URLs only. No regex over prose. |
| Instagram DMs via Meta Messaging API | same pipeline as SMS: one inbound signal per message, `handles.instagram` set, text goes to the classifier. Env-gated; dry until credentials exist. |

## 5. What is deleted

`social/match-engagements.ts` auto-bind fallbacks; the social branch of `orphan-promote.ts`;
`tangential_signals` writers; `client_match_queue` writers; the fragment coalesce in
`tracer.ts` moves to a named `fragment-sweep.ts` under the linker and `tracer.ts` goes.

## 6. Ratchets

`check-cascade-only-writer` already guards the spine. Add: no new reads of
`people.platform_handles` (baseline written by W22), and `check-no-direct-people-insert`
unchanged.
