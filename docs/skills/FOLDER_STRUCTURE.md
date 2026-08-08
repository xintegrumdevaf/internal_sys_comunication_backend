# FOLDER_STRUCTURE.md
## Estructura completa del repositorio (estado objetivo, no todo existe desde el día 1 — se va llenando por etapa)

```
isp-platform/
├── AGENTS.md
├── .cursor/
│   └── rules/
│       └── project.mdc
├── .env.example
├── .env                              (gitignored)
├── .eslintrc.cjs
├── .prettierrc
├── .gitignore
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── vitest.config.ts
│
├── docs/
│   ├── spec/                         ← normativo (00-05, ya generados)
│   │   ├── 00_OVERVIEW.md
│   │   ├── 01_DATA_MODEL.md
│   │   ├── 02_STATE_MACHINE.md
│   │   ├── 03_API_CONTRACT.md
│   │   ├── 04_N8N_WORKFLOW_SPEC.md
│   │   ├── 05_BUILD_PLAN.md
│   │   └── historical/               ← contexto, no normativo
│   │       ├── ARCHITECTURE_CURRENT.md
│   │       └── MIGRATION_PLAN.md
│   └── skills/                       ← guías de diseño para el agente (sección 2 de la respuesta)
│       ├── solid-principles.md
│       ├── design-patterns-backend.md
│       ├── hexagonal-architecture.md
│       ├── api-design-best-practices.md
│       └── testing-strategy.md
│
├── migrations/
│   ├── 0001_init_schema.sql          ← DDL completo de 01_DATA_MODEL.md §2
│   └── ...
│
├── scripts/
│   └── migrate.ts
│
├── src/
│   ├── index.ts                      ← entrypoint: levanta Express, conecta DB/Redis, monta routers
│   │
│   ├── shared/                       ← infraestructura transversal, sin lógica de negocio
│   │   ├── config/
│   │   │   └── env.ts
│   │   ├── db/
│   │   │   └── pool.ts
│   │   ├── queue/
│   │   │   └── redis.ts
│   │   ├── http/
│   │   │   ├── middlewares/
│   │   │   │   ├── auth-internal-key.middleware.ts
│   │   │   │   ├── error-handler.middleware.ts
│   │   │   │   └── request-logger.middleware.ts
│   │   │   └── whatsapp-signature.ts
│   │   ├── errors/
│   │   │   └── domain-errors.ts      ← BUSINESS_ERROR, TIMEOUT, etc. (02_STATE_MACHINE.md §5)
│   │   ├── events/
│   │   │   └── event-bus.ts          ← catálogo de eventos, 03_API_CONTRACT.md §D
│   │   └── logging/
│   │       └── logger.ts             ← pino + correlationId
│   │
│   └── core/
│       ├── composition/
│       │   └── container.ts          ← ÚNICO composition root
│       │
│       └── modules/
│           ├── conversations/        ← Etapa 1
│           │   ├── domain/
│           │   │   ├── conversation.entity.ts
│           │   │   └── message.entity.ts
│           │   ├── application/
│           │   │   ├── ports/
│           │   │   │   ├── conversation.repository.port.ts
│           │   │   │   └── message.repository.port.ts
│           │   │   └── use-cases/
│           │   │       ├── receive-inbound-message.use-case.ts
│           │   │       ├── list-conversations.use-case.ts
│           │   │       └── reply-as-human.use-case.ts
│           │   ├── infrastructure/
│           │   │   └── postgres/
│           │   │       ├── conversation.repository.pg.ts
│           │   │       └── message.repository.pg.ts
│           │   └── presentation/
│           │       ├── whatsapp-webhook.router.ts
│           │       └── conversations.router.ts
│           │
│           ├── cases/                ← Etapa 2-3
│           │   ├── domain/
│           │   │   ├── case.entity.ts
│           │   │   ├── workflow-instance.entity.ts
│           │   │   ├── workflow-execution.entity.ts
│           │   │   ├── workflow-event.entity.ts
│           │   │   ├── automation-state.entity.ts
│           │   │   └── contexts/
│           │   │       ├── support-internet.context.ts
│           │   │       ├── billing-balance.context.ts
│           │   │       └── sales-packages.context.ts
│           │   ├── application/
│           │   │   ├── ports/
│           │   │   │   ├── case.repository.port.ts
│           │   │   │   ├── workflow-execution.repository.port.ts
│           │   │   │   └── n8n-gateway.port.ts
│           │   │   ├── engine/
│           │   │   │   ├── workflow-engine.ts            ← motor declarativo (02_STATE_MACHINE.md)
│           │   │   │   ├── workflow-definition.ts         ← tipo base de definición
│           │   │   │   └── definitions/
│           │   │   │       ├── support-internet.workflow.ts
│           │   │   │       ├── billing-balance.workflow.ts  (Etapa 8)
│           │   │   │       └── sales-packages.workflow.ts   (Etapa 8)
│           │   │   ├── services/
│           │   │   │   ├── case-arbitration.service.ts    ← 02_STATE_MACHINE.md §4
│           │   │   │   └── expiration.service.ts          ← 02_STATE_MACHINE.md §8
│           │   │   └── use-cases/
│           │   │       ├── dispatch-action.use-case.ts
│           │   │       ├── handle-action-result.use-case.ts
│           │   │       └── handle-interpretation.use-case.ts
│           │   ├── infrastructure/
│           │   │   ├── postgres/
│           │   │   │   ├── case.repository.pg.ts
│           │   │   │   └── workflow-execution.repository.pg.ts
│           │   │   └── n8n/
│           │   │       └── n8n-gateway.http.ts
│           │   └── presentation/
│           │       ├── n8n-webhooks.router.ts             ← action-result, interpretation
│           │       └── cases.router.ts
│           │
│           ├── escalation/           ← Etapa 6
│           │   ├── domain/
│           │   │   └── escalation.entity.ts
│           │   ├── application/
│           │   │   ├── services/
│           │   │   │   ├── escalation.service.ts
│           │   │   │   └── case-summary-builder.service.ts  ← 03_API_CONTRACT.md §B.4
│           │   │   └── use-cases/
│           │   │       ├── assign-case.use-case.ts
│           │   │       ├── reactivate-automation.use-case.ts
│           │   │       └── disable-automation.use-case.ts
│           │   ├── infrastructure/
│           │   │   └── postgres/
│           │   │       └── escalation.repository.pg.ts
│           │   └── presentation/
│           │       └── escalations.router.ts
│           │
│           ├── departments/          ← Etapa 1
│           │   ├── domain/
│           │   │   ├── department.entity.ts
│           │   │   └── agent.entity.ts
│           │   ├── infrastructure/
│           │   │   └── postgres/
│           │   │       ├── department.repository.pg.ts
│           │   │       └── agent.repository.pg.ts
│           │   └── presentation/
│           │       └── departments.router.ts
│           │
│           ├── audit/                ← Etapa 1
│           │   ├── domain/
│           │   │   └── audit-event.entity.ts
│           │   ├── infrastructure/
│           │   │   └── postgres/
│           │   │       └── audit.repository.pg.ts
│           │   └── presentation/
│           │       └── audit.router.ts
│           │
│           └── realtime/             ← Etapa 7
│               ├── application/
│               │   └── realtime-broadcaster.ts
│               └── presentation/
│                   └── realtime.router.ts   ← WebSocket/SSE, 03_API_CONTRACT.md §C.3
│
├── n8n/                               ← Etapa 4-5, exportables .json de los workflows de 04_N8N_WORKFLOW_SPEC.md
│   ├── n8n-interpret-message.json
│   ├── n8n-execute-action.json
│   └── n8n-normalize-media.json
│
└── test/
    ├── conversations/
    ├── cases/
    ├── escalation/
    └── e2e/
        └── support-internet-flow.e2e.test.ts   ← caso A del brief original: no tengo internet → resolver
```

## Notas sobre el orden de aparición

- `shared/` y `core/composition/container.ts` nacen en la Etapa 0.
- `core/modules/conversations` y `departments`/`audit` nacen en la Etapa 1.
- `core/modules/cases` (dominio, engine, arbitraje) nace en la Etapa 2; su capa `infrastructure/n8n` y `presentation/n8n-webhooks.router.ts` en la Etapa 3.
- `n8n/` (los tres workflows exportados) se llena en la Etapa 4-5, en paralelo al desarrollo de la API — se exportan desde la instancia de n8n local (`docker-compose.yml`) y se versionan en el repo para poder reimportarlos en producción.
- `core/modules/escalation` nace en la Etapa 6.
- `core/modules/realtime` nace en la Etapa 7.
- Workflows adicionales (`billing-balance`, `sales-packages`) en la Etapa 8, siguiendo el mismo patrón de `support-internet.workflow.ts` sin tocar `workflow-engine.ts`.
