-- Migración 0035: Tabla de configuración de sistema (canales WhatsApp/Zernio, IA Gemini/Ollama y setup operativo)
CREATE TABLE IF NOT EXISTS system_setting (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES agent(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_system_setting_updated_at ON system_setting(updated_at);
