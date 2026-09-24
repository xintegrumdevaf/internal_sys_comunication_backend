-- Migración 0028: Prompts dinámicos versionados y políticas de guardrails
-- Permite autogestionar prompts con versionado, rollback y simulación sin recompilar el backend

CREATE TABLE IF NOT EXISTS ai_prompt_templates (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT,
  department_id     UUID REFERENCES department(id) ON DELETE SET NULL,
  allowed_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  active_version_id UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id    UUID NOT NULL REFERENCES ai_prompt_templates(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  system_prompt  TEXT NOT NULL,
  user_template  TEXT NOT NULL,
  model_config   JSONB NOT NULL DEFAULT '{"temperature": 0.2, "max_tokens": 1024}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  change_notes   TEXT,
  created_by     UUID REFERENCES agent(id) ON DELETE SET NULL,
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_prompt_version UNIQUE(template_id, version_number)
);

-- Agregar FK de active_version_id después de crear la tabla de versiones
ALTER TABLE ai_prompt_templates 
  ADD CONSTRAINT fk_prompt_active_version 
  FOREIGN KEY (active_version_id) 
  REFERENCES ai_prompt_versions(id) 
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_prompt_templates_slug ON ai_prompt_templates(slug);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_template ON ai_prompt_versions(template_id, version_number);

-- Políticas de guardrails (anti-hostilidad, anti-aturdimiento)
CREATE TABLE IF NOT EXISTS ai_guardrail_policies (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sembrado inicial de plantillas del sistema
INSERT INTO ai_prompt_templates (slug, name, description, allowed_variables)
VALUES 
  (
    'interpret_message',
    'Interpretación de Mensajes Inbound (NLU)',
    'Clasificación de intenciones, extracción de entidades y decisión de tipo de interacción',
    '["text", "recentMessages", "activeCase", "pendingQuestion"]'::jsonb
  ),
  (
    'compose_reply',
    'Redacción de Respuestas al Cliente',
    'Generación de mensaje conversacional empático y natural para WhatsApp en base a resultados de workflows',
    '["clientName", "clientFirstName", "stepOutcome", "templateHint", "missingFields", "workflowType"]'::jsonb
  ),
  (
    'refine_tone',
    'Refinamiento de Tono para Respuestas Rápidas',
    'Asistente para operadores que mejora la empatía y calidez sin alterar datos sensibles ni montos',
    '["originalText", "contextHint"]'::jsonb
  )
ON CONFLICT (slug) DO NOTHING;

-- Sembrado inicial de guardrails
INSERT INTO ai_guardrail_policies (slug, name, description, enabled, config)
VALUES (
  'anti_hostility_and_refusal',
  'Protección Anti-Hostilidad y Rechazo de Datos',
  'Frena el bot ante lenguaje ofensivo o negativa de cooperar y escala inmediatamente a un humano',
  true,
  '{"escalateOnProfanity": true, "escalateOnRefusal": true, "maxWaitingAttempts": 2, "apologyMessage": "Comprendo tu molestia y te pido disculpas. En este momento transfiero tu conversación a un asesor para que te atienda personalmente."}'::jsonb
)
ON CONFLICT (slug) DO NOTHING;
