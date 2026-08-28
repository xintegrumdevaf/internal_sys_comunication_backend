CREATE TABLE IF NOT EXISTS message_templates (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(50) NOT NULL,
  language VARCHAR(20) NOT NULL DEFAULT 'es',
  header_type VARCHAR(20) NOT NULL DEFAULT 'NONE',
  header_content TEXT,
  body_text TEXT NOT NULL,
  footer_text TEXT,
  buttons JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  meta_template_id VARCHAR(255),
  rejected_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_templates_status ON message_templates(status);
CREATE INDEX IF NOT EXISTS idx_message_templates_category ON message_templates(category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_name ON message_templates(name);
