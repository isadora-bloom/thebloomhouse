-- 417_vendor_attributes_and_type_vocabulary
--
-- Two halves of the same complaint from the 2026-07-26 Rixey parity
-- audit, Theme 7: "Preferred-vendors attribute filters + trust badges".
--
-- Half one, the columns. The Rixey portal lets a couple narrow the
-- directory to local vendors, budget-friendly ones, and the ones who
-- have worked the venue more than once, and puts the same three on the
-- card as badges (src/components/PreferredVendors.jsx, TOGGLES). Bloom's
-- vendor_recommendations had none of the three, so the couple page could
-- only filter by category. Rixey's fourth column, has_multiple_events,
-- keeps its name here so the standalone vendor network lines up when it
-- merges in; only the wording changes, because "Rixey veteran" does not
-- travel to other venues.
--
-- Half two, the vocabulary. vendor_type was free text written by two
-- surfaces that disagreed. On 2026-09-17 the live table held, across 28
-- rows and 4 venues: photography(4) AND photographer(1), florals(3) AND
-- florist(2), catering(2) AND caterer(2), plus cake, music, videography
-- and bartender. The couple page keyed a label map on exact strings, so
-- 13 of the 28 rendered as "Other" — in an "Other" pill next to the
-- correctly-labelled one. The folds below are the unambiguous ones, and
-- they match src/lib/vendors/vendor-types.ts, which both surfaces now
-- read. Unrecognised spellings are deliberately LEFT ALONE: the code
-- humanises them from their own text, so nothing is lost by not guessing.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the UPDATE is a no-op once
-- the values are folded.

ALTER TABLE public.vendor_recommendations
  ADD COLUMN IF NOT EXISTS is_local boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_budget_friendly boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_multiple_events boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.vendor_recommendations.is_local IS
  'Venue-set: vendor is local to the venue. Couple-facing filter + badge.';
COMMENT ON COLUMN public.vendor_recommendations.is_budget_friendly IS
  'Venue-set: vendor is a budget-friendly option. Couple-facing filter + badge.';
COMMENT ON COLUMN public.vendor_recommendations.has_multiple_events IS
  'Venue-set: vendor has worked this venue more than once. Rixey called this "3+ Rixey weddings"; the badge reads "Knows the venue".';

-- Fold the synonyms onto the canonical keys from
-- src/lib/vendors/vendor-types.ts. Keep this list and that file in step.
UPDATE public.vendor_recommendations
   SET vendor_type = canonical.key
  FROM (VALUES
    ('photography',    'photographer'),
    ('photo',          'photographer'),
    ('photos',         'photographer'),
    ('videography',    'videographer'),
    ('video',          'videographer'),
    ('cinematographer','videographer'),
    ('cinematography', 'videographer'),
    ('florals',        'florist'),
    ('floral',         'florist'),
    ('flowers',        'florist'),
    ('florists',       'florist'),
    ('catering',       'caterer'),
    ('caterers',       'caterer'),
    ('food',           'caterer'),
    ('food_truck',     'caterer'),
    ('cake',           'baker'),
    ('cakes',          'baker'),
    ('bakery',         'baker'),
    ('baking',         'baker'),
    ('desserts',       'baker'),
    ('dessert',        'baker'),
    ('bar',            'bartender'),
    ('bartending',     'bartender'),
    ('bartenders',     'bartender'),
    ('bar_service',    'bartender'),
    ('live_music',     'music'),
    ('musician',       'music'),
    ('musicians',      'music'),
    ('ceremony_music', 'music'),
    ('hair',           'hair_makeup'),
    ('makeup',         'hair_makeup'),
    ('hair_and_makeup','hair_makeup'),
    ('hmua',           'hair_makeup'),
    ('beauty',         'hair_makeup'),
    ('coordinator',    'planner'),
    ('planning',       'planner'),
    ('day_of_coordinator', 'planner'),
    ('wedding_planner','planner'),
    ('rental',         'rentals'),
    ('decor',          'rentals'),
    ('furniture',      'rentals'),
    ('stationer',      'stationery'),
    ('stationary',     'stationery'),
    ('invitations',    'stationery'),
    ('transport',      'transportation'),
    ('shuttle',        'transportation'),
    ('limo',           'transportation'),
    ('celebrant',      'officiant'),
    ('minister',       'officiant'),
    ('uplighting',     'lighting')
  ) AS canonical(synonym, key)
 WHERE regexp_replace(
         regexp_replace(lower(btrim(vendor_recommendations.vendor_type)), '[\s\-/&]+', '_', 'g'),
         '_+', '_', 'g'
       ) = canonical.synonym
   AND vendor_recommendations.vendor_type <> canonical.key;

-- Title Case and spacing the staff editor used to write ("Hair & Makeup",
-- "Photographer") fold to their own canonical key by the same slugify.
UPDATE public.vendor_recommendations
   SET vendor_type = slugged.key
  FROM (
    SELECT id,
           regexp_replace(
             regexp_replace(lower(btrim(vendor_type)), '[\s\-/&]+', '_', 'g'),
             '_+', '_', 'g'
           ) AS key
      FROM public.vendor_recommendations
  ) AS slugged
 WHERE slugged.id = vendor_recommendations.id
   AND slugged.key IN (
     'photographer','videographer','florist','dj','band','music','caterer',
     'baker','bartender','officiant','planner','rentals','hair_makeup',
     'transportation','lighting','stationery','other'
   )
   AND vendor_recommendations.vendor_type <> slugged.key;
