-- ---------------------------------------------------------------------------
-- 101_demo_floor_plans.sql
-- ---------------------------------------------------------------------------
-- Seed a placeholder floor plan onto the four Crestwood demo venues so
-- /demo/portal/weddings/<id>/table-map renders something useful instead
-- of an empty canvas. Real venues set this through the floor-plan
-- uploader; the demo never goes through that flow, so the table-map page
-- looked broken in the demo even though the route was fine.
--
-- The SVG ships in /public/assets/demo-floor-plan.svg (80ft × 45ft scale).
-- The page reads `floor_plan_url` and `floor_plan_venue_width_ft` out of
-- venue_config.feature_flags.
-- ---------------------------------------------------------------------------

UPDATE venue_config
SET feature_flags = jsonb_set(
  jsonb_set(
    coalesce(feature_flags, '{}'::jsonb),
    '{floor_plan_url}',
    '"/assets/demo-floor-plan.svg"'::jsonb,
    true
  ),
  '{floor_plan_venue_width_ft}',
  '80'::jsonb,
  true
)
WHERE venue_id IN (
  '22222222-2222-2222-2222-222222222201',  -- Hawthorne Manor
  '22222222-2222-2222-2222-222222222202',  -- Crestwood Farm
  '22222222-2222-2222-2222-222222222203',  -- The Glass House
  '22222222-2222-2222-2222-222222222204'   -- Rose Hill Gardens
)
-- Don't clobber a real upload if one already exists.
AND coalesce(feature_flags->>'floor_plan_url', '') = '';

NOTIFY pgrst, 'reload schema';
