-- Migracion 0005 (Etapa 4, docs/spec/04_N8N_WORKFLOW_SPEC.md §6.2):
--
-- QUERY_KNOWLEDGE_BASE reutiliza el vector store de n8n ("Upload files RAG.json",
-- Postgres PGVector Store en modo retrieve-as-tool) contra esta misma base de
-- datos (docker-compose.yml: postgres ahora usa la imagen pgvector/pgvector:pg16,
-- que ya trae la extension compilada). Las tablas de embeddings las crea/administra
-- el nodo de n8n directamente, no el runner de migraciones de la API — aqui solo
-- se habilita la extension, que es un requisito de la base, no del esquema de negocio.

CREATE EXTENSION IF NOT EXISTS vector;
