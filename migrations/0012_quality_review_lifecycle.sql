-- Migracion 0012: ciclo de vida durable de quality_review (cola claim + summary/error).
-- Normativo: docs/spec/07_QUALITY_SUPERVISION.md §4.

ALTER TABLE quality_review
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_quality_review_pending_claim
  ON quality_review (created_at)
  WHERE status = 'pending';
