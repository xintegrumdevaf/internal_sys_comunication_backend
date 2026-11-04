# Changelog

All notable changes to this project will be documented in this file.

## [0.2.5] - 2026-11-04

- **Quality Supervision Refinement: Burst Utterances, SLA Latency vs Politeness & Proactive Follow-ups (`analyze-agent-conversation.prompt.ts`)**:
  - *Context*: Supervisors identified critical false positives in quality assessments:
    1. Agents sending a question followed immediately by `?` or a typographical fix (e.g. `Buenas tardes, cómo continua con su servicio` + `?` seconds later) were severely penalized with `[Falta de respeto] «?»` for isolated punctuation.
    2. Response latency (e.g. agent replying 2–3 hours later) was penalizing polite, helpful messages (e.g. `Por favor me comenta cómo continua con su servicio`) as aggressive disrespect or abandonment, dropping the cordiality score to critical (<40).
    3. Proactive follow-ups by agents after customers went silent were falsely classified as "abandono/descuido".
  - *Changes*:
    - Enforced burst message cohesion: instructions mandate that consecutive messages sent in close succession (1–2 minutes) must be evaluated as a single cohesive utterance; isolated punctuation (`?`, `!`) or typo corrections are never treated as disrespect or impatience.
    - Strict separation between SLA latency and conversational politeness: response delays must only be reported under `efficiencyNotes` or as low/medium severity `inefficiency`, preserving cordiality scores for polite and professional phrasing.
    - Clarified customer silence vs agent abandonment: agent follow-ups when a client goes silent are recognized as proactive customer care, whereas neglect is reserved exclusively for unaddressed open inquiries left by customers.
    - Added unit test suite in `test/quality/analyze-agent-conversation-prompt.test.ts`.

## [0.2.4] - 2026-11-04

- **Multimodal Quality Analysis & Voice Note Transcription (`run-quality-analysis.use-case.ts`, `analyze-agent-conversation.prompt.ts`)**:
  - *Context*: Quality analysis previously evaluated only raw message bodies. When customers sent WhatsApp audio notes or receipts, the AI received empty or placeholder text (e.g. `[audio]`), falsely penalizing agents for abandonment or lack of responsiveness when responding to customer voice notes.
  - *Changes*:
    - Implemented `resolveMessageContent` in `RunQualityAnalysisUseCase` to dynamically execute `transcribeAudio` for audio voice notes, and `extractReceiptData` for images and PDF documents.
    - Updated `ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT` with explicit rules to evaluate agent replies within the full context of transcribed voice notes, documents, and vouchers.
    - Instructed the model to directly highlight infractions at the beginning of the summary before providing constructive pedagogical recommendations.
    - Sanitized chunk summaries in `buildFinalQualityReview` to eliminate duplicate "Eficiencia:" sections.

- **ESLint 10 & Clean Code Governance Implementation (`eslint.config.js`, `package.json`)**:
  - *Context*: The backend was missing automated static analysis enforcement for Clean Code practices, resulting in oversized modules, untyped `any` leaks, and dead code accumulation.
  - *Changes*:
    - Installed modern ESLint 10 with `@typescript-eslint` flat configuration.
    - Aligned TypeScript dependency to stable `^5.9.3` (`^5.8.3` semver) to resolve AST parser incompatibilities with `typescript-eslint`.
    - Added automated npm scripts: `pnpm run lint` and `pnpm run lint:fix`.
    - Configured rules:
      - `max-lines`: Warns on files exceeding 400 lines (ignoring comments/whitespace), establishing a target standard for ongoing modular refactoring.
      - `@typescript-eslint/no-explicit-any`: Enforces type safety by warning on explicit `any` usage.
      - `@typescript-eslint/consistent-type-imports`: Enforces explicit `type` imports for cleaner architecture and bundling.
      - `no-console`, `no-debugger`, `no-duplicate-imports`: Prohibits stray debugger statements, duplicate imports, and raw console logging in favor of structured Pino logging.
    - Fixed empty catch blocks in `meta-templates-gateway.http.ts` and `message-templates.router.ts` with explicit explanatory comments.
    - Cleaned up duplicate and unused type imports across case and escalation use cases.

