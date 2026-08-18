---
name: n8n-mcp
description: >-
  Build, import, and update n8n workflows for this project's action catalog
  (n8n_workflow_registry) using the n8n-mcp MCP server tools instead of the
  n8n UI. Use when creating/editing workflows in n8n, searching n8n nodes,
  validating workflow JSON, or connecting to the local n8n instance at
  http://localhost:5678 to migrate/build the action workflows from
  docs/spec/04_N8N_WORKFLOW_SPEC.md.
---

# n8n-mcp (este proyecto)

MCP server: `n8n-mcp` (czlonkowski), configurado en `.cursor/mcp.json` (gitignored,
tiene `N8N_API_KEY`). Apunta a `N8N_API_URL=http://localhost:5678` — el n8n de
`docker-compose.yml` de este repo, corriendo local sin túnel.

## Contrato de este proyecto (no genérico de n8n)

Todo workflow de acción (`docs/spec/04_N8N_WORKFLOW_SPEC.md`) es
`Webhook → ... → Respond to Webhook`, y debe cumplir:

1. **Body de entrada** (ya no plano): `{{ $json.body.input.<campo> }}`, nunca
   `{{ $json.body.<campo> }}` — los datos de negocio viven anidados bajo `input`.
   Campos en **camelCase** (`oltName`, no `olt_name`) del lado del contrato de
   la API; si el sistema externo (microservicio de diagnóstico) espera
   snake_case, el propio nodo que arma esa llamada hace la traducción — no se
   cambia el contrato de entrada por eso.
2. **Validar `X-Internal-Api-Key` primero**, antes de tocar cualquier sistema
   externo. Si no coincide: responder `401` con
   `{ success: false, result: null, error: { type: "VALIDATION_ERROR", message: "Unauthorized", retryable: false } }`
   sin ejecutar el resto del flujo.
3. **Respuesta siempre envuelta**: `{ success, result, error }` — nunca el
   dato plano. Éxito: `{ success: true, result: {...}, error: null }`. Error:
   `{ success: false, result: null, error: { type, message, retryable } }`
   (`type` es uno de `DomainErrorType`: `BUSINESS_ERROR | VALIDATION_ERROR |
   TIMEOUT | EXTERNAL_SERVICE_ERROR | AI_ERROR | UNSUPPORTED | NOT_FOUND`).
4. **Rama de error explícita** por acción — ver tabla de mapeo en
   `docs/spec/04_N8N_WORKFLOW_SPEC.md` §10 (qué condición de error mapea a
   qué `DomainErrorType`/`retryable`).
5. **URL de producción siempre** — nunca `/webhook-test/...`. Publicar y
   registrar la URL real (`http://localhost:5678/webhook/<path>` en local).
6. Nunca: WhatsApp Trigger/envío directo, agente de IA/memoria conversacional,
   buffer/debounce, ni datos técnicos del contrato pedidos "a ciegas" al LLM
   (esos ya vienen resueltos en `input`). Ver `04_N8N_WORKFLOW_SPEC.md` §5.

Fixtures de prueba (éxito y error) por accion: `docs/spec/04_N8N_WORKFLOW_SPEC.md` §11 — úsalos tal cual contra el webhook real antes de dar una migración/build por terminada.

## Flujo de trabajo con las tools de n8n-mcp

1. `tools_documentation()` una vez al empezar la sesión si no la has llamado antes.
2. Antes de crear un nodo nuevo: `search_nodes({query})` → `get_node({nodeType, detail:'standard', includeExamples:true})`.
3. Configura el nodo con **todos** los parámetros explícitos — nunca confíes en defaults (causa #1 de fallos en runtime).
4. Valida antes de escribir: `validate_node({nodeType, config, mode:'minimal'})` → `validate_node({..., mode:'full', profile:'runtime'})`.
5. Al terminar el workflow: `validate_workflow(workflow)` (conexiones + expresiones) antes de `n8n_create_workflow`/`n8n_update_full_workflow`.
6. Tras desplegar: `n8n_validate_workflow({id})`, y si aplica `n8n_autofix_workflow({id})`.
7. Para overrides parciales usa `n8n_update_partial_workflow({id, operations:[...]})` en un solo batch (varias operaciones), no llamadas separadas.

## Gotchas críticos

- **Webhook data vive bajo `$json.body`** dentro de n8n (y en este proyecto, además, bajo `.input` — ver contrato arriba).
- **IF node tiene 2 salidas** — al conectar, especifica `branch: "true"` / `branch: "false"` en `addConnection`, si no ambas conexiones pueden caer en la misma salida.
- **`addConnection`/`removeConnection`** requieren 4 parámetros string separados: `source`, `target`, `sourcePort`, `targetPort` (+ `branch` si aplica).
- **Code node**: usar solo como último recurso; preferir nodos estándar (`Set`, `IF`, `HTTP Request`). Retorno siempre `[{ json: {...} }]`.
- **Credenciales no viajan en el JSON exportado** — al importar/crear un workflow en la instancia nueva, las credenciales (Google Sheets OAuth, Postgres/RAG) hay que recrearlas y reconectar los nodos; el ID de credencial del export original no existe aquí.

## Instancia local

- `docker compose up -d` levanta el n8n de este proyecto en `localhost:5678` (ver `docker-compose.yml`).
- `n8n_health_check` / `n8n_list_workflows` para confirmar conectividad antes de crear nada.
- Los 7 workflows de acción + el de `admin_action` (`UPLOAD_RAG_DOCUMENT`) se registran en `n8n_workflow_registry` (`PUT /api/admin/n8n-workflows/:action`, requiere `role=admin` — header `x-agent-id`) con la URL real `http://localhost:5678/webhook/<path>`, nunca una URL de ejemplo ni de túnel.
- Al terminar un workflow, exportarlo de vuelta a `n8n/<nombre>.json` en el repo (`n8n_get_workflow({id, mode:'full'})` → guardar el JSON) para que quede versionado.
