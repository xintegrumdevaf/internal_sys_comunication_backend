# docs/skills/hexagonal-architecture.md
## Arquitectura hexagonal — cómo se aplica en este repo, capa por capa

## Regla de dirección de dependencias

```
presentation ──▶ application ──▶ domain
infrastructure ──▶ application (implementa los ports)
```

`domain` no importa de nadie. `application` solo importa de `domain` y de sus propios `ports` (interfaces). `infrastructure` implementa esos `ports`. `presentation` orquesta HTTP/WS y llama casos de uso de `application` — nunca contiene lógica de negocio.

## `domain/`
Entidades y value objects puros. Sin `import` de `express`, `pg`, `ioredis`, ni de ningún SDK externo.

```ts
// core/modules/cases/domain/case.entity.ts — ejemplo de forma esperada
export type CaseStatus = "NEW" | "ACTIVE" | "WAITING_USER" | "PAUSED"
  | "ESCALATED" | "HUMAN_ACTIVE" | "COMPLETED" | "EXPIRED" | "CANCELLED";

export interface Case {
  id: string;
  conversationId: string;
  departmentId: string;
  workflowType: string;
  status: CaseStatus;
  context: CaseContext;   // discriminated union, ver 01_DATA_MODEL.md §4
  version: number;
  lastActivityAt: Date;
  expiresAt: Date | null;
}
```

## `application/ports/`
Interfaces que `domain`+`application` necesitan de "afuera" (persistencia, integraciones), definidas en términos del dominio, no en términos de Postgres/HTTP.

```ts
// application/ports/case.repository.port.ts — forma esperada
export interface CaseRepositoryPort {
  findById(id: string): Promise<Case | null>;
  findActiveByConversation(conversationId: string): Promise<Case | null>;
  findPausedByWorkflowType(conversationId: string, workflowType: string): Promise<Case | null>;
  save(kase: Case, expectedVersion: number): Promise<void>; // optimistic concurrency
}
```

## `application/use-cases/`
Orquestan: leen del repositorio (puerto), aplican reglas del `domain`/`engine`, escriben (puerto), emiten eventos. No saben si el repositorio es Postgres o memoria.

## `infrastructure/`
Implementaciones concretas de los ports. Aquí sí viven `import { Pool } from "pg"`, `fetch()` hacia n8n, etc.

## `presentation/`
Routers Express. Un handler típico: parsear/validar input (Zod) → llamar un caso de uso → mapear resultado a HTTP. Nada de lógica de negocio aquí — si un router empieza a tener `if` sobre reglas de negocio, esa lógica se fue al lugar equivocado.

## `core/composition/container.ts`
Único lugar donde se decide qué implementación concreta usa cada puerto (`new CaseRepositoryPg(pool)` vs. `new CaseRepositoryFake()` en tests). Los módulos nunca instancian sus propias dependencias con `new` directamente fuera de este archivo (salvo value objects puros del dominio).

## Por qué esto importa en este proyecto específicamente
El sistema legacy auditado (`docs/spec/historical/ARCHITECTURE_CURRENT.md`) tenía **tres composition roots paralelas** porque esta regla no se respetó de forma consistente entre módulos. Mantener un único `container.ts` y esta dirección de dependencias es lo que evita que eso vuelva a pasar.
