-- ============================================
-- 044: SEED DEMO INTELLIGENCE INSIGHTS
-- Purpose: Populate intelligence_insights with realistic demo data
-- so the insight feed and cards are not empty during development/demos.
-- ============================================

-- Only insert if the demo venue exists and there are no existing insights
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM venues WHERE id = '22222222-2222-2222-2222-222222222201')
     AND NOT EXISTS (SELECT 1 FROM intelligence_insights WHERE venue_id = '22222222-2222-2222-2222-222222222201' LIMIT 1)
  THEN

INSERT INTO intelligence_insights (venue_id, insight_type, category, title, body, action, priority, confidence, impact_score, data_points, compared_to, expires_at) VALUES

-- 1. Response time correlation (high priority)
('22222222-2222-2222-2222-222222222201', 'correlation', 'response_time',
 'Leads who get a response within 30 minutes book at 2.4x the rate',
 'Your leads responded to within 30 minutes convert at 48%, compared to 20% for leads waiting 4+ hours. This pattern holds across 37 data points with high confidence.',
 'Prioritize sub-30-minute responses. Consider enabling auto-send for high-confidence drafts.',
 'high', 0.85, 12000,
 '{"fast_conversion": 0.48, "slow_conversion": 0.20, "fast_count": 18, "slow_count": 19, "threshold_minutes": 30}',
 'self_historical', NOW() + INTERVAL '14 days'),

-- 2. Day-of-week tour pattern (medium priority)
('22222222-2222-2222-2222-222222222201', 'correlation', 'lead_conversion',
 'Thursday tours convert at 2x the rate of Saturday tours',
 'Tours conducted on Thursday have a 62% booking rate versus 31% for Saturday tours. Thursday visitors may be more serious buyers, while Saturday tours attract more casual browsers. Based on 28 tours over the past 6 months.',
 'Consider offering premium Thursday tour slots and reducing Saturday tour capacity.',
 'medium', 0.72, 8500,
 '{"thursday_conversion": 0.62, "saturday_conversion": 0.31, "thursday_tours": 13, "saturday_tours": 15, "period_months": 6}',
 'self_historical', NOW() + INTERVAL '21 days'),

-- 3. Source quality anomaly (high priority)
('22222222-2222-2222-2222-222222222201', 'anomaly', 'source_attribution',
 'WeddingWire leads down 40% month-over-month with no spend change',
 'WeddingWire generated 12 inquiries last month versus 20 the month before — a 40% drop. Your ad spend on the platform is unchanged at $800/month. This may indicate a listing position change, seasonal shift, or competitor activity.',
 'Review your WeddingWire listing position and photos. Check if competitors have boosted their presence.',
 'high', 0.78, 6400,
 '{"current_month_inquiries": 12, "previous_month_inquiries": 20, "change_pct": -0.40, "monthly_spend": 800, "platform": "WeddingWire"}',
 'last_month', NOW() + INTERVAL '7 days'),

-- 4. Capacity opportunity (medium priority)
('22222222-2222-2222-2222-222222222201', 'opportunity', 'capacity',
 'March 2027 has 3 open Saturdays — historically your highest-demand month',
 'You have 3 of 4 Saturdays still available in March 2027, but March historically fills by October. Current inquiry pipeline shows only 1 March inquiry. You may be underpricing or under-promoting.',
 'Send a targeted email to your inquiry list highlighting March availability. Consider a limited-time pricing incentive.',
 'medium', 0.68, 15000,
 '{"open_saturdays": 3, "total_saturdays": 4, "month": "March 2027", "historical_fill_by": "October", "current_inquiries": 1}',
 'same_month_last_year', NOW() + INTERVAL '30 days'),

