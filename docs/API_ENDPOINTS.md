# API Endpoints — consumo desde Postman / frontend

Guía práctica de la superficie HTTP de esta API. El contrato normativo completo (DTOs, errores, semántica) está en [`docs/spec/03_API_CONTRACT.md`](./spec/03_API_CONTRACT.md). Este documento resume **qué llamar**, **con qué body/headers** y **para qué pantalla o flujo**.

**Base URL (local):** `http://localhost:3000`

**Formato de respuesta:** casi todo responde `{ "data": ... }`. Errores: `{ "error": { "type": "...", "message": "..." } }`.

---

## 1. Identidad (sin JWT todavía)

Aún no hay login/JWT. La identidad del agente se declara con:

| Mecanismo | Uso |
|---|---|
| Header `x-agent-id: <uuid del agent>` | Obligatorio en escalaciones, assign/reassign, dashboard (si no hay `userId`), admin n8n, y como fallback en complete/transfer/automation |
| Body `agentUserId` | `reply`, `take-control`, `claim`, y opcional en varias acciones de caso |
| Query `userId` | `GET /api/dashboard`, `GET /api/realtime` |

Obtén un UUID válido con `GET /api/agents` y úsalo en Postman como variable `agentId`.

Para rutas admin (`/api/admin/n8n-workflows*`) el agente debe tener `role: "admin"`.

---

## 2. Health

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| `GET` | `/health` | cualquiera | Postgres + Redis. `200` ok / `503` degraded |

No está bajo `/api`.

---

## 3. Catálogos (frontend / Postman)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/departments` | — | Lista departamentos (`slug`, `visibility`, …) |
| `GET` | `/api/agents` | — | Lista agentes (incluye `id`, `role`, `primaryDepartmentId`) |

Útiles al arrancar el frontend o al configurar variables de Postman.

---

## 4. Conversaciones (inbox + chat)

| Método | Ruta | Query / Body | Descripción |
|---|---|---|---|
| `GET` | `/api/conversations` | `?departmentId=&userId=&status=open\|pending\|resolved\|closed` | Bandeja. Cada ítem trae `lastMessagePreview` (no hace falta pedir mensajes por fila) |
| `GET` | `/api/conversations/:id/messages` | `?limit=&cursor=` | Historial cronológico paginado |
| `GET` | `/api/conversations/:id/cases` | — | Casos de esa conversación (histórico; pueden coexistir SUPPORT + BILLING) |
| `GET` | `/api/conversations/:id/automation` | — | Automation del caso activo (o `null`) |
| `POST` | `/api/conversations/:id/reply` | `{ "agentUserId", "body" }` → `201` | Respuesta humana a WhatsApp; desactiva automation si hacía falta |
| `POST` | `/api/conversations/:id/take-control` | `{ "agentUserId" }` | Agente toma la conversación |

### Postman — reply

```http
POST {{baseUrl}}/api/conversations/{{conversationId}}/reply
Content-Type: application/json

{
  "agentUserId": "{{agentId}}",
  "body": "Hola, soy un asesor. Ya estoy revisando tu caso."
}
```

---

## 5. Casos

| Método | Ruta | Body / headers | Descripción |
|---|---|---|---|
| `GET` | `/api/cases/:id` | — | Detalle: status, `workflowType`, `context`, `currentState`, automation |
| `GET` | `/api/cases/:id/timeline` | — | Ejecuciones n8n + eventos ordenados |
| `GET` | `/api/cases/:id/summary` | — | Resumen para triaje (caso escalado / `HUMAN_ACTIVE`) |
| `POST` | `/api/cases/:id/claim` | `{ "agentUserId" }` → `204` | Reclama caso sin dueño |
| `POST` | `/api/cases/:id/assign` | header `x-agent-id` + `{ "agentUserId", "departmentId?" }` → `204` | Asigna (manager/admin) |
| `POST` | `/api/cases/:id/reassign` | igual que assign → `204` | Reasigna caso ya asignado |
| `POST` | `/api/cases/:id/complete` | `{ "agentUserId?", "resolutionNote?" }` | Cierra `COMPLETED` |
| `POST` | `/api/cases/:id/cancel` | `{ "reason", "agentUserId?" }` | `CANCELLED` |
| `POST` | `/api/cases/:id/transfer` | `{ "toDepartmentId", "reason", "agentUserId?" }` | Cambia departamento |
| `POST` | `/api/cases/:id/disable-automation` | `{ "reason", "agentUserId?" }` | Apaga bot sin escalar |
| `POST` | `/api/cases/:id/reactivate-automation` | `{ "agentUserId?" }` o header `x-agent-id` | Reactiva bot **conservando** el context |

### Postman — ver un caso

```http
GET {{baseUrl}}/api/cases/{{caseId}}
```

Respuesta típica (campos relevantes):

```json
{
  "data": {
    "id": "...",
    "conversationId": "...",
    "workflowType": "BILLING_BALANCE",
    "status": "COMPLETED",
    "currentState": "RESPOND_NO_DEBT",
    "context": { "workflowType": "BILLING_BALANCE", "data": { "balance": { "hasDebt": false } } },
    "automation": { "enabled": true, "disabledReason": null }
  }
}
```

