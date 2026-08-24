-- Migración 0015: Tablas para la persistencia real de la Base de Conocimiento RAG (PostgreSQL)

CREATE TABLE IF NOT EXISTS rag_documents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'processed',
  chunks_count  INT NOT NULL DEFAULT 0,
  uploaded_by   TEXT NOT NULL DEFAULT 'Admin Sistema',
  source_url    TEXT,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  category      TEXT NOT NULL,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  variations    TEXT[] NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO rag_documents (id, name, category, mime_type, size_bytes, status, chunks_count, uploaded_by)
VALUES
  ('doc-1', 'Manual_Soporte_Tecnico_FTTH_v3.pdf', 'Soporte Técnico', 'application/pdf', 2450000, 'processed', 64, 'Admin Sistema'),
  ('doc-2', 'Politicas_Facturacion_y_Cobranza_2026.pdf', 'Cartera & Cobros', 'application/pdf', 1120000, 'processed', 28, 'Carlos Mendoza'),
  ('doc-3', 'Procedimientos_UTGA_Cambio_Domicilio.pdf', 'UTGA & Operaciones', 'application/pdf', 890000, 'processed', 19, 'Admin Sistema')
ON CONFLICT (id) DO NOTHING;

INSERT INTO rag_faqs (id, question, answer, category, tags, variations, active)
VALUES
  ('faq-1', '¿Cómo consultar el saldo y fecha límite de pago del servicio?', 'El cliente puede enviar la palabra SALDO o su número de cédula/RUC al bot. El sistema consulta automáticamente el ERP y devuelve el valor pendiente, fecha límite de pago y código de pago en bancos autorizados.', 'Cartera & Cobros', ARRAY['saldo', 'factura', 'pago', 'cuentas'], ARRAY['¿Cuánto debo?', 'Ver mi factura', 'Fecha de pago'], true),
  ('faq-2', '¿Qué hacer si la luz PON parpadea en rojo en el módem (ONT)?', 'La luz PON parpadeando o en rojo (LOS) indica una pérdida de señal óptica (fibra cortada o atenuada). Se debe recomendar al cliente no doblar el cable amarillo de fibra y coordinar visita técnica presencial registrando la novedad en el sistema.', 'Soporte Técnico', ARRAY['PON', 'LOS', 'luz roja', 'sin internet', 'fibra'], ARRAY['Luz roja en el router', 'Sin señal de fibra', 'Luz PON intermitente'], true)
ON CONFLICT (id) DO NOTHING;
