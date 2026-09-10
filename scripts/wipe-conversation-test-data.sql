-- Limpieza de datos de prueba de conversación / caso (deja department, agent, n8n_workflow_registry).
BEGIN;

-- Romper FKs circulares conversation ↔ case y message ↔ case
UPDATE conversation SET active_case_id = NULL;
UPDATE message SET case_id = NULL WHERE case_id IS NOT NULL;

DELETE FROM quality_coaching_note;
DELETE FROM quality_finding;
DELETE FROM quality_review;
DELETE FROM internal_message;
DELETE FROM internal_thread_participant;
DELETE FROM internal_thread;
DELETE FROM escalation;
DELETE FROM automation_state;
DELETE FROM workflow_event;
DELETE FROM workflow_execution;
DELETE FROM workflow_instance;
DELETE FROM message;
DELETE FROM "case";
DELETE FROM conversation;

-- Efectos de prueba de n8n (pagos / cuentas) — no son catálogo
DELETE FROM n8n_recorded_payments;
DELETE FROM n8n_bank_account_requests;

-- Identidad persistida (§14) — limpia para pruebas desde cero
DELETE FROM contract;
DELETE FROM customer;

COMMIT;

SELECT 'conversation' AS tbl, count(*) FROM conversation
UNION ALL SELECT 'message', count(*) FROM message
UNION ALL SELECT 'case', count(*) FROM "case"
UNION ALL SELECT 'workflow_instance', count(*) FROM workflow_instance
UNION ALL SELECT 'workflow_execution', count(*) FROM workflow_execution
UNION ALL SELECT 'escalation', count(*) FROM escalation;