---

## 6. Escalaciones y dashboard

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/escalations` | `x-agent-id` | Bandeja. Query: `?departmentId=`, `?status=PENDING\|ASSIGNED\|RESOLVED`, `?triage=true` (pool sin departamento) |
| `GET` | `/api/dashboard` | `?userId=` o `x-agent-id` | KPIs del agente |

---

## 7. Auditoría

| Método | Ruta | Query | Descripción |
|---|---|---|---|
| `GET` | `/api/audit` | `?limit=` (máx 200, default 50) | Eventos recientes de escritura |

---

## 8. Admin — catálogo n8n

Solo `role=admin` + header `x-agent-id`.

| Método | Ruta | Body | Descripción |
|---|---|---|---|
| `GET` | `/api/admin/n8n-workflows` | `?category=case_action\|admin_action` | Lista action → URL |
| `PUT` | `/api/admin/n8n-workflows/:action` | `{ "url", "timeoutMs?", "maxRetries?", "active?" }` | Upsert (efecto inmediato) |
| `DELETE` | `/api/admin/n8n-workflows/:action` | — | Desactiva la entrada |

Ejemplo:

```http
PUT {{baseUrl}}/api/admin/n8n-workflows/CHECK_BALANCE
x-agent-id: {{adminAgentId}}
Content-Type: application/json

{
  "url": "http://localhost:5678/webhook/check-balance",
  "timeoutMs": 15000,
  "maxRetries": 1,
  "active": true
}
```

---

## 9. Tiempo real (SSE)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/realtime?userId=` | o header `x-agent-id` | Server-Sent Events |

En el navegador:

```js
const es = new EventSource(`${baseUrl}/api/realtime?userId=${agentId}`);
es.onmessage = (ev) => {
  const event = JSON.parse(ev.data);
  // MESSAGE_RECEIVED | MESSAGE_SENT | CASE_ESCALATED | CASE_CLAIMED | HUMAN_ASSIGNED | AUTOMATION_ENABLED
};
```

Los eventos de mensaje solo traen IDs; el contenido se lee con `GET /api/conversations/:id/messages`.

En Postman: tipo **SSE** / stream, o usa el navegador; no es un JSON único.

---

## 10. WhatsApp webhook (no es para el frontend)

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| `GET` | `/api/webhooks/whatsapp` | Meta | Verificación del webhook |
| `POST` | `/api/webhooks/whatsapp` | Meta | Ingesta de mensajes (firma `X-Hub-Signature-256`) |

No lo uses desde el panel de agentes. El flujo de cliente llega por aquí → buffer → IA → casos → WhatsApp outbound.

---

## 11. Flujos típicos en el frontend

### Inbox de agente
1. `GET /api/agents` + `GET /api/departments` (bootstrap)
2. `GET /api/conversations?status=open&departmentId=...`
3. Abrir chat: `GET /api/conversations/:id/messages` + `GET /api/conversations/:id/cases`
4. Suscribirse a `GET /api/realtime?userId=...` y refrescar mensajes al recibir `MESSAGE_*`

### Atender escalación
1. `GET /api/escalations` (o `?triage=true` si eres manager/admin)
2. `GET /api/cases/:id` + `/summary` + `/timeline`
3. `POST /api/cases/:id/claim` → `POST /api/conversations/:id/reply`
4. Al terminar: `POST /api/cases/:id/complete` o `reactivate-automation`

### Verificar independencia de casos (misma conversación)
1. `GET /api/conversations/:id/cases` → varios IDs
2. `GET /api/cases/:supportCaseId` → p.ej. `SUPPORT_INTERNET` / `ESCALATED`
3. `GET /api/cases/:billingCaseId` → p.ej. `BILLING_BALANCE` / `COMPLETED`  
   Solo comparten `conversationId`.

---

## 12. Colección Postman sugerida

Variables de entorno:

| Variable | Ejemplo |
|---|---|
| `baseUrl` | `http://localhost:3000` |
| `agentId` | UUID de `GET /api/agents` |
| `adminAgentId` | UUID de un agent con `role=admin` |
| `conversationId` | de la bandeja |
| `caseId` | de `/cases` o del active case |

Orden recomendado al armar la colección:
1. Health → Departments → Agents  
2. Conversations list → Messages → Cases  
3. Case detail / timeline / summary  
4. Claim → Reply → Complete  
5. Escalations → Dashboard  
6. Admin n8n (con admin)  
7. Realtime (SSE aparte)

---

## 13. Qué **no** es HTTP en esta API

- Interpretación IA / compose reply → interno (`AIProviderPort`), no endpoints.
- Llamadas a n8n (`VALIDATE_CLIENT`, `CHECK_BALANCE`, `DIAGNOSTIC`, …) → las hace la API hacia n8n; el frontend no las invoca.

Detalle: [`03_API_CONTRACT.md`](./spec/03_API_CONTRACT.md) §A y §B.
