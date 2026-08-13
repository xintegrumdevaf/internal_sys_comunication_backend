# 05_BUILD_PLAN.md (v3)

Orden de construcción para un agente de IA que construye el sistema **desde cero**, siguiendo `00` a `04`. Cada etapa debe quedar funcionando y con tests antes de continuar. No se reutiliza código del repositorio legacy — se puede consultar como referencia de intención de negocio, pero no como base de implementación.

> **Si ya ejecutaste la Etapa 1 con una versión anterior de este paquete** (antes de que existiera `agent.role`, `department.visibility`, `case.assigned_agent_id`, `n8n_workflow_registry`): antes de continuar con la Etapa 2, aplica una corrección a lo ya construido:
> - Migración que agrega `department.visibility` (default `'shared'`) y reemplaza `agent.is_global_admin` por `agent.role` (`agent|manager|admin`) — migrar `is_global_admin=true` → `role='admin'`.
> - Verificar que los casos de uso/tests de Etapa 1 que referenciaban `is_global_admin` se actualicen a `role`.
> No hace falta rehacer nada del módulo `conversations` en sí (mensajes, ingesta, idempotencia) — eso no cambió.

## Etapa 0 — Bootstrap
- Proyecto TypeScript/Express, estructura hexagonal (`core/modules/{module}/{domain,application,infrastructure,presentation}`), un único composition root.
- Aprovisionar PostgreSQL, aplicar DDL de `01_DATA_MODEL.md` §2 como migraciones versionadas (incluye `n8n_workflow_registry`, aunque se puebla en la Etapa 3-4).
- Aprovisionar/point a Redis (colas, buffer/debounce, locks).
- `.env` con: `WHATSAPP_*`, `API_INTERNAL_KEY`, `DATABASE_URL`, `REDIS_URL`, `APP_PUBLIC_URL`, y configuración del proveedor de IA (`AI_PROVIDER=ollama`, `OLLAMA_BASE_URL`, `AI_CALL_TIMEOUT_MS`) — ya no URLs de n8n por acción (eso vive en la DB, §7 de `04_N8N_WORKFLOW_SPEC.md`).
- Health check `/health`.

**Aceptación:** servidor arranca, migra la base, health check responde.

## Etapa 1 — Conversaciones y mensajes (fuente de verdad)
- Módulo `conversations`: entidades `Conversation`/`Message`, repositorios Postgres, casos de uso: recibir mensaje inbound, listar conversaciones, listar mensajes, responder (humano).
- Webhook `POST /api/webhooks/whatsapp`: verificación de firma, parseo, persistencia con `UNIQUE(conversation_id, external_id)`, respuesta `200` inmediata.
- Módulos `departments`/`identity` (agents con `role`, memberships, `department.visibility`) — CRUD mínimo + seed.

**Aceptación (tests):** nueva conversación se crea; mensaje con `waMessageId` repetido no duplica; mensaje concurrente en la misma conversación se serializa; conversación existente reutiliza el mismo registro.

## Etapa 2 — Buffer/debounce + Modelo Case/Workflow/State
- **Buffer de ingesta** (`02_STATE_MACHINE.md` §12): al persistir un mensaje inbound, se reprograma un temporizador por `conversationId` en Redis (debounce configurable, p. ej. 4-5s); al vencer sin mensajes nuevos, se recuperan todos los mensajes acumulados desde el último procesamiento como una unidad de trabajo para el worker.
- Módulo `cases`: entidades `Case` (con `department_id`/`assigned_agent_id` nullable), `WorkflowInstance`, `WorkflowExecution`, `WorkflowEvent`, `AutomationState` (Postgres, `01_DATA_MODEL.md`).
- Motor de workflow declarativo (`02_STATE_MACHINE.md` §1-3): definiciones de estados/transiciones como datos, no como cadenas de `if`.
- Implementar **un solo** workflow completo primero: `SUPPORT_INTERNET` (`02_STATE_MACHINE.md` §3), con contexto tipado `SupportInternetContext` (`01_DATA_MODEL.md` §4).
- `CaseArbitrationService` (`02_STATE_MACHINE.md` §4): un solo caso activo por conversación, pausar/reanudar sin reiniciar. En esta etapa se prueba con una interpretación **sintética** (fake), la real llega en la Etapa 5.
- Tabla de mapeo `workflow_type → department_id` (`02_STATE_MACHINE.md` §9) — configuración, no keywords sobre el texto.
- Optimistic concurrency (`version`) en `Case`/`WorkflowInstance`.

