-- Migración 0047: Índices de alto rendimiento para supervisión de calidad y atribución de mensajes
-- Normativo: Optimización Big O de getAgentStats y listReviews (docs/spec/07_QUALITY_SUPERVISION.md)

-- 1. Optimización para filtrado y agrupación de casos por agente y fecha de actualización
CREATE INDEX IF NOT EXISTS idx_case_assigned_status_updated
  ON "case" (assigned_agent_id, status, updated_at)
  WHERE assigned_agent_id IS NOT NULL;

-- 2. Optimización para búsqueda de respuestas de asesores humanos (O(log M) index seek vs O(M) seq scan)
CREATE INDEX IF NOT EXISTS idx_message_case_author
  ON message (case_id, author)
  WHERE case_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_conv_agent_author
  ON message (conversation_id, agent_id, author)
  WHERE agent_id IS NOT NULL;

-- 3. Optimización para agregación de estadísticas de quality_review y DISTINCT ON
CREATE INDEX IF NOT EXISTS idx_quality_review_agent_created
  ON quality_review (agent_id, created_at, status, cordiality_score);

CREATE INDEX IF NOT EXISTS idx_quality_review_distinct_case_agent
  ON quality_review (case_id, agent_id, created_at DESC);

-- 4. Optimización Index-Only Scan para conteo de severidad en hallazgos de calidad
CREATE INDEX IF NOT EXISTS idx_quality_finding_review_severity
  ON quality_finding (review_id, severity);

