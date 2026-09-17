# The couple portal against the market, 17 September 2026

What the products that give a couple a planning space actually do, and what Bloom's portal (and the Rixey portal it grew from) can take from them. Read from public sites and help centres; nothing was trialled. Sources at the end. Companion to `2026-09-17-rixey-portal-vs-bloom-portal.md`, which is the internal parity list.

Four kinds of product overlap with the portal:

- **Venue-side portals**, where the venue owns the space and the couple is invited into it: Weven (now redirecting to The Knot's vendor site, so absorbed), Planning Pod, Tripleseat's guest portal, Seated With Love, HoneyBook's client portal. This is Bloom's category.
- **Planner-side portals**: Aisle Planner. Same shape, but a planner rather than a venue holds the pen.
- **Couple-owned planning apps**: Zola, The Knot, Joy, Bridebook (UK). Free, enormous, and what most couples already have open in another tab.
- **One-job tools couples and planners pull in**: Prismm (was AllSeated) for floor plans and seating, Timeline Genius for the day-of timeline, RSVPify and Joy for RSVPs. Losava is the one AI-first planner with a real planning suite behind the chat.

## What they're built around

| | Who owns it | What the couple lands on | Sections / tools | What flows back to the venue or planner |
|---|---|---|---|---|
| Planning Pod | Venue | Tiles on a home screen. A red dot on a tile when something needs the couple: sign, pay, answer a questionnaire, do a task. | Payments, contacts and vendors, sign proposals and contracts and BEOs, to-dos, guest list with RSVPs and meals, files, menu review, itinerary, vision board, floor plan (view or edit). Each tool can be on, off, or view-only. The venue can **lock all changes N days before the event**. | Guest list, RSVPs and meals, seating on the venue's own floor plan, files, questionnaire answers. |
| Tripleseat guest portal | Venue | One branded dashboard: documents, messages, payments. Documents are **live**: change the menu or BEO in the venue's system and the couple sees it at once. | Proposal, contract, BEO, invoices, discussion thread. | Signatures, payments, messages. Its pitch is "friction is the ultimate conversion killer": sign and pay in the moment. |
| Weven | Venue (now The Knot) | A portal "customized to their venue" that syncs with the venue's platform. | Checklist, vendor and document management, wedding website, share floor plans and timelines with the host, add planning partners and family as collaborators, online payments. | Vendor lists, timelines, floor plans, seating charts, certificates of insurance, key event details. Collection from the couple is the explicit purpose. |
| Aisle Planner | Planner | A dashboard with a generic welcome, only the **released** tools showing, and a right column of "your assigned tasks" and "the next 30 days". | Checklist, timeline, budget, guest list, seating, style guide and design studio, vendor contacts, payment due dates, project calendar the couple can sync to their own. Three levels per tool: hidden, view, edit. Checklist has a "planners only" flag per task, and a couple can be shown only the tasks assigned to them. | Comments on photos and tasks, task completion, calendar. Notifications are specific: a comment on a design photo, a task assigned (batched after ten minutes), a deadline on a task assigned to you. |
| HoneyBook client portal | Vendor | Tabs: files, messages, payments, project details. Anything internal is greyed or marked private. | Contracts to sign, invoices to pay, files, messages. | Signatures, payments, messages. Deliberately thin. |
| Zola | Couple | Checklist as a countdown. | Checklist, budget with allocation suggestions, guest list, seating, website, registry, invitations, vendor marketplace, AI for writing. | Nothing to a venue; exports a spreadsheet "for venue and vendor coordination". |
| The Knot | Couple | Month-by-month checklist. | Checklist, guest list and RSVP with built-in email and text to guests, budget advisor with local averages, vendor manager, website. AI is a vendor-matching quiz. | Nothing to a venue. |
| Joy | Couple | Website first, tools around it. | Website, guest list, smart RSVP, registry, invitations. Free; only a domain costs. | Export "to hand over to your wedding day coordinators". |
| Bridebook | Couple (UK) | Checklist generated from the date. | Checklist, budget with UK allocation, guest list with day or evening guests, dietary needs, plus ones and children, supplier directory. | Nothing to a venue. |
| Prismm | Shared | A 3D floor plan with a share link; no account needed to view. | Floor plan, seating, guest list, real-time co-editing, virtual walk-through. Built into Tripleseat. | Seating on the venue's real plan. |
| Timeline Genius | Planner | One timeline, one link per collaborator, each seeing their own version. | Per-item access (hidden, view, edit) per person, so a surprise stays a surprise. Comments in one place. Files attached to the timeline. Text reminders on the day. | Vendor and venue comments and edits. |
| Losava | Couple, AI first | A chat that "knows your entire wedding" plus the usual tools. | Budget, guest list, seating, timeline, vendors, website, and an assistant that remembers between sessions and acts on its own (RSVP reminders, budget alerts). | None. |

Bloom's portal has more sections than any of them (32 defaults, from bar planning to a borrow catalogue), a per-venue on/off per section, a Sage chat with the wedding's context, and the venue on the other side of every page. What it lacks is not sections. It is the handful of mechanisms in the table above that make a portal feel finished: a tile with a red dot, a lock date, live documents, per-item hiding, a checklist that is a countdown, and notifications that are about one specific thing.

## Mechanisms worth taking, in order

1. **"Needs you" on the home screen.** Planning Pod's red dot on a tile, Aisle Planner's right column of assigned tasks and the next 30 days. Bloom's couple dashboard should open with the three things the venue is waiting on from the couple (a worksheet, the final count, a payment) and the next three dated things, before any section grid. Rixey's "tick and pending count per section" (14 Sep) is half of this; the other half is putting it at the top.
2. **A lock date.** Planning Pod lets the venue freeze couple edits N days before the event. Rixey has the final guest count deadline as a variable and Bloom has section sign-off; neither stops a couple changing the seating chart on the Thursday. One venue setting, "changes close N days before", enforced on the couple side with a clear message, would end a class of day-of surprises.
3. **Released, view-only, or edit, per section, and "unreleased" as a state.** Aisle Planner's three levels beat Bloom's on/off. A venue wants to show the couple the timeline without letting them edit it, and wants to build the bar plan before the couple sees it. Bloom's `portal_section_config.visibility` is close; it needs "venue only until released" and "couple can view but not edit".
4. **The checklist as a countdown from the date, with a task assigned to a person.** Zola works twelve months back from the date and asks two questions first (how much guidance, are guests travelling). The Knot is month by month. Aisle Planner assigns a task to one partner and reminds only them. Bloom's checklist should generate from the wedding date and the venue's own deadlines (final count at 30 days, balance at 30 days, insurance certificate at 30 days) and let a task belong to one of the two partners.
5. **Live documents.** Tripleseat's point: the BEO the couple sees is the one the venue is editing, so there is never a stale version. Bloom's "Notes from the venue" and "Documents" gaps in the parity audit are this. Whatever the venue writes about the wedding (walkthrough notes, the run sheet) should have one couple-visible rendering that is always current, with a "last updated" line.
6. **Notifications about one thing, never a digest.** Aisle Planner notifies on a comment on your photo, a task assigned to you, a deadline on your task. Bloom's couple bell exists; the question is whether each entry names the thing and links to it. A rule: every notification is one sentence with one link.
7. **Per-item hiding on the timeline.** Timeline Genius hides a surprise from the person it's for. A wedding timeline shared with both partners and the wedding party needs "hidden from" per item. Small change, and the kind of detail couples tell each other about.
8. **RSVP the way Joy does it.** Guest finds themselves by name against the list (Rixey added this in August), household answers in one go, follow-up questions that appear only for some groups (rehearsal dinner for family and party), meal choice as a dependent question after "yes", scheduled reminders to guests who haven't answered, and a decliner can leave a note. Bloom's `rsvp-settings` should be checked against that list on the road test.
9. **Guest messaging from the guest list.** The Knot lets the couple email or text guests from the list with templates (share the website, RSVP reminder, day-of details). Bloom holds guest emails and phones already; a "message these guests" action with three templates would be used more than most sections.
10. **Floor plan on the venue's real room.** Prismm and Planning Pod seat guests on the venue's own plan, with the venue's tables, and share it by link with no login. Bloom's `table-map` and Rixey's ceremony chairs are steps toward this; the venue should be able to upload or draw its rooms once, and the couple seats onto them.
11. **The venue's numbers in the budget.** The Knot's budget advisor uses local averages. A venue portal can do better: the budget page should start with the venue's own contract total and payment dates already filled in, and suggest the rest from what past couples at this venue spent (Bloom has the data for the second half through Intel, once there are enough weddings).
12. **Collaborators without a login.** Weven lets the couple add planning partners and family; Rixey built "family and contacts" on the venue side. Both directions are needed: the couple invites their mother to see the seating chart; the venue files the mother's calls to the wedding. Bloom has neither on the couple side yet.
13. **The AI that acts, not only answers.** Losava's assistant sends the RSVP reminders and fires the budget alert itself, and remembers between sessions. Sage already knows the wedding; the step is letting Sage propose an action ("Twelve guests haven't answered and the count is due in nine days. Send them the reminder?") and do it on a yes. That is the thing none of the big four have and the one an AI-first competitor is selling on.

## What to promise, and what not to

**Say:**
- One place, always current, with the venue on the other side of it. Tripleseat and Seated With Love both sell "one organised place" and "a continuation of the hospitality".
- Your venue can see what you've filled in, so you never have to email it. Weven's whole pitch.
- Works at your own pace, on your phone.

**Don't say:**
- That it replaces the planner or the coordinator. Seated With Love says it outright: give routine information a dependable home "so personal communication can focus on the moments where the venue's expertise matters most". Bloom's own doctrine ("anti-guilt", the first principle) points the same way.
- That Sage's answers are the venue's word. The Rixey portal already frames Sage as the venue's assistant with the venue's knowledge; keep the line that the coordinator confirms anything that costs money or changes the contract.
- Feature counts. Zola, The Knot and Joy are free and have every tool a couple would list. The portal's claim is the venue in the room, not the number of sections.

## Structural notes

- The couple-owned apps are all **countdown first**: the date drives everything. Bloom's dashboard is a section grid. The road test should watch whether couples know what to do next when they land.
- The venue-side portals are all **thin on the couple's own planning** (Tripleseat and HoneyBook have no checklist at all) and strong on the transaction. Bloom is the reverse. That is a real position, but it means the transactional pieces (sign, pay, the BEO) have to be as clean as theirs, which is what the ContractHouse merge is for.
- Every product with a venue or planner on the other side has **per-tool permissions**, and the better ones have three levels. Bloom has two.
- **Nobody** puts the venue's own explanations next to the couple's decisions the way ContractHouse does with clauses. "Why we ask for the final count 30 days out" beside the count field would be the same idea inside the portal.

## Sources

- Planning Pod: [client portals](https://planningpod.com/client-portals), [client portal overview](https://planningpod.com/help-center/overview-what-is-the-client-portal-and-how-does-it-work), [floor plans](https://planningpod.com/event-floor-plan-software)
- Tripleseat: [guest portal](https://tripleseat.com/blog/customer-portal-2/), [wedding venues](https://tripleseat.com/industries/wedding-venues/)
- Weven: [online planning](https://weven.co/blog/online-planning/), [planning toolkit](https://weven.co/blog/wedding-planning-toolkit/) (the features page now redirects to The Knot's vendor site)
- Seated With Love: [client portals](https://blog.seatedwithlove.com/wedding-venue-client-portal-what-is-it-and-do-you-need-one/)
- Aisle Planner: [what clients see](https://help.aisleplanner.com/en/articles/2766424-what-do-my-clients-see-in-aisle-planner), [checklist for month-of](https://help.aisleplanner.com/en/articles/2056739-using-the-checklist-to-make-month-of-coordination-easy-and-stress-free)
- HoneyBook: [what clients see in the portal](https://help.honeybook.com/en/articles/6428603-what-clients-can-see-and-do-in-the-client-portal)
- Zola: [checklist setup](https://www.zola.com/faq/115002135931-How-do-I-set-up-my-wedding-checklist-), [guest list](https://www.zola.com/wedding-planning/guests), [AI planning guide](https://www.zola.com/expert-advice/ai-wedding-planning-guide)
- The Knot: [planning tools](https://www.theknot.com/content/our-top-wedding-planning-tools), [guest list](https://www.theknot.com/gs/guest-list), [AI tool](https://www.digitalcommerce360.com/2025/09/29/the-knot-adds-ai-tool-to-its-online-wedding-planner/)
- Joy: [smarter RSVP](https://withjoy.com/blog/a-more-sophisticated-online-rsvp-2/), [guest list](https://withjoy.com/guest-list/)
- Bridebook: [app](https://apps.apple.com/gb/app/bridebook-1-wedding-planner/id1200853011)
- Prismm: [wedding planning](https://www.prismm.com/solutions/persona/wedding-planning-software), [external collaboration](https://www.prismm.com/tutorial/external-collaboration), [Tripleseat partnership](https://www.prismm.com/press/tripleseat-partners-allseated-give-venue-planners-access-3d-floor-plan-seating-arrangements)
- Timeline Genius: [collaboration](https://blog.timelinegenius.com/how-to-collaborate-on-your-wedding-day-timelines-with-vendors-team-members-and-clients/)
- RSVPify: [guest list app](https://rsvpify.com/guest-list-app/)
- Losava: [AI planning tools compared](https://www.losava.com/blog/best-ai-wedding-planning-tools-2026)

## Second look: what actually helps, and what just adds pressure

Isadora's test, 17 Sep: the portal must not panic or pressure people. Read against that, half the list above is borrowed from products whose business is engagement, and the mechanics that drive engagement are the ones that drive dread. Zola's twelve-month countdown with push notifications is the most effective planning tool on the market and the most stressful thing a couple can install.

**Keep, because both sides feel it and nobody is chased:**
- Live venue documents (5). The couple reads what the venue wrote, always current, no version anxiety. The venue stops answering "did you get my email".
- Fewer sections, released when they're relevant (3). Thirty-two sections on day one says "you are behind on thirty-two things". Show the five that matter at booking, and let the venue release the rest as the wedding approaches. This is the single biggest calm-down available and it costs a permission level, not a feature.
- Where things stand, not "needs you" (1, reframed). No red dots, no counts of overdue. A short calm strip: what the venue is waiting on (rarely more than one thing), the next dated moment, and, most of the time, "Nothing needed from you right now" as a first-class state. The venue benefit is real: fewer chasing emails. The couple benefit is knowing they are not behind.
- A soft close, not a lock (2, reframed). "Changes close on the 5th; after that, message us and we'll make them for you." The venue gets a stable plan for the day; the couple never meets a refused save.
- RSVP done properly (8). Fewer texts from the couple to their guests, fewer from guests to the couple. Reminders to guests are the couple's call, and normal.
- Collaborators the couple invites (12). A mother who can see the seating chart without borrowing a login is a small kindness that removes a recurring argument.
- Hide a timeline item from one person (7). Cheap, and the kind of thing couples tell each other about.
- Notification restraint (6). The rule is fewer, not better formatted: a notification only when the venue did something for you or needs exactly one thing.

**Cut or change, because they pressure:**
- The countdown checklist (4). A generated list of a hundred dated tasks is the panic machine. The venue has perhaps five real asks (final count, balance, insurance certificate, vendor list, the timeline) and they already have dates. Show those five, with the reason beside each, and make everything else undated and optional. Assigning tasks to one partner: skip; it invites blame.
- Completeness percentages and per-section tick counts (Rixey, 14 Sep). A page that says 40% complete is a page that says you are 60% behind. Drop the percentage. A quiet tick when the venue has what it needs is enough.
- "What past couples spent" in the budget (11). It reads as a comparison, and comparisons are the thing couples come to a venue to escape. Keep the pre-fill from the contract; drop the benchmark.
- Sage proposing actions (13). Worth building, later, with one rule first: Sage never says "you haven't", only "want me to". An offer removes work; a reminder adds it. Until that rule is written into the prompt and tested, leave Sage answering rather than nudging.
- Guest messaging from the list (9) and the real-room floor plan (10). Useful, not calming, not urgent. Wait for the road test to show whether couples want them.

**The honest ranking for the road test:** 5, 3, 1-reframed, 2-reframed, 8, 12, 7, 6. Then stop and watch real couples before doing anything else.
