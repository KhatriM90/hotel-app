-- 0019 K1 Klubhouse Parklands: the real room list.
--
-- Manish sent K1's active rooms on 7 Nov 2026: SAP items K1-AC0008 to
-- K1-AC0029, "ROOM 108" to "ROOM 129" (22 rooms). The seed had 13 invented
-- rooms (101-107, 201-206). Room types are not known yet, so the real rooms
-- keep the placeholder types STD / DLX / STE until the client sends them.
--
-- The lock software at K1 reception (HData.mdb, building "PSH") has door
-- addresses for 17 of these rooms: 108-122, 124 and 125. Rooms 123 and
-- 126-129 have none yet and are left blank.
--
-- On a fresh database the seed creates these rooms itself (room types come
-- from the seed, which runs after migrations), so this migration only acts
-- where the K1 placeholder types already exist. The invented rooms are not
-- deleted, because stays may point at them: they become unsellable, which
-- takes them out of availability, the room board and counts.

WITH k1 AS (SELECT id FROM properties WHERE code = 'K1'),
real_rooms (number, type_code) AS (
  SELECT n::text, CASE WHEN n <= 119 THEN 'STD' WHEN n <= 127 THEN 'DLX' ELSE 'STE' END
    FROM generate_series(108, 129) AS n
)
INSERT INTO rooms (property_id, room_type_id, number, floor, building, notes)
SELECT k1.id, t.id, r.number, '1', 'Main', 'Room type is a placeholder until K1 sends its room types'
  FROM k1
  JOIN real_rooms r ON true
  JOIN room_types t ON t.property_id = k1.id AND t.code = r.type_code
ON CONFLICT (property_id, number) DO UPDATE
  SET is_sellable = true, active_to = NULL;

UPDATE rooms SET is_sellable = false,
       notes = 'Invented test room, retired 7 Nov 2026 when K1''s real rooms (108-129) were loaded'
 WHERE property_id = (SELECT id FROM properties WHERE code = 'K1')
   AND number IN ('101', '102', '103', '104', '105', '106', '107', '201', '202', '203', '204', '205', '206');

UPDATE rooms r SET lock_address = v.addr
  FROM (VALUES
    ('108', '01010100100'), ('109', '01010100200'), ('110', '01010100300'), ('111', '01010100400'),
    ('112', '01010100500'), ('113', '01010100600'), ('114', '01010100700'), ('115', '01010100800'),
    ('116', '01010100900'), ('117', '01010101000'), ('118', '01010101100'), ('119', '01010101200'),
    ('120', '01010101300'), ('121', '01010101400'), ('122', '01010101500'), ('124', '01010101700'),
    ('125', '01010101800')
  ) AS v (number, addr)
 WHERE r.property_id = (SELECT id FROM properties WHERE code = 'K1')
   AND r.number = v.number
   AND r.lock_address IS NULL
   AND NOT EXISTS (SELECT 1 FROM rooms o WHERE o.property_id = r.property_id AND o.lock_address = v.addr);
