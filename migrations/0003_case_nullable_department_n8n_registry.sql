-- Migracion 0003 (Etapa 2, docs/spec/01_DATA_MODEL.md v3 §2):
--
-- Las tablas "case"/workflow_instance/workflow_execution/workflow_event/
-- automation_state/escalation ya existian desde la migracion 0001 (se aplico
-- el DDL completo de 01_DATA_MODEL.md en la Etapa 0), pero con la forma v1/v2:
-- "case".department_id y escalation.department_id eran NOT NULL, y no existia
-- "case".assigned_agent_id ni la tabla n8n_workflow_registry.
--
-- v3 introduce el pool de triage (02_STATE_MACHINE.md §10): un caso puede no
-- tener departamento resuelto todavia, y una escalacion puede caer sin
-- clasificar. Tambien introduce case.assigned_agent_id (bandeja compartida,
-- 01_DATA_MODEL.md §7) y el catalogo n8n_workflow_registry (poblado en la
-- Etapa 3-4, se crea ahora junto con el resto de tablas de negocio de esta
-- etapa por completitud del esquema).

ALTER TABLE "case" ALTER COLUMN department_id DROP NOT NULL;

ALTER TABLE "case" ADD COLUMN assigned_agent_id UUID REFERENCES agent(id);
CREATE INDEX idx_case_assigned_agent ON "case"(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;

ALTER TABLE escalation ALTER COLUMN department_id DROP NOT NULL;

CREATE TABLE n8n_workflow_registry (
  action        TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  description   TEXT,
  timeout_ms    INT NOT NULL DEFAULT 8000,
  max_retries   INT NOT NULL DEFAULT 2,
  active        BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID REFERENCES agent(id)
);
