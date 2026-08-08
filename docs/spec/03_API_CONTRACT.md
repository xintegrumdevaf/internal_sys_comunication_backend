# 03_API_CONTRACT.md (v3 — interpretación movida a código, catálogo de acciones en DB)

> Cambios acumulados: (v2) todos los workflows de n8n responden síncronamente. (v3) la interpretación de lenguaje y la composición de respuesta al cliente **ya no pasan por n8n** — viven en la API como un `AIProviderPort` (interfaz en código, adapters intercambiables: Ollama por defecto, extensible a OpenAI/OpenRouter/Claude). n8n queda dedicado exclusivamente a integraciones con sistemas externos reales (contrato, saldo, diagnóstico, pagos). El registro de acción→URL de n8n pasa de variables de entorno a una tabla (`n8n_workflow_registry`, `01_DATA_MODEL.md` §2).

Una superficie de contrato **interna** (IA, en proceso) + una superficie **externa síncrona** hacia n8n (solo acciones) + el contrato REST/tiempo real hacia el frontend.

---

## A. `AIProviderPort` — interpretación y composición (interno, no HTTP)

No es un webhook: es una interfaz TypeScript implementada por un adapter (`OllamaAdapter` por defecto). Se documenta aquí como contrato porque cualquier adapter nuevo (OpenAI, OpenRouter, Claude) debe cumplirlo exactamente.

```ts
interface AIProviderPort {
  interpretMessage(input: InterpretMessageInput): Promise<Interpretation>;
  composeReply(input: ComposeReplyInput): Promise<string>;
  transcribeAudio(mediaUrl: string, mimeType: string): Promise<{ transcript: string }>;
  extractReceiptData(mediaUrl: string, mimeType: string): Promise<{ amount?: number; reference?: string; date?: string }>;
}

type InterpretMessageInput = {
  correlationId: string;
  conversationId: string;
  messageId: string;
  text: string;                              // ya normalizado: transcrito/con datos de OCR fusionados si aplicaba
  conversationSnapshot: {
    activeCase?: { workflowType: string; pendingQuestion?: string };
  };
};

type Interpretation = {
  type: "NEW_INTENT" | "CONTINUE" | "ANSWER" | "CHANGE_TOPIC" | "CONFIRM" | "DENY" | "CANCEL" | "REQUEST_HUMAN" | "UNCLEAR";
  intent: string;                            // 'support.internet' | 'billing.record_payment' | ...
  entities: Record<string, unknown>;         // validado/tipado por caso de uso consumidor, no genérico más allá de este borde
  confidence: number;
};

type ComposeReplyInput = {
  caseId: string;
  workflowType: string;
  stepOutcome: { action: string; status: "COMPLETED" | "FAILED" | "WAITING_USER"; result?: Record<string, unknown> };
  templateHint?: string;                     // plantilla base cuando el paso ya define una (02_STATE_MACHINE.md §12); el LLM solo naturaliza, no decide contenido
};
```

### A.1 Flujo end-to-end de un mensaje (texto o media)

1. Mensaje inbound se acumula en el buffer/debounce de la conversación (`02_STATE_MACHINE.md` §12).
2. Al vencer el debounce: si hay `audio`/`image`, se llama primero `transcribeAudio`/`extractReceiptData`; el resultado se funde en `text`/`entities` antes de interpretar.
3. `interpretMessage(...)` → `Interpretation`.
4. `CaseArbitrationService` decide transición (`02_STATE_MACHINE.md` §4).
5. Si corresponde ejecutar una acción, se llama a n8n (§B).
6. `composeReply(...)` genera el texto final; se persiste como `message` (`author: "ai"`) y se envía a WhatsApp.

### A.2 Ejemplo — imagen de comprobante de pago
`extractReceiptData` devuelve `{ amount: 45.00, reference: "ABC123", date: "2026-08-07" }` → se refleja en `entities` de la interpretación resultante (`intent: "billing.record_payment"`). La API decide con esos `entities` si ya puede llamar directo a `RECORD_PAYMENT` (§B) o si falta un dato y hay que preguntarlo.

### A.3 Timeouts y fallback
Timeout configurable (`AI_CALL_TIMEOUT_MS`, default ~8-10s) por llamada al provider; si expira o falla, se trata como `AI_ERROR` (`02_STATE_MACHINE.md` §5) — reintento único, y si persiste, `UNCLEAR`/escalación según corresponda.

