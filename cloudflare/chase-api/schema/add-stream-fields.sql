ALTER TABLE chase_status ADD COLUMN stream_status TEXT DEFAULT 'Offline';
ALTER TABLE chase_status ADD COLUMN stream_title TEXT DEFAULT '';
ALTER TABLE chase_status ADD COLUMN stream_url TEXT DEFAULT '';
ALTER TABLE chase_status ADD COLUMN stream_embed_url TEXT DEFAULT '';
