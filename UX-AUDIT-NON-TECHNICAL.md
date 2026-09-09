# UX audit: the platform read by someone who is not technical

**Date:** 2026-09-08 · **Workstream:** W8 · **Branch:** `consolidation`
**Method:** the code was read, not a browser. Every finding carries a file and a line.

## Who this audit is written for

A wedding-venue owner or coordinator. They run weddings. They are not
technical and they are not comfortable with data. On a Monday morning
with a coffee they want five answers: who needs a reply, who is going
quiet, who is touring this week, who looks ready to book, and is
anything wrong.

They do not know what a touchpoint is. Or a spine, a cascade, a heat
tier, a lifecycle state, an attribution model, a cohort, a decay window,
a signal tier or a first touch. They should never have to.

## Pages walked

`/` (the post-login landing) · `/pulse` · `/agent/inbox` · `/agent/leads`
· `/intel/dashboard` · `/intel/couples/[id]`

Fifteen findings, worst first. Findings 1, 7, 8 and 13 are partly or
wholly addressed by the new `/today` page shipped in this workstream;
the rest are recorded for the workstreams that own those files.

---

## 1. Nothing in the product answers "what do I do now"

**Where:** `src/app/(platform)/page.tsx` (before this workstream) ·
`src/lib/intel/canonical.ts:756-891`

After login the coordinator landed on a dashboard of six counts:
`Active Inquiries`, `Upcoming (30d)`, `Pending Drafts`,
`Booked Revenue (12mo)`, plus a Recent Activity list and four Quick
Action tiles. Not one of those is a person's name. Not one of them says
who is waiting on a reply.

Meanwhile `getDailyList` in `canonical.ts` already computes exactly the
four buckets that answer the question — `needsReply`, `goingCold`,
`toursThisWeek`, `highIntent`, each from a sourced threshold — and it was
rendered by **no page at all**. The only caller was
`src/app/api/admin/intel/canonical/daily/route.ts`, an admin endpoint.

The work was done and the coordinator could not see it.

**Fixed** by `/today` (`src/app/(platform)/today/page.tsx`), which is now
the post-login landing.

---

## 2. Every lead can read "Frozen" and the page will not say why

**Where:** `src/app/(platform)/agent/leads/page.tsx:484-487, 503-504`

```
const { data: heatRows } = await supabase.from('wedding_heat')...
```

The error is destructured away. When the `wedding_heat` read fails —
permissions, a missing view, a timeout — every lead falls to the default
at lines 503-504: score `0`, tier `'cool'`. No banner, no retry, no hint.

The coordinator gets a fully populated, confidently sorted, entirely
wrong ranking of their business. This is the exact shape of the demo
where every lead showed as Frozen.

The same pattern is on the venue-scope lookups (`:429`, `:435`) and the
last-activity read (`:519`). A lead with genuinely no data and a lead
whose data failed to load are drawn identically.

**Fix:** check the error, and render "we could not load interest levels"
instead of a ranking built on a default.

---

## 3. "Approve & Send" can silently not send

**Where:** `src/app/(platform)/agent/inbox/page.tsx:1695-1697`

The PATCH that actually sends the email is commented
`// email send is best-effort` and its failure is swallowed. The draft is
marked approved and the UI tells the coordinator it went. A couple who
never received a reply looks, from inside the product, like a couple who
was answered.

Compose (`:461-463`) and Reply (`:603-605`) fail the same way, to
`console.error` only.

**Fix:** a send failure must surface as a failure, and the draft must not
be marked sent.

---

## 4. Four different definitions of "booked", none of them labelled

**Where:**

| Surface | Counts | Window |
|---|---|---|
| `/intel/dashboard` via `src/lib/services/intel/briefings.ts:481-487` | `weddings` where `status='booked'` | `booked_at` inside the briefing window (7 or 30 days) |
| `/intel/couples/page.tsx:84, 123, 205-221` | `couples.lifecycle_state='booked'`, `completed` is a **separate** pill, and the denominator changes when "show channel-only signals" is ticked | all time |
| `src/lib/intel/canonical.ts:126-142` | `couples.lifecycle_state='booked'` **and `merged_into_id IS NULL`** | all time |
| `/intel/clients/[id]/page.tsx:938` | `weddings.status` on a six-stage ladder | all time |

