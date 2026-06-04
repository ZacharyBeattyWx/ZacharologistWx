ALTER TABLE chase_status ADD COLUMN chase_probability INTEGER NOT NULL DEFAULT 75;
ALTER TABLE chase_status ADD COLUMN chase_probability_label TEXT NOT NULL DEFAULT 'High';
