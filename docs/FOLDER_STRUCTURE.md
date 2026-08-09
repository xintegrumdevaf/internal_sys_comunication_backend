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
│           │   │   ├── case.entity.ts               ← incluye department_id / assigned_agent_id nullable
│           │   │   ├── workflow-instance.entity.ts
│           │   │   ├── workflow-execution.entity.ts
│           │   │   ├── workflow-event.entity.ts
│           │   │   ├── automation-state.entity.ts
│           │   │   ├── intent-catalog.ts             ← fuente única del mapeo intent→workflowType, 06_AI_PROMPTS.md §2
│           │   │   └── contexts/
│           │   │       ├── support-internet.context.ts
│           │   │       ├── billing-balance.context.ts
│           │   │       ├── sales-packages.context.ts
│           │   │       └── general-inquiry.context.ts
│           │   ├── application/
│           │   │   ├── ports/
│           │   │   │   ├── case.repository.port.ts
│           │   │   │   ├── workflow-execution.repository.port.ts
│           │   │   │   └── n8n-gateway.port.ts        ← solo executeAction(...), sin interpretación
│           │   │   ├── engine/
│           │   │   │   ├── workflow-engine.ts            ← motor declarativo (02_STATE_MACHINE.md)
│           │   │   │   ├── workflow-definition.ts         ← tipo base de definición (incluye WaitingStep: requireAll/requireAny/maxAttempts, §13)
│           │   │   │   └── definitions/
│           │   │   │       ├── support-internet.workflow.ts
│           │   │   │       ├── billing-balance.workflow.ts  (Etapa 8)
│           │   │   │       └── sales-packages.workflow.ts   (Etapa 8)
│           │   │   ├── services/
│           │   │   │   ├── case-arbitration.service.ts        ← 02_STATE_MACHINE.md §4
│           │   │   │   ├── department-resolver.service.ts     ← tabla workflow_type→department_id, 02_STATE_MACHINE.md §9
│           │   │   │   └── expiration.service.ts              ← 02_STATE_MACHINE.md §8
│           │   │   └── use-cases/
│           │   │       ├── dispatch-action.use-case.ts         ← llama a n8n-gateway.port
│           │   │       └── process-buffered-messages.use-case.ts  ← consumido por ingestion, dispara interpretación+arbitraje+engine
│           │   ├── infrastructure/
│           │   │   ├── postgres/
│           │   │   │   ├── case.repository.pg.ts
│           │   │   │   ├── workflow-execution.repository.pg.ts
│           │   │   │   └── n8n-workflow-registry.repository.pg.ts
│           │   │   └── n8n/
│           │   │       └── n8n-gateway.http.ts
│           │   └── presentation/
│           │       ├── cases.router.ts
│           │       └── admin/
│           │           └── n8n-workflows.router.ts    ← GET/PUT/DELETE catálogo, solo admin (Etapa 3)
│           │
│           ├── ai/                    ← Etapa 5, nuevo módulo (interpretación/composición, YA NO en n8n)
│           │   ├── application/
│           │   │   ├── ports/
│           │   │   │   └── ai-provider.port.ts    ← interpretMessage, composeReply, transcribeAudio, extractReceiptData
│           │   │   ├── prompts/                    ← normativo, 06_AI_PROMPTS.md — NO es detalle de infraestructura
│           │   │   │   ├── interpret-message.prompt.ts
│           │   │   │   └── compose-reply.prompt.ts
│           │   │   └── use-cases/
│           │   │       ├── interpret-message.use-case.ts
│           │   │       ├── compose-customer-reply.use-case.ts
│           │   │       ├── transcribe-audio.use-case.ts
│           │   │       └── extract-receipt-data.use-case.ts
│           │   └── infrastructure/
│           │       └── ollama/
│           │           └── ollama-adapter.ts       ← implementa ai-provider.port.ts; recibe el prompt ya armado, no conoce su contenido; base para futuros OpenAI/OpenRouter/Claude adapters
│           │
│           ├── ingestion/             ← Etapa 2, buffer/debounce (antes vivía en n8n como Data Table + Wait)
│           │   └── application/
│           │       └── services/
│           │           └── inbound-buffer.service.ts   ← debounce por conversationId sobre Redis, 02_STATE_MACHINE.md §12
│           │
│           ├── escalation/           ← Etapa 6
│           │   ├── domain/
│           │   │   └── escalation.entity.ts          ← department_id nullable (pool de triage)
│           │   ├── application/
│           │   │   ├── services/
│           │   │   │   ├── escalation.service.ts
│           │   │   │   └── case-summary-builder.service.ts  ← 03_API_CONTRACT.md §D
│           │   │   └── use-cases/
│           │   │       ├── claim-case.use-case.ts
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
│           │   │   ├── department.entity.ts          ← incluye visibility ('shared'|'restricted')
│           │   │   └── agent.entity.ts                ← incluye role ('agent'|'manager'|'admin')
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
│               │   └── realtime-broadcaster.ts       ← emite MESSAGE_RECEIVED/SENT, CASE_CLAIMED, etc.
│               └── presentation/
│                   └── realtime.router.ts   ← WebSocket/SSE, 03_API_CONTRACT.md §C.3
│
├── n8n/                               ← Etapa 4, exportables .json de los workflows de acción de 04_N8N_WORKFLOW_SPEC.md
│   ├── validate-client.json
│   ├── check-balance.json
│   ├── diagnostic.json
│   ├── continue-diagnostic.json
│   ├── record-payment.json
│   └── apply-bank-account.json
│
└── test/
    ├── conversations/
    ├── ingestion/
    ├── cases/
    ├── ai/
    ├── escalation/
    └── e2e/
        └── support-internet-flow.e2e.test.ts   ← caso A del brief original: no tengo internet → resolver
```

## Notas sobre el orden de aparición

- `shared/` y `core/composition/container.ts` nacen en la Etapa 0.
- `core/modules/conversations` y `departments`/`audit` nacen en la Etapa 1.
- `core/modules/ingestion` (buffer/debounce) y `core/modules/cases` (dominio, engine, arbitraje) nacen en la Etapa 2; la capa `infrastructure/n8n` y el router admin del catálogo en la Etapa 3.
- `n8n/` (los workflows de acción exportados — ya no hay workflow de interpretación) se llena en la Etapa 4, en paralelo al desarrollo de la API.
- `core/modules/ai` (interpretación/composición vía `AIProviderPort`) nace en la Etapa 5.
- `core/modules/escalation` nace en la Etapa 6, con soporte de triage/claim.
- `core/modules/realtime` nace en la Etapa 7.
- Workflows adicionales (`billing-balance`, `sales-packages`) en la Etapa 8, siguiendo el mismo patrón de `support-internet.workflow.ts` sin tocar `workflow-engine.ts` ni `ai-provider.port.ts`.
