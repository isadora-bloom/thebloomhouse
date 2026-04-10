ALTER TABLE decor_inventory ADD COLUMN IF NOT EXISTS image_url text;

-- Seed Unsplash placeholder images for the demo wedding's decor items
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1519225421980-715cb0215aed?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%arch%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1478146059778-26028b07395a?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%farm table%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1606800052052-a08af7148866?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%cross-back%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1519741347686-c1e0aadf4611?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%candelabra%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1591604466107-ec97de577aff?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%bud vase%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%lantern%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%string light%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%card box%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1525772764200-be829a350797?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%welcome sign%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%cake table%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1469371670807-013ccf25f16a?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%sweetheart%';
UPDATE decor_inventory SET image_url = 'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=600' WHERE wedding_id = 'ab000000-0000-0000-0000-000000000001' AND item_name ILIKE '%linen napkin%';
