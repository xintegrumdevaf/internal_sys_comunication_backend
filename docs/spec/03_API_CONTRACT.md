# 03_API_CONTRACT.md (v2 — corregido a patrón 100% síncrono)

> Cambio respecto a v1: como confirmaste, todos los workflows de n8n (interpretación y cada acción) responden **síncronamente** en el mismo request HTTP (`Webhook` → `Respond to Webhook`). Esto elimina la necesidad de endpoints de callback (`/action-result`, `/interpretation`) — la API llama, espera, y recibe el resultado en la misma respuesta.

Dos superficies de contrato hacia n8n (ambas salientes desde la API, ambas síncronas) + el contrato REST/tiempo real hacia el frontend.

---

## A. API → n8n: interpretación de lenguaje (síncrono)

`POST {N8N_WEBHOOK_INTERPRET_MESSAGE}`

Request:
```json
{
  "correlationId": "corr_9f1c...",
  "conversationId": "conv_456",
  "messageId": "msg_789",
  "type": "text",
  "text": "ya reinicié el router",
  "mediaUrl": null,
  "mimeType": null,
  "conversationSnapshot": {
    "activeCase": { "workflowType": "SUPPORT_INTERNET", "pendingQuestion": "¿Ya reiniciaste el router?" }
  }
}
```

Response (mismo request, vía `Respond to Webhook`):
```json
{
  "interpretation": {
    "type": "ANSWER",
    "intent": "support.internet",
    "entities": { "routerRestarted": true },
    "confidence": 0.93
  },
  "modelMeta": { "model": "qwen3.5:4b", "latencyMs": 812 }
}
```

`interpretation.type` (enum cerrado, exhaustivo):
`NEW_INTENT | CONTINUE | ANSWER | CHANGE_TOPIC | CONFIRM | DENY | CANCEL | REQUEST_HUMAN | UNCLEAR`

### A.1 Ejemplo — imagen de comprobante de pago
`type: "image"`, `mediaUrl` presente → el workflow hace OCR internamente (`04_N8N_WORKFLOW_SPEC.md` §5) y refleja lo extraído en `entities`:
```json
{
  "interpretation": {
    "type": "NEW_INTENT",
    "intent": "billing.record_payment",
    "entities": { "amount": 45.00, "reference": "ABC123", "date": "2026-08-07" },
    "confidence": 0.88
  }
}
```
La API decide con esos `entities` si ya puede llamar directo a `RECORD_PAYMENT` (§B) o si falta un dato y hay que preguntarlo.

La API aplica un **timeout razonable** (ej. 8-10s) a esta llamada; si expira, se trata como `AI_ERROR` (`02_STATE_MACHINE.md` §5) — reintento único, y si persiste, `UNCLEAR`/escalación según corresponda.

---

## B. API → n8n: ejecución de acción (síncrono, por workflow independiente)

`POST {URL específica de la acción}` — registro de URLs en `04_N8N_WORKFLOW_SPEC.md` §7 (`N8N_WEBHOOK_VALIDATE_CLIENT`, `N8N_WEBHOOK_CHECK_BALANCE`, etc.)

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
1. **Trazabilidad**: `workflow_execution` se crea y se cierra (`COMPLETED`/`FAILED`) en el mismo ciclo, pero queda registrado con este `executionId` para reconstruir el timeline (`03_API_CONTRACT.md` §D... ver más abajo §E).
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
| `GET /api/conversations?departmentId=&userId=&status=` | Bandeja de conversaciones |
| `GET /api/conversations/:id/messages` | Mensajes de la conversación |
| `GET /api/conversations/:id/cases` | Casos (histórico) de la conversación |
| `GET /api/conversations/:id/automation` | Estado de automatización del caso activo |
| `GET /api/cases/:id` | Detalle del caso: estado, workflow, contexto tipado, automation state |
| `GET /api/cases/:id/timeline` | `workflow_execution`/`workflow_event` ordenados cronológicamente |
| `GET /api/cases/:id/summary` | Resumen estructurado — solo si el caso fue escalado o está `HUMAN_ACTIVE` |
| `GET /api/escalations?departmentId=&status=` | Bandeja de escalaciones |
| `GET /api/audit?limit=` | Auditoría reciente |
| `GET /api/dashboard?userId=` | KPIs y resumen para el agente autenticado |

### C.2 Acciones

| Endpoint | Efecto |
|---|---|
| `POST /api/conversations/:id/reply` `{ agentUserId, body }` | Respuesta humana; fuerza `automation.enabled=false` si no lo estaba |
| `POST /api/conversations/:id/take-control` `{ agentUserId }` | Un agente toma la conversación |
| `POST /api/cases/:id/assign` `{ agentUserId }` | Asigna el caso (requiere pertenecer al `department` del caso o ser admin) |
| `POST /api/cases/:id/reassign` `{ agentUserId }` | Reasigna |
| `POST /api/cases/:id/complete` `{ resolutionNote? }` | `COMPLETED` |
| `POST /api/cases/:id/cancel` `{ reason }` | `CANCELLED` |
| `POST /api/cases/:id/disable-automation` `{ reason }` | Fuerza `automation.enabled=false` sin escalar |
| `POST /api/cases/:id/reactivate-automation` | `automation.enabled=true`, conserva `context` |
| `POST /api/cases/:id/transfer` `{ toDepartmentId, reason }` | Transferencia de departamento, auditada |

Toda escritura valida pertenencia de departamento (`agentBelongsToDepartment` o `is_global_admin`) y queda en `audit_event`.

### C.3 Tiempo real

`WebSocket`/`SSE` en `/api/realtime?userId=`, filtrado por los departamentos del agente:

```json
{ "type": "MESSAGE_RECEIVED", "conversationId": "conv_456", "messageId": "msg_789" }
{ "type": "CASE_ESCALATED", "caseId": "case_123", "conversationId": "conv_456", "departmentId": "dept_support", "at": "..." }
{ "type": "HUMAN_ASSIGNED", "caseId": "case_123", "agentUserId": "user_1" }
{ "type": "AUTOMATION_ENABLED", "caseId": "case_123" }
```

### C.4 DTO de referencia

```ts
type CaseDto = {
  id: string;
  conversationId: string;
  workflowType: "SUPPORT_INTERNET" | "BILLING_BALANCE" | "SALES_PACKAGES" | string;
  status: "NEW" | "ACTIVE" | "WAITING_USER" | "PAUSED" | "ESCALATED" | "HUMAN_ACTIVE" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  departmentId: string;
  automation: { enabled: boolean; disabledReason: string | null };
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string | null;
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
- Autorización de agentes: por `department` vía `agent_membership`, o `is_global_admin=true`.
- Toda acción de escritura queda en `audit_event`.

---

## G. Qué ya no aplica de la v1 (para quien haya visto la versión anterior)

- ~~`POST /api/webhooks/n8n/action-result`~~ — eliminado, la respuesta llega síncrona en §B.
- ~~`POST /api/webhooks/n8n/interpretation`~~ — eliminado, la respuesta llega síncrona en §A.
- ~~Validación de "resultado huérfano" contra `executionId`~~ — ya no aplica, no hay callback separado que pueda llegar sin haber sido disparado.
