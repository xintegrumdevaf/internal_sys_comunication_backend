# 00_OVERVIEW.md
## Plataforma omnicanal de atención automatizada — Especificación de construcción (desde cero)

> Este documento y los que lo acompañan (`01` a `05`) son la **fuente única de verdad** para construir el sistema. No dependen de leer el código legacy. `ARCHITECTURE_CURRENT.md` y `MIGRATION_PLAN.md` quedan como contexto histórico de por qué se decidió reconstruir; no son requisitos de diseño.

## 1. Principio rector (no negociable)

```
API   → "¿Qué está pasando y qué debe ocurrir?"   → fuente de verdad, decide, persiste
IA    → "¿Qué quiso decir el usuario?"             → interpreta, nunca gobierna el estado
n8n   → "¿Cómo ejecuto esta integración?"          → ejecuta, nunca decide
UI    → "¿Qué está pasando y quién lo atiende?"    → supervisa, interviene, reactiva
```

Toda decisión de diseño posterior se resuelve contra este principio. Si algo hace que la IA decida negocio, o que n8n almacene estado de negocio, o que la API dependa de memoria implícita: está mal, sin importar qué tan conveniente parezca.

## 2. Stack

- **API**: TypeScript, Express, arquitectura hexagonal (`domain / application / infrastructure / presentation` por módulo — un único composition root).
- **Base de datos de negocio**: PostgreSQL. Es la fuente de verdad de conversaciones, mensajes, casos, workflows, ejecuciones, eventos, escalaciones, automatización, y del catálogo de acciones de n8n. **Debe aprovisionarse** (no existe hoy en la API).
- **Redis**: colas (serialización por conversación), buffer/debounce de mensajes, locks. **Nunca** almacenamiento de negocio.
- **IA (Ollama/Qwen u otro proveedor)**: se invoca directamente desde la API vía `AIProviderPort` (interpretación, composición de respuesta, OCR, transcripción) — no a través de n8n.
- **n8n**: exclusivamente motor de integración con sistemas externos reales (Excel, MikroTik, APIs de contrato/cartera/pagos). No hace IA, no decide transiciones ni persiste estado de negocio.
- **WhatsApp Business Cloud**: único canal por ahora, diseñado para admitir más canales luego (el modelo de `Conversation` no debe acoplarse a WhatsApp).
- **Frontend**: tipo Whaticket, consume el contrato de `03_API_CONTRACT.md` §C (no se construye en esta entrega, pero cada endpoint se diseña para él).

## 3. Componentes y flujo

```mermaid
flowchart TB
    WA[WhatsApp Cloud] -->|"único webhook de entrada"| API

    subgraph API["API — fuente de verdad"]
        ING[Ingestion: persist RAW + 200 OK]
        BUF[(Redis: buffer/debounce por conversationId)]
        WORKER[Worker interno]
        AI["AIProviderPort\n(interpretar, componer respuesta, OCR, audio)"]
        ARB[Case Arbitration]
        ENGINE[Workflow Engine]
        ESC[Escalation Service]
        AUTOM[Automation Gate]
        DB[(PostgreSQL:\nnegocio + n8n_workflow_registry)]
        ING --> BUF --> WORKER --> AI --> ARB --> ENGINE --> DB
        ENGINE --> ESC --> DB
        ENGINE --> AUTOM --> DB
    end

    AI -->|"llamada directa"| OLLAMA["Ollama / Qwen\n(u otro provider)"]
    API -->|"POST síncrono, URL resuelta de n8n_workflow_registry (03 §B)"| TOOLS

    subgraph N8N["n8n — solo integraciones externas (cada caja = workflow independiente, Webhook → Respond to Webhook)"]
        TOOLS["Workflows de acción:\nVALIDATE_CLIENT, CHECK_BALANCE,\nDIAGNOSTIC, RECORD_PAYMENT, ..."]
    end

    API -->|"envío WhatsApp"| WA
    API <-->|"REST + WebSocket/SSE (03 §C)"| FE[Frontend tipo Whaticket]
```

