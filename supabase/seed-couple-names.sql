-- Backfill realistic couple names for every demo wedding that doesn't have linked
-- people records yet, then point orphaned interactions at the partner1 person.
--
-- Idempotent: skips weddings that already have people, only touches interactions
-- whose person_id is still NULL.

-- ---------------------------------------------------------------------------
-- Task B: Backfill people (partner1 + partner2) for every unnamed demo wedding
-- ---------------------------------------------------------------------------
WITH unnamed_weddings AS (
  SELECT
    w.id,
    w.venue_id,
    ROW_NUMBER() OVER (ORDER BY w.created_at, w.id) AS rn
  FROM weddings w
  WHERE w.venue_id::text LIKE '22222222%'
    AND NOT EXISTS (SELECT 1 FROM people p WHERE p.wedding_id = w.id)
),
name_pool(rn, p1_first, p1_last, p2_first, p2_last) AS (
  VALUES
    (1,  'Sophie',   'Whitfield',  'James',     'Whitfield'),
    (2,  'Amara',    'Osei',       'Daniel',    'Osei'),
    (3,  'Claire',   'Henderson',  'Tom',       'Henderson'),
    (4,  'Priya',    'Mehta',      'Rajan',     'Mehta'),
    (5,  'Lucy',     'Grant',      'Oliver',    'Grant'),
    (6,  'Hannah',   'Webb',       'Marcus',    'Webb'),
    (7,  'Zoe',      'Flynn',      'Patrick',   'Flynn'),
    (8,  'Natalie',  'Sorensen',   'Chris',     'Sorensen'),
    (9,  'Isabel',   'Carver',     'Ben',       'Carver'),
    (10, 'Megan',    'Thornton',   'Jack',      'Thornton'),
    (11, 'Rachel',   'Kim',        'David',     'Kim'),
    (12, 'Emma',     'Foster',     'Liam',      'Foster'),
    (13, 'Chloe',    'Ashford',    'Sam',       'Ashford'),
    (14, 'Grace',    'Bennett',    'Noah',      'Bennett'),
    (15, 'Ava',      'Cole',       'Ethan',     'Cole'),
    (16, 'Lauren',   'Davenport',  'Will',      'Davenport'),
    (17, 'Mia',      'Park',       'Ryan',      'Park'),
    (18, 'Ella',     'Turner',     'Alex',      'Turner'),
    (19, 'Olivia',   'Sinclair',   'Matt',      'Sinclair'),
    (20, 'Sophia',   'Monroe',     'Jake',      'Monroe'),
    (21, 'Aaliyah',  'Brooks',     'Jordan',    'Brooks'),
    (22, 'Maya',     'Russo',      'Nico',      'Russo'),
    (23, 'Bella',    'Voss',       'Theo',      'Voss'),
    (24, 'Ines',     'Ortega',     'Felipe',    'Ortega'),
    (25, 'Hazel',    'Bryant',     'Wyatt',     'Bryant'),
    (26, 'Iris',     'Park',       'Ezra',      'Park'),
    (27, 'Juno',     'Reyes',      'Calvin',    'Reyes'),
    (28, 'Talia',    'Greene',     'Sebastian', 'Greene'),
    (29, 'Mira',     'Klein',      'Adrian',    'Klein'),
    (30, 'Esme',     'Wells',      'Caleb',     'Wells')
)
INSERT INTO people (id, venue_id, wedding_id, role, first_name, last_name, email)
SELECT
  gen_random_uuid(),
  uw.venue_id,
  uw.id,
  'partner1',
  np.p1_first,
  np.p1_last,
  lower(np.p1_first || '.' || np.p1_last || '@email.com')
FROM unnamed_weddings uw
JOIN name_pool np ON np.rn = ((uw.rn - 1) % 30) + 1
UNION ALL
SELECT
  gen_random_uuid(),
  uw.venue_id,
  uw.id,
  'partner2',
  np.p2_first,
  np.p2_last,
  lower(np.p2_first || '.' || np.p2_last || '@email.com')
FROM unnamed_weddings uw
JOIN name_pool np ON np.rn = ((uw.rn - 1) % 30) + 1;

-- ---------------------------------------------------------------------------
-- Task C: Wire orphaned interactions to the wedding's partner1
-- ---------------------------------------------------------------------------
UPDATE interactions i
SET person_id = (
  SELECT id FROM people
  WHERE wedding_id = i.wedding_id AND role = 'partner1'
  LIMIT 1
)
WHERE person_id IS NULL
  AND wedding_id IS NOT NULL
  AND venue_id::text LIKE '22222222%';
