-- Migración 0053: Departamento de respaldo (overflow) e índice de colas pendientes sin asignar

ALTER TABLE department
  ADD COLUMN IF NOT EXISTS fallback_department_id UUID REFERENCES department(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_department_fallback_not_self'
  ) THEN
    ALTER TABLE department
      ADD CONSTRAINT chk_department_fallback_not_self
      CHECK (fallback_department_id IS NULL OR fallback_department_id <> id);
  END IF;
END $$;

-- Índice parcial para que el watcher de desborde encuentre escalamientos PENDING antiguos en O(log N)
CREATE INDEX IF NOT EXISTS idx_escalation_pending_overflow
  ON escalation (status, created_at ASC)
  WHERE status = 'PENDING' AND assigned_agent_id IS NULL;