Legacy table versus spine, windowed versus all-time, finished weddings
folded in versus split out, merge tombstones counted versus excluded.
Nothing on screen states which is which, so a coordinator comparing two
tabs concludes the software is broken. They are not wrong to.

The same page contradicts itself on money too: `Revenue Booked` sums
`weddings.quoted_price` in dollars (`briefings.ts:499-510`) while
`Avg Booking Value` on the same screen divides `weddings.booking_value`
by 100 because it is cents (`intel/dashboard/page.tsx:100-104`).

---

## 5. Lists are truncated and then described as complete

**Where:** `src/app/(platform)/intel/couples/[id]/page.tsx:203, 619`

The touchpoint query is `.limit(500)`. The heading above it reads
`Every touchpoint, in order ({touchpoints.length})`. For a couple with
600 messages that heading is a false statement, and the "N channels ·
N touchpoints" line at `:448-450` inherits the same cap.

Also: candidate matches `.limit(50)` (`:212`), inbox `.limit(200)`
(`inbox/page.tsx:1481`) with a `{n} matches` count rendered against it
(`:2446`), and `/agent/leads` with **no limit at all** (`:444-479`) plus
a full client-side scan of `interactions` (`:519-534`).

---

## 6. Counts that disagree with the rows sitting underneath them

**Where:**

- `inbox/page.tsx:2300` — `{pendingDraftCount} pending approval` is
  venue-wide (query `:1400-1408`), while the list below is filtered to
  one tab. Two numbers, one screen, no relationship.
- `inbox/page.tsx:2235-2251` — tab counts dedupe by `gmail_thread_id`
  and drop outbound rows when "Show sent" is off (`:2243`), so the same
  tab shows a different number depending on a toggle. `Unread` (`:2284`)
  is **not** thread-deduped (`:2218`). Two units, side by side.
- `leads/page.tsx:659-666` — tier pill counts ignore the active search,
  so the pills and the visible rows disagree the moment you type.
- `leads/page.tsx:303, 327` — the Heat Distribution bar's denominator is
  the unfiltered lead count while the filter pills operate on a
  different set.

---

## 7. "Heat" organises a daily page and is defined nowhere

**Where:** `src/app/(platform)/agent/leads/page.tsx`

The page is titled `Lead Scoring` (`:694`). The subtitle says
`ranked by engagement heat score` (`:697`). The sort column is
`Heat Score` (`:821`). There is a `Heat Distribution` card (`:316`) and
a `Tier` column (`:830`). The score renders as a flame and a bare integer
(`:930`), and its only tooltip is a restatement of itself —
`"Hot (87)"` (`heat-badge.tsx:54`).

Five tiers: `Hot`, `Warm`, `Cool`, `Cold`, `Frozen`. `Cool` and `Cold`
are the same word to an English speaker, and they are drawn in two
shades of blue (`:308-309`). `Frozen` is never explained.

There is no scale, no range, no statement of what feeds it, no recency.
`/intel/dashboard` compounds it with `Pipeline Heat (Avg)` (`:77`).

**Partly fixed:** `/today` uses the same underlying score to pick the
"Ready to book" list but never prints it, and says in words why each
couple is there. `src/lib/copy/client-terms.ts` maps `heat → interest`
for the pages that still need to show it.

---

## 8. Raw database values printed straight onto the screen

**Where:**

| File:line | What renders |
|---|---|
| `intel/couples/[id]/page.tsx:446` | `{couple.lifecycle_state ?? 'unknown'}` — literally `channel_scoped`, `ghost`, `agent` in a pill |
| `intel/couples/[id]/page.tsx:675` | `` `${fragment.channel} fragment: ${external_id}` `` — a slug, the word "fragment", and a provider row id |
| `intel/couples/[id]/page.tsx:676` | `` `${primary_record_type} ↔ ${secondary_record_type}` `` → `fragment ↔ touchpoint` |
| `identity/UnmergeModal.tsx:167` | `{t.action_type.replace(/_/g, ' ')}` → `body extracted email`, `discovery self report` |
| `agent/leads/page.tsx:794` | `` `No ${tierFilter} leads` `` → "No frozen leads" |
| `agent/leads/page.tsx:191` | `return map[status] ?? status` — any status outside the map, e.g. the `contracted` that `inbox/page.tsx:2601` writes, renders raw |
| `intel/dashboard/page.tsx:81, 108` | `map[name] ?? name` and `String(value)` — an unmapped metric renders its column name and `0.4285714285714286` |
| `intel/dashboard/page.tsx:302`, `BriefingsPanel.tsx:873`, `insight-panel.tsx:146` | raw `high`/`medium`/`low`, `info`/`warning`/`critical` enums as pills with no legend |

