CREATE TABLE IF NOT EXISTS chase_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  target_area TEXT NOT NULL,
  current_location TEXT NOT NULL,
  headline TEXT NOT NULL,
  discussion TEXT NOT NULL,
  hazards TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  next_update TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  is_live INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO chase_status (
  id,
  status,
  target_area,
  current_location,
  headline,
  discussion,
  hazards,
  confidence,
  next_update,
  last_updated,
  is_live
) VALUES (
  1,
  'Monitoring',
  'NC / VA / SC',
  'Not actively chasing',
  'Monitoring potential chase opportunities',
  'No active chase is currently underway. Updates will appear here when operations are active.',
  '["Large Hail","Tornadoes","Damaging Winds"]',
  75,
  'As needed',
  '2026-06-04T18:00:00-04:00',
  0
);
