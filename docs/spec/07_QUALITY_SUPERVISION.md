# 07_QUALITY_SUPERVISION.md

## Supervisión de calidad de atenciones humanas (QA conversacional)

> Documento normativo del feature de calidad. Complementa `01` (DDL), `03` (port IA + REST), `06_AI_PROMPTS` (prompt de análisis) y `05` (Etapa 10). La UI consume este contrato; el detalle de pantallas vive en el frontend (`docs/spec/07_QUALITY_SUPERVISION.md` de ese repo).

## 1. Objetivo

Detectar atenciones humanas ineficientes o inapropiadas (agresividad, falta de respeto, abandono, desinformación, vueltas innecesarias) en el tramo **agente humano ↔ cliente**, y dar a supervisores (`admin` y `manager` de área) un panel con:

1. **Eficiencia operativa** por agente (casos cerrados en rango, tiempos derivados).
2. **Cordialidad / calidad** (`cordialityScore` 0–100) por revisión de conversación/caso.
3. **Hallazgos** anclados a `messageId` para remarcar mensajes problemáticos en el detalle.
4. **Coaching híbrido MVP**: nota estructurada persistida + deep-link al chat interno del frontend (hoy local). Chat staff persistente = etapa futura (§8).

La IA **solo evalúa** y devuelve JSON tipado. La API decide cuándo analizar, qué persistir, quién ve qué y qué hacer con el hallazgo. La IA **nunca** decide sanciones HR ni transiciones de caso.

## 2. Alcance y no-alcance

**Incluye**

- Mensajes con `author IN ('customer','agent')` del caso (ventana §4).
- Análisis automático al cerrar tramo humano + análisis on-demand por supervisor.
- Ranking / stats por agente y departamento.
- Coaching notes creadas por supervisor sobre un `quality_review`.

**No incluye (MVP)**

- Chat interno persistente entre staff (etapa futura §8).
- Que el rol `agent` vea su propio score o el panel `/calidad`.
- Análisis de turnos `ai`/`system` (atención bot fuera de este feature).
- Sanciones automáticas, descuentos o bloqueos de cuenta de agente.

## 3. Roles y autorización

| Rol | Visibilidad |
|---|---|
| `admin` | Todos los departamentos, agentes y reviews |
| `manager` | Solo reviews/stats cuyo `department_id` ∈ memberships del manager (mismo patrón que triage/asignaciones, `01_DATA_MODEL.md` §7) |
| `agent` | `403` en todos los endpoints `/api/quality/*` |

Toda escritura (`POST` notes, `PATCH` reviewed, on-demand analyze) queda en `audit_event`.

## 4. Triggers y ventana de mensajes

### Política de costo (tokens) — no negociable en producto

| Momento | ¿Llama a la IA? | Motivo |
|---|---|---|
| Cargar `/calidad` (ranking/lista) | **No** | Solo lee Postgres (`quality_review` ya persistidas). Sin score = aún no analizado o `pending`/`failed`. |
| Cerrar caso con mensajes `agent` | **Sí, 1 vez** (`…:auto`, background) | Momento natural; no bloquea al cliente ni al supervisor. |
| Abrir detalle de review `pending` | **No** (solo poll HTTP) | Espera el job ya encolado. |
| Botón «Reintentar» / on-demand por chat | **Sí** (1 chat) | Fresco solo si `failed` o sin review; **no** reanaliza `ready`/`reviewed`. |
| Worker | Cola durable Postgres, **1 a la vez** | Claim `SKIP LOCKED`; reclaim al boot. |
| `pnpm seed:quality -- --analyze` | Solo demo/dev | No es el flujo de producción. |

No reanalizar reviews `ready`/`reviewed` salvo on-demand explícito. Ventana al modelo: solo `customer`+`agent`, cuerpos truncados (~800 chars), **tramos de tamaño configurable** (`QUALITY_ANALYSIS_CHUNK_SIZE`, default 40) hasta cubrir **todos** los mensajes del caso.

### 4.1 Automático (`trigger_kind = auto_case_closed` / DTO `trigger: "auto_case_closed"`)

Cuando un caso transita desde un estado con atención humana relevante hacia cierre:

