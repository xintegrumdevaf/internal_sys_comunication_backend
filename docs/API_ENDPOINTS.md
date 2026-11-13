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
| `GET` | `/api/departments` | sesión | Lista departamentos (`id`, `name`, `slug`, `description`, `visibility`, `cases: [...]`) |
| `POST` | `/api/departments` | sesión de `role=admin` | Crea departamento con casos. Body: `{ name, slug, description?, visibility?, cases?: [{ label, description, handlingMode?, workflowType? }] }` |
| `PUT` | `/api/departments/:id` | sesión de `role=admin` | Edita departamento y sus casos. Body: `{ name?, slug?, description?, visibility?, active?, cases? }` |
| `DELETE` | `/api/departments/:id` | sesión de `role=admin` | Desactiva un departamento (soft delete) |
| `GET` | `/api/departments/:id/cases` | sesión (`admin` o `manager`) | Lista casos/solicitudes configuradas que atiende ese departamento |
| `POST` | `/api/departments/:id/cases` | sesión de `role=admin` | Agrega un nuevo caso al departamento. Body: `{ label, description, handlingMode?, workflowType? }` |
| `DELETE` | `/api/departments/cases/:caseId` | sesión de `role=admin` | Elimina un caso configurado de un departamento |
| `GET` | `/api/agents` | sesión | Lista agentes (incluye `id`, `role`, `primaryDepartmentId`) |
| `POST` | `/api/agents` | sesión de `role=admin` | Crea un agente. Body: `{ name, email, role?, primaryDepartmentId? }` → `{ agent, temporaryPassword }` |
| `PUT` | `/api/agents/:id` | sesión de `role=admin` | Edita un agente. Body: `{ name?, email?, role?, primaryDepartmentId?, active? }` |
| `DELETE` | `/api/agents/:id` | sesión de `role=admin` | Desactiva un agente (soft delete). No permite quedarse sin ningún admin activo |
| `POST` | `/api/agents/:id/reset-password` | sesión de `role=admin` | Nueva contraseña temporal → `{ agent, temporaryPassword }` |

### Modelo de Casos por Departamento (`cases`)
Cada departamento puede declarar qué motivos o solicitudes atiende:
- **`label`**: Nombre amigable para el operador (ej. *"Cancelación de Contrato"*).
- **`description`**: Frases o ejemplos de lo que dice el cliente (ej. *"cuando el cliente pide cancelar el contrato o darse de baja"*). Se inyecta en el prompt de la IA en tiempo real. Fallback automático a `"Sin descripción"` si no se especifica.
- **`handlingMode`**:
  - `"ai_assisted"`: La IA atiende primero con RAG y escala si no se resuelve.
  - `"human_direct"`: Escala de inmediato al departamento y notifica al cliente sin preguntas de bot.
- **`workflowType`**: Flujo base asignado (por defecto `"GENERAL_INQUIRY"`).

> [!NOTE]
> **Sanitización y Persistencia Robusta de Casos (`PUT /api/departments/:id`)**:
> - **Tolerancia a IDs no-UUID**: Si el cliente envía identificadores temporales o mock (ej. `"mock-case-1"` o cadenas vacías), el backend los sanea automáticamente a `undefined`, eliminando errores `400 Bad Request` por `VALIDATION_ERROR`.
> - **Reconciliación por `intentKey`**: Al actualizar el catálogo de un departamento, si un ítem no posee `id`, el backend verifica si ya existe un registro con el mismo `intentKey` (`toIntentKey(label)`). Si existe, reutiliza el `id` original de PostgreSQL en lugar de borrar y recrear el registro, conservando claves foráneas e integridad referencial.

---

## 4. Conversaciones (inbox + chat)

