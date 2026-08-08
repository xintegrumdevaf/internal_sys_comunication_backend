# PROJECT_SETUP.md
## Cómo dejar el repo listo para que Cursor (o cualquier agente de IA) construya el sistema

## 0. Topología de red en desarrollo local (evita túneles innecesarios)

- **La API necesita un túnel público** (ngrok, cloudflared, localtunnel) — es la única pieza a la que Meta (WhatsApp) debe poder llegar desde internet.
- **n8n NO necesita túnel.** La API es la única que le llama, y si ambos corren en la misma máquina (n8n en Docker con el puerto publicado, API en el host), la comunicación es local: `http://localhost:5678/webhook/...`. Registra las URLs de `n8n_workflow_registry` así, no con una URL de túnel.
- Esto también resuelve el límite de "un solo túnel gratis" de ngrok: ese único túnel se usa para la API; n8n se queda sin exponer.
- Los workflows exportados de n8n van versionados en el repo — ver §1.5.

## 1. Estructura del repositorio

```
isp-platform/
├── .cursor/
│   └── rules/
│       └── project.mdc          ← reglas de Cursor (sección 3)
├── AGENTS.md                    ← instrucciones para cualquier agente de IA (Cursor, Claude Code, etc.)
├── docs/
│   ├── PROJECT_SETUP.md         ← este documento
│   ├── FOLDER_STRUCTURE.md      ← árbol completo de src/, por etapa
│   └── spec/
│       ├── 00_OVERVIEW.md
│       ├── 01_DATA_MODEL.md
│       ├── 02_STATE_MACHINE.md
│       ├── 03_API_CONTRACT.md
│       ├── 04_N8N_WORKFLOW_SPEC.md
│       ├── 05_BUILD_PLAN.md
│       └── historical/
│           ├── ARCHITECTURE_CURRENT.md
│           └── MIGRATION_PLAN.md
├── docker-compose.yml
├── .env.example
├── package.json                 ← lo genera Cursor en Etapa 0
├── tsconfig.json
├── src/
│   └── ...
├── migrations/
├── n8n/                          ← workflows exportados de n8n, versionados (§1.5)
│   ├── validate-client.json
│   ├── check-balance.json
│   ├── diagnostic.json
│   ├── continue-diagnostic.json
│   ├── record-payment.json
│   ├── apply-bank-account.json
│   └── query-knowledge-base.json
└── test/
```

Puntos clave:
- Los documentos `00`–`05` son **normativos**. `historical/` es solo contexto de por qué se decidió reconstruir — díselo explícitamente al agente para que no los tome como requisito.
- `AGENTS.md` en la raíz es el estándar que hoy leen la mayoría de herramientas de codificación con IA (Cursor, Claude Code, otros). Ponlo ahí aunque uses solo Cursor: si más adelante pruebas otra herramienta, ya está.
- `.cursor/rules/project.mdc` es el mecanismo específico de Cursor (reemplaza al antiguo `.cursorrules`, que sigue funcionando pero está deprecado).

## 1.5 Dónde van los JSON de workflows de n8n que ya tienes

Los 4 workflows que ya construiste (`find-client-contract`, `check-balance`, `do-diagnostic`, `continue-diagnostic`) van en `n8n/` en la raíz del repo **ahora**, con los nombres de `04_N8N_WORKFLOW_SPEC.md` §7 (`validate-client.json`, `check-balance.json`, `diagnostic.json`, `continue-diagnostic.json`) — así Cursor los tiene como punto de partida real, no tiene que adivinar la forma de tus flujos.

El repo es la fuente de verdad versionada; la instancia de n8n (vacía hoy) es donde se ejecutan. Flujo de trabajo:
1. Los JSON ya existentes van al repo ahora, tal cual los tienes (sin editar todavía).
2. Cursor los usa como referencia para importarlos/reconstruirlos en la instancia nueva, aplicando los ajustes de `04_N8N_WORKFLOW_SPEC.md` §9-10 (rutas `input.*`, envoltura de respuesta, validación de header, manejo de error).
3. Una vez migrados y probando bien en la instancia real, se re-exportan desde n8n y **reemplazan** el JSON en `n8n/` — el repo siempre refleja lo que está corriendo, no la versión vieja de otra arquitectura.
4. Los 3 workflows nuevos (`record-payment.json`, `apply-bank-account.json`, `query-knowledge-base.json`) se crean directo en n8n y se exportan al repo al terminarlos — no existen todavía en ningún lado.

No hace falta cargarlos manualmente tú en la UI de n8n si usas el MCP (§2 más abajo) — Cursor puede crearlos/importarlos directo contra la instancia vía la API de n8n.

## 2. Pasos para arrancar

1. Crea el repo (`git init`) y agrega la estructura de arriba.
2. Copia los 6 documentos `00`–`05` a `docs/spec/`.
3. Copia `ARCHITECTURE_CURRENT.md` y `MIGRATION_PLAN.md` a `docs/spec/historical/`.
4. Agrega `AGENTS.md`, `.cursor/rules/project.mdc`, `docker-compose.yml`, `.env.example` (todos abajo).
5. Levanta la infraestructura local: `docker compose up -d` (Postgres + Redis + n8n opcional).
6. Abre el repo en Cursor, y en el chat (en modo **Agent/Composer**, no "chat" simple) pega el prompt de arranque (sección 4).
7. Deja que trabaje **una etapa a la vez** según `05_BUILD_PLAN.md`. No le pidas "hazlo todo" — pídele explícitamente "Etapa 0" y revisa antes de decirle que continúe con la Etapa 1.
8. Un commit de git por etapa completada (facilita revertir si una etapa introduce algo inconsistente).

## 3. Disciplina de trabajo con el agente

- Nunca le des el brief original completo (el `.txt` largo) como instrucción de trabajo — dale `docs/spec/`. El brief ya está condensado y resuelto ahí; pasárselo de nuevo genera ambigüedad y contradicciones con lo ya decidido.
- Si el agente propone desviarse de `00`-`05` (nombres distintos, otra librería, otro flujo), pídele que **primero explique por qué y actualice el documento correspondiente**, y recién después toque código — igual que se le pidió a Claude en la fase de diseño.
- Revisa que cada etapa tenga tests que pasen antes de aprobar avanzar (criterios de aceptación ya están escritos en `05_BUILD_PLAN.md` por etapa).
