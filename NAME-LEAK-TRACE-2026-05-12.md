# Trace: package_interest leaking into partner1.first_name

**Class of problem:** the `name-upgrade` pipeline regex-mines `weddings.notes` and `weddings.sage_context_notes` for Capitalized + Capitalized word pairs and treats every match as a couple-name candidate. Those columns contain structured Calendly Q&A in `key:value` format, where the values like `Whole Weekend`, `One Day Weekday`, `Final Walkthrough`, `Tour Date` are literally English bigrams that satisfy the regex. The regex can't tell a couple name from a package label.

## The exact path

1. **A Calendly tour booking arrives** (either via webhook or CSV import).
2. **`tour-scheduler.ts:763-788`** composes the interaction body and **`tour-scheduler.ts:910-917`** composes the weddings.notes:
   ```
   notes: [
     `partner2_email:${partner2Email}`,
     `package_interest:${q.package_interest.replace(/\n/g, ' / ')}`,
     `pricing_calculator:...`,
     `unknown_q_a:\n  ...`,
   ].filter(Boolean).join('\n\n')
   ```
   For the Whole Weekend lead: `notes` ends up containing `package_interest:Whole Weekend / One Day Weekend`.
3. **`crm-import/index.ts:651`** INSERTs partner1 with `first_name: row.partner1_first_name ?? null` — null when the Calendly form had no Invitee First Name (most leads).
4. **`name-upgrade.ts:317-373 candidatesFromWeddingText`** later runs against the wedding:
   ```ts
   const NAME_RE = /\b([A-Z][a-z'À-ſ-]{1,29})\s+([A-Z](?:[a-z'À-ſ-]{1,29}|\.))/g
   const harvestFrom = (text: string, source: string) => {
     ...
     while ((m = NAME_RE.exec(cleanedText)) !== null) {
       const candidate = `${m[1]} ${m[2]}`
       ...
       out.push({ first, last, source, confidence: 50 })
     }
   }
   if (wedding.notes) harvestFrom(wedding.notes, 'wedding_notes')
   ```
   The regex matches `Whole Weekend` (cap + cap), `One Day` (cap + cap). The blacklist at line 336 catches HTTP-ish junk (`Reply`, `View`, `Click`, etc.) but doesn't catch `Whole`, `One`, `Final`, `Tour`, `Pre`.
5. **`name-upgrade.ts:540-587`** scores those candidates against partner1's existing name. Per `classifyFirstNameMove`: when existing is null, ANY non-null candidate is an `upgrade`. So `first_name='Whole'`, `last_name='Weekend'` lands directly. Bypasses the chokepoint — written via direct `.from('people').update()` at line 571, no `captureNameEvidence` call.
6. **Result:** `people.first_name = 'Whole'`, `people.last_name = 'Weekend'`. UI displays "Whole Weekend". `name_evidence` array stays empty because step 5 bypassed the chokepoint.

The same path explains every "(Unknown) X" lead:
1. `wedding-has-people.ts:220` writes `first_name='(Unknown)'` for ghost weddings with no partner1Claim.
2. `name-upgrade.ts` regex finds `One Day` in notes. `classifyFirstNameMove("(Unknown)", "One")` rejects (no prefix match, existing is non-trivial). `classifyLastNameMove(null, "Day")` upgrades because existing is null.
3. Writes `last_name='Day'`. Display: "(Unknown) Day".

## Why the reconstruct prompt knows about it but doesn't fix it

`src/config/prompts/identity-reconstruction.ts:297` already explicitly lists "Whole Weekend, Final Walkthrough, Tour Date, Estimate" as form-bleed patterns the Sonnet judge must refuse. Line 335 elaborates: "When partner1 has no name evidence (form-bleed case where 'Whole Weekend' or 'One Day' landed in the name field), emit refusal and add `partner1: null`."

So the team has **seen this exact bug before**. The Sonnet judge correctly refuses to claim it as a name. But the Sonnet judge writes to `name_evidence` — which is why `name_evidence` shows zero claims for these leads, and the screenshot says "partner1: (no claim)".

