-- 0036_coverage_zones.sql
-- Almacenamiento de zonas y polígonos de cobertura (KML / GeoJSON) para el motor de ventas y factibilidad técnica.

CREATE TABLE IF NOT EXISTS coverage_zone (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  folder      TEXT,
  city        TEXT NOT NULL,
  coordinates JSONB NOT NULL,
  bbox        JSONB NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coverage_zone_city ON coverage_zone (city);
CREATE INDEX IF NOT EXISTS idx_coverage_zone_active ON coverage_zone (active);
