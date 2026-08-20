# API Endpoints — consumo desde Postman / frontend

Guía práctica de la superficie HTTP de esta API. El contrato normativo completo (DTOs, errores, semántica) está en [`docs/spec/03_API_CONTRACT.md`](./spec/03_API_CONTRACT.md). Este documento resume **qué llamar**, **con qué body/headers** y **para qué pantalla o flujo**.

**Base URL (local):** `http://localhost:3000`

**Formato de respuesta:** casi todo responde `{ "data": ... }`. Errores: `{ "error": { "type": "...", "message": "..." } }`.

---

## 1. Identidad (login real con sesión de servidor)

Desde la migración `0009_agent_password_hash.sql` hay login real: `POST /api/auth/login` valida `{ email, password }` (argon2id) y deja una **cookie `httpOnly` `sid`** (token opaco guardado en Redis, expiración deslizante de 12h). El header `x-agent-id` **ya no se usa como identidad** — cada router resuelve siempre `req.agent` a partir de esa cookie (`session.middleware.ts`), nunca de algo que el cliente declare.

| Endpoint | Body | Descripción |
|---|---|---|
| `POST /api/auth/login` | `{ email, password }` | Deja la cookie de sesión. En Postman: activa "Automatically follow redirects" y "Send cookies" (por defecto en la app de escritorio) |
| `POST /api/auth/logout` | — | Revoca la sesión en el servidor |
| `GET /api/auth/me` | — | Agente de la sesión actual (`403` si no hay sesión) |
| `POST /api/auth/change-password` | `{ currentPassword, newPassword }` | Autoservicio, requiere sesión |

Para pruebas rápidas en Postman: crea una request `POST /api/auth/login`, envíala una vez (Postman guarda la cookie automáticamente en su cookie jar) y todas las requests siguientes al mismo `Base URL` ya van autenticadas — no hace falta setear ningún header a mano.

En desarrollo, `npm run seed` deja dos cuentas con contraseña conocida: `admin@isp.local` / `soporte@isp.local`, contraseña `ChangeMe123!` (ver el `console.log` del script). Para cualquier otro agente, usa `POST /api/agents/:id/reset-password` (requiere estar logueado como `role: admin`) y copia la `temporaryPassword` de la respuesta — solo se muestra una vez.

Para rutas admin (`/api/admin/n8n-workflows*`, `/api/agents` en escritura, `/api/audit`) el agente de la sesión debe tener `role: "admin"`.

Campos como `agentUserId` que siguen apareciendo en algunos bodies (`assign`/`reassign`) **no son identidad** — son el destino de la acción ("a qué agente asignar este caso"), un parámetro de negocio normal.

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
| `GET` | `/api/departments` | sesión | Lista departamentos (`slug`, `visibility`, …) |
| `POST` | `/api/departments` | sesión de `role=admin` | Crea un departamento. Body: `{ name, slug, visibility }` |
| `PUT` | `/api/departments/:id` | sesión de `role=admin` | Edita un departamento. Body: `{ name?, slug?, visibility?, active? }` |
| `DELETE` | `/api/departments/:id` | sesión de `role=admin` | Desactiva un departamento (soft delete) |
| `GET` | `/api/agents` | sesión | Lista agentes (incluye `id`, `role`, `primaryDepartmentId`) |
| `POST` | `/api/agents` | sesión de `role=admin` | Crea un agente. Body: `{ name, email, role?, primaryDepartmentId? }` → `{ agent, temporaryPassword }` |
| `PUT` | `/api/agents/:id` | sesión de `role=admin` | Edita un agente. Body: `{ name?, email?, role?, primaryDepartmentId?, active? }` |
| `DELETE` | `/api/agents/:id` | sesión de `role=admin` | Desactiva un agente (soft delete). No permite quedarse sin ningún admin activo |
| `POST` | `/api/agents/:id/reset-password` | sesión de `role=admin` | Nueva contraseña temporal → `{ agent, temporaryPassword }` |

Útiles al arrancar el frontend o al configurar la colección de Postman (login primero — ver §1).

---

## 4. Conversaciones (inbox + chat)

| Método | Ruta | Query / Body | Descripción |
|---|---|---|---|
| `GET` | `/api/conversations` | `?departmentId=&userId=&status=open\|pending\|resolved\|closed` | Bandeja. Cada ítem trae `lastMessagePreview` (no hace falta pedir mensajes por fila) |
| `GET` | `/api/conversations/:id/messages` | `?limit=&cursor=` | Historial cronológico paginado |
| `GET` | `/api/conversations/:id/cases` | — | Casos de esa conversación (histórico; pueden coexistir SUPPORT + BILLING) |
| `GET` | `/api/conversations/:id/automation` | — | Automation del caso activo (o `null`) |
| `POST` | `/api/conversations/:id/reply` | `{ "body" }` → `201` | Respuesta humana a WhatsApp (el agente es el de la sesión); desactiva automation si hacía falta |
| `POST` | `/api/conversations/:id/take-control` | — | El agente de la sesión toma la conversación |

