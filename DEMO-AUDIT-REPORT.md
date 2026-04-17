# Bloom House — Automated Demo Audit Report
**Generated:** 2026-04-16 13:13
**Target:** https://bloom-house-iota.vercel.app/demo/*
**Method:** Playwright Chromium — full JS rendering, network monitoring, console capture
**Total duration:** 509s

## Summary
| Metric | Count |
|--------|-------|
| Total pages tested | 96 |
| Passed (no critical issues) | 96 |
| Failed (critical issues) | 0 |
| Pages with warnings | 1 |
| Total issues found | 2 |

## What Was Checked
Each page was loaded in a real Chromium browser with full JavaScript execution:

| Check | What it catches |
|-------|----------------|
| **Console errors** | Runtime JS crashes, unhandled promise rejections, failed imports |
| **Bad text patterns** | Visible "undefined", "NaN", "null", "[object Object]", error messages, "Lorem ipsum" |
| **Failed network requests** | Broken API calls (4xx/5xx), missing endpoints |
| **Broken images** | Images that failed to load (naturalWidth === 0) |
| **Empty pages** | Pages with < 20 characters of visible text (blank renders) |
| **Screenshots** | Every page screenshotted for visual review |

## Issue Breakdown by Type
| Type | Count | Severity |
|------|-------|----------|
| console-error | 1 | Medium |
| failed-request | 1 | Medium-High |

---

## Detailed Results by Section

### Agent (14 pages — 14 passed)

| Page | Status | Time | Issues |
|------|--------|------|--------|
| `agent/inbox` | ✅ passed | 8.9s | — |
| `agent/pipeline` | ✅ passed | 5.1s | — |
| `agent/leads` | ✅ passed | 4.9s | — |
| `agent/drafts` | ✅ passed | 4.6s | — |
| `agent/sequences` | ✅ passed | 4.5s | — |
| `agent/relationships` | ✅ passed | 4.7s | — |
| `agent/analytics` | ✅ passed | 4.6s | — |
| `agent/codes` | ✅ passed | 4.8s | — |
| `agent/errors` | ✅ passed | 4.6s | — |
| `agent/knowledge-gaps` | ✅ passed | 5.5s | — |
| `agent/learning` | ✅ passed | 6.0s | — |
| `agent/notifications` | ✅ passed | 4.9s | — |
| `agent/rules` | ✅ passed | 5.4s | — |
| `agent/settings` | ✅ passed | 4.6s | — |

### Intel (22 pages — 22 passed)

| Page | Status | Time | Issues |
|------|--------|------|--------|
| `intel/dashboard` | ✅ passed | 4.2s | — |
| `intel/briefings` | ✅ passed | 5.6s | — |
| `intel/clients` | ✅ passed | 4.5s | — |
| `intel/tours` | ✅ passed | 5.3s | — |
| `intel/reviews` | ✅ passed | 4.7s | — |
| `intel/campaigns` | ✅ passed | 4.1s | — |
| `intel/capacity` | ✅ passed | 4.7s | — |
| `intel/company` | ✅ passed | 6.4s | — |
| `intel/forecasts` | ✅ passed | 4.9s | — |
| `intel/health` | ✅ passed | 4.8s | — |
| `intel/lost-deals` | ✅ passed | 4.8s | — |
| `intel/market-pulse` | ✅ passed | 7.7s | — |
| `intel/matching` | ✅ passed | 4.3s | — |
| `intel/nlq` | ✅ passed | 4.3s | — |
| `intel/portfolio` | ✅ passed | 4.3s | — |
| `intel/regions` | ✅ passed | 4.4s | — |
| `intel/social` | ✅ passed | 4.4s | — |
| `intel/sources` | ✅ passed | 5.6s | — |
| `intel/team` | ✅ passed | 5.2s | — |
| `intel/team-compare` | ✅ passed | 4.4s | — |
| `intel/trends` | ✅ passed | 4.5s | — |
| `intel/annotations` | ✅ passed | 4.2s | — |

