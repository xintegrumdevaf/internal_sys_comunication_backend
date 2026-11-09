-- Migration 0048: Soporte de reintentos con backoff exponencial para destinatarios de campañas
ALTER TABLE campaign_recipient
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_recipient_retry
  ON campaign_recipient (campaign_id, status, next_retry_at);