**Aceptación (tests):** el buffer agrupa 3 mensajes seguidos en una sola unidad de trabajo tras el debounce; iniciar workflow; continuar desde `WAITING_USER` sin volver a `VALIDATE_CLIENT`; pausar por cambio de tema y reanudar preservando contexto; completar; cancelar; expirar por inactividad configurable; `department_id` se resuelve por la tabla de mapeo, no por el texto del mensaje.

## Etapa 3 — Contrato API→n8n (cliente HTTP saliente, síncrono)
- `N8nGatewayPort` + implementación HTTP (`infrastructure/n8n/n8n-gateway.http.ts`): `executeAction(action, input, ...)`, que resuelve la URL consultando `n8n_workflow_registry` (con cache en memoria de corta duración, invalidada al escribir en la tabla) y hace el `POST` síncrono de `03_API_CONTRACT.md` §B.
- Timeout por llamada + reintento con backoff solo si el error es `retryable`, reusando el mismo `idempotencyKey`.
- `workflow_execution` se crea y se cierra (`COMPLETED`/`FAILED`) en el mismo ciclo de la llamada.
- Endpoints admin: `GET/PUT/DELETE /api/admin/n8n-workflows[/:action]` (`03_API_CONTRACT.md` §C.1/§C.2), solo `role=admin`.

**Aceptación (tests):** con un `N8nGatewayFake`, mismo `idempotencyKey` en un reintento no duplica el efecto simulado; timeout se clasifica `TIMEOUT`/`retryable` y dispara el reintento configurado; error no retryable no reintenta; `PUT /api/admin/n8n-workflows/:action` actualiza la URL usada en la siguiente llamada sin reiniciar el proceso.

## Etapa 4 — n8n: workflows de acción
- Construir en n8n los workflows independientes de `04_N8N_WORKFLOW_SPEC.md` §2 (uno por acción: `VALIDATE_CLIENT`, `CHECK_BALANCE`, `DIAGNOSTIC`, `CONTINUE_DIAGNOSTIC`, y luego pagos), cada uno con `Webhook` de entrada y `Respond to Webhook` de salida, publicados en URL de producción (no test).
- Verificar que ningún dato técnico (`sector/oltName/pon/serial`) dependa de inferencia de un LLM — la API los envía ya resueltos en `input`.
- Poblar `n8n_workflow_registry` con las URLs reales (seed de migración o vía el endpoint admin de la Etapa 3).

**Aceptación (test end-to-end):** caso "no tengo internet" completo — validar cliente → revisar deuda (sin deuda) → diagnóstico → esperar usuario → continuar desde diagnóstico → resolver o escalar, con el `N8nGatewayHttp` real apuntando a la instancia de n8n de `docker-compose.yml`.