Todas requieren sesión (§1) — el agente que responde/toma control es siempre el de la cookie, nunca uno declarado en el body.

### Postman — reply

```http
POST {{baseUrl}}/api/conversations/{{conversationId}}/reply
Content-Type: application/json

{
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
| `POST` | `/api/cases/:id/claim` | — (sesión) → `204` | Reclama caso sin dueño para el agente de la sesión |
| `POST` | `/api/cases/:id/assign` | sesión + `{ "agentUserId", "departmentId?" }` → `204` | Asigna (manager/admin) al agente `agentUserId` (destino, no identidad) |
| `POST` | `/api/cases/:id/reassign` | igual que assign → `204` | Reasigna caso ya asignado |
| `POST` | `/api/cases/:id/complete` | `{ "resolutionNote?" }` | Cierra `COMPLETED` |
| `POST` | `/api/cases/:id/cancel` | `{ "reason" }` | `CANCELLED` |
| `POST` | `/api/cases/:id/transfer` | `{ "toDepartmentId", "reason" }` | Cambia departamento |
| `POST` | `/api/cases/:id/disable-automation` | `{ "reason" }` | Apaga bot sin escalar |
| `POST` | `/api/cases/:id/reactivate-automation` | — (sesión) | Reactiva bot **conservando** el context |

Todas requieren sesión — quién ejecuta la acción es siempre el agente de la cookie.

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
| `GET` | `/api/escalations` | sesión | Bandeja. Query: `?departmentId=`, `?status=PENDING\|ASSIGNED\|RESOLVED`, `?triage=true` (pool sin departamento) |
| `GET` | `/api/dashboard` | sesión (`?userId=` opcional para ver el de otro agente) | KPIs del agente |

---

## 7. Auditoría

| Método | Ruta | Query | Descripción |
|---|---|---|---|
| `GET` | `/api/audit` | sesión de `role=admin` — `?limit=` (máx 200, default 50) | Eventos recientes de escritura |

---

## 8. Admin — catálogo n8n

Solo `role=admin`, con sesión iniciada (§1).

| Método | Ruta | Body | Descripción |
|---|---|---|---|
| `GET` | `/api/admin/n8n-workflows` | `?category=case_action\|admin_action` | Lista action → URL |
| `PUT` | `/api/admin/n8n-workflows/:action` | `{ "url", "timeoutMs?", "maxRetries?", "active?" }` | Upsert (efecto inmediato) |
| `DELETE` | `/api/admin/n8n-workflows/:action` | — | Desactiva la entrada |

Ejemplo (después de `POST /api/auth/login` con una cuenta admin):

```http
PUT {{baseUrl}}/api/admin/n8n-workflows/CHECK_BALANCE
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
| `GET` | `/api/realtime` | sesión (cookie) | Server-Sent Events |

En el navegador, `EventSource` no manda headers propios pero sí cookies con `withCredentials: true`:

```js
const es = new EventSource(`${baseUrl}/api/realtime`, { withCredentials: true });
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
1. `POST /api/auth/login` (una vez, deja la cookie) → `GET /api/agents` + `GET /api/departments` (bootstrap)
2. `GET /api/conversations?status=open&departmentId=...`
3. Abrir chat: `GET /api/conversations/:id/messages` + `GET /api/conversations/:id/cases`
4. Suscribirse a `GET /api/realtime` (`withCredentials: true`) y refrescar mensajes al recibir `MESSAGE_*`

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
| `agentEmail` / `agentPassword` | credenciales de un agente activo (ver §1 para las de desarrollo) |
| `conversationId` | de la bandeja |
| `caseId` | de `/cases` o del active case |

Orden recomendado al armar la colección:
1. `POST /api/auth/login` (Postman guarda la cookie sola) → Health → Departments → Agents
2. Conversations list → Messages → Cases  
3. Case detail / timeline / summary  
4. Claim → Reply → Complete  
5. Escalations → Dashboard  
6. Admin n8n (logueado como admin)
7. Realtime (SSE aparte)

---

## 13. Qué **no** es HTTP en esta API

- Interpretación IA / compose reply → interno (`AIProviderPort`), no endpoints.
- Llamadas a n8n (`VALIDATE_CLIENT`, `CHECK_BALANCE`, `DIAGNOSTIC`, …) → las hace la API hacia n8n; el frontend no las invoca.

Detalle: [`03_API_CONTRACT.md`](./spec/03_API_CONTRACT.md) §A y §B.
