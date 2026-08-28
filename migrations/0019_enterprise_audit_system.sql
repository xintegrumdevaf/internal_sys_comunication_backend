-- Migracion 0018: Sistema de auditoria empresarial (Enterprise Audit System).
-- Normativo: docs/spec/01_DATA_MODEL.md §2, docs/spec/03_API_CONTRACT.md §C.1/§C.2.

ALTER TABLE audit_event
  ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'agent' CHECK (actor_type IN ('agent', 'system', 'customer', 'external_api')),
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES department(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'operational' CHECK (category IN ('security', 'operational', 'data_change', 'system')),
  ADD COLUMN IF NOT EXISTS before_state JSONB,
  ADD COLUMN IF NOT EXISTS after_state JSONB,
  ADD COLUMN IF NOT EXISTS ip_address TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_occurred_at ON audit_event(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_event(actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_event(action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_department ON audit_event(department_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_event(category, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_event(correlation_id) WHERE correlation_id IS NOT NULL;
