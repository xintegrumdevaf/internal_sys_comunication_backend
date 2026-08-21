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
  /** Evaluación de calidad de atención humana (07_QUALITY_SUPERVISION.md). No decide sanciones ni cambia el caso. */
  analyzeAgentConversation(input: AnalyzeAgentConversationInput): Promise<QualityAnalysis>;
}

type InterpretMessageInput = {
  correlationId: string;
  conversationId: string;
  messageId: string;
  text: string;                              // ya normalizado: transcrito/con datos de OCR fusionados si aplicaba
  conversationSnapshot: {
    activeCase?: {
      workflowType: string;
      pendingQuestion?: string;
      // qué debe extraer el modelo para este paso puntual (02_STATE_MACHINE.md §13) — no es una lista fija global,
      // cambia por paso/workflow. El modelo extrae SOLO lo que se le pide aquí, nada más.
      requireAll?: string[];
      requireAny?: string[];
    };
  };
};

type Interpretation = {
  type: "NEW_INTENT" | "CONTINUE" | "ANSWER" | "CHANGE_TOPIC" | "CONFIRM" | "DENY" | "CANCEL" | "REQUEST_HUMAN" | "UNCLEAR";
  intent: string;                            // 'support.internet' | 'billing.record_payment' | ...
  entities: Record<string, unknown>;         // solo las claves de requireAll/requireAny que el modelo pudo identificar
  confidence: number;
};

type ComposeReplyInput = {
  caseId: string;
  workflowType: string;
  stepOutcome: { action: string; status: "COMPLETED" | "FAILED" | "WAITING_USER"; result?: Record<string, unknown> };
  templateHint?: string;                     // plantilla base cuando el paso ya define una (02_STATE_MACHINE.md §13); el LLM solo naturaliza, no decide contenido
  missingFields?: string[];                  // cuando se re-pregunta por datos incompletos (02_STATE_MACHINE.md §13) — para que la respuesta sea específica ("no pude leer el número de comprobante") en vez de repetir la pregunta completa
};

type AnalyzeAgentConversationInput = {
  correlationId: string;
  conversationId: string;
  caseId: string;
  agentId: string;
  messages: Array<{
    messageId: string;
    author: "customer" | "agent";
    body: string;
    createdAt: string;
  }>;
};