| Método | Ruta | Query / Body | Descripción |
| `GET` | `/api/conversations` | `?departmentId=&userId=&status=open\|pending\|resolved\|closed` | Bandeja. Cada ítem trae `lastMessagePreview` (no hace falta pedir mensajes por fila) y `activeCase` (estado, departamento, agente y estado del bot). Los filtros `departmentId` y `userId` aplican sobre el **caso activo actual**, ignorando casos históricos cerrados. |
| `GET` | `/api/conversations/:id/messages` | `?limit=&cursor=` | Historial cronológico paginado |
| `GET` | `/api/conversations/:id/cases` | — | Casos de esa conversación (histórico; pueden coexistir SUPPORT + BILLING) |
| `GET` | `/api/conversations/:id/automation` | — | Automation del caso activo (o `null`) |
| `POST` | `/api/conversations/:id/read` | — | Marca todos los mensajes de la conversación como leídos (pone `unreadCount` en 0) |
| `POST` | `/api/conversations/:id/reply` | `{ "body" }` → `201` | Respuesta humana a WhatsApp (el agente es el de la sesión); desactiva automation si hacía falta |
| `POST` | `/api/conversations/:id/template` | `{ "templateName", "templateLanguage?", "parameters?", "components?" }` → `201` | Envío manual de plantilla oficial de WhatsApp/Meta por parte del asesor. Asigna `agentId: agent.id` de la sesión activa para trazabilidad del asesor. No silencia a la IA por inactividad si el cliente responde posteriormente |
| `POST` | `/api/conversations/:id/take-control` | — | El agente de la sesión toma la conversación |
| `POST` | `/api/conversations/sync-history` | sesión de `role=admin` | Encola en Redis la sincronización de mensajes históricos de Zernio. Body opcional: `{ "days": 30, "limit": 100 }` |
| `GET` | `/api/conversations/sync-history/status` | sesión (`admin` o `manager`) | Consulta el estado del worker de sincronización (`idle`, `running`, `completed`, `failed`), total sincronizado y errores |
| `GET` | `/api/media/*` o `?url=` | wildcard o query `?url=` | Proxy de streaming y persistencia local de adjuntos (`LocalMediaStorageAdapter`). Desempaqueta URLs recursivamente, soporta Range Requests (`Accept-Ranges: bytes`) para streaming continuo de audio/video y reintento con accountId |

Todas requieren sesión (§1) — el agente que responde/toma control es siempre el de la cookie, nunca uno declarado en el body.

> [!NOTE]
> **Resiliencia de Envío en WhatsApp vía Zernio y Manejo de Ventana de 24 Horas**:
> - **Rutas de Envío en Zernio**: Cuando un asesor responde vía `POST /api/conversations/:id/reply` (o envía adjuntos vía `/media` o `/attachments`), el adaptador `ZernioSenderHttp` entrega tanto texto plano como archivos en `POST /inbox/conversations/:id/messages` (conversación existente). Si no posee el `conversationId` y llamase a `POST /inbox/conversations` (crear chat nuevo), Meta rechaza mensajes de texto o multimedia con `400 TEMPLATE_REQUIRED`. Ambos flujos (`sendText` y `sendMedia`) cuentan con auto-recuperación activa por teléfono si la caché local no tuviese el identificador.
> - **Persistencia en Redis (`zernio:conv:*`)**: Para evitar pérdidas de IDs ante reinicios del backend, la correspondencia `teléfono <-> zernio_conversation_id` se persiste en Redis con TTL de 30 días, además de registrarse desde los webhooks entrantes y salientes.
> - **Búsqueda Activa y Auto-Recuperación**: Si la caché fallase y Zernio respondiera `TEMPLATE_REQUIRED`, el adaptador consulta automáticamente a Zernio por teléfono (`search=${cleanPhone}`, con y sin prefijo internacional `593`), recupera el `conversationId` existente y reintenta la entrega de inmediato por el endpoint de conversación existente, entregando el mensaje sin requerir plantilla.
> - **Desambiguación de Errores de Entrega**: La función normalizadora `is24HourWindowError` (`meta-delivery-error.ts`) solo marca la ventana como cerrada ante reportes explícitos de expiración de tiempo (código Meta `131047` o `"24 hours elapsed"`), previniendo falsos positivos de chat inactivo cuando la ventana de 24h del cliente sigue vigente.

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
| `POST` | `/api/cases/:id/transfer` | `{ "toDepartmentId?", "toAgentId?", "reason?" }` | Cambia departamento o transfiere a agente. Auto-asigna agente si aplica y deja mensaje de sistema en la conversación para trazabilidad |
| `POST` | `/api/cases/:id/disable-automation` | `{ "reason" }` | Apaga bot sin escalar |
| `POST` | `/api/cases/:id/reactivate-automation` | — (sesión) | Reactiva bot **conservando** el context |
| `POST` | `/api/cases/:id/sync-data` | — (sesión) | Sincroniza ficha completa de cliente (contratos, sector, OLT, PON, serial, IP) y saldo actual |
| `POST` | `/api/cases/:id/diagnose` | — (sesión) | Dispara diagnóstico técnico en caliente a MikroTik/OLT (`SUPPORT_INTERNET`) y actualiza telemetría |

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
| `GET` | `/api/escalations` | sesión | Bandeja de escalaciones y triaje. Query: `?departmentId=`, `?status=PENDING\|ASSIGNED\|RESOLVED`, `?triage=true`. Retorna `{ data: EscalationDto[] }` enriquecido con datos del cliente (`customerName`, `customerPhone`) y `conversationId`. |
| `POST` | `/api/escalations/drain` | sesión | Despacho automático de cola por departamento o global con bloqueo atómico `FOR UPDATE OF e SKIP LOCKED`. Body: `{ departmentId?: string }`. Retorna `{ data: { drainedCount: number } }` |
| `GET` | `/api/dashboard` | sesión (`?userId=` opcional para ver el de otro agente) | KPIs del agente |

