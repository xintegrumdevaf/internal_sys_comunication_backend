-- Migracion 0002: correccion senalada al inicio de docs/spec/05_BUILD_PLAN.md (v3).
-- La Etapa 1 se construyo contra una version anterior del paquete de specs,
-- antes de que existieran `agent.role` y `department.visibility`.
--
-- - department.visibility: 'shared' (default, visible a todos los agentes en
--   lectura) | 'restricted' (solo agentes con agent_membership en el depto).
-- - agent.role: reemplaza el booleano agent.is_global_admin. Migra
--   is_global_admin=true -> role='admin'; el resto queda en 'agent' (default).

ALTER TABLE department
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'restricted'));

ALTER TABLE agent
  ADD COLUMN role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('agent', 'manager', 'admin'));

UPDATE agent SET role = 'admin' WHERE is_global_admin = true;

ALTER TABLE agent DROP COLUMN is_global_admin;
