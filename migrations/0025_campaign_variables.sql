-- Migration 0025: Soporte de variable_mapping en campaign y variables en campaign_recipient

ALTER TABLE campaign
  ADD COLUMN IF NOT EXISTS variable_mapping JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE campaign_recipient
  ADD COLUMN IF NOT EXISTS variables JSONB NOT NULL DEFAULT '{}'::jsonb;
