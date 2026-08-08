-- Migracion 0006 (Etapa 4): URLs reales de n8n local (docker-compose :5678).
-- Reemplaza las URLs de ejemplo/tunnel del seed 0004. n8n no necesita tunel;
-- solo la API publica (WhatsApp) lo requiere.

UPDATE n8n_workflow_registry SET url = 'http://localhost:5678/webhook/find-client-contract', updated_at = NOW()
  WHERE action = 'VALIDATE_CLIENT';
UPDATE n8n_workflow_registry SET url = 'http://localhost:5678/webhook/check-balance', updated_at = NOW()
  WHERE action = 'CHECK_BALANCE';
UPDATE n8n_workflow_registry SET url = 'http://localhost:5678/webhook/do-diagnostic', updated_at = NOW()
  WHERE action = 'DIAGNOSTIC';
UPDATE n8n_workflow_registry SET url = 'http://localhost:5678/webhook/continue-diagnostic', updated_at = NOW()
  WHERE action = 'CONTINUE_DIAGNOSTIC';
UPDATE n8n_workflow_registry SET url = 'http://localhost:5678/webhook/record-payment', updated_at = NOW()
  WHERE action = 'RECORD_PAYMENT';
UPDATE n8n_workflow_registry SET url = 'http://localhost:5678/webhook/apply-bank-account', updated_at = NOW()
  WHERE action = 'APPLY_BANK_ACCOUNT';
UPDATE n8n_workflow_registry SET url = 'http://localhost:5678/webhook/query-knowledge-base', updated_at = NOW()
  WHERE action = 'QUERY_KNOWLEDGE_BASE';
UPDATE n8n_workflow_registry SET url = 'http://localhost:5678/form/cargar-documentos', updated_at = NOW()
  WHERE action = 'UPLOAD_RAG_DOCUMENT';
