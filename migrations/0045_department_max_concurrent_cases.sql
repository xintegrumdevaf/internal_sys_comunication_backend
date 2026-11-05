-- migrations/0045_department_max_concurrent_cases.sql
-- Cupo máximo de casos activos concurrentes por agente en este departamento (default: 6)
-- para despacho progresivo (Paced FIFO Dispatch / Concurrency Cap) de la cola de escalación.

ALTER TABLE department
  ADD COLUMN IF NOT EXISTS max_concurrent_cases INTEGER NOT NULL DEFAULT 6;

COMMENT ON COLUMN department.max_concurrent_cases IS 'Límite de casos concurrentes en estado HUMAN_ACTIVE por agente antes de pausar la auto-asignación automática hacia ese agente.';

