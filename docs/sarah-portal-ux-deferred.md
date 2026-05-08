# Sarah-portal UX items needing design input

**Date:** 2026-05-08
**Owner:** Isadora Martin-Dye
**Status:** code-side closed; design + copy decisions needed before shipping

---

The launch-plan bucket-3 (Sarah-portal long-tail UX) had 15 items. 5
shipped this session as concrete code fixes. The remaining 10 need
either a design call from you, copy you write, or live testing on a
real device + couple before they're worth coding.

This doc lists each one with what specifically I need from you to
unblock it.

---

## Already shipped this session

- ✓ **#187** Login screen branding flicker — skeleton in logo + name slots until `branding` loads.
- ✓ **#188 / #190** "After the Day" + Day-of Memories pre-wedding hide — sidebar section gated to `daysUntilWedding <= 0`. Direct URL still resolves with friendly empty-state.
- ✓ **#191** Multi-user assigned_to UX — `prompt()` replaced with `AssignedToPicker` (7 quick-pick roles + custom + unassign + click-out commit).
- ✓ **#197** Bookmark-able "what's next" landing — `/couple/[slug]/whats-next` surfaces overdue checklist + next item + next payment + recent venue message + day-of link, ranked by urgency.
- ✓ **#200** Couple-photo upload simplification — verified the existing path already supports drag-drop alongside the file picker. Closed.

---

## Needs design / copy from Isadora

### #189 — Final Review 42-day badge redesign

**Current:** sidebar shows `42d` next to Final Review when wedding is 1-42 days away.

**Audit feedback:** "Confusing badge."

**Why I didn't ship a fix:** the right answer is a design call. Options:
- `T-42` (countdown, technical)
- `42d to go` (verbose but unambiguous)
- `42 days` (clearer but takes more sidebar real estate)
- Color-shifted urgency (green > 21d, amber 8-21d, red ≤ 7d) without changing text
- An icon + tooltip rather than a text badge

**To unblock:** pick one. Or send a one-line "what should this say."

### #192 — Mom (52) accessibility pass

**Current:** sidebar uses 14-15px fonts, sage-on-warm-white contrast, no
explicit zoom support. The couple portal renders well on a laptop;
Mom on her iPad in dim light may struggle.

**Why I didn't ship:** no concrete spec. The audit framing was a
persona ("Mom, 52, low light, iPad") not a requirement.

**To unblock:** either (a) hand me a list of explicit acceptance
criteria (font sizes, AA contrast minimums, zoom levels to support),
or (b) book 30 minutes with someone in that demographic and a list of
their actual complaints.

### #193 — "Picks" / "Venue Inventory" / "Inspo" rename + IA

**Current:** three sidebar items in two different sections — "Saved
Items" (= Picks), "Venue Inventory", and "Inspo" — that all roughly
mean "things you saved or want." Couples find this confusing per
audit.

**Why I didn't ship:** renaming live nav items affects bookmarks,
muscle memory, and SEO. This is a product call.

**To unblock:** decide (a) what the canonical name is, and (b) whether
the three become one section or stay as three. Once decided I'll
rename + add redirect routes from the old paths.

### #194 — Sarah's emotional-reaction copy cleanup

**Current:** various microcopy across the portal that feels off
("Nothing here yet. After the wedding, your venue will add..." is one
example flagged in the audit).

**Why I didn't ship:** copy edits without specific examples are
unilateral creative-writing. Wrong move.

**To unblock:** open `/couple/hawthorne-manor` and screenshot or
quote the 3-5 specific phrases that feel wrong, with what you'd
prefer instead.

### #195 — Weeknight-9pm-couch design pass

**Current:** the portal works fine on desktop. Audit: how does it
hold up at low energy on the couch with one hand?

**Why I didn't ship:** "design pass" is open-ended. Could be
typography, could be tap targets, could be visual hierarchy, could
be motion / animation reduction.

**To unblock:** define what "weeknight-9pm-couch ready" means
concretely. Maybe: "every primary action reachable in one tap from
What's Next, no >2-line paragraphs in the default view, all
animations under 150ms."

### #196 — David-friendly home + assignment notifications

**Current:** the portal is single-user-feeling. Both partners see the
same view. Notifications go to whoever logged in.

**Why I didn't ship:** "David-friendly" is a persona shorthand without
a feature spec. Audit likely wants: per-partner home view, assignment
notifications routed to the right partner, partner-specific recap.

**To unblock:** decide whether to (a) build per-partner views with
filtered task lists, (b) just add an "assigned to David" notification
filter, or (c) defer until both-partner-active becomes a real
customer ask.

### #198 — Weeknight progressive disclosure

**Current:** dashboard renders all stats + sections at once. Audit:
"reveal complexity gradually."

**Why I didn't ship:** progressive disclosure is a design philosophy
that touches every page. Implementing piecemeal would create
inconsistency.

**To unblock:** confirm the philosophy is desired site-wide (then I
do a full-portal pass), OR pick the 1-2 surfaces where it matters
most and we ship targeted versions.

### #199 — One-task-at-a-time mode

**Current:** checklist shows all items in a flat list with filters.

**Why I didn't ship:** "one task at a time" could mean (a) a
distraction-free overlay, (b) a reordering of the existing list, or
(c) a separate "focus" route.

**To unblock:** decide which. Probably worth a 15-minute Loom of you
walking through what you envision.

### #201 — First-time-onboarding skip pattern

**Current:** `/getting-started` shows 5 action cards. Returning users
who've completed all 5 still see the same page on direct nav.

**Why I didn't ship:** the audit said "returners shouldn't see the
welcome flow." But getting-started isn't in the sidebar — returners
don't actively land on it unless they URL-type. The skip pattern
exists at the dashboard level (no welcome banner there). So the
specific gap is unclear.

**To unblock:** confirm whether (a) you want
`/getting-started` to redirect to `/whats-next` for fully-onboarded
couples, or (b) you want a "Welcome back" different layout when
revisited, or (c) the current state is fine and the audit was
referring to something else.

---

## Process for closing these out

When you have a one-line answer for any of these, paste it back to
me. I can ship most of them in 30-60 minutes once unblocked. The
goal is for none of them to be open as standing UX debt — either
they ship, or we explicitly punt them with a reason.