Worst single string on any page, `intel/couples/[id]/page.tsx:704-708`:

> "Identity matching runs continuously. The identity engine rebuilds this
> picture nightly and links new signals in shadow mode the moment they
> arrive."

Below it, `:713`, a raw UUID: `Couple ID: {couple.id}`.

The humanising helpers already exist — `action-labels.ts`,
`couples/page.tsx:81-90` — and are applied on some lines of the same file
and skipped on others.

---

## 9. The most useful action on the couple page is not clickable; the destructive one is prominent

**Where:** `src/components/identity/JourneyActionChip.tsx:173-183` ·
`src/app/(platform)/intel/couples/[id]/page.tsx:413, 417-423`

`JourneyActionChip` works out the single best next move — `Reply now`,
`Send pricing or tour`, `Re-engage`, `Offer tour` — and renders it as a
plain `<div>`. There is no button. Its own header comment says the quiet
part out loud: *"Without action affordance, the ribbon is decoration."*

Meanwhile the two prominent buttons are `Full profile` (which navigates
to a different data model and implies the page you are on is the partial
one) and `Split this couple` — identity surgery whose own modal warns it
is *"reversible only by another manual edit"*.

`/agent/leads` has the same shape from the other direction: zero row
actions, `:865-869`, every row is a full navigation to
`/intel/clients/[id]` and back.

---

## 10. The honesty components were built and then not used

`src/components/ui/` contains `data-maturity.tsx`, `why-this-card.tsx`,
`empty-state.tsx` and `recommendation.tsx`. Their own comments describe
precisely the problems above — *"replaces ad-hoc 'n < 10' pills"*,
*"trust comes from showing the work"*, *"'Nothing here' alone is a dead
end"*.

Across all five audited pages and their child components there is
**one** import: `Recommendation` at `BriefingsPanel.tsx:21`, and only in
the legacy branch at `:815`.

`DataMaturity`, `WhyThisCard` and `EmptyState`: zero uses.

Every metric that `canonical.ts` returns already carries `n`,
`enoughData` and a `reason` (`canonical.ts:48-58`). No coordinator-facing
page reads any of them. The only genuine sample size anywhere in the
audit is `BriefingsPanel.tsx:316-318` — and it is on emotional themes,
not on money.

---

## 11. The one explanation that exists is a hover tooltip

**Where:** `src/app/(platform)/intel/dashboard/page.tsx:703`

`Latest Demand Score` is the most opaque number on the dashboard, and its
sole explanation is a native `title` attribute — which does not fire on
touch. So on the phone the coordinator sees `74`, a `positive` pill, and
nothing else. When it does fire, it reads:

> "Demand Score is a 0–100 composite of national economic indicators…
> computed daily from FRED data. 50 is the historical baseline…"

The card footer, always visible, says `30-day series · daily from FRED`
(`:762`). **FRED** is shipped to a venue coordinator, unexplained.

Same pattern on `inbox/page.tsx:1063`, where a draft's confidence score
is explained only via `title` and only in engineering language: *"The
brain's confidence in this DRAFT (based on… KB hits…). Not
classification confidence."*

---

## 12. The two pages a coordinator opens daily overflow sideways on a phone

Coordinators check phones between tours. At 390px:

| File:line | className | What happens |
|---|---|---|
| `agent/inbox/page.tsx:2308` | `flex items-center gap-2 shrink-0` | seven controls, no `flex-wrap`, `shrink-0` forbids shrinking. ~900px of buttons in a 390px viewport |
| `agent/inbox/page.tsx:2416` | `flex items-center gap-1 bg-sage-50 rounded-lg p-1` | seven filter tabs, no wrap, no `overflow-x-auto` |
| `agent/leads/page.tsx:735` | same shape | six tier pills, no wrap |
| `intel/couples/[id]/page.tsx:492, 564` | `grid grid-cols-2` | hard two columns with no breakpoint. Never collapses |
| `intel/couples/[id]/page.tsx:617, 624, 631` | `overflow-hidden` + `w-28 shrink-0` + `w-24 shrink-0` | 272px of a 326px row spent before the label. Overflow is clipped, not scrollable |
| `identity/JourneyRibbon.tsx:276-278` | `viewBox="0 0 800 64"` + `preserveAspectRatio="none"` | authored at 800px, squashed 2.45× to ~326px. Every dot becomes an ellipse; the word "Booked" is unreadable |
| `JourneyRibbon.tsx:416-457` | hover-only tooltips | confidence and signal tier simply do not exist on touch |
| `BriefingsPanel.tsx:744` | `grid grid-cols-2 md:grid-cols-5` | five metric tiles at two columns; `$1,250,000` in `text-2xl` will not fit |

