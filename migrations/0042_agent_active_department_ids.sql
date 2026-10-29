-- Migracion 0041: Colas de departamentos activas por agente para auto-asignacion granular.
-- active_department_ids define en que departamentos especificos el agente esta atendiendo
-- en este turno/guardia. Si es NULL o vacio, por defecto atiende en su primary_department_id.

ALTER TABLE agent
  ADD COLUMN IF NOT EXISTS active_department_ids UUID[] DEFAULT NULL;
