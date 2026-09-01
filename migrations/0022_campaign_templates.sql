-- Migration 0022: Agregar campos de plantillas oficiales de WhatsApp (template_name, template_language) a la tabla campaign

ALTER TABLE campaign
  ADD COLUMN IF NOT EXISTS template_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS template_language VARCHAR(10) NULL DEFAULT 'es';
