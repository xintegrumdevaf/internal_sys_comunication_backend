-- Migración 0025: Soporte para mensajes editados por clientes (WhatsApp Inbound Edits)
-- Permite registrar la fecha de última edición y el histórico de cambios de texto para trazabilidad y auditoría.

ALTER TABLE message
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edit_history JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_message_edited ON message(edited_at) WHERE edited_at IS NOT NULL;
