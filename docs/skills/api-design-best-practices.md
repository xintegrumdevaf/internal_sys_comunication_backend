# docs/skills/api-design-best-practices.md
## Buenas prácticas de API aplicadas a este proyecto

## Contratos explícitos, validados en el borde
Todo payload de entrada (webhook de WhatsApp, resultado de n8n, request del frontend) se valida con Zod contra el esquema exacto de `docs/spec/03_API_CONTRACT.md` antes de tocar cualquier caso de uso. Un payload inválido se rechaza en `presentation/` con `400`, nunca llega a `application/`.

## Idempotencia como contrato, no como best-effort
- Ingesta: `UNIQUE(conversation_id, external_id)` en `message` — un `INSERT` duplicado falla por constraint, se captura y se responde como éxito (ya existe), nunca como error 500.
- API↔n8n: `executionId` + `idempotencyKey` (`docs/spec/03_API_CONTRACT.md` §B.5) — todo endpoint que reciba un resultado de n8n primero verifica si ya fue procesado.

## Respuestas de error consistentes
Un solo formato de error HTTP en todo el API:
```json
{ "error": { "type": "VALIDATION_ERROR", "message": "..." } }
```
Los `DomainErrorType` de `shared/errors/domain-errors.ts` mapean 1:1 a este formato — nunca se filtra un stack trace ni un mensaje de Postgres crudo al cliente HTTP (y mucho menos al usuario final de WhatsApp, ver `docs/spec/00_OVERVIEW.md` §5).

## Versionado de contrato interno
El campo `"version": 1` en el contrato API↔n8n (`03_API_CONTRACT.md` §A) existe para poder evolucionar el payload sin romper integraciones ya desplegadas — si se cambia la forma de un contrato, se sube la versión y se soporta la anterior durante una ventana de transición, no se rompe en caliente.

## Paginación y filtros consistentes
Todo listado (`/api/conversations`, `/api/cases`, `/api/escalations`, `/api/cases/:id/timeline`) usa el mismo patrón `?limit=&cursor=` + filtros por `departmentId`/`status`/`workflowType` (ver `03_API_CONTRACT.md` §C.1) — no inventar un esquema de paginación distinto por endpoint.

## Separación lectura/escritura en el router
Los `GET` nunca tienen efectos secundarios (ni logging de negocio, ni cambios de estado). Las acciones de escritura (`POST /api/cases/:id/assign`, etc.) siempre quedan en `audit_event` — es un requisito de seguridad de `docs/spec/03_API_CONTRACT.md` §E, no opcional.

## Tiempo real como proyección de eventos persistidos
El WebSocket/SSE de `03_API_CONTRACT.md` §C.3 nunca es la única fuente de un evento — siempre hay una fila en `workflow_event` primero. Si el cliente se desconecta y reconecta, debe poder reconstruir el estado actual vía REST, no depender de haber "escuchado" el evento en tiempo real.
