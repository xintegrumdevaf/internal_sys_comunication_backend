-- Catálogo de etiquetas (tags) administrables
CREATE TABLE IF NOT EXISTS tag (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100) NOT NULL UNIQUE,
  description   TEXT,
  color         VARCHAR(50),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tag_name ON tag(name);

-- Seed de etiquetas iniciales
INSERT INTO tag (name, description, color) VALUES
  ('PRUEBA INFORMACION', 'esta es una prueba', 'ambar'),
  ('AGENDADO', 'Seguimiento estándar agendado', 'ambar'),
  ('POSPUESTO', 'Postergado por el cliente', NULL),
  ('MONITOREO', 'En observación técnica de servicio', 'azul'),
  ('REVISION_TECNICA', 'Revisión en nodo/campo', 'esmeralda'),
  ('LLAMAR_LUEGO', 'Contactar en horario preferido', 'morado'),
  ('PAGO_PENDIENTE', 'Esperando pago o comprobante', 'rojo'),
  ('CONFIRMACION_SERVICIO', 'Validar calidad tras mantenimiento', 'cian')
ON CONFLICT (name) DO NOTHING;
