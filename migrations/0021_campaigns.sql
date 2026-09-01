-- Migration 0021: Tablas para el modulo de campañas masivas (campaigns)

CREATE TABLE IF NOT EXISTS campaign (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  message_body TEXT NOT NULL DEFAULT '',
  quick_mode BOOLEAN NOT NULL DEFAULT FALSE,
  quick_mode_interval_seconds INT NOT NULL DEFAULT 45,
  chat_routing JSONB NOT NULL DEFAULT '{}'::jsonb,
  contact_enrichment JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_recipients INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS campaign_recipient (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  phone VARCHAR(50) NOT NULL,
  name VARCHAR(255) NULL,
  custom_body TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  external_id VARCHAR(255) NULL,
  error_message TEXT NULL,
  sent_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_status ON campaign(status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipient_campaign_status ON campaign_recipient(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipient_phone ON campaign_recipient(phone);
