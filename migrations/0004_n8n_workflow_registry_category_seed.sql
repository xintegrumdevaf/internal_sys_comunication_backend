-- Migracion 0004 (Etapa 3, docs/spec/01_DATA_MODEL.md v3 §2 + 04_N8N_WORKFLOW_SPEC.md v3 §6-7):
--
-- n8n_workflow_registry se creo en la migracion 0003 sin la columna `category`
-- (case_action | admin_action) que introdujo la v3 del paquete de specs para
-- distinguir pasos de un WorkflowDefinition (los llama el motor de workflow
-- de un Case) de herramientas administrativas (ej. ingesta de documentos al
-- RAG) que el motor nunca invoca.
--
-- Se agrega la columna y se puebla el catalogo con el listado real de
-- 04_N8N_WORKFLOW_SPEC.md §7 (nombres de accion, URLs y descripciones
-- exactos, sacados de los workflows reales de n8n del negocio) para que la
-- Etapa 3 (N8nGatewayHttp + endpoints admin) tenga datos reales desde el
-- primer arranque, no un catalogo vacio.

ALTER TABLE n8n_workflow_registry
  ADD COLUMN category TEXT NOT NULL DEFAULT 'case_action' CHECK (category IN ('case_action', 'admin_action'));

INSERT INTO n8n_workflow_registry (action, category, url, description) VALUES
  ('VALIDATE_CLIENT',       'case_action',  'https://free-roses-enjoy.loca.lt/webhook/find-client-contract', 'Busca contrato(s) y datos tecnicos por cedula; puede devolver mas de uno'),
  ('CHECK_BALANCE',         'case_action',  'https://free-roses-enjoy.loca.lt/webhook/check-balance',         'Consulta saldo/deuda'),
  ('DIAGNOSTIC',            'case_action',  'https://free-roses-enjoy.loca.lt/webhook/do-diagnostic',         'Diagnostico tecnico inicial (proxy a microservicio propio)'),
  ('CONTINUE_DIAGNOSTIC',   'case_action',  'https://free-roses-enjoy.loca.lt/webhook/continue-diagnostic',   'Continua diagnostico con el mensaje textual del usuario'),
  ('RECORD_PAYMENT',        'case_action',  'https://free-roses-enjoy.loca.lt/webhook/record-payment',        'Registra un pago (idempotente por idempotencyKey) - pendiente de construir'),
  ('APPLY_BANK_ACCOUNT',    'case_action',  'https://free-roses-enjoy.loca.lt/webhook/apply-bank-account',    'Solicitud de cuenta bancaria asociada - pendiente de construir'),
  ('QUERY_KNOWLEDGE_BASE',  'case_action',  'https://free-roses-enjoy.loca.lt/webhook/query-knowledge-base',  'Consulta la base de conocimiento (RAG) - pendiente de construir'),
  ('UPLOAD_RAG_DOCUMENT',   'admin_action', 'https://free-roses-enjoy.loca.lt/form/cargar-documentos',        'Ingesta de documentos al RAG - herramienta administrativa, ya existe');