- Desde `HUMAN_ACTIVE` (o equivalente con mensajes `author=agent` ya persistidos) hacia `COMPLETED` | `EXPIRED` | `CANCELLED`.

Condición: existe al menos un `message` del caso con `author='agent'`. Si no hay mensajes de agente, **no** se crea review.

Idempotencia: `idempotency_key = '{caseId}:{agentId}:auto'` (`UNIQUE`). Un segundo cierre/reintento no duplica el análisis.

`agent_id` de la review = `case.assigned_agent_id` al momento del cierre (si es null, no auto-analizar).

### 4.2 On-demand (`trigger_kind = on_demand` / DTO `trigger: "on_demand"`)

`POST /api/quality/reviews` con `{ caseId }` por un supervisor autorizado.

Idempotencia: `idempotency_key = '{caseId}:{agentId}:on_demand:{uuid}'` (cada solicitud es una review nueva) **salvo** que ya exista una review `pending` del mismo caso+agente: en ese caso devolver la existente (`200` con la misma entidad), no encolar otra.

### 4.2.1 Batch on-demand (`POST /api/quality/analyze-batch`)

Encola análisis para casos `COMPLETED`/`EXPIRED`/`CANCELLED` con mensajes `agent` **y sin** review en `pending`/`ready`/`reviewed` del mismo agente asignado.

Body opcional: `{ from, to, agentId, departmentId, limit }` — `limit` default 3, max 10. Respuesta: `{ enqueued, pendingTotal, reviews[] }`.

Los jobs se ejecutan en **cola serial** (uno a la vez) para no saturar Ollama. Timeout típico: `AI_QUALITY_TIMEOUT_MS` (default 10 min).

`GET /api/quality/pending-count` expone cuántas reviews están en `pending` (alcance del actor + filtros opcionales) para el indicador de “análisis en curso” en el panel.

### 4.3 Ventana enviada a la IA (análisis por tramos)

1. Mensajes del `case_id` con `author IN ('customer','agent')`, orden cronológico **del más antiguo al más reciente**.
2. Si el caso no tiene `case_id` en mensajes antiguos, fallback: mensajes de la conversación entre el primer `author=agent` del caso y el cierre (documentar en código; preferir siempre `message.case_id`).
3. Excluir `ai` y `system`.
4. Truncar cuerpo por mensaje (~800 chars) — el `messageId` se preserva.
5. **Tramos:** se envían bloques de `chunk_size` mensajes (`QUALITY_ANALYSIS_CHUNK_SIZE`, default 40, rango 10–80). Campos en `quality_review`: `messages_total`, `messages_analyzed`, `chunk_size`.
6. Tras cada tramo: `messages_analyzed` avanza; `status` sigue `pending` mientras `messages_analyzed < messages_total`. El worker reencola el mismo registro (libera `started_at`).
7. Cuando `messages_analyzed = messages_total`: **valoración total** = promedio redondeado de scores por tramo; **review final** (summary) remarca fallos high/medium y síntesis; findings unidos (sin duplicar `messageId`+categoría); `status=ready`.

Indicador UI/API: `messagesAnalyzed / messagesTotal` por conversación/caso (texto, sin barra de progreso global).

### 4.4 Job / cola

- Crear `quality_review` con `status=pending`, `chunk_size` fijado al encolar, `messages_total`/`messages_analyzed` = 0 hasta el primer claim.
- Encolar trabajo (worker interno durable — **no** n8n). Cola serial (1 tramo a la vez en Ollama).
- Invocar `AIProviderPort.analyzeAgentConversation` **por tramo**.
- Validar con Zod (`06_AI_PROMPTS.md` §7): todo `finding.messageId` debe existir en el input del tramo; si no, descartar ese finding.
- Persistencia parcial tras cada tramo; `status=ready` + `completed_at` solo al cubrir el total; o `status=failed` si el provider falla / JSON inválido (el reintento **retoma** desde `messages_analyzed`, no desde 0).
- Fallo de calidad **nunca** afecta al cliente ni al estado del caso.

## 5. Score y umbrales

`cordialityScore`: entero 0–100 (100 = excelente atención).

| Rango | Semáforo UI | Significado |
|---|---|---|
| ≥ 70 | ok | Atención aceptable / cordial |
| 40–69 | atención | Revisar; posibles fallas de tono o eficiencia |
| &lt; 40 | crítico | Alta probabilidad de conducta inapropiada o abandono grave |

