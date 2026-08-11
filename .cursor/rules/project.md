---
description: Reglas del proyecto isp-platform — leer antes de generar o modificar código
alwaysApply: true
---

# Reglas del proyecto

Este repo construye una plataforma omnicanal de atención automatizada para un ISP. La especificación completa y normativa vive en `docs/spec/00_OVERVIEW.md` a `docs/spec/05_BUILD_PLAN.md`. Léelos antes de proponer cualquier cambio. `docs/spec/historical/` es contexto, no requisito.

Sigue también `AGENTS.md` en la raíz del repo — contiene los no-negociables y convenciones técnicas completas.

## Reglas de esta sesión

- Trabaja **una etapa de `05_BUILD_PLAN.md` a la vez**. No generes código de una etapa posterior sin que se te pida explícitamente.
- Antes de escribir código para una etapa, resume en pocas líneas el plan y los archivos a tocar.
- No modifiques `docs/spec/00_OVERVIEW.md` a `05_BUILD_PLAN.md` sin señalarlo explícitamente y explicar por qué el cambio es necesario.
- La IA (Ollama/Qwen vía n8n) nunca decide transiciones de negocio ni ejecuta acciones directamente — solo interpreta. Si estás a punto de escribir código donde un prompt de LLM decide un estado o dispara una integración directamente, detente: eso es responsabilidad de la API, no de n8n/la IA.
- n8n nunca escribe directamente al canal (WhatsApp) ni almacena estado de negocio. Si estás construyendo algo del lado de n8n, revisa `04_N8N_WORKFLOW_SPEC.md` §3 (lista explícita de lo que no debe existir) antes de continuar.
- Todo endpoint, evento o entidad nueva debe reflejarse en el documento de spec correspondiente antes o junto con el código (no solo en el código).