---

## B. API → n8n: ejecución de acción (síncrono, por workflow independiente)

`POST {URL resuelta desde n8n_workflow_registry}` — catálogo en base de datos, no en `.env` (`01_DATA_MODEL.md` §2, gestión en §C.2 de este documento).

Request:
```json
{
  "correlationId": "corr_9f1c...",
  "executionId": "exec_01HZY...",
  "idempotencyKey": "case_123:CHECK_BALANCE:hash(input)",
  "caseId": "case_123",
  "conversationId": "conv_456",
  "input": { "nationalId": "1205500216" }
}
```

Response (mismo request, vía `Respond to Webhook`):
```json
{ "success": true, "result": { "hasDebt": false, "balance": 0 }, "error": null }
```
o en error:
```json
{ "success": false, "result": null, "error": { "type": "EXTERNAL_SERVICE_ERROR", "message": "MikroTik timeout", "retryable": true } }
```

`executionId`/`idempotencyKey` se siguen enviando aunque el patrón sea síncrono, por dos razones:
1. **Trazabilidad**: `workflow_execution` se crea y se cierra (`COMPLETED`/`FAILED`) en el mismo ciclo, pero queda registrado con este `executionId` para reconstruir el timeline (`GET /api/cases/:id/timeline`, §C.1).
2. **Reintentos a nivel de red**: si el cliente HTTP de la API reintenta por timeout/caída de conexión (no porque n8n haya fallado, sino porque la respuesta no llegó), el workflow de n8n debe usar `idempotencyKey` antes de ejecutar un efecto no idempotente (ej. `RECORD_PAYMENT`) para no duplicarlo.

### B.1 Timeouts y reintentos
- Cada acción tiene un timeout configurado en la API (por defecto unos segundos; ajustable por acción si alguna, como `DIAGNOSTIC`, típicamente tarda más por llamar a otra API externa).
- Timeout o error `retryable: true` → reintento con backoff, mismo `idempotencyKey` (nunca uno nuevo).
- Reintentos agotados → `FAILED`, se evalúa política de error (`02_STATE_MACHINE.md` §5) para decidir si escala.

### B.2 Ejemplo — `DIAGNOSTIC` (datos técnicos resueltos por la API, no por el LLM)
```json
{ "input": { "sector": "pomasqui", "oltName": "bicentenario", "pon": "3", "serial": "D011A66CB67C" } }
```

---

## C. API REST — Frontend

### C.1 Lecturas

| Endpoint | Descripción |
|---|---|
| `GET /api/departments` | Lista de departamentos |
| `GET /api/agents` | Lista de agentes |
| `GET /api/conversations?departmentId=&userId=&status=` | Bandeja de conversaciones — cada item incluye `lastMessagePreview` (ver `ConversationDto` en §C.4), para pintar el inbox sin pedir `/messages` por cada fila |
| `GET /api/conversations/:id/messages?limit=&cursor=` | Mensajes de la conversación, orden cronológico, paginado |
| `GET /api/conversations/:id/cases` | Casos (histórico) de la conversación |
| `GET /api/conversations/:id/automation` | Estado de automatización del caso activo |
| `GET /api/cases/:id` | Detalle del caso: estado, workflow, contexto tipado, automation state |
| `GET /api/cases/:id/timeline` | `workflow_execution`/`workflow_event` ordenados cronológicamente |
| `GET /api/cases/:id/summary` | Resumen estructurado — solo si el caso fue escalado o está `HUMAN_ACTIVE` |
| `GET /api/escalations?departmentId=&status=` | Bandeja de escalaciones. `departmentId=null` (o `?triage=true`) devuelve el pool sin clasificar (`02_STATE_MACHINE.md` §10), visible solo a `role IN (manager, admin)` |
| `GET /api/audit?limit=` | Auditoría reciente |
| `GET /api/dashboard?userId=` | KPIs y resumen para el agente autenticado |
| `GET /api/admin/n8n-workflows` | Catálogo de acciones → URL (`n8n_workflow_registry`), solo `admin` |

### C.2 Acciones

