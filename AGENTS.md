# AGENTS.md

Instrucciones para cualquier agente de IA (Cursor, Claude Code, u otro) que trabaje en este repositorio.

## Qué es este proyecto

Backend de una plataforma omnicanal de atención automatizada para un ISP (WhatsApp Business Cloud + n8n + Ollama/Qwen + PostgreSQL + Redis). La API es la fuente de verdad del estado del negocio; n8n solo ejecuta integraciones; la IA solo interpreta lenguaje, nunca decide transiciones de negocio.

## Fuente de verdad del diseño

**Toda decisión de arquitectura, modelo de datos, contratos y orden de construcción está en `docs/spec/00_OVERVIEW.md` a `docs/spec/05_BUILD_PLAN.md`, más `docs/spec/06_AI_PROMPTS.md` y `docs/spec/07_QUALITY_SUPERVISION.md`.** Léelos en ese orden antes de escribir código. `docs/spec/historical/` es solo contexto de una auditoría previa — no es normativo, no lo uses como fuente de requisitos. `docs/FOLDER_STRUCTURE.md` (fuera de `spec/`, no es normativo de negocio) tiene el árbol de carpetas de `src/` esperado por etapa — consúltalo al crear archivos nuevos para mantener la ubicación consistente.

No inventes entidades, endpoints, nombres de estado ni eventos que no estén en esos documentos. Si algo no está cubierto y hace falta, propone una adición al documento correspondiente antes de codificarlo.

## Cómo trabajar

1. Sigue `docs/spec/05_BUILD_PLAN.md` **una etapa a la vez**, en orden. No adelantes trabajo de una etapa posterior aunque parezca conveniente.
2. Antes de codificar una etapa: resume en 3-5 líneas qué vas a construir y qué archivos vas a tocar/crear.
3. Cada etapa debe terminar con los tests de su "criterio de aceptación" (en `05_BUILD_PLAN.md`) pasando en verde.
4. No avances a la siguiente etapa si la actual deja el build roto, migraciones pendientes, o tests fallando.
5. Un commit por etapa completada, mensaje descriptivo (`feat(etapa-2): motor de workflow declarativo + SUPPORT_INTERNET`).

## No-negociables (repetidos de `00_OVERVIEW.md` §5 — no los rompas nunca)

- Sin lógica de negocio en controllers ni en prompts de IA.
- La IA nunca decide transiciones de negocio ni sanciones: produce `{ type, intent, entities, confidence }` (NLU, `03_API_CONTRACT.md` §A), texto de reply sobre plantilla, o `QualityAnalysis` tipado (`07_QUALITY_SUPERVISION.md`). La API decide qué hacer con eso.
- n8n nunca es dueño de estado de negocio ni envía mensajes directamente al canal (WhatsApp). Ver `04_N8N_WORKFLOW_SPEC.md` §3 para la lista explícita de lo que NO debe existir en n8n.
- Idempotencia obligatoria: ingesta de mensajes (`UNIQUE(conversation_id, external_id)`) y todo intercambio API↔n8n (`idempotencyKey`/`executionId`).
- Un único caso automatizado activo por conversación (`conversation.active_case_id`).
- Retomar un caso pausado nunca reinicia el workflow desde el estado inicial.
- Contextos de caso tipados por `workflow_type` (`01_DATA_MODEL.md` §4) — nunca `Record<string, unknown>` genérico donde el dato es estructurado.
- El cliente final nunca recibe detalles internos (nombres de workflow, tools, nodos de n8n, stack traces) — mensajería de negocio siempre.
- Todo error no recuperable tiene una ruta definida (política de errores en `02_STATE_MACHINE.md` §5); no todo error escala.

## Convenciones técnicas

- TypeScript estricto (`strict: true`), sin `any` salvo justificación explícita en comentario.
- Arquitectura hexagonal por módulo: `domain/` (entidades, sin dependencias externas) → `application/` (casos de uso, puertos/interfaces) → `infrastructure/` (adapters concretos: Postgres, Redis, HTTP) → `presentation/` (routers/controllers). Las capas internas nunca importan de las externas.
- Un único composition root (`src/core/composition/container.ts`). No crear containers/DI paralelos — ese fue justamente uno de los problemas detectados en el sistema legacy (ver `docs/spec/historical/ARCHITECTURE_CURRENT.md` si quieres el detalle).
- Migraciones SQL versionadas y reproducibles (`migrations/`), nunca `synchronize`/auto-schema mágico.
- Tests con Vitest; cada caso de uso de negocio tiene al menos los tests listados en el criterio de aceptación de su etapa.
- Logging estructurado con `correlationId` propagado end-to-end (mensaje → caso → ejecución → resultado).

## Variables de entorno

Ver `.env.example` en la raíz. Nunca hardcodear URLs, secretos ni tokens en código o en nodos de n8n.
