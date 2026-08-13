-- Migracion 0011: supervision de calidad de atenciones humanas (Etapa 10).
-- Normativo: docs/spec/07_QUALITY_SUPERVISION.md, DDL en 01_DATA_MODEL.md §2.

-- Atribucion de replies humanos (07 §6).
ALTER TABLE message ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agent(id);
CREATE INDEX IF NOT EXISTS idx_message_agent ON message(agent_id) WHERE agent_id IS NOT NULL;

-- trigger_kind (no TRIGGER: palabra reservada en PostgreSQL). DTO HTTP: `trigger`.
CREATE TABLE IF NOT EXISTS quality_review (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id   UUID NOT NULL REFERENCES conversation(id),
  case_id           UUID NOT NULL REFERENCES "case"(id),
  agent_id          UUID NOT NULL REFERENCES agent(id),
  department_id     UUID REFERENCES department(id),
  cordiality_score  INT CHECK (cordiality_score IS NULL OR (cordiality_score >= 0 AND cordiality_score <= 100)),
  efficiency_notes  TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed','reviewed')),
  trigger_kind      TEXT NOT NULL CHECK (trigger_kind IN ('auto_case_closed','on_demand')),
  model_raw         JSONB,
  idempotency_key   TEXT NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_quality_review_agent_completed ON quality_review(agent_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_quality_review_department_status ON quality_review(department_id, status);
CREATE INDEX IF NOT EXISTS idx_quality_review_case ON quality_review(case_id);

CREATE TABLE IF NOT EXISTS quality_finding (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  review_id    UUID NOT NULL REFERENCES quality_review(id) ON DELETE CASCADE,
  message_id   UUID NOT NULL REFERENCES message(id),
  severity     TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  category     TEXT NOT NULL CHECK (category IN ('aggression','disrespect','neglect','misinformation','inefficiency','other')),
  excerpt      TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quality_finding_review ON quality_finding(review_id);
CREATE INDEX IF NOT EXISTS idx_quality_finding_message ON quality_finding(message_id);

CREATE TABLE IF NOT EXISTS quality_coaching_note (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  review_id         UUID NOT NULL REFERENCES quality_review(id) ON DELETE CASCADE,
  author_agent_id   UUID NOT NULL REFERENCES agent(id),
  body              TEXT NOT NULL,
  ack_status        TEXT NOT NULL DEFAULT 'open' CHECK (ack_status IN ('open','acknowledged')),
  acknowledged_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quality_coaching_note_review ON quality_coaching_note(review_id);
