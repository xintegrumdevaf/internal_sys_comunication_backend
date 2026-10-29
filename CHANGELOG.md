# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-10-28

### Added
- **Multi-Queue Availability for Agents (`activeDepartmentIds`)**: Added migration `0042_agent_active_department_ids.sql` providing `active_department_ids TEXT[]` column. Agents can now independently toggle availability per department (e.g. active in primary department, paused in substitute department).
- **Availability Management Endpoint**: `PUT /api/auth/me/availability` supporting `{ autoAssignEnabled: boolean, activeDepartmentIds: string[] }`.
- **Live Balance Synchronization**: Added `SyncCaseBalanceUseCase` and `POST /api/cases/:id/sync-balance` to trigger real-time balance queries via n8n (`CHECK_BALANCE`) without reopening or restarting cases.
- **Contract & Network Data Enrichment**: Enhanced `SyncCaseDataUseCase` to extract and persist `sectorNom`, `barrioNom`, and contract arrays from ERP/Excel data feeds.
- **Enriched OLT Diagnostic Telemetry**: Preserved `_history`, `failedStep`, and CLI execution traces in `TriggerCaseDiagnosticUseCase`, dispatching full diagnostic context to operational audit logs and WebSockets.

### Fixed
- **Image False Positives as Payment Vouchers**:
  - *Damage*: Non-receipt images (e.g. photos of broken routers, red ONT lights, offline TV screens) were falsely classified as payment vouchers, trapping customers in `BILLING_BALANCE` with an automated message *"Estamos verificando tu comprobante de pago..."* and halting technical support.
  - *Root Cause*: In `GeminiVisionAdapter` and `process-buffered-messages.use-case.ts`, an empty receipt entity extraction object defaulted to affirmative receipt handling instead of routing to standard NLU.
  - *Resolution*: Introduced explicit `isReceipt: boolean` flag in vision analysis. Non-receipt images are routed through standard NLU with image captions/context into their appropriate queues (e.g. `SUPPORT_INTERNET`).
- **Frozen Case Balance Snapshot**:
  - *Damage*: Case balance remained permanently frozen at intake value ($22.58 snapshot), preventing agents from observing on-demand accounting updates or client bank transfers.
  - *Root Cause*: Missing balance re-query use case and communication pipeline with accounting workflows.
  - *Resolution*: Implemented `SyncCaseBalanceUseCase` calling n8n `CHECK_BALANCE` and notifying frontend via `case:updated` WebSocket event.
- **Missing Sector & Neighborhood in Internet Support**:
  - *Damage*: Technicians only saw raw MikroTik router slugs rather than human-readable sector and neighborhood names.
  - *Root Cause*: n8n `find-cliend-contract.json` omitted `sector_nom` and `barrio_nom` mapping.
  - *Resolution*: Mapped `sectorNom` and `barrioNom` across n8n, domain entities, and database context.
- **Database Migration Collision**:
  - *Damage*: Concurrent migration file collisions on sequence `0041` during branch merges with `develop`.
  - *Resolution*: Renumbered agent department availability migration to `0042_agent_active_department_ids.sql`.

## [0.1.2] - 2026-10-16

### Added
- **AI Settings**: Endpoint `POST /api/admin/settings/ai/models` to discover and list compatible AI models live from Google Gemini and Ollama APIs.
- **Cost & Capability Tiers**: Classification of inference models into economy, balanced, and performance tiers with recommended indicators.
- **Embedding Models Discovery**: Automated retrieval and dimension alignment for embedding models (e.g. `text-embedding-004` at 768 dims).
- **Security & Secret Protection**: Strict payload-only credential transmission with masking and merging (`mergeSecret`), avoiding sensitive URL query parameters or credential leaks in logs/responses.