> **Nota sobre queries y persistencia (`escalation.repository.pg.ts`)**:  
> Al unir la tabla `escalation` con la entidad de casos, siempre debe utilizarse el identificador entre comillas dobles `"case"` (ej: `LEFT JOIN "case" c ON c.id = e.case_id`), debido a que `CASE` es una palabra reservada en la gramática estándar de PostgreSQL. Nunca usar el plural sin comillas `cases`.

---

## 7. Auditoría

| Método | Ruta | Query | Descripción |
|---|---|---|---|
| `GET` | `/api/audit` | sesión de `role=admin` — `?limit=` (máx 200, default 50) | Eventos recientes de escritura |
 
---
 
## 8. Base de Conocimiento (RAG)
 
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/rag/documents` | sesión | Listar todos los documentos RAG registrados en la base de datos |
| `POST` | `/api/rag/documents` | sesión de `role=admin` | Registrar un nuevo documento RAG. Body: `{ name, category?, mimeType?, sizeBytes?, uploadedBy?, sourceUrl? }` |
| `DELETE` | `/api/rag/documents/:id` | sesión de `role=admin` | Elimina un documento RAG de la base de datos |
| `GET` | `/api/rag/faqs` | sesión | Listar todas las preguntas frecuentes (FAQs) del RAG |
| `POST` | `/api/rag/faqs` | sesión de `role=admin` | Crear o actualizar una FAQ. Body: `{ id?, question, answer, category?, tags?, variations?, active? }` |
| `DELETE` | `/api/rag/faqs/:id` | sesión de `role=admin` | Eliminar una FAQ de la base de datos |
| `POST` | `/api/rag/query` | sesión | Realiza una consulta RAG simulada/basada en palabras clave. Body: `{ question }` → `{ answer, found, confidenceScore, sources, retrievedChunks, executionTimeMs }` |
 
---

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

## 10. RAG y Base de Conocimiento (100% Nativo en Backend)

Endpoints administrativos para ingesta, gestión y consulta de la base de conocimiento vectorial (PGVector + Búsqueda Híbrida):

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/rag/stats` | sesión (admin/manager) | Estadísticas (total documentos, chunks, faqs) |
| `GET` | `/api/rag/documents` | sesión (admin/manager) | Listado de documentos cargados |
| `POST` | `/api/rag/documents/upload` | sesión (admin/manager) | Ingesta de PDF / Texto (multipart `file` o `text`, `title`, `description`) |
| `DELETE` | `/api/rag/documents/:id` | sesión (admin/manager) | Elimina documento y sus embeddings vectoriales |
| `GET` | `/api/rag/faqs` | sesión (admin/manager) | Listado de FAQs estructuradas |
| `POST` | `/api/rag/faqs` | sesión (admin/manager) | Crea FAQ (`{ "question", "answer", "category?" }`) |
| `DELETE` | `/api/rag/faqs/:id` | sesión (admin/manager) | Elimina una FAQ |
| `POST` | `/api/rag/query` | sesión (admin/manager) | Playground de consulta RAG (`{ "question", "topK?" }`) |

