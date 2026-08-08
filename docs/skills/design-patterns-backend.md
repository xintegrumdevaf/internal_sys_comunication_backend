# docs/skills/design-patterns-backend.md
## Patrones de diseño aplicados a este proyecto (con ubicación exacta en el repo)

## Strategy / Table-driven state machine — motor de workflows
`core/modules/cases/application/engine/workflow-engine.ts` + `definitions/*.workflow.ts`.
Cada `WorkflowDefinition` es una tabla de datos `{ states, transitions, contextType }`, no una cadena de `if/else`. El motor es genérico: itera la definición, nunca conoce reglas específicas de `SUPPORT_INTERNET`. Esto es lo que permite cumplir Open/Closed (ver `solid-principles.md`).

```ts
// forma esperada, no literal — referencia de intención
type WorkflowDefinition<TContext> = {
  workflowType: string;
  initialState: string;
  states: Record<string, StateHandler<TContext>>;
};
```

## Ports & Adapters (Hexagonal) — todo el repo
Cada módulo separa `domain → application (ports) → infrastructure (adapters) → presentation`. Ver `docs/skills/hexagonal-architecture.md` para el detalle capa por capa.

## Repository — acceso a datos
`application/ports/case.repository.port.ts` (interfaz) + `infrastructure/postgres/case.repository.pg.ts` (implementación). Nunca SQL embebido en un caso de uso o en un controller.

## Unit of Work (implícito vía `withTransaction`) — consistencia transaccional
Cuando una operación toca más de una tabla de forma atómica (ej. crear `Case` + `WorkflowInstance` + `WorkflowEvent` de `CASE_CREATED`), se envuelve en `shared/db/pool.ts:withTransaction`. No hacer tres `INSERT` sueltos que puedan quedar a medias si falla el tercero.

## Optimistic Concurrency Control — `Case`/`WorkflowInstance`
`UPDATE ... WHERE id = :id AND version = :expected`. En conflicto (0 filas afectadas) se lanza `OptimisticLockError` y el caso de uso decide si reintenta o propaga. Nunca "último que escribe gana" silenciosamente sobre el estado de un caso.

## Circuit breaker / retry con backoff — llamadas a n8n
`infrastructure/n8n/n8n-gateway.http.ts`. Reintentos solo para acciones `retryable` (ver `docs/spec/02_STATE_MACHINE.md` §5-6); nunca reintentar una acción no idempotente sin `idempotencyKey`.

## Outbox-like event log — `WorkflowEvent`
Cada transición relevante escribe una fila en `workflow_event` **en la misma transacción** que el cambio de estado, no como un efecto secundario separado que pueda perderse. El broadcaster de tiempo real (`realtime/`) lee de esta tabla (o la consume vía notificación), nunca inventa eventos por su cuenta.

## Anti-Corruption Layer — `n8n-gateway.port.ts`
Todo lo que entra/sale de n8n pasa por este puerto, que traduce entre el modelo de dominio (`Case`, `WorkflowExecution`) y el contrato externo de `docs/spec/03_API_CONTRACT.md`. El dominio nunca conoce la forma exacta de un payload de n8n directamente.

## Qué NO usar aquí (evitar sobre-ingeniería)
- No introducir un Event Bus/broker externo (Kafka, RabbitMQ) para esta escala — el catálogo de eventos vive en Postgres + notificación simple a WebSocket, según `docs/spec/00_OVERVIEW.md` (evitar infraestructura innecesaria).
- No usar un ORM con "active record" (entidades que se guardan a sí mismas) — rompe la separación domain/infrastructure. Preferir repositorios explícitos aunque se use un query builder o un ORM ligero tipo Kysely/Drizzle.
- No crear una jerarquía de herencia profunda para los `WorkflowDefinition` — composición de datos (tabla de estados) sobre herencia de clases.
