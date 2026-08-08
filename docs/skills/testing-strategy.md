# docs/skills/testing-strategy.md
## Estrategia de tests para este proyecto

## Pirámide
- **Unitarios (mayoría)**: `application/use-cases/*` y `application/engine/*` contra implementaciones **en memoria** de los `ports` (nunca Postgres/Redis real). Rápidos, corren en cada guardado.
- **Integración**: `infrastructure/postgres/*` contra la Postgres real de `docker-compose.yml` — verifica que el SQL y los constraints (unicidad, optimistic concurrency) funcionan de verdad.
- **End-to-end (pocos, los importantes)**: `test/e2e/support-internet-flow.e2e.test.ts` simulando el caso A completo del negocio (no tengo internet → validar → deuda → diagnóstico → esperar → continuar → resolver), con un `N8nGatewayFake` que responde como respondería n8n real.

## Qué test es obligatorio por etapa
Ya están enumerados en `docs/spec/05_BUILD_PLAN.md`, criterio de aceptación de cada etapa — no inventar una suite paralela, esos son el mínimo exigido antes de dar la etapa por terminada.

## Nombrado y estructura
`test/<module>/<use-case-or-service>.test.ts`, un `describe` por caso de uso, un `it` por escenario del criterio de aceptación (ej. `it("continúa desde DIAGNOSTIC, no reinicia en VALIDATE_CLIENT")`).

## Fakes, no mocks frágiles
Preferir una implementación en memoria completa de un puerto (`CaseRepositoryFake`) sobre mockear método por método con una librería de mocking — un fake se comporta como el repositorio real (respeta unicidad, optimistic concurrency), un mock solo responde lo que se le programó y puede ocultar bugs de interacción.

## Qué NO testear
No testear el SDK de WhatsApp ni el motor interno de n8n — se asume correcto; se testea el contrato en el borde (que la API construye bien el payload y que sabe interpretar la respuesta), no la integración externa en sí.