---

## 11. Webhooks de Entrada (Zernio y WhatsApp Cloud API)

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| `POST` | `/api/webhooks/zernio` | Zernio | Ingesta de mensajes y estados de Zernio (firma HMAC-SHA256 en header `x-zernio-signature`) |
| `GET` | `/api/webhooks/whatsapp` | Meta | Verificación del webhook directo de WhatsApp Cloud API |
| `POST` | `/api/webhooks/whatsapp` | Meta | Ingesta de mensajes de Meta (firma `X-Hub-Signature-256`) |

No lo uses desde el panel de agentes. El flujo de cliente llega por aquí → buffer → IA → casos → WhatsApp outbound.

---

## 12. Flujos típicos en el frontend

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

## 13. Colección Postman sugerida

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

## 14. Respuestas Rápidas (Quick Replies estilo Whaticket)

Atajos de respuesta predefinidos con variables dinámicas (`{{nombre}}`, `{{cedula}}`, `{{agente}}`, `{{telefono}}`), alcance General vs Departamento, y control de acceso por roles.

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/quick-replies` | sesión | Lista respuestas visibles (globales + asignadas al agente). Query: `departmentId` (opcional, uuid o `null`), `search` (opcional), `category` (opcional), `activeOnly` (booleano) |
| `GET` | `/api/quick-replies/resolve` | sesión | Resuelve un atajo con interpolación de variables de contexto. Query: `shortcut` (requerido, ej. `saludo`), `departmentId` (opcional), `conversationId` (opcional) |
| `POST` | `/api/quick-replies` | `admin` o `manager` | Crea una respuesta rápida. Body: `{ shortcut, title, body, departmentId?, category?, mediaUrl? }`. `manager` solo puede crear para su departamento; `admin` para cualquier departamento o global (`departmentId: null`) |
| `POST` | `/api/quick-replies/refine-tone` | `admin` o `manager` | Refina el tono de un borrador de respuesta rápida hacia uno empático y profesional con IA on-demand. Body: `{ text: string }`. Responde: `{ refinedText: string }` |
| `PUT` | `/api/quick-replies/:id` | `admin` o `manager` | Actualiza una respuesta rápida existente. `manager` solo puede modificar las de su departamento |
| `DELETE` | `/api/quick-replies/:id` | `admin` o `manager` | Elimina una respuesta rápida |

## 15. Directorio de Contactos y Clientes (/api/customers)

Gestión unificada de clientes del ISP, etiquetado, sincronización con n8n y apertura inmediata de chats operativos:

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/customers` | sesión | Lista paginada de clientes. Query: `search=`, `tagId=`, `hasTags=`, `startDate=`, `endDate=`, `page=`, `limit=` |
| `GET` | `/api/customers/:id` | sesión | Detalle del cliente: datos de contacto, contratos asociados, etiquetas y conversación vinculada |
| `POST` | `/api/customers` | sesión | Crea un contacto nuevo y lo vincula automáticamente a su conversación si existe |
| `PATCH` | `/api/customers/:id` | sesión | Modifica datos del contacto y actualiza sus etiquetas |
| `DELETE` | `/api/customers/:id` | `admin` o `manager` | Elimina un contacto |
| `POST` | `/api/customers/:id/sync-isp` | sesión | Sincroniza contratos del cliente consultando a n8n (`VALIDATE_CLIENT`) y auto-asigna etiquetas por sector |
| `POST` | `/api/customers/:id/conversation` | sesión | Abre o crea al vuelo la conversación de WhatsApp para ese cliente, permitiendo chatear inmediatamente sin esperar que termine la sincronización de historial |

