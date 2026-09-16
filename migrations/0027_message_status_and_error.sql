-- Migracion 0027: Estado y mensaje de error de entrega para mensajes de conversacion
-- Rastrea si un mensaje saliente fue enviado, entregado, leido o si fallo en Meta/Zernio.

ALTER TABLE message ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed'));
ALTER TABLE message ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_message_status_failed ON message(status) WHERE status = 'failed';