`efficiency_notes` (texto opcional de la IA): percepción de demoras o ida-vuelta innecesaria. **No** sustituye KPIs duros del endpoint de agentes.

### 5.1 KPIs de eficiencia (agregados)

`GET /api/quality/agents` calcula por agente en `[from, to]`:

| Campo | Fórmula |
|---|---|
| `casesCompleted` | `COUNT(case)` con `assigned_agent_id=agent`, `status=COMPLETED`, `updated_at` en rango |
| `avgCordialityScore` | `AVG(quality_review.cordiality_score)` donde `status IN ('ready','reviewed')`, `agent_id`, `completed_at` en rango |
| `criticalReviewCount` | reviews con `cordiality_score < 40` en rango |
| `avgFirstHumanReplyMs` | promedio, por caso cerrado en rango, de `(t_first_agent_msg - t_case_human_start)` donde `t_case_human_start` = momento en que el caso pasó a `ESCALATED` o `HUMAN_ACTIVE` (usar `workflow_event` / `last_activity` documentado en implementación; si no hay evento, null para ese caso) |

Si no hay reviews ready, `avgCordialityScore` es `null` (no inventar 0).

## 6. Atribución de mensajes

Migración: `message.agent_id UUID NULL REFERENCES agent(id)`.

- `POST /api/conversations/:id/reply` (y cualquier reply humano) **debe** setear `agent_id` = agente de la sesión.
- Mensajes históricos pueden quedar `NULL`; el análisis usa `case.assigned_agent_id` como dueño de la review y los findings siguen anclados a `message_id`.

## 7. Coaching híbrido (MVP)

1. Supervisor crea `quality_coaching_note` vía `POST /api/quality/reviews/:id/notes` `{ body }`.
2. UI ofrece CTA “Abrir chat interno” → `/chat-interno?peerId={agentId}&qualityReviewId={reviewId}`.
3. El front carga la review por API y muestra un panel **Hallazgos a justificar** (severity medium/high, borde rojo/ámbar) + prefill del compositor pidiendo justificación por cada excerpt. El agente responde en el chat (canal informal; chat aún local).
4. En MVP el agente **no** lee notes por API de calidad; `ack_status` queda para etapa posterior.

## 8. Etapa futura — chat interno persistente

Fuera de Etapa 10. Cuando se construya:

- Tablas `internal_thread` / `internal_message` (staff↔staff), realtime, auditoría.
- Deep-link desde calidad abre hilo real pre-cargado con contexto del `qualityReviewId`.
- Hasta entonces el front mantiene `localStorage` y el backend **no** expone endpoints de chat staff.

Documentar en `05_BUILD_PLAN.md` como etapa posterior explícita (no implementar en Etapa 10).

## 9. Contrato IA (resumen)

Ver `03_API_CONTRACT.md` §A (`analyzeAgentConversation`) y prompt normativo en `06_AI_PROMPTS.md` §7.

```ts
type QualityAnalysis = {
  cordialityScore: number;
  summary: string;
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

## 10. REST (resumen)

Ver `03_API_CONTRACT.md` §C — endpoints `/api/quality/*`. Solo `manager`/`admin`.

## 11. Anti-casos

- No llamar a n8n para análisis de calidad.
- No meter lógica de score en controllers ni en el adapter (prompt + Zod + use case).
- No exponer `model_raw` al frontend ni al agente supervisado.
- No analizar conversaciones solo-bot.
- No bloquear `complete`/`cancel` del caso si el job de calidad falla.
- No inventar findings con `messageId` que no existan en el input (filtrar post-Zod).

## 12. Módulo y tests

Módulo hexagonal: `src/core/modules/quality/` (ver `docs/FOLDER_STRUCTURE.md`).

Tests mínimos (Etapa 10 / `05_BUILD_PLAN.md`):

- Reply humano persiste `agent_id`.
- Cierre de caso con mensajes agent crea review idempotente `…:auto`.
- Fake AI → findings persistidos; `messageId` inventado se descarta.
- Manager de depto A no lista reviews de depto B; admin sí.
- On-demand con review `pending` existente no duplica job.
- Coaching note auditable.
