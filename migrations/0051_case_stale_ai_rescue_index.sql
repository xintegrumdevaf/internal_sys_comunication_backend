-- 0051_case_stale_ai_rescue_index.sql
-- Índice parcial para que AiWaitingRescueService consulte casos estancados o en espera con IA
-- en O(log K) sobre los pocos casos vivos sin asignar, evitando seq scans al crecer la tabla "case".

CREATE INDEX IF NOT EXISTS idx_case_stale_ai_rescue
  ON "case" (status, last_activity_at)
  WHERE assigned_agent_id IS NULL
    AND status IN ('NEW', 'ACTIVE', 'WAITING_USER');
