# docs/skills/solid-principles.md
## Cómo aplicar SOLID en este proyecto (no como teoría, como reglas concretas de este código)

## S — Single Responsibility
- Un caso de uso (`*.use-case.ts`) hace una sola cosa de negocio. `ReceiveInboundMessageUseCase` no envía WhatsApp ni decide escalación — eso es de otro caso de uso.
- Un `WorkflowDefinition` (ej. `support-internet.workflow.ts`) declara estados y transiciones; no sabe cómo se persiste un `Case` ni cómo se llama a n8n por HTTP — eso vive en `WorkflowEngine` y en el `n8n-gateway.port.ts`.
- Señal de violación en este repo: un archivo `*.service.ts` que crece y empieza a manejar HTTP, SQL y reglas de negocio a la vez → es el "God Service" que `AGENTS.md` prohíbe explícitamente.

## O — Open/Closed
- Agregar un workflow nuevo (`SALES_UPGRADE`) debe significar **crear un archivo nuevo** en `definitions/`, nunca modificar `workflow-engine.ts`. Si agregar un caso de negocio te obliga a tocar el motor, el motor está mal diseñado.
- Agregar una acción nueva de n8n (`APPLY_BANK_ACCOUNT`) es un nuevo `case` en el `Switch` de `n8n-execute-action` + un nuevo sub-workflow adapter — no reescribir el workflow principal.

## L — Liskov Substitution
- Cualquier implementación de un puerto (`CaseRepositoryPort`, `N8nGatewayPort`) debe ser intercambiable sin que el caso de uso que la consume note la diferencia. Esto es lo que permite tener un `N8nGatewayHttp` real y un `N8nGatewayFake` en tests sin tocar el caso de uso.
- Si necesitas hacer `instanceof` para saber qué implementación concreta llegó, el contrato del puerto está mal definido.

## I — Interface Segregation
- No crear un puerto gigante `CaseGatewayPort` con 15 métodos. Separar por necesidad real del consumidor: `CaseRepositoryPort` (persistencia), `N8nGatewayPort` (despacho de acciones), `EventPublisherPort` (eventos en tiempo real) — cada caso de uso depende solo de los puertos que realmente necesita.

## D — Dependency Inversion
- `domain/` y `application/` nunca importan de `infrastructure/`. Es al revés: `infrastructure/postgres/case.repository.pg.ts` implementa `application/ports/case.repository.port.ts`.
- El `container.ts` (composition root) es el único lugar del repo donde se conocen las implementaciones concretas y se "cablean" contra las interfaces.
- Prueba de que esto se está cumpliendo: se debería poder correr todos los tests de `application/` sin una base de datos real levantada, usando implementaciones en memoria de los puertos.

## Cómo verificarlo automáticamente
Ver `docs/skills/design-patterns-backend.md` §4 y la sección de herramientas en la respuesta del asistente — `dependency-cruiser` o `eslint-plugin-boundaries` hacen cumplir estas reglas de dirección de dependencias en CI, no solo por revisión manual.