---

## 16. Configuración de Red e Infraestructura (/api/admin/settings/network)

Endpoints para la gestión de Routers MikroTik y OLTs (administrados por `admin` y gerentes de soporte):

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/admin/settings/network/routers` | `admin` o soporte | Lista todos los routers y sus OLTs vinculadas |
| `POST` | `/api/admin/settings/network/routers` | `admin` o soporte | Crea un router individual (`{ name, sector, ip, port, user, password, description? }`) |
| `PUT` | `/api/admin/settings/network/routers/:id` | `admin` o soporte | Actualiza un router |
| `DELETE` | `/api/admin/settings/network/routers/:id` | `admin` o soporte | Elimina un router |
| `GET` | `/api/admin/settings/network/routers/:id/password` | `admin` o soporte | Consulta la contraseña del router para edición |
| `POST` | `/api/admin/settings/network/routers/:routerId/olts` | `admin` o soporte | Crea una OLT bajo un router (`{ name, ip, brand, model, port, user, password, ponPorts }`) |
| `PUT` | `/api/admin/settings/network/routers/:routerId/olts/:oltId` | `admin` o soporte | Actualiza una OLT |
| `DELETE` | `/api/admin/settings/network/routers/:routerId/olts/:oltId` | `admin` o soporte | Elimina una OLT |
| `GET` | `/api/admin/settings/network/routers/:routerId/olts/:oltId/password` | `admin` o soporte | Consulta la contraseña de la OLT |
| `POST` | `/api/admin/settings/network/test-connection` | `admin` o soporte | Prueba de conectividad con un equipo antes de guardar |
| `POST` | `/api/admin/settings/network/import` | `admin` o soporte | **Importación masiva**: sube un JSON con la lista completa de routers y OLTs (ej. [docs/network-topology-sample.json](./network-topology-sample.json)) |
| `GET` | `/api/admin/settings/network/export` | `admin` o soporte | **Exportación**: descarga la topología completa en JSON para respaldos o transferir entre ambientes |

---

## 17. Módulo de Campañas Masivas de WhatsApp (/api/campaigns)

Endpoints para la gestión, importación de destinatarios y despacho progresivo de campañas masivas por WhatsApp (vía plantillas Meta o mensajes con variables):

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/campaigns` | sesión | Lista campañas registradas con su progreso calculado `(sentCount + failedCount) / totalRecipients * 100`. Query: `status?` (`DRAFT`, `RUNNING`, `SUSPENDED`, `COMPLETED`, `FAILED`) |
| `GET` | `/api/campaigns/:id` | sesión | Detalle completo de una campaña con su lista enriquecida de destinatarios. Consulta directamente la base de datos local (<10ms) sin hacer polling HTTP a Zernio |
| `POST` | `/api/campaigns` | sesión | Crea una campaña en estado `DRAFT`. Body: `{ name, messageBody?, templateName?, templateLanguage?, variableMapping?, quickMode?, quickModeIntervalSeconds?, chatRouting? }` |
| `POST` | `/api/campaigns/:id/recipients/import` | sesión | Importación masiva de destinatarios vía archivo multipart (`.csv` o `.xlsx`) |
| `POST` | `/api/campaigns/:id/start` | sesión | Pasa la campaña a estado `RUNNING` y encola los lotes en Redis para su procesamiento por el worker |
| `POST` | `/api/campaigns/:id/suspend` | sesión | Suspende la campaña en ejecución |
| `POST` | `/api/campaigns/:id/resume` | sesión | Reanuda una campaña suspendida reencolando los pendientes |
| `DELETE` | `/api/campaigns/:id` | sesión | Elimina una campaña (únicamente permitido si está en estado `DRAFT`) |

### Enrutamiento de Chat (`chatRouting`), Casos Activos y Ciclo de Vida:
* **Bandeja de Cerrados por Defecto (`initialStatus: "CLOSED"`)**:
  Al crear y despachar una campaña, la configuración por defecto de `chatRouting.initialStatus` es estrictamente `"CLOSED"` (tanto si el frontend envía `chatRouting` como si envía `routingConfig: { chatStatus: "closed" }`). Al entregar cada mensaje masivo, la conversación se posiciona en la pestaña **"Cerradas"** (`status: 'closed'`), evitando inundar la **Bandeja de Abiertos** de los asesores con cientos de mensajes salientes sin interacción del cliente.
