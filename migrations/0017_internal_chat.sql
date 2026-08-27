-- Migracion 0017: Chat interno persistente entre agentes / staff y citas de calidad (Etapa 11).
-- Normativo: docs/spec/07_QUALITY_SUPERVISION.md §8, DDL en 01_DATA_MODEL.md §2, contratos en 03_API_CONTRACT.md §C.1/§C.3/§C.4.

CREATE TABLE IF NOT EXISTS internal_thread (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type         TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'quality_coaching')),
  reference_id UUID,                                -- opcional: quality_review_id, case_id, etc.
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_internal_thread_updated ON internal_thread(updated_at DESC);

CREATE TABLE IF NOT EXISTS internal_thread_participant (
  thread_id     UUID NOT NULL REFERENCES internal_thread(id) ON DELETE CASCADE,
  agent_id      UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  last_read_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_internal_participant_agent ON internal_thread_participant(agent_id);

CREATE TABLE IF NOT EXISTS internal_message (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  thread_id        UUID NOT NULL REFERENCES internal_thread(id) ON DELETE CASCADE,
  sender_agent_id  UUID NOT NULL REFERENCES agent(id),
  type             TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'quality_quote', 'conversation_excerpt')),
  body             TEXT NOT NULL,
  context_data     JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_internal_message_thread ON internal_message(thread_id, created_at ASC);
