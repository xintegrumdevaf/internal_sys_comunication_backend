# 05_BUILD_PLAN.md

Orden de construcción para un agente de IA que construye el sistema **desde cero**, siguiendo `00` a `04`. Cada etapa debe quedar funcionando y con tests antes de continuar. No se reutiliza código del repositorio legacy — se puede consultar como referencia de intención de negocio (ej. la máquina de estados de soporte ya pensada), pero no como base de implementación.

## Etapa 0 — Bootstrap
- Proyecto TypeScript/Express, estructura hexagonal (`core/modules/{module}/{domain,application,infrastructure,presentation}`), un único composition root.
- Aprovisionar PostgreSQL, aplicar DDL de `01_DATA_MODEL.md` §2 como migraciones versionadas.
- Aprovisionar/point a Redis (colas + locks).
- `.env` con: `WHATSAPP_*`, `API_INTERNAL_KEY`, `DATABASE_URL`, `REDIS_URL`, `APP_PUBLIC_URL`, y el registro de URLs de n8n por acción (`N8N_WEBHOOK_INTERPRET_MESSAGE`, `N8N_WEBHOOK_VALIDATE_CLIENT`, `N8N_WEBHOOK_CHECK_BALANCE`, etc. — ver `.env.example` y `04_N8N_WORKFLOW_SPEC.md` §7).
- Health check `/health`.

**Aceptación:** servidor arranca, migra la base, health check responde.

## Etapa 1 — Conversaciones y mensajes (fuente de verdad)
- Módulo `conversations`: entidades `Conversation`/`Message`, repositorios Postgres, casos de uso: recibir mensaje inbound, listar conversaciones, listar mensajes, responder (humano).
- Webhook `POST /api/webhooks/whatsapp`: verificación de firma, parseo, persistencia con `UNIQUE(conversation_id, external_id)`, respuesta `200` inmediata, encolado en Redis para procesamiento asíncrono.
- Módulos `departments`/`identity` (agents, memberships) — CRUD mínimo + seed.

**Aceptación (tests):** nueva conversación se crea; mensaje con `waMessageId` repetido no duplica; mensaje concurrente en la misma conversación se serializa; conversación existente reutiliza el mismo registro.

## Etapa 2 — Modelo Case/Workflow/State
- Módulo `cases`: entidades `Case`, `WorkflowInstance`, `WorkflowExecution`, `WorkflowEvent`, `AutomationState` (Postgres, `01_DATA_MODEL.md`).
- Motor de workflow declarativo (`02_STATE_MACHINE.md` §1-3): definiciones de estados/transiciones como datos, no como cadenas de `if` en el flujo de control.
- Implementar **un solo** workflow completo primero: `SUPPORT_INTERNET` (referencia §3 de `02_STATE_MACHINE.md`), con contexto tipado `SupportInternetContext` (`01_DATA_MODEL.md` §4).
- `CaseArbitrationService` (`02_STATE_MACHINE.md` §4): un solo caso activo por conversación, pausar/reanudar sin reiniciar.
- Optimistic concurrency (`version`) en `Case`/`WorkflowInstance`.

**Aceptación (tests):** iniciar workflow; continuar desde `WAITING_USER` sin volver a `VALIDATE_CLIENT`; pausar por cambio de tema y reanudar preservando contexto; completar; cancelar; expirar por inactividad configurable.

## Etapa 3 — Contrato API→n8n (cliente HTTP saliente, síncrono)
- `N8nGatewayPort` + implementación HTTP (`infrastructure/n8n/n8n-gateway.http.ts`): un método por tipo de llamada (`interpret(...)`, `executeAction(action, input, ...)`), que resuelve la URL desde el registro acción→URL (`04_N8N_WORKFLOW_SPEC.md` §7) y hace el `POST` síncrono descrito en `03_API_CONTRACT.md` §A/§B.
- Timeout por llamada + reintento con backoff solo si el error es `retryable`, reusando el mismo `idempotencyKey` (nunca uno nuevo en un reintento).
- `workflow_execution` se crea y se cierra (`COMPLETED`/`FAILED`) en el mismo ciclo de la llamada — no hay estado `DISPATCHED` esperando un callback externo.
- No hay endpoints nuevos que la API deba exponer para n8n en esta etapa (n8n nunca llama a la API salvo por lo que ya cubre WhatsApp en Etapa 1).

