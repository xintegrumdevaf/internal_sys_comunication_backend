# Changelog

All notable changes to this project will be documented in this file.

## [0.1.2] - 2026-10-16

### Added
- **AI Settings**: Endpoint `POST /api/admin/settings/ai/models` to discover and list compatible AI models live from Google Gemini and Ollama APIs.
- **Cost & Capability Tiers**: Classification of inference models into economy, balanced, and performance tiers with recommended indicators.
- **Embedding Models Discovery**: Automated retrieval and dimension alignment for embedding models (e.g. `text-embedding-004` at 768 dims).
- **Security & Secret Protection**: Strict payload-only credential transmission with masking and merging (`mergeSecret`), avoiding sensitive URL query parameters or credential leaks in logs/responses.
