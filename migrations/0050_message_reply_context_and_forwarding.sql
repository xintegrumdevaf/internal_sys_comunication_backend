-- 0050_message_reply_context_and_forwarding.sql
-- Agrega soporte para mensajes citados (reply-to / context) y reenvíos (forwarded) en la tabla message.

ALTER TABLE message
  ADD COLUMN IF NOT EXISTS reply_to_external_id TEXT,
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES message(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_message_reply_to_ext
  ON message (conversation_id, reply_to_external_id)
  WHERE reply_to_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_reply_to_id
  ON message (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