## [0.2.3] - 2026-11-04

- **AI Automation Deactivation Upon Agent Assignment & Case Claim**:
  - *Damage*: When an AI assistant escalated a conversation to a human department or an agent took control, subsequent customer incoming messages could still trigger the AI bot to reply automatically, talking over the human agent or giving contradictory advice.
  - *Root Cause*: Arbitration (`CaseArbitrationService`) did not treat active cases with an assigned agent as strictly human-owned if status was not yet `HUMAN_ACTIVE`, and assignment / claim / transfer use cases did not automatically persist `automation_enabled = false` on the case or publish realtime deactivation events.
  - *Resolution*:
    - Reinforced `CaseArbitrationService` and `ProcessBufferedMessagesUseCase` to strictly return `REQUEST_HUMAN` for any non-terminal case with `assignedAgentId` set or with status `HUMAN_ACTIVE`/`ESCALATED`, preventing any automated bot messages while human staff are assigned.
    - Updated `AssignCaseUseCase`, `ClaimCaseUseCase`, and `TransferCaseUseCase` to automatically disable case automation (`setAutomationEnabled(false)`), append `AUTOMATION_DISABLED` audit events, sync `conversation.active_case_id`, and broadcast `AUTOMATION_DISABLED` and `HUMAN_ASSIGNED` realtime events.
    - Added unit test coverage in `test/cases/use-cases/process-buffered-messages.use-case.test.ts`.

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

- **Persistent Local Media Storage & Streaming (LocalMediaStorageAdapter)**:
  - *Damage*: WhatsApp and Zernio temporary media URLs expire after hours or days, causing broken image/video links in past conversation histories and failing downstream vision/OCR processing.
  - *Root Cause*: Lack of local persistence for ingested media files; media endpoints acted only as a passthrough proxy.
  - *Resolution*:
    - Implemented LocalMediaStorageAdapter satisfying MediaStoragePort to persist media locally under MEDIA_STORAGE_PATH (storage/media) with Docker volume support.
    - Added dual-layer caching (in-memory LRU + disk persistence) in conversations.router.ts.
    - Implemented HTTP Range Requests (Accept-Ranges: bytes) enabling seeking and smooth streaming for WhatsApp audio and video in frontend clients.
    - Added automatic retry with zernioAccountId parameter when external Zernio requests return 400/404.

- **Direct Case Transfer to Agents & In-Chat Traceability**:
  - *Damage*: Case transfers were restricted to department IDs only without direct agent assignment, and agents could not see transfer or assignment history inside the conversation timeline.
  - *Root Cause*: TransferCaseUseCase did not accept "toAgentId", lacked auto-assignment dispatch, and did not emit system messages into the message repository.
  - *Resolution*:
    - Enhanced TransferCaseUseCase to accept "toAgentId" or "toDepartmentId" with auto-assignment fallback to eligible agents.
    - Registered visible system audit messages (author: "system") in the conversation history upon case transfers, manual assignments, and take-control actions for human agent visibility.
    - Broadcasted real-time WebSocket events (MESSAGE_SENT, HUMAN_ASSIGNED, HUMAN_UNASSIGNED).

- **Network Connection Testing & OLT Subnet Traversal**:
  - *Damage*: Testing connections to OLTs located behind MikroTik routers in private subnets failed when the MikroTik microservice was offline or when credentials were omitted.
  - *Root Cause*: Lack of parent router credential hydration and TCP socket fallback probing.
  - *Resolution*:
    - POST /api/admin/settings/network/test-connection now hydrates host, port, and credentials from local database topology.
    - Direct TCP socket fallback probe with latency measurement and parent router reachability checks for OLTs on private subnets.

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
