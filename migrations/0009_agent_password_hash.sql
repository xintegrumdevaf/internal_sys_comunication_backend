-- Migracion 0009: login real con credenciales (docs/spec/06_BACKEND_GAPS.md
-- del frontend, seccion 1.b). Hasta ahora la identidad se declaraba por
-- header x-agent-id sin verificar nada; a partir de esta migracion cada
-- agente puede tener una contrasena (hash argon2, nunca texto plano).
--
-- Nullable a proposito: los agentes creados antes de esta migracion no
-- tienen contrasena todavia. No pueden iniciar sesion hasta que un admin
-- les genere una con POST /api/agents/:id/reset-password (o hasta que
-- scripts/seed.ts les asigne una de desarrollo conocida).

ALTER TABLE agent ADD COLUMN password_hash TEXT;