## Etapa 5 — Interpretación y composición de respuesta (`AIProviderPort`, en código)
- `AIProviderPort` (`03_API_CONTRACT.md` §A) + `OllamaAdapter` como implementación por defecto — estructura pensada para poder agregar `OpenAIAdapter`/`OpenRouterAdapter`/`ClaudeAdapter` después sin tocar el resto del sistema (Dependency Inversion, `docs/skills/solid-principles.md`).
- Prompts de `docs/spec/06_AI_PROMPTS.md` §3/§4, ubicados en `application/prompts/` (no hardcodeados dentro del adapter) — copiar el texto tal cual, no parafrasear ni "mejorar" sin señalarlo.
- `intent-catalog.ts` (`06_AI_PROMPTS.md` §2) como fuente única del mapeo `intent → workflowType`, consumida tanto por el prompt como por `department-resolver.service.ts` de la Etapa 2.
- Validación con Zod del JSON devuelto contra el tipo `Interpretation` antes de usarlo en cualquier caso de uso; JSON inválido o que no matchea el schema se trata como `AI_ERROR` con un reintento (`06_AI_PROMPTS.md` §5) — usar el modo de salida JSON forzada del proveedor (`format: "json"` en Ollama) además del prompt.
- Casos de uso: `InterpretMessageUseCase`, `ComposeCustomerReplyUseCase`, `TranscribeAudioUseCase`, `ExtractReceiptDataUseCase`.
- `CaseArbitrationService` de la Etapa 2 conectado a la interpretación real (ya no al fake).
- Cada estado de `SupportInternetWorkflow` (Etapa 2) define su plantilla de respuesta o delega en `composeReply` (`02_STATE_MACHINE.md` §12).
- Umbrales de confianza configurables por `intent` (`02_STATE_MACHINE.md` §7).
- Timeout de la llamada al provider tratado como `AI_ERROR`.

**Aceptación (tests):** intención válida activa/continúa el caso correcto; intención desconocida pide aclaración; baja confianza con caso activo continúa ese caso; cambio de intención pausa y activa el nuevo; `REQUEST_HUMAN` escala directo; imagen de comprobante con datos completos en `entities` dispara `RECORD_PAYMENT` sin preguntar nada al cliente; el mensaje final enviado al cliente nunca es el JSON crudo del resultado de un paso; JSON malformado del modelo se reintenta una vez y luego cae a `UNCLEAR`/escalación, no rompe el flujo.

## Etapa 6 — Escalación, automatización y triage
- `EscalationService`: política de errores (`02_STATE_MACHINE.md` §5) → `ESCALATED` + `automation.enabled=false` + resumen estructurado (`03_API_CONTRACT.md` §D) generado desde `workflow_execution`/`workflow_event`.
- Manejo de intención no clasificable → pool de triage (`department_id = NULL`, `02_STATE_MACHINE.md` §10), visible para `role IN (manager, admin)`.
- Mensajería de negocio para el cliente (tabla de mensajes por `department`/`reason`, nunca el error crudo).
- Endpoints `claim`/`assign`/`reassign`/`reactivate-automation`/`disable-automation` (`03_API_CONTRACT.md` §C.2), con las reglas de autorización de lectura/escritura de `01_DATA_MODEL.md` §7.

**Aceptación (tests):** error técnico no recuperable escala; workflow no soportado cae en triage sin departamento; un `manager` (no solo `admin`) puede ver y clasificar el pool de triage; un agente puede `claim` un caso sin asignar pero no puede actuar sobre uno asignado a otro; reactivar automatización conserva contexto y no reinicia el workflow.

## Etapa 7 — Frontend (contrato, no necesariamente UI en esta entrega)
- Exponer endpoints de `03_API_CONTRACT.md` §C completos, incluida visibilidad compartida por defecto (`department.visibility='shared'`) con edición restringida a `assigned_agent_id`.
- WebSocket/SSE de §C.3, incluidos `MESSAGE_SENT` y `CASE_CLAIMED`.
- Puede validarse con un cliente mínimo de pruebas (Postman/colección) si el frontend real se construye por separado.

## Etapa 8 — Workflows adicionales
- Repetir el patrón de Etapa 2/4 para `BILLING_BALANCE` y `SALES_PACKAGES`, reutilizando el mismo motor declarativo y el mismo `AIProviderPort` (agregar una definición nueva no debe tocar el engine ni el port).

