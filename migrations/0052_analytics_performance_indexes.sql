-- Migración 0052: Índices de alto rendimiento para analítica multi-agente,
-- consultas paginadas de casos/clientes y exportación streaming en áreas de alto volumen.

-- 1. Listado paginado y filtros de casos por departamento y fecha de creación
CREATE INDEX IF NOT EXISTS idx_case_dept_created_at
  ON "case" (department_id, created_at DESC);

-- 2. Conteo y filtrado de casos resueltos/completados por rango de actualización
CREATE INDEX IF NOT EXISTS idx_case_status_updated_at
  ON "case" (status, updated_at DESC);

-- 3. Participación real de agentes mediante mensajes enviados en un caso
CREATE INDEX IF NOT EXISTS idx_message_case_agent_participating
  ON message (case_id, agent_id)
  WHERE author = 'agent' AND agent_id IS NOT NULL AND case_id IS NOT NULL;

-- 4. Eventos de asignación, transferencia y cierre filtrados por tipo y fecha
CREATE INDEX IF NOT EXISTS idx_workflow_event_type_occurred
  ON workflow_event (type, occurred_at DESC);

-- 5. Fallback histórico de transferencias registradas en audit_event
CREATE INDEX IF NOT EXISTS idx_audit_event_action_occurred
  ON audit_event (action, occurred_at DESC);