`/agent/leads:779` (`w-full sm:w-64` on the search box) is the one place
that gets it right.

---

## 13. Empty states dead-end, and one points at a button that does not exist

**Where:** `src/app/(platform)/agent/inbox/page.tsx:2499-2501`

> "Click "Sync Emails" to pull in the latest from Gmail."

The button is labelled `Sync` (`:2331`). The empty state names a control
that is not on the page.

`/agent/leads:788-802` offers no recovery action at all — no clear
search, no clear filter — while the inbox at least offers `Clear search`.

And five components vanish with no explanation when they have nothing:
`PostTourBrowsingCard:60-61`, `WeeklyLearnedCard:121, 136`,
`InsightPanel:113`, plus six conditional sections of
`intel/couples/[id]/page.tsx` (`:454, 484, 559, 604, 616, 641`). A brand
new couple sees a name, a raw `channel_scoped` pill, `0 channels ·
0 touchpoints`, "No touchpoints yet", the shadow-mode paragraph, and a
UUID. No next step.

---

## 14. `/pulse` is an orphan, and it is padded twice

**Where:** `src/app/(platform)/pulse/page.tsx:239` ·
`src/components/shell/nav-config.ts`

`/pulse` describes itself as *"the coordinator's single inbox for things
that need attention"*. It appears nowhere in `nav-config.ts`. The only
route to it is the bell icon in the top bar. `modeForPath('/pulse')`
returns `null`, so the sidebar falls back to Agent mode with nothing
highlighted.

Its container is `max-w-5xl mx-auto p-6` (`:239`) inside the shell's own
`p-6` (`platform-shell.tsx`), so at 390px the content sits in 294px.

Its row actions are three icon-only buttons whose only labels are `title`
attributes — `"Snooze 1 day"`, `"Snooze 1 week"`, `"Dismiss forever"`
(`:385, 393, 401`) — invisible on touch. Dismiss is permanent and has no
confirmation.

Vocabulary: `Pulse`, `Anomalies`, `Insights`, and per row the raw source
word `notification` / `anomaly` / `insight` (`:373`). The paused banner
says `Autonomous behavior paused` (`:271`, American spelling) and points
at `/agent/cost-ceiling`.

**Partly addressed:** `/today` now surfaces the top three pulse items
under the heading "Anything wrong", with priorities translated to
"Needs a look now" / "Worth a look" / "For information", and a link
through to the full list.

---

## 15. Eighty-nine nav destinations plus a thirty-item gear menu

**Where:** `src/components/shell/nav-config.ts`

Four modes carrying 14, 5, 33 and 37 entries, plus `GEAR_GROUPS` with
about 30 more. Entries include `Cohort Intelligence`, `Attribution`,
`Heat`, `Source quality`, `Channel Truth`, `Matching / Dedup`,
`Candidate Review (legacy)`, `All Clients (legacy)`, `Identity Review`,
`Macro Correlations`, `Tracer runs`, `Identity divergence`,
`Prediction calibration`.

The Essential / All rail toggle in `sidebar-v2.tsx:76-79` already
defaults to Essential and cuts each mode down to its `daily: true`
items — that part works and needed no change. But the four-mode strip
across the top is still four doors, and the coordinator's morning is one
door.

`Today` has been added as the first `daily` item in Agent mode.

---

## What `/today` fixes, and what it does not

**Fixes:** finding 1 outright. Findings 7, 8, 13 and 14 on that page —
no internal vocabulary, no raw enum, a warm and specific empty state per
block, and the pulse items surfaced where they are needed.

**Does not fix:** findings 2, 3, 4, 5, 6, 9, 10, 11, 12 and 15. Those
live in files this workstream does not own. Findings 2 and 3 are the two
that make the product tell a coordinator something untrue, and they
should be next.