**Nota (no es un bug si lo ves antes de esta etapa):** hasta que `BILLING_BALANCE` esté construido, cualquier mensaje que la IA clasifique con `intent="billing.*"` no tiene `WorkflowDefinition` registrada → cae en `UNSUPPORTED` (`02_STATE_MACHINE.md` §5) → escala directo a un humano. Es el comportamiento esperado del sistema con un workflow todavía no implementado, no una falla de interpretación — no lo confundas con el bug de §"caso conocido de falla" de `06_AI_PROMPTS.md` §6, que es sobre extracción de entidades, no sobre workflows faltantes.

## Etapa 9 — Endurecimiento
- Revisar si alguna acción (típicamente `DIAGNOSTIC`) necesita en la práctica pasar de síncrona a asíncrona por tiempos reales de respuesta — solo si se confirma con datos de producción, no por anticipado (confirmado en esta versión: todo responde rápido).
- Observabilidad: `correlationId` propagado end-to-end en logs estructurados (mensaje → buffer → interpretación → acción → transición de caso → respuesta).
- Pruebas de carga de concurrencia (ráfaga de mensajes) y de reintentos end-to-end con `idempotencyKey`.

**Aceptación (tests en `test/hardening/etapa-9-acceptance.test.ts`):** logs del pipeline de un batch comparten el mismo `correlationId`; una ráfaga en la misma conversación produce un solo flush; dos conversaciones en paralelo no cruzan flushes; un reintento HTTP retryable reusa la misma `idempotencyKey` y deja una sola `workflow_execution` COMPLETED.

**Decisión documentada:** `DIAGNOSTIC` / `CONTINUE_DIAGNOSTIC` permanecen síncronos (contrato `03`/`04`); no se introduce cola async hasta medir latencias reales en producción.

## Etapa 10 — Supervisión de calidad de atenciones humanas

Normativo: `07_QUALITY_SUPERVISION.md`, DDL en `01_DATA_MODEL.md`, contratos en `03` §A/§C y prompt en `06_AI_PROMPTS.md` §7.

- Migración: `message.agent_id`; tablas `quality_review`, `quality_finding`, `quality_coaching_note`.
- `reply-as-human` (y equivalentes) setean `message.agent_id` desde la sesión.
- Extender `AIProviderPort` + `OllamaAdapter` con `analyzeAgentConversation`; prompt en `application/prompts/`; Zod + post-filtro de `messageId`.
- Módulo `src/core/modules/quality/`: encolar al cerrar caso con mensajes agent (`…:auto` idempotente); on-demand; listados/stats; notes; mark reviewed.
- Routers `/api/quality/*` con auth `manager`/`admin` y alcance por departamento.
- Fallo del job → `status=failed`; nunca revierte el cierre del caso ni notifica al cliente.

**Aceptación (tests):** migración aplica; reply humano persiste `agent_id`; cierre de caso con mensajes agent crea una sola review `…:auto`; Zod/post-filtro descarta `messageId` inventado; manager no ve reviews de otro depto y admin sí; on-demand con `pending` existente no duplica job; coaching note queda en `audit_event`; fake AI produce findings persistidos y score en rango 0–100.

## Etapa futura (no Etapa 10) — Chat interno staff persistente

Documentado en `07_QUALITY_SUPERVISION.md` §8. Fuera de alcance de la Etapa 10: hilos/mensajes staff↔staff en Postgres + realtime. El frontend sigue con chat local + deep-link desde calidad hasta esa etapa.

---

## Regla de trabajo para cada etapa

1. Explicar qué se va a construir.
2. Construir.
3. Ejecutar tests.
4. Corregir errores.
5. Verificar compilación y migraciones.
6. Verificar integración con la etapa anterior.
7. Documentar cualquier desviación respecto a `00`-`04`/`06`/`07` y por qué.

No se avanza a la siguiente etapa si la anterior deja el sistema inconsistente.
