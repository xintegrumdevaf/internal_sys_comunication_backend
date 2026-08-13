-- Migracion 0011: opt-in de auto-asignacion por agente.
-- Solo agentes con auto_assign_enabled=true entran al pool de
-- AutoAssignAgentService (ademas de active y pertenencia al departamento).
-- Default false: los agentes existentes no reciben carga automatica hasta
-- que un admin lo active via PUT /api/agents/:id.

ALTER TABLE agent
  ADD COLUMN auto_assign_enabled BOOLEAN NOT NULL DEFAULT false;
