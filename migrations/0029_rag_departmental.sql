-- Migración 0029: Soporte de RAG Departamental y Documentos Globales
-- Permite que cada departamento tenga su propia base de conocimiento y comparta documentos globales

ALTER TABLE rag_documents 
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES department(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE rag_faqs 
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES department(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_rag_documents_dept_global ON rag_documents(department_id, is_global);
CREATE INDEX IF NOT EXISTS idx_rag_faqs_dept_global ON rag_faqs(department_id, is_global);

-- Los documentos o FAQs existentes sin departamento se marcan como globales por compatibilidad
UPDATE rag_documents SET is_global = true WHERE department_id IS NULL;
UPDATE rag_faqs SET is_global = true WHERE department_id IS NULL;