type QualityAnalysis = {
  cordialityScore: number; // 0-100
  summary: string;         // para supervisor, sin jerga interna ni nombres de tools/workflows
  efficiencyNotes?: string;
  findings: Array<{
    messageId: string;
    severity: "low" | "medium" | "high";
    category: "aggression" | "disrespect" | "neglect" | "misinformation" | "inefficiency" | "other";
    excerpt: string;
    rationale: string;
  }>;
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

### A.4 Análisis de calidad (`analyzeAgentConversation`)
Usado solo por el módulo `quality` (`07_QUALITY_SUPERVISION.md`). Timeout puede ser mayor que el de NLU (análisis de hilos más largos; configurable, ej. `AI_QUALITY_TIMEOUT_MS`). Fallo → `quality_review.status=failed`; **nunca** altera el caso ni el mensaje al cliente. Prompt y schema Zod en `06_AI_PROMPTS.md` §7. Findings cuyo `messageId` no esté en el input se descartan tras validar.

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
| `POST /api/agents` | Crea un agente — requiere `role=admin` (§F). Body: `{ name, email, role?, primaryDepartmentId? }` → `{ data: { agent, temporaryPassword } }` |
| `PUT /api/agents/:id` | Edita un agente — requiere `role=admin`. Body: `{ name?, email?, role?, primaryDepartmentId?, active? }` |
| `DELETE /api/agents/:id` | Desactiva un agente (soft delete, `active=false`) — requiere `role=admin`. No permite dejar el sistema sin ningún `role=admin` activo |
| `POST /api/agents/:id/reset-password` | Genera una contraseña temporal nueva — requiere `role=admin` → `{ data: { agent, temporaryPassword } }` |
| `POST /api/auth/login` | `{ email, password }` → `{ data: AgentDto }` + cookie `httpOnly` de sesión (§F) |
| `POST /api/auth/logout` | Revoca la sesión actual → `204` |
| `GET /api/auth/me` | Agente de la sesión actual → `{ data: AgentDto }` \| `403` sin sesión |
| `POST /api/auth/change-password` | `{ currentPassword, newPassword }` — autoservicio, requiere sesión → `204` |
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
| `GET /api/quality/agents?from=&to=&departmentId=` | Ranking/eficiencia por agente (`07_QUALITY_SUPERVISION.md` §5.1) — solo `manager`/`admin` |
| `GET /api/quality/reviews?agentId=&from=&to=&minScore=&maxScore=&status=&departmentId=` | Lista de reviews de calidad — solo `manager`/`admin` |
| `GET /api/quality/reviews/:id` | Detalle: review + findings + coaching notes (+ mensajes referenciados o ids) — solo `manager`/`admin` |
| `GET /api/quality/pending-count?agentId=&departmentId=` | Cuántas reviews están `pending` (análisis en curso) — solo `manager`/`admin` |

### C.2 Acciones

| Endpoint | Efecto |
|---|---|
| `POST /api/conversations/:id/reply` `{ body }` | Respuesta humana (agente = sesión actual); fuerza `automation.enabled=false` si no lo estaba |
| `POST /api/conversations/:id/take-control` | Un agente toma la conversación |
| `POST /api/cases/:id/claim` | Reclama un caso sin asignar (`assigned_agent_id IS NULL`) — falla si ya tiene dueño |
| `POST /api/cases/:id/assign` `{ agentUserId }` | Asigna/reasigna el caso (requiere `manager`/`admin` del departamento del caso, o ser el pool de triage) |
| `POST /api/cases/:id/reassign` `{ agentUserId }` | Reasigna (alias semántico de `assign` sobre un caso ya asignado) |
| `POST /api/cases/:id/complete` `{ resolutionNote? }` | `COMPLETED` |
| `POST /api/cases/:id/cancel` `{ reason }` | `CANCELLED` |
| `POST /api/cases/:id/disable-automation` `{ reason }` | Fuerza `automation.enabled=false` sin escalar |
| `POST /api/cases/:id/reactivate-automation` | `automation.enabled=true`, conserva `context` |
| `POST /api/cases/:id/transfer` `{ toDepartmentId, reason }` | Transferencia de departamento, auditada |
| `PUT /api/admin/n8n-workflows/:action` `{ url, timeoutMs?, maxRetries?, active? }` | Crea/actualiza la entrada del catálogo (`admin` únicamente) — efecto inmediato, sin redeploy |
| `DELETE /api/admin/n8n-workflows/:action` | Desactiva una entrada del catálogo |
| `POST /api/quality/reviews` `{ caseId }` | Encola análisis on-demand (`07_QUALITY_SUPERVISION.md` §4.2) — solo `manager`/`admin` con alcance al depto del caso |
| `POST /api/quality/analyze-batch` `{ from?, to?, agentId?, departmentId?, limit? }` | Encola hasta `limit` (default 3, max 10) análisis de casos cerrados **sin** review útil — cola serial; solo `manager`/`admin` |
| `POST /api/quality/reviews/:id/notes` `{ body }` | Crea `quality_coaching_note` — solo `manager`/`admin` con alcance |
| `PATCH /api/quality/reviews/:id` `{ status: "reviewed" }` | Marca review como revisada por el supervisor — solo `manager`/`admin` |

**Autorización de lectura**: cualquier agente autenticado puede leer conversaciones/casos de departamentos `visibility='shared'` (default); solo agentes con `agent_membership` en el departamento pueden leer los `restricted`. El pool de triage (`department_id IS NULL`) solo lo leen `manager`/`admin`.

**Autorización de escritura**: requiere `case.assigned_agent_id = self`, o el caso sin asignar (vía `claim`), o `role IN (manager, admin)` con pertenencia/alcance sobre el departamento del caso. Se aplica de forma consistente en `reply`, `complete`, `claim`, `disable-automation` y `reactivate-automation` cuando el caso ya está `HUMAN_ACTIVE`/`ESCALATED` (`agent-case-auth.ts`) — el resto de agentes puede **leer** la conversación/caso pero recibe `403` si intenta escribir.

**Autorización de calidad** (`/api/quality/*`): solo `role IN (manager, admin)`. `admin` ve todo; `manager` solo reviews/stats cuyo `department_id` ∈ sus memberships. `agent` → `403`. Detalle en `07_QUALITY_SUPERVISION.md` §3.

Toda escritura queda en `audit_event`.

**Auto-asignación** (docs/spec/06_BACKEND_GAPS.md §2): al escalarse un caso con `department_id` resuelto (nunca en el pool de triage), el sistema intenta asignarlo de inmediato al agente humano con menor carga activa de ese departamento (`AutoAssignAgentService`, umbral configurable via `AUTO_ASSIGN_MAX_ACTIVE_CASES_PER_AGENT`). Elegibles: `active === true` **y** `autoAssignEnabled === true` **y** pertenencia al departamento (`primaryDepartmentId` o `agent_membership`). Si nadie es elegible, el caso queda `ESCALATED` sin asignar para asignación manual. Se audita como `CASE_AUTO_ASSIGNED` con `actorId: null` (sistema).

`PUT /api/agents/:id` acepta patch parcial `{ "autoAssignEnabled": true | false }`. En `POST /api/agents`, si se omite el campo se persiste `false` (opt-in). El campo viaja en `AgentDto` de list/create/update/deactivate/login/me/reset-password.

**Calidad post-cierre** (`07_QUALITY_SUPERVISION.md` §4.1): al completar/expirar/cancelar un caso que tuvo mensajes `author=agent`, se encola `quality_review` idempotente (`…:auto`). El fallo del job no revierte el cierre del caso.

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
  // Nombre de perfil/agenda de WhatsApp (contacts[].profile.name del webhook de
  // Meta) — real, nunca inventado; null hasta el primer mensaje del cliente.
  // Distinto de Customer.fullName (ese es el nombre validado por cédula). No
  // existe foto de perfil: Meta no la expone via la API oficial (01_DATA_MODEL.md).
  waProfileName: string | null;
  // Preview del último mensaje, para pintar el inbox sin un round-trip extra a /messages.
  // Se calcula al leer (JOIN al último message de la conversación), no se persiste aparte.
  lastMessagePreview: {
    body: string;
    author: "customer" | "ai" | "agent" | "system";
    direction: "inbound" | "outbound";
    createdAt: string;
  } | null;
  // Metadatos del caso activo actual (para filtros por departamento e indicadores Bot/Especialista en la UI)
  activeCase?: {
    id: string;
    status: "NEW" | "ACTIVE" | "WAITING_USER" | "PAUSED" | "ESCALATED" | "HUMAN_ACTIVE" | "COMPLETED" | "EXPIRED" | "CANCELLED";
    workflowType: string;
    departmentId: string | null;
    assignedAgentId: string | null;
    automationEnabled: boolean;
  } | null;
};