* **Protección de Clientes con Atención Humana o Caso Activo (`activeCaseId`)**:
  ¿Qué sucede si un cliente incluido en la campaña masiva está siendo atendido actualmente por un asesor o bot?
  - Si la conversación tiene un caso activo en curso (`activeCaseId` no nulo, ej. `HUMAN_ACTIVE` o `ACTIVE`):
    - El mensaje de la campaña se entrega exitosamente al WhatsApp del cliente y se añade al historial del chat vinculándolo al `activeCaseId`.
    - **NO se modifica el estado de la conversación a `"closed"`**: la conversación permanece abierta (`open`), protegiendo la sesión del asesor para que el chat no se mueva de su bandeja ni se interrumpa la conversación en curso (salvo que la campaña declare explícitamente `forceChatUpdate: true`).
* **Clientes con Casos Resueltos (`COMPLETED`) o sin Caso Activo**:
  - Si el cliente tenía un caso previo que ya fue cerrado o resuelto (o no tenía casos previos), el envío del mensaje de campaña ubica la conversación en **"Cerradas"** (`status: 'closed'`). El caso resuelto se mantiene cerrado en su historial y no se reabre.
* **Diferenciación entre Campaña Masiva y Envío Manual de Plantilla**:
  - **Campaña Masiva**: Despachada por el motor de campañas en lotes automatizados; se enruta por defecto a "Cerradas", no tiene asesor asignado (`agentId: null`) y en la interfaz muestra la etiqueta `📢 Campaña Masiva`.
  - **Plantilla Manual (`POST /api/conversations/:id/template`)**: Enviada por un asesor desde el chat individual (ej. para reabrir ventana de 24h o notificar individualmente); **no altera el estado del chat a cerrado**, registra la autoría con `agentId: agent.id` y muestra en pantalla el nombre real del asesor con la etiqueta `🏷️ Plantilla`.
* **Reapertura y Análisis con IA al Recibir Respuesta**:
  Cuando un cliente responde al mensaje de la campaña en WhatsApp:
  1. `ReceiveInboundMessageUseCase` reabre automáticamente la conversación (`status: 'open'`), trasladándola a la bandeja de Abiertos en tiempo real.
  2. La IA (Gemini) toma el mensaje junto con el contexto del mensaje previo de la campaña que el cliente recibió.
  3. Si es una consulta de negocio (ventas, soporte técnico, facturación), la IA inicia el caso automatizado o lo deriva al área humana pertinente.
  4. Si el cliente solo responde una cortesía (*"gracias"*, *"ok gracias"*, emojis), el filtro de cortesías lo mantiene en Cerrados sin crear casos falsos.
* **Seguimiento Asíncrono de Entregas (Webhooks vs. Polling HTTP)**:
  Los estados de entrega de cada destinatario (`SENT`, `FAILED`, recibos de lectura) son notificados asíncronamente vía webhooks de Zernio/Meta (`message.delivered`, `message.failed`). La consulta de campañas en la API no realiza llamadas HTTP externas a Zernio, protegiendo las cuotas de Rate Limit (429) de la empresa.
