-- Migración 0033: Campos extendidos para contactos/clientes y catálogo pivote customer_tag

-- 1. Agregar campos de contacto a la tabla customer
ALTER TABLE customer ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 2. Índices para búsqueda eficiente en customer
CREATE INDEX IF NOT EXISTS idx_customer_email ON customer(email);
CREATE INDEX IF NOT EXISTS idx_customer_created_at ON customer(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_full_name ON customer(full_name);

-- 3. Tabla de relación N:M entre customer y tag
CREATE TABLE IF NOT EXISTS customer_tag (
  customer_id UUID NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_tag_customer ON customer_tag(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_tag_tag ON customer_tag(tag_id);
