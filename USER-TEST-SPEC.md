# Bloom House E2E Test Spec (User-Supplied)

This file preserves the original test specification prompt so each section
run can reread it. See TEST-PROGRESS.md for the running log and
TEST-FINAL-REPORT.md for the wrap-up.

## Option A (chosen)
Ship coverage for sections that test code that already exists. Produce a
separate "needs building" report for sections that test features not yet
built.

## Worked sections (sequentially)
1. §1 Authentication & Roles
2. §15 Schema & Constraint Integrity (BUG-01/02/03/04/05/06/09 regression)
3. §4 Budget Data Consistency
4. §3 Couple Invitation & Portal Access
5. §12 Staffing
6. §6 Email Pipeline & Agent Draft Flow (Gmail send path mocked)
7. §10 Knowledge Base & Content Uploads
8. §7 Voice Training System
9. §9 Sage (Couple Portal AI) — existing paths only, SKIP BUG-12 rate limiter
10. §8 Intelligence Engine — existing subset, SKIP GAP-12 plan gating, GAP-07 NLQ guard
11. §11 Couple Portal Features — subset, SKIP GAP-11 public RSVP

## Skipped (needs building) sections
- §2 Gmail OAuth (no /api/auth/gmail/callback)
- §5 Stripe checkout
- §8 plan tier gating (GAP-12)
- §8 NLQ empty-data guard (GAP-07)
- §9 persistent rate limiter (BUG-12)
- §11 public RSVP form (GAP-11)
- §13 push notifications (GAP-03)
- §14 data export (GAP-10)

## Ground rules
- Per-section loop: write → run → fix → re-run → gate on green before moving on.
- Seed via service role; teardown per-test.
- Role fixtures: super_admin, org_admin, venue_manager, coordinator, readonly, couple.
- Stripe CLI is skipped (interactive); §5 excluded.
- Resend: real key if present; otherwise assert at route-intercept layer.
- Do not apply migrations — flag BLOCKED if 051/052 missing.
- Commit after each section.
- playwright webServer runs `npm run dev`, baseURL http://localhost:3000.

## Commands
```
npm run test:e2e                 # all projects, sections + pending
npm run test:e2e:desktop         # chromium-desktop only
npm run test:e2e:mobile          # chromium-mobile only
npm run test:e2e:report          # open last HTML report
```