* **Traducción y Normalización de Errores de Entrega de Meta (`errorMessage`)**:
  Al consultar el detalle de una campaña (`GET /api/campaigns/:id`) o procesar webhooks de fallo, los mensajes técnicos en inglés de WhatsApp Cloud API se traducen automáticamente a explicaciones de negocio claras en español (`meta-delivery-error.ts`):
  * `131049` (*Healthy ecosystem engagement*): *"Límite de protección de Meta: Meta bloqueó la entrega para evitar saturar al destinatario con mensajes de marketing/campaña (Error Meta 131049)"*.
  * `131047` (*24-hour window*): *"Ventana de 24 horas cerrada: Han transcurrido más de 24h desde el último mensaje del cliente. WhatsApp requiere una plantilla oficial (Template) aprobada (Error Meta 131047)"*.
  * `131026` (*Message undeliverable*): *"Número no disponible: El destinatario no tiene WhatsApp activo o no puede recibir mensajes (Error Meta 131026)"*.
  * `131056` (*Param count mismatch*): *"Error en plantilla: Las variables enviadas no coinciden con los parámetros requeridos por la plantilla (Error Meta 131056)"*.
  * `130429` / `429` (*Rate limit exceeded*): *"Límite de envíos excedido en Meta/Zernio (Error Rate Limit)"*.
  Esto garantiza que tanto en pantalla como al descargar los reportes de fallidas (en Excel `.xlsx` o CSV), el operador y el administrador entiendan exactamente por qué no se entregó cada mensaje y qué acción comercial o técnica corresponde.

---

## 18. Centinela & Ops de Telegram (`/api/admin/settings/telegram`, `/api/v1/telegram/webhook`, `/analitica`)

Gestión ejecutiva por Telegram Bot API (alertas reactivas de SLA/OLT/cola, pulso operativo programado, Copilot IA y Snapshot Ejecutivo Web):

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/admin/settings/telegram` | `admin` | Obtiene la configuración de Telegram con `botToken` enmascarado |
| `PUT` | `/api/admin/settings/telegram` | `admin` | Actualiza credenciales, `frontendUrl`, modo/temas, horarios de pulso, reglas del Centinela y Copilot IA |
| `POST` | `/api/admin/settings/telegram/detect-chat` | `admin` | Consulta actualizaciones recientes (`getUpdates`) para detectar grupos/supergrupos candidatos |
| `POST` | `/api/admin/settings/telegram/test` | `admin` | Valida el bot vía `getMe` y envía mensaje opcional de prueba (auto-persiste `migratedToChatId` si el grupo migró a supergrupo) |
| `POST` | `/api/admin/settings/telegram/test-topic` | `admin` | Envía mensaje de prueba a un `threadId` específico dentro de un supergrupo con Temas (Forum Topics) |
| `POST` | `/api/admin/settings/telegram/send-digest` | `admin` | Dispara envío manual inmediato (`timeLabel: "Manual"`) del Pulso Operativo Ejecutivo |
| `POST` | `/api/admin/settings/telegram/check-alerts` | `admin` | Ejecuta una evaluación inmediata del Centinela Reactivo (brechas SLA, cortes OLT, saturación de cola) |
| `POST` | `/api/admin/settings/telegram/test-alert` | `admin` | Envía una alerta simulada (`category`: `SLA` \| `INFRASTRUCTURE` \| `QUEUE`) sin esperar incidente real |
| `POST` | `/api/admin/settings/telegram/set-webhook` | `admin` | Registra la URL del webhook en `api.telegram.org` con `secretToken` (`webhookSecret`) |
| `POST` | `/api/v1/telegram/webhook` | `x-telegram-bot-api-secret-token` | Receptor público de updates de Telegram (comandos `/resumen`, `/sla`, `/agentes`, callbacks y Copilot IA) |
| `GET` | `/analitica` (`/analitica/snapshot`) | público | Snapshot Ejecutivo Web HTML responsivo en vivo (`?format=json` o `Accept: application/json` retorna payload JSON) |
| `GET` | `/cases/:caseId` (`/case/:caseId`), `/casos`, `/bandeja`, `/settings`, `/configuracion` | público | Redirecciones HTTP `302` amigables hacia la URL pública del frontend (`frontendUrl` / `FRONTEND_URL`) |

---

## 19. Qué **no** es HTTP en esta API

- Interpretación IA / compose reply → interno (`AIProviderPort`), no endpoints.
- Llamadas a n8n (`VALIDATE_CLIENT`, `CHECK_BALANCE`, `DIAGNOSTIC`, …) → las hace la API hacia n8n; el frontend no las invoca.

Detalle: [`03_API_CONTRACT.md`](./spec/03_API_CONTRACT.md) §A y §B.