type MessageDto = {
  id: string;
  conversationId: string;
  caseId: string | null;
  direction: "inbound" | "outbound";
  author: "customer" | "ai" | "agent" | "system";
  agentId: string | null;           // set en replies humanos (07_QUALITY_SUPERVISION.md §6)
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
  email: string;
  role: "agent" | "manager" | "admin";
  primaryDepartmentId: string | null;
  active: boolean;
  /** Opt-in al pool de auto-asignación al escalar. Default `false`. */
  autoAssignEnabled: boolean;
  createdAt: string;
};

type AgentQualityStatsDto = {
  agentId: string;
  agentName: string;
  departmentId: string | null;
  casesCompleted: number;
  avgCordialityScore: number | null;
  criticalReviewCount: number;
  avgFirstHumanReplyMs: number | null;
};

type QualityFindingDto = {
  id: string;
  messageId: string;
  severity: "low" | "medium" | "high";
  category: "aggression" | "disrespect" | "neglect" | "misinformation" | "inefficiency" | "other";
  excerpt: string;
  rationale: string;
};

type QualityCoachingNoteDto = {
  id: string;
  reviewId: string;
  authorAgentId: string;
  body: string;
  ackStatus: "open" | "acknowledged";
  acknowledgedAt: string | null;
  createdAt: string;
};