### Portal (17 pages — 17 passed)

| Page | Status | Time | Issues |
|------|--------|------|--------|
| `portal/weddings` | ✅ passed | 4.7s | — |
| `portal/bar-config` | ✅ passed | 4.3s | — |
| `portal/checklist-config` | ✅ passed | 4.1s | — |
| `portal/decor-config` | ✅ passed | 4.1s | — |
| `portal/guest-care-config` | ✅ passed | 4.2s | — |
| `portal/kb` | ✅ passed | 4.2s | — |
| `portal/messages` | ✅ passed | 4.2s | — |
| `portal/rehearsal-config` | ✅ passed | 4.2s | — |
| `portal/rooms-config` | ✅ passed | 4.6s | — |
| `portal/sage-queue` | ✅ passed | 4.5s | — |
| `portal/seating-config` | ✅ passed | 4.2s | — |
| `portal/section-settings` | ✅ passed | 4.2s | — |
| `portal/shuttle-config` | ✅ passed | 4.6s | — |
| `portal/staffing-config` | ✅ passed | 5.0s | — |
| `portal/tables-config` | ✅ passed | 4.3s | — |
| `portal/vendors` | ✅ passed | 4.5s | — |
| `portal/wedding-details-config` | ✅ passed | 4.2s | — |

### Couple (38 pages — 38 passed)

| Page | Status | Time | Issues |
|------|--------|------|--------|
| `couple/hawthorne-manor` | ✅ passed | 7.5s | — |
| `couple/hawthorne-manor/getting-started` | ✅ passed | 5.7s | — |
| `couple/hawthorne-manor/chat` | ✅ passed | 5.8s | — |
| `couple/hawthorne-manor/messages` | ✅ passed | 5.5s | — |
| `couple/hawthorne-manor/checklist` | ✅ passed | 5.7s | — |
| `couple/hawthorne-manor/timeline` | ✅ passed | 6.5s | — |
| `couple/hawthorne-manor/budget` | ✅ passed | 6.8s | — |
| `couple/hawthorne-manor/contracts` | ✅ passed | 6.3s | — |
| `couple/hawthorne-manor/guests` | ✅ passed | 5.8s | — |
| `couple/hawthorne-manor/rsvp-settings` | ✅ passed | 5.6s | — |
| `couple/hawthorne-manor/seating` | ✅ passed | 5.3s | — |
| `couple/hawthorne-manor/tables` | ✅ passed | 7.2s | — |
| `couple/hawthorne-manor/party` | ✅ passed | 6.6s | — |
| `couple/hawthorne-manor/ceremony` | ✅ passed | 5.3s | — |
| `couple/hawthorne-manor/rehearsal` | ✅ passed | 5.3s | — |
| `couple/hawthorne-manor/bar` | ✅ passed | 6.2s | — |
| `couple/hawthorne-manor/decor` | ✅ passed | 5.3s | — |
| `couple/hawthorne-manor/photos` | ✅ passed | 5.3s | — |
| `couple/hawthorne-manor/couple-photo` | ✅ passed | 5.2s | — |
| `couple/hawthorne-manor/inspo` | ✅ passed | 5.6s | — |
| `couple/hawthorne-manor/picks` | ✅ passed | 5.8s | — |
| `couple/hawthorne-manor/beauty` | ✅ passed | 5.3s | — |
| `couple/hawthorne-manor/vendors` | ✅ passed | 5.1s | — |
| `couple/hawthorne-manor/preferred-vendors` | ✅ passed | 5.9s | — |
| `couple/hawthorne-manor/rooms` | ✅ passed | 5.7s | — |
| `couple/hawthorne-manor/stays` | ✅ passed | 5.3s | — |
| `couple/hawthorne-manor/transportation` | ✅ passed | 10.0s | — |
| `couple/hawthorne-manor/allergies` | ✅ passed | 5.2s | — |
| `couple/hawthorne-manor/guest-care` | ✅ passed | 5.6s | — |
| `couple/hawthorne-manor/staffing` | ✅ passed | 5.1s | — |
| `couple/hawthorne-manor/venue-inventory` | ✅ passed | 5.2s | — |
| `couple/hawthorne-manor/wedding-details` | ✅ passed | 5.8s | — |
| `couple/hawthorne-manor/worksheets` | ✅ passed | 5.3s | — |
| `couple/hawthorne-manor/downloads` | ✅ passed | 5.2s | — |
| `couple/hawthorne-manor/resources` | ✅ passed | 5.5s | — |
| `couple/hawthorne-manor/website` | ✅ passed | 5.7s | — |
| `couple/hawthorne-manor/booking` | ✅ passed | 6.1s | — |
| `couple/hawthorne-manor/final-review` | ✅ passed | 6.1s | — |