Reglas duras de este flujo:
1. **Solo la API recibe el webhook de WhatsApp.** n8n no tiene trigger de WhatsApp propio; todo mensaje entra por la API.
2. **Solo la API envía mensajes a WhatsApp.** n8n nunca llama directamente al canal — ya ni siquiera participa en componer el texto (eso lo hace `AIProviderPort`, §3 arriba); la API decide si, cuándo y qué enviar.
3. El webhook de WhatsApp responde `200 OK` inmediatamente tras persistir el mensaje crudo. El mensaje entra a un **buffer con debounce** por conversación (Redis) antes de procesarse — agrupa ráfagas de mensajes seguidos del mismo cliente (`02_STATE_MACHINE.md` §12). Cada llamada individual desde ahí (interpretar vía IA, ejecutar una acción en n8n) es **síncrona**: se recibe el resultado en el mismo ciclo, sin callbacks separados.
4. La IA se invoca **directamente desde la API** (`AIProviderPort`, adapter intercambiable — Ollama por defecto) para interpretar, componer respuestas, transcribir audio y leer comprobantes — n8n no participa en nada de esto.
5. Cada acción de negocio (`VALIDATE_CLIENT`, `CHECK_BALANCE`, `DIAGNOSTIC`, ...) es su propio workflow de n8n con su propia URL, resuelta desde `n8n_workflow_registry` (tabla en Postgres, editable sin redeploy) — no existe un workflow "dispatcher" central ni variables de entorno por acción.
6. Ninguna URL/secreto se hardcodea en nodos ni en código. URL de n8n siempre de **producción**, nunca `/webhook-test/…`.

## 4. Documentos de este paquete

| Doc | Contenido |
|---|---|
| `00_OVERVIEW.md` | Este documento |
| `01_DATA_MODEL.md` | Entidades, relaciones, DDL de PostgreSQL, índices, constraints, roles/visibilidad |
| `02_STATE_MACHINE.md` | Estados de `Case`, transiciones, políticas de error/expiración/confianza, buffer y composición de respuesta, triage |
| `03_API_CONTRACT.md` | Contrato interno `AIProviderPort`, contrato síncrono API→n8n (solo acciones), REST/tiempo real para frontend |
| `04_N8N_WORKFLOW_SPEC.md` | Especificación de los workflows de acción de n8n (solo integraciones externas) |
| `05_BUILD_PLAN.md` | Orden de construcción para un agente de IA, con criterios de aceptación por etapa |

## 5. No-negociables de todo el sistema

- Sin `Record<string, unknown>` para contexto donde el dato es estructurado: cada `workflow_type` tiene un tipo de contexto propio (ver `01_DATA_MODEL.md` §4).
- Sin lógica de negocio en controllers ni en prompts de IA.
- Sin decisiones de negocio tomadas por el LLM: la IA entrega `intent/entities/confidence` o texto de respuesta sobre una plantilla ya decidida — la API decide qué ocurre y qué se dice.
- n8n nunca ejecuta IA ni decide transiciones; solo integraciones externas síncronas.
- El departamento nunca determina qué acción se ejecuta — solo enruta humanos (`02_STATE_MACHINE.md` §9).
- Idempotencia obligatoria en ingesta de mensajes y en todo intercambio API↔n8n.
- Un único caso automatizado activo por conversación.
- Retomar un proceso pausado nunca reinicia el workflow desde el principio.
- El cliente final nunca ve detalles internos (nombres de workflow, tools, nodos, stack traces).
- Todo error no recuperable tiene una ruta definida (nunca un caso "colgado" sin salida).
- Visibilidad de casos por defecto: compartida entre agentes (lectura), edición restringida a quien lo tiene asignado (`01_DATA_MODEL.md` §7).
