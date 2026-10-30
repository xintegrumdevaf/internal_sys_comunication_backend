# Changelog

All notable changes to this project will be documented in this file.

## [0.2.2] - 2026-10-30

- **Contextual Intent-Driven Routing & Elimination of Rigid Regex Bypasses**:
  - *Damage*: A rigid keyword-based regex block (`isPaymentSubmission`) intercepted messages before AI interpretation. This created two serious failure modes:
    1. *Misrouting technical outages*: When a customer reported a service failure while mentioning a payment or attaching a voucher (e.g. *"No tengo internet, pero ya pagué en la mañana el servicio"*), the hardcoded regex hijacked the ticket and routed it to Cartera, ignoring that the user had an active internet outage needing technical support.
    2. *Brittleness to natural language*: When a customer reported a payment using terms not present in the hardcoded regex (or when OCR didn't extract fields), the regex evaluated to false and trapped the user in an automated balance inquiry asking for their cédula.
  - *Root Cause*: Rigid keyword checks attempted to replace AI natural language understanding with regular expressions, bypassing message history and full burst context.
  - *Resolution*:
    - Completely removed the pre-NLU regex bypass `isPaymentSubmission` from `ProcessBufferedMessagesUseCase`.
    - Enriched `prepareText` to always supply full media context (`[Adjunto imagen...]`, `[Adjunto documento...]`, audio transcripts, GPS coordinates) alongside message bursts and recent conversation history to `interpretMessage`.
    - Reinforced normative intent priority rules in `interpret-message.prompt.ts`:
      - Outages/technical issues take precedence (`support.internet`) even when payment proof is attached, recording payment entities in context for technicians.
      - Payment reports without technical failures (`billing.record_payment`) in any natural language phrasing escalate immediately to Cartera, acknowledge receipt, and silence the bot without asking for cédula.
    - Verified all test suites pass with 492 tests across 87 files.

- **WhatsApp Video & Media Ingestion, Classification & Multimodal Visual Analysis**:
  - *Damage*: Video messages received from WhatsApp (such as customer recordings of blinking router lights, damaged cables, or payment confirmations) were either dropped, misclassified as generic documents, or ignored by the AI reasoning engine, leaving the bot blind to the actual visual evidence provided by the customer.
  - *Root Cause*: Ingestion classification omitted video MIME types and extensions, and the reasoning pipeline (`prepareText`) lacked visual extraction for video and document media types.
  - *Resolution*:
    - Enhanced `parseZernioWebhookPayload` and `ZernioHistorySyncWorker` to accurately detect video attachments (`type === "video"` or MIME types `video/*` and extensions `.mp4`, `.mov`, `.webm`, `.3gp`, `.mkv`).
    - Integrated multimodal visual analysis in `GeminiAdapter.extractReceiptData` and `ProcessBufferedMessagesUseCase.prepareText` to process videos, images, and documents, automatically extracting visual scene descriptions (e.g. `[Adjunto video: router con luz roja LOS parpadeando]`) and receipt data.
    - Added unit test coverage in `test/cases/use-cases/process-buffered-messages.use-case.test.ts` and `test/conversations/parse-zernio-webhook.test.ts`.

- **Preservation of Line Breaks and Multiline Structure in Quick Replies**:
  - *Damage*: Quick replies containing instructions with multiple paragraphs, bullet points, and contract terms (e.g. equipment return requirements, payment instructions) had all line breaks collapsed into a continuous, illegible block of text.
  - *Root Cause*: Input and resolution use cases did not normalize Windows CRLF (`\r\n`) or literal backslash-escaped sequences (`\\n`), and AI tone refinement prompts lacked instructions to preserve paragraph and list structures.
  - *Resolution*:
    - Standardized line-break normalization (`\r\n` and `\\n` -> `\n`) in `CreateQuickReplyUseCase`, `UpdateQuickReplyUseCase`, and `ResolveQuickReplyUseCase`.
    - Added structural preservation directive to `buildRefineQuickReplyTonePrompt` ensuring AI-assisted tone improvements preserve bullet points, lists, and line breaks.
    - Added unit and router integration tests validating multiline preservation.

## [0.2.1] - 2026-10-29

### Added
- **Network Topology Bulk Import (`POST /api/admin/settings/network/import`)**: Enables bulk JSON topology ingestion for MikroTik routers and internal OLTs directly from admin settings without requiring deployment scripts or CI secrets. Supports both `host`/`ip` and `username`/`user` notations with automatic deduplication.
- **Network Topology Backup Export (`GET /api/admin/settings/network/export`)**: Full network topology export with decrypted vault credentials for authorized administrators, allowing portability and cross-environment migration between development, test, and production.
- **Sample Topology Template**: Added `docs/network-topology-sample.json` documenting the expected payload structure for bulk network provisioning.

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