### Settings (5 pages — 5 passed, 1 with warnings)

| Page | Status | Time | Issues |
|------|--------|------|--------|
| `settings` | ✅ passed | 4.1s | — |
| `settings/personality` | ✅ passed | 4.4s | — |
| `settings/voice` | ✅ passed | 4.6s | — |
| `onboarding` | ✅ passed | 4.4s | ⚠️ 2 |
| `super-admin` | ✅ passed | 4.0s | — |

#### Settings — Issue Details

**`onboarding`:**
- 🔴 **console-error**: Failed to load resource: the server responded with a status of 400 ()
- 🔴 **failed-request**: 400 https://jsxxgwprxuqgcauzlxcb.supabase.co/rest/v1/venues?select=name%2Caddress%2Ccity%2Cstate%2Czip%2Ctimezone&id=eq.22222222-2222-2222-2222-222222222201

---

## Recurring Issues (Deduplicated)

These issues appear across multiple pages and likely share a root cause:

No recurring issues found.

---

## Clean Pages (No Issues Detected)

- ✅ Agent / `agent/inbox`
- ✅ Agent / `agent/pipeline`
- ✅ Agent / `agent/leads`
- ✅ Agent / `agent/drafts`
- ✅ Agent / `agent/sequences`
- ✅ Agent / `agent/relationships`
- ✅ Agent / `agent/analytics`
- ✅ Agent / `agent/codes`
- ✅ Agent / `agent/errors`
- ✅ Agent / `agent/knowledge-gaps`
- ✅ Agent / `agent/learning`
- ✅ Agent / `agent/notifications`
- ✅ Agent / `agent/rules`
- ✅ Agent / `agent/settings`
- ✅ Intel / `intel/dashboard`
- ✅ Intel / `intel/briefings`
- ✅ Intel / `intel/clients`
- ✅ Intel / `intel/tours`
- ✅ Intel / `intel/reviews`
- ✅ Intel / `intel/campaigns`
- ✅ Intel / `intel/capacity`
- ✅ Intel / `intel/company`
- ✅ Intel / `intel/forecasts`
- ✅ Intel / `intel/health`
- ✅ Intel / `intel/lost-deals`
- ✅ Intel / `intel/market-pulse`
- ✅ Intel / `intel/matching`
- ✅ Intel / `intel/nlq`
- ✅ Intel / `intel/portfolio`
- ✅ Intel / `intel/regions`
- ✅ Intel / `intel/social`
- ✅ Intel / `intel/sources`
- ✅ Intel / `intel/team`
- ✅ Intel / `intel/team-compare`
- ✅ Intel / `intel/trends`
- ✅ Intel / `intel/annotations`
- ✅ Portal / `portal/weddings`
- ✅ Portal / `portal/bar-config`
- ✅ Portal / `portal/checklist-config`
- ✅ Portal / `portal/decor-config`
- ✅ Portal / `portal/guest-care-config`
- ✅ Portal / `portal/kb`
- ✅ Portal / `portal/messages`
- ✅ Portal / `portal/rehearsal-config`
- ✅ Portal / `portal/rooms-config`
- ✅ Portal / `portal/sage-queue`
- ✅ Portal / `portal/seating-config`
- ✅ Portal / `portal/section-settings`
- ✅ Portal / `portal/shuttle-config`
- ✅ Portal / `portal/staffing-config`
- ✅ Portal / `portal/tables-config`
- ✅ Portal / `portal/vendors`
- ✅ Portal / `portal/wedding-details-config`
- ✅ Couple / `couple/hawthorne-manor`
- ✅ Couple / `couple/hawthorne-manor/getting-started`
- ✅ Couple / `couple/hawthorne-manor/chat`
- ✅ Couple / `couple/hawthorne-manor/messages`
- ✅ Couple / `couple/hawthorne-manor/checklist`
- ✅ Couple / `couple/hawthorne-manor/timeline`
- ✅ Couple / `couple/hawthorne-manor/budget`
- ✅ Couple / `couple/hawthorne-manor/contracts`
- ✅ Couple / `couple/hawthorne-manor/guests`
- ✅ Couple / `couple/hawthorne-manor/rsvp-settings`
- ✅ Couple / `couple/hawthorne-manor/seating`
- ✅ Couple / `couple/hawthorne-manor/tables`
- ✅ Couple / `couple/hawthorne-manor/party`
- ✅ Couple / `couple/hawthorne-manor/ceremony`
- ✅ Couple / `couple/hawthorne-manor/rehearsal`
- ✅ Couple / `couple/hawthorne-manor/bar`
- ✅ Couple / `couple/hawthorne-manor/decor`
- ✅ Couple / `couple/hawthorne-manor/photos`
- ✅ Couple / `couple/hawthorne-manor/couple-photo`
- ✅ Couple / `couple/hawthorne-manor/inspo`
- ✅ Couple / `couple/hawthorne-manor/picks`
- ✅ Couple / `couple/hawthorne-manor/beauty`
- ✅ Couple / `couple/hawthorne-manor/vendors`
- ✅ Couple / `couple/hawthorne-manor/preferred-vendors`
- ✅ Couple / `couple/hawthorne-manor/rooms`
- ✅ Couple / `couple/hawthorne-manor/stays`
- ✅ Couple / `couple/hawthorne-manor/transportation`
- ✅ Couple / `couple/hawthorne-manor/allergies`
- ✅ Couple / `couple/hawthorne-manor/guest-care`
- ✅ Couple / `couple/hawthorne-manor/staffing`
- ✅ Couple / `couple/hawthorne-manor/venue-inventory`
- ✅ Couple / `couple/hawthorne-manor/wedding-details`
- ✅ Couple / `couple/hawthorne-manor/worksheets`
- ✅ Couple / `couple/hawthorne-manor/downloads`
- ✅ Couple / `couple/hawthorne-manor/resources`
- ✅ Couple / `couple/hawthorne-manor/website`
- ✅ Couple / `couple/hawthorne-manor/booking`
- ✅ Couple / `couple/hawthorne-manor/final-review`
- ✅ Settings / `settings`
- ✅ Settings / `settings/personality`
- ✅ Settings / `settings/voice`
- ✅ Settings / `super-admin`

---

## Still Needs Manual Review

Automated testing catches structural issues. These still need human eyes:

- [ ] Charts/graphs render with real data (not empty containers)
- [ ] Drag-and-drop interactions work (seating, timeline reordering)
- [ ] Form submissions save and persist correctly
- [ ] Sage AI chat responds coherently with venue voice
- [ ] Cross-page data consistency (portal config ↔ couple portal display)
- [ ] Mobile/tablet responsiveness across breakpoints
- [ ] Correct venue branding per demo venue (not just Hawthorne Manor)
- [ ] Print/PDF export functionality
- [ ] Email notifications trigger correctly
- [ ] Multi-venue scope switching works (Hawthorne → Crestwood → Glass House → Rose Hill)

---
*Screenshots saved to `test-results/` — one per page for visual walkthrough.*