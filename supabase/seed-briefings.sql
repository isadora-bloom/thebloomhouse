-- P4.1: Seed ai_briefings for Hawthorne Manor (venue 201)
-- content is jsonb: { title, body, summary }

-- Clean prior seeded briefings in this window (idempotent)
DELETE FROM public.ai_briefings
WHERE venue_id = '22222222-2222-2222-2222-222222222201'
  AND created_at >= '2026-03-10'
  AND created_at <= '2026-03-31'
  AND briefing_type IN ('weekly');

INSERT INTO public.ai_briefings (id, venue_id, briefing_type, content, delivered_via, delivered_at, created_at)
VALUES
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222201',
    'weekly',
    jsonb_build_object(
      'title', '3 leads need attention this week',
      'summary', 'Three time-sensitive items: a Whitfield follow-up is overdue, October Saturdays at Hawthorne are filling up, and one Rose Hill proposal has gone cold.',
      'body', 'Sophie Whitfield and James Whitfield haven''t responded to your last follow-up (sent March 28). It''s been 3 days — a gentle nudge would be timely. Your October dates at Hawthorne Manor are filling up: you have 3 Saturdays left in October and 2 active inquiries interested in that month. Worth mentioning availability in your next outreach. Crestwood Farm''s average response time this week was 71 minutes — up from your usual 45. Nothing urgent, but worth keeping an eye on if it continues. One couple (Ella Turner, Rose Hill Gardens) has been in ''Proposal Sent'' for 19 days with no reply. Consider moving to your re-engagement sequence.'
    ),
    'in_app',
    '2026-03-31 07:30:00+00',
    '2026-03-31 07:30:00+00'
  ),
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222201',
    'weekly',
    jsonb_build_object(
      'title', 'Strong week — 2 new inquiries, 1 booking confirmed',
      'summary', 'Ava Cole booked The Glass House, two new inquiries landed, and lead response time across the portfolio is beating industry averages.',
      'body', 'Ava Cole officially booked The Glass House for May 2026 — congratulations! That brings The Glass House to 4 confirmed bookings for the year. Two new inquiries came in this week: Chloe Ashford (Glass House, budget $45k) and Ella Turner (Rose Hill, budget $15k). Both received automated first responses via Sage within 4 minutes. Your lead response time across all venues averaged 32 minutes this week — well below the industry average of 18 hours. This is a real competitive advantage worth highlighting in your marketing.'
    ),
    'in_app',
    '2026-03-24 07:30:00+00',
    '2026-03-24 07:30:00+00'
  ),
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222201',
    'weekly',
    jsonb_build_object(
      'title', 'April and May availability getting tight at Hawthorne',
      'summary', 'Spring Saturdays at Hawthorne are almost gone, Glass House tour conversion is at 67%, and Sage flagged two bar-package knowledge gaps.',
      'body', 'Hawthorne Manor has only 2 open Saturdays remaining in April and 3 in May. If you have any warm leads interested in spring dates, now is the time to create urgency in your follow-ups. The Glass House tour conversion rate for Q1 is running at 67% — meaning 2 out of 3 couples who tour are booking. That''s excellent. If you have capacity for more tours, consider promoting them more actively. Knowledge base note: Sage flagged 2 questions she couldn''t answer confidently this week — both about the bar package upgrade options. Consider adding detail to your KB about bar pricing tiers.'
    ),
    'in_app',
    '2026-03-17 07:30:00+00',
    '2026-03-17 07:30:00+00'
  ),
  (
    gen_random_uuid(),
    '22222222-2222-2222-2222-222222222201',
    'weekly',
    jsonb_build_object(
      'title', 'Season trend: inquiries up 40% vs this time last year',
      'summary', 'Portfolio inquiries are up 40% YoY, Rose Hill is converting below average, and Claire Henderson''s guest count is due April 15th.',
      'body', 'Inquiry volume across all four venues is running 40% higher than the same period in 2025. This is consistent with broader industry trends showing a post-pandemic surge in 2026/2027 weddings. Rose Hill Gardens is receiving more inquiries than this time last year but has the lowest conversion rate (31% vs 48% portfolio average). It may be worth reviewing the initial response templates for Rose Hill specifically. Reminder: Claire Henderson''s final guest count is due by April 15th. It''s worth a proactive message from Jordan before the deadline.'
    ),
    'in_app',
    '2026-03-10 07:30:00+00',
    '2026-03-10 07:30:00+00'
  );
