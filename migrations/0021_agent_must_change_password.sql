-- docs/spec/06_BACKEND_GAPS.md §1.b: Bandera para forzar cambio de contraseña en primer login
ALTER TABLE agent
ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT true;
