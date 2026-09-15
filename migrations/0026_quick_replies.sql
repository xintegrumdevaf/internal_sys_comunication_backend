-- Migración 0026: Respuestas Rápidas (Quick Replies / Fast Replies) estilo Whaticket
-- Permite disponer de atajos predefinidos con variables dinámicas para agentes humanos y para la IA,
-- con alcance General (department_id IS NULL) o por Departamento.

CREATE TABLE IF NOT EXISTS quick_reply (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shortcut            VARCHAR(64) NOT NULL,
  title               VARCHAR(150) NOT NULL,
  body                TEXT NOT NULL,
  department_id       UUID REFERENCES department(id) ON DELETE CASCADE,
  category            VARCHAR(50),
  media_url           TEXT,
  created_by_agent_id UUID REFERENCES agent(id) ON DELETE SET NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidad del atajo en ámbito Global (sin departamento)
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_reply_global_shortcut 
  ON quick_reply (LOWER(shortcut)) 
  WHERE department_id IS NULL;

-- Unicidad del atajo por Departamento
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_reply_dept_shortcut 
  ON quick_reply (department_id, LOWER(shortcut)) 
  WHERE department_id IS NOT NULL;

-- Índice para acelerar listados por departamento y estado activo
CREATE INDEX IF NOT EXISTS idx_quick_reply_dept_active 
  ON quick_reply (department_id, active);