| Endpoint | Efecto |
|---|---|
| `POST /api/conversations/:id/reply` `{ agentUserId, body }` | Respuesta humana; fuerza `automation.enabled=false` si no lo estaba |
| `POST /api/conversations/:id/take-control` `{ agentUserId }` | Un agente toma la conversación |
| `POST /api/cases/:id/claim` `{ agentUserId }` | Reclama un caso sin asignar (`assigned_agent_id IS NULL`) — falla si ya tiene dueño |
| `POST /api/cases/:id/assign` `{ agentUserId }` | Asigna/reasigna el caso (requiere `manager`/`admin` del departamento del caso, o ser el pool de triage) |
| `POST /api/cases/:id/reassign` `{ agentUserId }` | Reasigna (alias semántico de `assign` sobre un caso ya asignado) |
| `POST /api/cases/:id/complete` `{ resolutionNote? }` | `COMPLETED` |
| `POST /api/cases/:id/cancel` `{ reason }` | `CANCELLED` |
| `POST /api/cases/:id/disable-automation` `{ reason }` | Fuerza `automation.enabled=false` sin escalar |
| `POST /api/cases/:id/reactivate-automation` | `automation.enabled=true`, conserva `context` |
| `POST /api/cases/:id/transfer` `{ toDepartmentId, reason }` | Transferencia de departamento, auditada |
| `PUT /api/admin/n8n-workflows/:action` `{ url, timeoutMs?, maxRetries?, active? }` | Crea/actualiza la entrada del catálogo (`admin` únicamente) — efecto inmediato, sin redeploy |
| `DELETE /api/admin/n8n-workflows/:action` | Desactiva una entrada del catálogo |

**Autorización de lectura**: cualquier agente autenticado puede leer conversaciones/casos de departamentos `visibility='shared'` (default); solo agentes con `agent_membership` en el departamento pueden leer los `restricted`. El pool de triage (`department_id IS NULL`) solo lo leen `manager`/`admin`.

**Autorización de escritura**: requiere `case.assigned_agent_id = self`, o el caso sin asignar (vía `claim`), o `role IN (manager, admin)` con pertenencia/alcance sobre el departamento del caso.

Toda escritura queda en `audit_event`.

### C.3 Tiempo real

`WebSocket`/`SSE` en `/api/realtime?userId=`, filtrado por los departamentos del agente:

```json
{ "type": "MESSAGE_RECEIVED", "conversationId": "conv_456", "messageId": "msg_789" }
{ "type": "MESSAGE_SENT", "conversationId": "conv_456", "messageId": "msg_790", "author": "ai" }
{ "type": "CASE_ESCALATED", "caseId": "case_123", "conversationId": "conv_456", "departmentId": "dept_support", "at": "..." }
{ "type": "CASE_CLAIMED", "caseId": "case_123", "agentUserId": "user_1" }
{ "type": "HUMAN_ASSIGNED", "caseId": "case_123", "agentUserId": "user_1" }
{ "type": "AUTOMATION_ENABLED", "caseId": "case_123" }
```

`MESSAGE_RECEIVED` = mensaje entrante del cliente ya persistido. `MESSAGE_SENT` = mensaje saliente ya persistido y (si aplica) ya enviado a WhatsApp — `author` distingue `"ai"` de `"agent"` para que el frontend pueda, por ejemplo, mostrar distinto quién respondió. Ambos eventos solo llevan el `messageId`; el frontend pide el contenido vía `GET /api/conversations/:id/messages` (o mantiene su propio cache local) — el evento es una notificación de "hay algo nuevo", no el mensaje completo, para no duplicar la fuente de verdad.

### C.4 DTOs de referencia

```ts
type ConversationDto = {
  id: string;
  waPhone: string;
  customerId: string | null;
  activeCaseId: string | null;
  status: "open" | "pending" | "resolved" | "closed";
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  // Preview del último mensaje, para pintar el inbox sin un round-trip extra a /messages.
  // Se calcula al leer (JOIN al último message de la conversación), no se persiste aparte.
  lastMessagePreview: {
    body: string;
    author: "customer" | "ai" | "agent" | "system";
    direction: "inbound" | "outbound";
    createdAt: string;
  } | null;
};

type MessageDto = {
  id: string;
  conversationId: string;
  caseId: string | null;
  direction: "inbound" | "outbound";
  author: "customer" | "ai" | "agent" | "system";
  body: string;
  type: "text" | "audio" | "image" | "document";
  createdAt: string;
};

type CaseDto = {
  id: string;
  conversationId: string;
  workflowType: "SUPPORT_INTERNET" | "BILLING_BALANCE" | "SALES_PACKAGES" | string | null; // null = pool de triage, ver 02_STATE_MACHINE.md §10
  status: "NEW" | "ACTIVE" | "WAITING_USER" | "PAUSED" | "ESCALATED" | "HUMAN_ACTIVE" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  departmentId: string | null;
  assignedAgentId: string | null;   // null = sin reclamar/lo maneja el bot
  automation: { enabled: boolean; disabledReason: string | null };
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string | null;
};

type AgentDto = {
  id: string;
  name: string;
  role: "agent" | "manager" | "admin";
  primaryDepartmentId: string | null;
};
```