-- 5. Pricing benchmark (low priority)
('22222222-2222-2222-2222-222222222201', 'benchmark', 'pricing',
 'Your average booking value is 12% above the regional median',
 'Your average booking of $18,500 places you in the 68th percentile for premium venues in Virginia. Comparable venues range from $14,000 to $22,000. You have room to adjust pricing without losing competitive position.',
 NULL,
 'low', 0.80, 3200,
 '{"your_average": 18500, "regional_median": 16500, "percentile": 68, "range_low": 14000, "range_high": 22000, "tier": "premium"}',
 'industry', NOW() + INTERVAL '60 days'),

-- 6. Lead conversion risk (critical)
('22222222-2222-2222-2222-222222222201', 'risk', 'lead_conversion',
 '4 leads stalled in pipeline for 14+ days without follow-up',
 'Four leads that last had activity more than 14 days ago are sitting in your pipeline with a combined estimated value of $72,000. Leads that go quiet for this long historically convert at only 8%, compared to 34% for actively engaged leads.',
 'Send a personalized re-engagement email to each stalled lead this week. Consider a "just checking in" template.',
 'critical', 0.90, 72000,
 '{"stalled_count": 4, "stalled_value": 72000, "days_threshold": 14, "stalled_conversion": 0.08, "active_conversion": 0.34}',
 'self_historical', NOW() + INTERVAL '7 days'),

-- 7. Seasonal prediction (medium)
('22222222-2222-2222-2222-222222222201', 'prediction', 'seasonal',
 'Inquiry volume expected to spike 35% in the next 3 weeks based on historical patterns',
 'April is historically your second-busiest inquiry month. Over the past 2 years, inquiry volume increased 35% from late March through mid-April. Ensure your response capacity can handle the surge.',
 'Pre-draft common response templates and consider turning on auto-send for routine inquiries during peak.',
 'medium', 0.65, 5000,
 '{"expected_increase_pct": 0.35, "peak_month": "April", "years_of_data": 2, "avg_peak_inquiries_per_week": 8}',
 'same_month_last_year', NOW() + INTERVAL '21 days'),

-- 8. Team performance recommendation (high)
('22222222-2222-2222-2222-222222222201', 'recommendation', 'team_performance',
 'AI-drafted responses approved without edits convert 18% better than heavily edited ones',
 'When coordinators approve AI drafts as-is, leads convert at 42%. When drafts are edited more than 50%, conversion drops to 24%. The AI voice may be better calibrated to your brand than manual rewrites. Based on 45 approved drafts.',
 'Review the most-edited drafts to understand the gap. Consider running a voice training session to align the AI more closely.',
 'high', 0.75, 9000,
 '{"approve_as_is_conversion": 0.42, "heavy_edit_conversion": 0.24, "total_drafts": 45, "as_is_count": 28, "heavy_edit_count": 17}',
 'self_historical', NOW() + INTERVAL '14 days'),

-- 9. Couple behavior trend (low)
('22222222-2222-2222-2222-222222222201', 'trend', 'couple_behavior',
 'Average guest count trending up: 165 this year vs 142 last year',
 'The average guest count for bookings this year is 165, up from 142 last year — a 16% increase. This affects catering minimums, table configurations, and shuttle capacity planning.',
 NULL,
 'low', 0.70, 2000,
 '{"current_year_avg": 165, "last_year_avg": 142, "change_pct": 0.16, "current_year_bookings": 12, "last_year_bookings": 18}',
 'last_year', NOW() + INTERVAL '30 days'),

-- 10. Weather competitive insight (medium)
('22222222-2222-2222-2222-222222222201', 'recommendation', 'competitive',
 'Couples who mention rain plans in inquiries book at 1.8x the rate',
 'Couples who ask about rain contingency plans in their initial inquiry are significantly more likely to book. This suggests they are further along in their venue decision process and value your outdoor space. 23 of 67 inquiries mentioned rain plans.',
 'Include a proactive rain plan section in your auto-response template to address this concern upfront.',
 'medium', 0.71, 7500,
 '{"rain_mention_conversion": 0.52, "no_mention_conversion": 0.29, "rain_mention_count": 23, "total_inquiries": 67}',
 'self_historical', NOW() + INTERVAL '21 days');

  END IF;
END $$;
