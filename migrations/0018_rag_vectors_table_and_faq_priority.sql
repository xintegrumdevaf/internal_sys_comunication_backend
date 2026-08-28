-- Migración 0017: Tabla n8n_vectors para el vector store nativo de RAG y columna priority en rag_faqs

CREATE EXTENSION IF NOT EXISTS vector;

-- Tabla de vectores compartida entre RAG nativo y n8n pgvector store
CREATE TABLE IF NOT EXISTS n8n_vectors (
  id          BIGSERIAL PRIMARY KEY,
  text        TEXT,
  metadata    JSONB DEFAULT '{}'::jsonb,
  embedding   VECTOR,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice HNSW opcional para búsquedas rápidas por similitud de coseno
CREATE INDEX IF NOT EXISTS idx_n8n_vectors_metadata_source ON n8n_vectors ((metadata->>'source'));
CREATE INDEX IF NOT EXISTS idx_n8n_vectors_metadata_filename ON n8n_vectors ((metadata->>'filename'));

-- Asegurar que rag_faqs tenga la columna priority requerida por listFaqs()
ALTER TABLE rag_faqs ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 5;