---

## D. Resumen estructurado para escalación (generado por la API, no por el LLM)

```json
{
  "problem": "Cliente reporta falta de internet",
  "workflow": "SUPPORT_INTERNET",
  "department": "SUPPORT",
  "status": "ESCALATED",
  "reason": "No fue posible completar el diagnóstico automático",
  "completedSteps": ["VALIDATE_CLIENT", "CHECK_BALANCE", "DIAGNOSTIC"],
  "results": { "hasDebt": false, "diagnostic": "ONU_UNREACHABLE" },
  "pendingAction": "Intervención técnica humana",
  "timeline": [
    { "action": "VALIDATE_CLIENT", "status": "COMPLETED", "at": "..." },
    { "action": "CHECK_BALANCE", "status": "COMPLETED", "at": "..." },
    { "action": "DIAGNOSTIC", "status": "FAILED", "at": "..." },
    { "action": "ESCALATE", "status": "COMPLETED", "at": "..." }
  ],
  "readableSummary": "opcional, generado por IA, nunca sustituye lo anterior"
}
```

Construido determinísticamente desde `workflow_execution`/`workflow_event`; se persiste en `escalation.summary`.

## E. Catálogo de eventos (`workflow_event.type`)

`MESSAGE_RECEIVED, MESSAGE_PERSISTED, INTENT_INTERPRETED, CASE_CREATED, CASE_ACTIVATED, CASE_PAUSED, CASE_RESUMED, WORKFLOW_STEP_STARTED, WORKFLOW_STEP_COMPLETED, WORKFLOW_STEP_FAILED, WAITING_USER, CASE_ESCALATED, HUMAN_ASSIGNED, AUTOMATION_DISABLED, AUTOMATION_ENABLED, CASE_COMPLETED, CASE_EXPIRED, CASE_CANCELLED`

Persistidos en `workflow_event` y re-emitidos por el canal de §C.3.

## F. Seguridad

- Webhook de Meta (único webhook que la API expone al mundo exterior fuera de n8n): verificación de firma HMAC (`X-Hub-Signature-256`).
- API → n8n: header `X-Internal-Api-Key` en cada llamada saliente; cada workflow de n8n valida ese header antes de ejecutar nada.
- Autorización de agentes: por `role` (`agent | manager | admin`) + `agent_membership`/`department.visibility` (`01_DATA_MODEL.md` §7) — reemplaza el antiguo `is_global_admin` booleano.
- Toda acción de escritura queda en `audit_event`.

---

## G. Historial de cambios de contrato

**v1 → v2**: se eliminó el patrón asíncrono (`/action-result`, `/interpretation`, `executionId` como callback) porque los workflows de n8n responden síncronamente (`Webhook` → `Respond to Webhook`).

**v2 → v3**:
- ~~`POST {N8N_WEBHOOK_INTERPRET_MESSAGE}`~~ — eliminado. La interpretación y la composición de respuesta se movieron a `AIProviderPort` (código de la API, §A), n8n ya no participa en NLU/OCR/transcripción.
- El registro de acción→URL de n8n pasó de variables de entorno (`N8N_WEBHOOK_*`) a la tabla `n8n_workflow_registry`, gestionable vía `PUT/DELETE /api/admin/n8n-workflows/:action` (§C.2) sin redeploy.
- Se agregó el rol `manager` y el pool de triage (`department_id IS NULL`) para casos/mensajes no clasificables automáticamente.
- Se agregó `case.assigned_agent_id` y el endpoint `claim` para el modelo de bandeja compartida (visible a todos, editable solo por el asignado).
