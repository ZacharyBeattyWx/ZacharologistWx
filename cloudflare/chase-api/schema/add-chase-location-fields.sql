ALTER TABLE chase_status ADD COLUMN chase_lat REAL;
ALTER TABLE chase_status ADD COLUMN chase_lon REAL;
ALTER TABLE chase_status ADD COLUMN chase_accuracy REAL;
ALTER TABLE chase_status ADD COLUMN chase_heading REAL;
ALTER TABLE chase_status ADD COLUMN chase_speed REAL;
ALTER TABLE chase_status ADD COLUMN chase_location_updated TEXT;
ALTER TABLE chase_status ADD COLUMN chase_map_display INTEGER DEFAULT 0;
