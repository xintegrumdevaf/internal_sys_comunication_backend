-- ============================================================================
-- 01_N8N_WORKFLOWS.SQL
-- Gestión de catálogo de Webhooks y Workflows de n8n en base de datos.
-- Compatible con DBeaver, pgAdmin, TablePlus, DataGrip, psql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CONSULTAR EL CATÁLOGO COMPLETO
-- ----------------------------------------------------------------------------
SELECT 
    action AS "Acción",
    category AS "Categoría",
    url AS "URL Webhook",
    timeout_ms AS "Timeout (ms)",
    max_retries AS "Reintentos",
    active AS "Activo",
    updated_at AS "Última Actualización"
FROM n8n_workflow_registry
ORDER BY category, action;


-- ----------------------------------------------------------------------------
-- 2. ACTUALIZACIÓN MASIVA DE LA URL BASE DE N8N
-- Cambia 'http://NUEVA-URL-N8N' por el host correspondiente a tu ambiente:
--   Producción: http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io
--   Local:       http://localhost:5678
-- ----------------------------------------------------------------------------
-- IMPORTANTE: Ejecutar en un bloque de transacción para verificar antes de confirmar.
BEGIN;

-- Opción A: Reemplazar el host dinámicamente manteniendo la ruta del webhook (/webhook/...)
UPDATE n8n_workflow_registry
SET 
    url = 'http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io' || substring(url from '(:[0-9]+)?(/.*)$'),
    updated_at = NOW();

-- Verificar cómo quedaron las URLs:
SELECT action, url, active FROM n8n_workflow_registry;

COMMIT; -- O haz ROLLBACK si algo no quedó bien.


-- ----------------------------------------------------------------------------
-- 3. ACTUALIZACIÓN INDIVIDUAL POR ACCIÓN
-- ----------------------------------------------------------------------------
UPDATE n8n_workflow_registry
SET url = 'http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io/webhook/find-client-contract', updated_at = NOW()
WHERE action = 'VALIDATE_CLIENT';

UPDATE n8n_workflow_registry
SET url = 'http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io/webhook/check-balance', updated_at = NOW()
WHERE action = 'CHECK_BALANCE';

UPDATE n8n_workflow_registry
SET url = 'http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io/webhook/do-diagnostic', updated_at = NOW()
WHERE action = 'DIAGNOSTIC';

UPDATE n8n_workflow_registry
SET url = 'http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io/webhook/continue-diagnostic', updated_at = NOW()
WHERE action = 'CONTINUE_DIAGNOSTIC';

UPDATE n8n_workflow_registry
SET url = 'http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io/webhook/record-payment', updated_at = NOW()
WHERE action = 'RECORD_PAYMENT';

UPDATE n8n_workflow_registry
SET url = 'http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io/webhook/apply-bank-account', updated_at = NOW()
WHERE action = 'APPLY_BANK_ACCOUNT';

UPDATE n8n_workflow_registry
SET url = 'http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io/webhook/query-knowledge-base', updated_at = NOW()
WHERE action = 'QUERY_KNOWLEDGE_BASE';

UPDATE n8n_workflow_registry
SET url = 'http://n8n-hf0cquxxn2xkitg4aiyb8zyh.187.77.20.87.sslip.io/form/cargar-documentos', updated_at = NOW()
WHERE action = 'UPLOAD_RAG_DOCUMENT';


-- ----------------------------------------------------------------------------
-- 4. ACTIVAR / DESACTIVAR ACCIONES (KILL-SWITCH)
-- Si n8n está en mantenimiento para una acción, se puede pausar aquí.
-- ----------------------------------------------------------------------------
-- Desactivar una acción:
-- UPDATE n8n_workflow_registry SET active = false, updated_at = NOW() WHERE action = 'DIAGNOSTIC';

-- Reactivar:
-- UPDATE n8n_workflow_registry SET active = true, updated_at = NOW() WHERE action = 'DIAGNOSTIC';


-- ----------------------------------------------------------------------------
-- 5. MONITOREO DE LLAMADAS A N8N (ÚLTIMAS EJECUCIONES Y ERRORES)
-- ----------------------------------------------------------------------------
SELECT 
    we.started_at AS "Fecha",
    we.action AS "Acción",
    we.status AS "Resultado",
    ROUND(EXTRACT(EPOCH FROM (we.completed_at - we.started_at)) * 1000) AS "Duración (ms)",
    we.idempotency_key AS "Idempotency Key",
    we.input AS "Input Enviado",
    we.output AS "Respuesta n8n",
    we.error AS "Error si Hubo"
FROM workflow_execution we
ORDER BY we.started_at DESC
LIMIT 50;
