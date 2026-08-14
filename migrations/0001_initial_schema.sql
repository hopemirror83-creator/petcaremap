CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'public-data',
  source_id TEXT NOT NULL UNIQUE,
  business_type TEXT NOT NULL CHECK (business_type IN ('clinic', 'hotel', 'shop')),
  name TEXT NOT NULL,
  display_name TEXT,
  category TEXT,
  city TEXT,
  district TEXT,
  dong TEXT,
  road_address TEXT,
  lot_address TEXT,
  phone TEXT,
  lat REAL,
  lng REAL,
  mapx INTEGER,
  mapy INTEGER,
  naver_place_id TEXT,
  naver_map_url TEXT,
  opening_hours TEXT,
  operation_status TEXT,
  permit_no TEXT,
  permit_date TEXT,
  closed_date TEXT,
  data_base_date TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_businesses_location ON businesses(city, district, dong);
CREATE INDEX IF NOT EXISTS idx_businesses_type ON businesses(business_type);

CREATE TABLE IF NOT EXISTS business_services (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_key TEXT NOT NULL,
  service_label TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'inferred',
  evidence TEXT,
  PRIMARY KEY (business_id, service_key)
);

CREATE TABLE IF NOT EXISTS review_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  excerpt TEXT,
  published_at TEXT,
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, url)
);

CREATE TABLE IF NOT EXISTS generated_pages (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  meta_description TEXT NOT NULL,
  intro_section TEXT NOT NULL,
  service_section TEXT NOT NULL,
  check_section TEXT NOT NULL,
  review_section TEXT NOT NULL,
  field_note_section TEXT NOT NULL,
  caution_points TEXT NOT NULL,
  generated_by TEXT NOT NULL DEFAULT 'template',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS group_pages (
  slug TEXT PRIMARY KEY,
  group_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  intent TEXT,
  generated_body TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target_scope TEXT,
  status TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
