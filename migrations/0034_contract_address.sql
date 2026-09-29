-- Migración 0034: Dirección específica por contrato técnico (soporte multi-contrato)
ALTER TABLE contract ADD COLUMN IF NOT EXISTS address TEXT;
