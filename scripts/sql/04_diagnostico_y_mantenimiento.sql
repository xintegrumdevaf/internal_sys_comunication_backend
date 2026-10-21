-- ============================================================================
-- 04_DIAGNOSTICO_Y_MANTENIMIENTO.SQL
-- Métricas, salud de base de datos, migraciones y auditoría.
-- Compatible con DBeaver, pgAdmin, TablePlus, DataGrip, psql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CONTEO GENERAL DE REGISTROS POR TABLA
-- ----------------------------------------------------------------------------
SELECT 'department' AS tabla, count(*) AS registros FROM department
UNION ALL SELECT 'agent', count(*) FROM agent
UNION ALL SELECT 'agent_membership', count(*) FROM agent_membership
UNION ALL SELECT 'customer', count(*) FROM customer
UNION ALL SELECT 'contract', count(*) FROM contract
UNION ALL SELECT 'conversation', count(*) FROM conversation
UNION ALL SELECT 'message', count(*) FROM message
UNION ALL SELECT 'case', count(*) FROM "case"
UNION ALL SELECT 'workflow_instance', count(*) FROM workflow_instance
UNION ALL SELECT 'workflow_execution', count(*) FROM workflow_execution
UNION ALL SELECT 'workflow_event', count(*) FROM workflow_event
UNION ALL SELECT 'escalation', count(*) FROM escalation
UNION ALL SELECT 'automation_state', count(*) FROM automation_state
UNION ALL SELECT 'n8n_workflow_registry', count(*) FROM n8n_workflow_registry
UNION ALL SELECT 'rag_documents', count(*) FROM rag_documents
UNION ALL SELECT 'n8n_vectors', count(*) FROM n8n_vectors
UNION ALL SELECT 'audit_event', count(*) FROM audit_event
ORDER BY registros DESC;


-- ----------------------------------------------------------------------------
-- 2. HISTORIAL DE MIGRACIONES APLICADAS
-- Permite verificar qué migraciones se ejecutaron en este ambiente.
-- ----------------------------------------------------------------------------
SELECT 
    id AS nombre_archivo_migracion,
    applied_at AS fecha_aplicacion
FROM schema_migrations
ORDER BY id ASC;


-- ----------------------------------------------------------------------------
-- 3. VERIFICADOR DE SALUD: ALERTAS DE CONFIGURACIÓN
-- Detecta si en el ambiente productivo existen URLs apuntando a localhost.
-- ----------------------------------------------------------------------------
SELECT 
    action,
    url,
    '⚠️ APUNTA A LOCALHOST' AS diagnostico
FROM n8n_workflow_registry
WHERE url ILIKE '%localhost%' OR url ILIKE '%127.0.0.1%';


-- ----------------------------------------------------------------------------
-- 4. TAMAÑO DE LAS TABLAS EN DISCO (POSTGRESQL)
-- ----------------------------------------------------------------------------
SELECT 
    relname AS "Tabla",
    pg_size_pretty(pg_total_relation_size(relid)) AS "Tamaño Total",
    pg_size_pretty(pg_relation_size(relid)) AS "Datos",
    pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS "Índices"
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;


-- ----------------------------------------------------------------------------
-- 5. ÚLTIMOS EVENTOS DE AUDITORÍA DEL SISTEMA
-- ----------------------------------------------------------------------------
SELECT 
    occurred_at AS "Fecha",
    action AS "Acción",
    resource_type AS "Tipo Recurso",
    resource_id AS "ID Recurso",
    metadata AS "Metadata",
    actor_id AS "ID Actor/Agente"
FROM audit_event
ORDER BY occurred_at DESC
LIMIT 50;