The **regex-based** `name-upgrade.ts` pipeline runs INDEPENDENTLY of reconstruct, has no such blacklist, and writes directly to `people.first_name` / `last_name` bypassing the evidence chokepoint. The Sonnet patch is downstream of the actual writer.

## Concrete impact across the three leads in the screenshots

| Lead | Wedding notes contained | name-upgrade wrote |
|---|---|---|
| RM-0472 "Whole Weekend" | `package_interest:Whole Weekend / One Day Weekend` | `first='Whole'`, `last='Weekend'` |
| RM-0455 "(Unknown) Day" | `package_interest:One Day Weekday` | `first='(Unknown)'` (from wedding-has-people), `last='Day'` (from name-upgrade scan) |
| RM-0480 Crystal Fuller | `package_interest:Whole Weekend / One Day Weekend` | `first='Crystal'`, `last='Fuller'` — NOT leaked because the real name signal (Calendly invitee + email handle parse) beat the package-interest signal in `pickBestCandidate` scoring. So the leak silently lives in EVERY package_interest-bearing lead but only displays when the real name signal is weak/absent. |

So "Whole Weekend" / "(Unknown) Day" are the visible failure mode. Every Rixey lead with package_interest is silently carrying a false `Whole Weekend` candidate in their name_evidence (well, would be if name-upgrade went through the chokepoint — currently it bypasses).

## The fix

Three layers, in order of leverage:

**1. Tactical (5 min):** add a structured-prose detector to `harvestFrom` in name-upgrade.ts:325. When the source text contains a `key:value` line (regex `/^\w+:.+/m`), skip regex extraction on that line entirely. Wedding.notes is structured Q&A, not free prose. Cure addresses the entire class — any future leaked key gets caught.

**2. Token-level (10 min):** extend the blacklist at name-upgrade.ts:336 to include package / time-of-day / event-shape tokens: `Whole`, `One`, `Two`, `Three`, `Half`, `Final`, `Tour`, `Pre`, `Post`, `Day`, `Night`, `Weekend`, `Weekday`, `Walkthrough`, `Meeting`, `Booking`, `Estimate`, `Package`. Lower leverage than #1 but defensive belt-and-suspenders.

**3. Structural (30-60 min):** stop stuffing Calendly Q&A into `weddings.notes`. Replace with a dedicated `weddings.calendly_qa jsonb` column (mig 322). Migrate existing rows. Notes column reverts to being free-text only. Removes the leak surface entirely — name-upgrade's regex on a jsonb column wouldn't fire. This is the proper Constitution-aligned move (structured evidence on structured columns, free text on free-text columns).

I'd ship #1 immediately as a band-aid plus #3 as the architectural fix. #2 is optional.

## Related issues I traced while in here

**Marked-lost event without status flip (RM-0480):** I couldn't fully trace this one. The canonical `markLost` function at `heat-mapping.ts:1420` writes both the engagement event AND `status='lost'` together in `Promise.all`. So either (a) the partial-failure of that Promise.all wrote the event but failed the status update silently, OR (b) someone manually flipped the status BACK to `tour_scheduled` after the lost event landed. No obvious code path does the latter. Worth checking the lifecycle_transitions audit log for this wedding.

**Duplicate Crystal Fuller person rows:** F10 from the identity audit. `crm-import/index.ts:651` and the direct-INSERT sites that ship before my mintWedding chokepoint don't check for `(wedding_id, role='partner1', email=X)` existing rows. Same wedding processed twice via different paths creates two rows. The fix is the daily auto-merge sweep — find people rows with matching email+wedding+role and call `mergePeople`.

**The "Tipton" SMS:** confirmed external (Lindy). `inferNameFromEmail('crazytippy@gmail.com')` returns null. No Bloom code path produces "Tipton". Sage's outbound SMS templating didn't exist on Jan 16 (shipped today as Pattern 9). The "Hey Tipton" message was composed by a different system (Lindy) and sent via OpenPhone API to the venue's phone number. OpenPhone synced it back to Bloom as an outbound interaction. Bloom's name-upgrade pipeline could theoretically pick up "Tipton" from that outbound SMS body if regex-mined... but I don't see candidatesFromInteraction reading the body, only `extracted_identity.names[]`. So Bloom didn't store "Tipton" as the person's first_name from that SMS.