type QualityReviewDto = {
  id: string;
  conversationId: string;
  caseId: string;
  agentId: string;
  departmentId: string | null;
  cordialityScore: number | null;
  efficiencyNotes: string | null;
  status: "pending" | "ready" | "failed" | "reviewed";
  trigger: "auto_case_closed" | "on_demand";
  summary: string | null;            // review final al completar tramos; nunca model_raw crudo
  messagesTotal: number;             // turnos customer+agent del caso
  messagesAnalyzed: number;          // progreso de tramos
  chunkSize: number;                 // QUALITY_ANALYSIS_CHUNK_SIZE al encolar
  findings: QualityFindingDto[];
  notes: QualityCoachingNoteDto[];
  startedAt: string | null;
  createdAt: string;
  completedAt: string | null;
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
- **Sesión de agente** (login real, `POST /api/auth/login`): cookie `httpOnly` (`sid`) con un token opaco aleatorio guardado en Redis (`session:<token>` → `{ agentId, createdAt }`, TTL deslizante de `SESSION_TTL_SECONDS`, default 12h). No es JWT: una sesión se puede revocar al instante borrando la clave de Redis. Contraseñas con `argon2id` (`shared/security/password-hasher.ts`). `SameSite=Lax` es suficiente contra CSRF porque todos los `GET` son de solo lectura (sin efectos secundarios).
- **`req.agent`** (poblado por `session.middleware.ts` a partir de la cookie) es la única fuente de identidad en cada request — ningún router confía ya en el header `x-agent-id` ni en `agentUserId`/`actorId` del body para decidir "quién hace esto" (esos campos, cuando siguen existiendo en algún body como `assign`/`reassign`, son el destino de la acción, no una afirmación de identidad).

---

## G. Historial de cambios de contrato

**v1 → v2**: se eliminó el patrón asíncrono (`/action-result`, `/interpretation`, `executionId` como callback) porque los workflows de n8n responden síncronamente (`Webhook` → `Respond to Webhook`).

**v2 → v3**:
- ~~`POST {N8N_WEBHOOK_INTERPRET_MESSAGE}`~~ — eliminado. La interpretación y la composición de respuesta se movieron a `AIProviderPort` (código de la API, §A), n8n ya no participa en NLU/OCR/transcripción.
- El registro de acción→URL de n8n pasó de variables de entorno (`N8N_WEBHOOK_*`) a la tabla `n8n_workflow_registry`, gestionable vía `PUT/DELETE /api/admin/n8n-workflows/:action` (§C.2) sin redeploy.
- Se agregó el rol `manager` y el pool de triage (`department_id IS NULL`) para casos/mensajes no clasificables automáticamente.
- Se agregó `case.assigned_agent_id` y el endpoint `claim` para el modelo de bandeja compartida (visible a todos, editable solo por el asignado).

**v3 → v4**: login real (`agent.password_hash` + `POST/GET /api/auth/*`, migración `0009_agent_password_hash.sql`). Todos los routers dejaron de confiar en `x-agent-id`/`agentUserId` del cliente como identidad — ahora resuelven siempre `req.agent` desde la cookie de sesión real. Se agregó el CRUD completo de agentes (`POST/PUT/DELETE /api/agents`, `POST /api/agents/:id/reset-password`). Se agregó auto-asignación de casos escalados por departamento (`AutoAssignAgentService`) y se cerró el hueco de autorización de escritura en `reply`/`complete` (antes solo `claim`/`disable-automation`/`reactivate-automation` lo exigían).

**v4 → v5**: `ConversationDto.waProfileName` (migración `0010_conversation_wa_profile_name.sql`) — nombre real de perfil/agenda de WhatsApp, capturado del webhook sin llamada extra a la API de Meta. La foto de perfil no se agrega: no existe endpoint oficial de Meta para obtenerla (ver nota en `01_DATA_MODEL.md`).

**v5 → v6**: opt-in de auto-asignación por agente (`agent.auto_assign_enabled` / `AgentDto.autoAssignEnabled`, migración `0011_agent_auto_assign_enabled.sql`). Default `false`. `AutoAssignAgentService` solo considera agentes `active && autoAssignEnabled` con pertenencia al departamento.
