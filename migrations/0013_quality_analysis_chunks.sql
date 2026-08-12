-- Migracion 0013: analisis de calidad por tramos + progreso de mensajes.
-- Normativo: docs/spec/07_QUALITY_SUPERVISION.md §4.3.

ALTER TABLE quality_review
  ADD COLUMN IF NOT EXISTS messages_total INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS messages_analyzed INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chunk_size INT NOT NULL DEFAULT 40;

ALTER TABLE quality_review
  DROP CONSTRAINT IF EXISTS quality_review_chunk_size_check;

ALTER TABLE quality_review
  ADD CONSTRAINT quality_review_chunk_size_check
  CHECK (chunk_size >= 10 AND chunk_size <= 80);

ALTER TABLE quality_review
  DROP CONSTRAINT IF EXISTS quality_review_messages_progress_check;

ALTER TABLE quality_review
  ADD CONSTRAINT quality_review_messages_progress_check
  CHECK (messages_analyzed >= 0 AND messages_total >= 0 AND messages_analyzed <= messages_total);