**Aceptación (tests):** con un `N8nGatewayFake`, mismo `idempotencyKey` en un reintento no duplica el efecto simulado; timeout se clasifica como error `retryable`/`TIMEOUT` y dispara el reintento configurado; error no retryable no reintenta.

## Etapa 4 — n8n: workflows de acción
- Construir en n8n los workflows independientes de `04_N8N_WORKFLOW_SPEC.md` §2/§4 (uno por acción: `VALIDATE_CLIENT`, `CHECK_BALANCE`, `DIAGNOSTIC`, `CONTINUE_DIAGNOSTIC`, y luego pagos), cada uno con `Webhook` de entrada y `Respond to Webhook` de salida, publicados en URL de producción (no test).
- Verificar que ningún dato técnico (`sector/oltName/pon/serial`) se le pide al LLM como parámetro — la API los envía ya resueltos en `input`.
- Cargar las URLs reales en el registro de la Etapa 3 (`.env`).

**Aceptación (test end-to-end):** caso "no tengo internet" completo — validar cliente → revisar deuda (sin deuda) → diagnóstico → esperar usuario → continuar desde diagnóstico → resolver o escalar, con el `N8nGatewayHttp` real apuntando a la instancia de n8n de `docker-compose.yml`.

## Etapa 5 — Interpretación de IA
- Workflow `n8n-interpret-message` (`04_N8N_WORKFLOW_SPEC.md` §5), incluyendo el paso de OCR/transcripción cuando el mensaje trae media, respondiendo síncronamente `{ type, intent, entities, confidence }` en el mismo request.
- `CaseArbitrationService` de Etapa 2 conectado a la interpretación real (antes probado con inputs sintéticos vía fake).
- Umbrales de confianza configurables por `intent` (`02_STATE_MACHINE.md` §7).
- Timeout de la llamada de interpretación (ver `03_API_CONTRACT.md` §A) tratado como `AI_ERROR`.

**Aceptación (tests):** intención válida activa/continúa el caso correcto; intención desconocida pide aclaración; baja confianza con caso activo continúa ese caso; cambio de intención pausa y activa el nuevo; `REQUEST_HUMAN` escala directo; imagen de comprobante con datos completos en `entities` dispara `RECORD_PAYMENT` sin preguntar nada al cliente.

## Etapa 6 — Escalación y automatización
- `EscalationService`: política de errores (`02_STATE_MACHINE.md` §5) → `ESCALATED` + `automation.enabled=false` + resumen estructurado (`03_API_CONTRACT.md` §B.4) generado desde `workflow_execution`/`workflow_event`.
- Mensajería de negocio para el cliente (tabla de mensajes por `department`/`reason`, nunca el error crudo).
- Endpoints de asignación/reactivación (`03_API_CONTRACT.md` §C.2).

**Aceptación (tests):** error técnico no recuperable escala; workflow no soportado escala al departamento por defecto; asignación respeta pertenencia a departamento; reactivar automatización conserva contexto y no reinicia el workflow.

## Etapa 7 — Frontend (contrato, no necesariamente UI en esta entrega)
- Exponer endpoints de `03_API_CONTRACT.md` §C completos; WebSocket/SSE de §C.3.
- Puede validarse con un cliente mínimo de pruebas (Postman/colección) si el frontend real se construye por separado.

## Etapa 8 — Workflows adicionales
- Repetir el patrón de Etapa 2/4 para `BILLING_BALANCE` y `SALES_PACKAGES`, reutilizando el mismo motor declarativo (agregar una definición nueva no debe tocar el engine).

## Etapa 9 — Endurecimiento
- Revisar si alguna acción (típicamente `DIAGNOSTIC`) necesita en la práctica pasar de síncrona a asíncrona por tiempos reales de respuesta (`04_N8N_WORKFLOW_SPEC.md` §4) — solo si se confirma con datos de producción, no por anticipado.
- Observabilidad: `correlationId` propagado end-to-end en logs estructurados (mensaje → interpretación → acción → transición de caso).
- Pruebas de carga de concurrencia (ráfaga de mensajes) y de reintentos end-to-end con `idempotencyKey`.

---

## Regla de trabajo para cada etapa

1. Explicar qué se va a construir.
2. Construir.
3. Ejecutar tests.
4. Corregir errores.
5. Verificar compilación y migraciones.
6. Verificar integración con la etapa anterior.
7. Documentar cualquier desviación respecto a `00`-`04` y por qué.

No se avanza a la siguiente etapa si la anterior deja el sistema inconsistente.
