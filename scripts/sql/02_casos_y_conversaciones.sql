-- ============================================================================
-- 02_CASOS_Y_CONVERSACIONES.SQL
-- Consultas operativas de negocio: casos, conversaciones, mensajes y escalaciones.
-- Compatible con DBeaver, pgAdmin, TablePlus, DataGrip, psql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CASOS ACTIVOS CON CLIENTE Y DEPARTAMENTO (PANEL DE CONTROL)
-- Cruce relacional: "case" -> conversation -> customer -> department -> agent
-- ----------------------------------------------------------------------------
SELECT 
    c.id AS case_id,
    c.workflow_type,
    c.status AS case_status,
    conv.wa_phone AS telefono_cliente,
    cust.full_name AS nombre_cliente,
    cust.national_id AS cedula,
    d.name AS departamento,
    ag.name AS agente_asignado,
    wi.current_state AS paso_actual_workflow,
    c.last_activity_at AS ultima_actividad
FROM "case" c
INNER JOIN conversation conv ON conv.id = c.conversation_id
LEFT JOIN customer cust ON cust.id = conv.customer_id
LEFT JOIN department d ON d.id = c.department_id
LEFT JOIN agent ag ON ag.id = c.assigned_agent_id
LEFT JOIN workflow_instance wi ON wi.case_id = c.id
WHERE c.status IN ('NEW', 'ACTIVE', 'WAITING_USER', 'PAUSED', 'ESCALATED', 'HUMAN_ACTIVE')
ORDER BY c.last_activity_at DESC;


-- ----------------------------------------------------------------------------
-- 2. RESUMEN ESTADÍSTICO DE CASOS POR ESTADO Y TIPO DE TRÁMITE
-- ----------------------------------------------------------------------------
SELECT 
    c.workflow_type AS "Tipo de Trámite",
    c.status AS "Estado",
    COUNT(*) AS "Total Casos"
FROM "case" c
GROUP BY c.workflow_type, c.status
ORDER BY c.workflow_type, "Total Casos" DESC;


-- ----------------------------------------------------------------------------
-- 3. COLA DE ESCALACIONES PENDIENTES (BANDEJA DE HUMANOS)
-- Casos que la IA o el workflow derivaron para atención por operador.
-- ----------------------------------------------------------------------------
SELECT 
    e.id AS escalation_id,
    e.priority AS prioridad,
    e.status AS estado_escalacion,
    e.reason AS motivo,
    d.name AS departamento,
    ag.name AS operador_asignado,
    conv.wa_phone AS telefono,
    e.summary AS resumen_contexto_ia,
    e.created_at AS fecha_escalacion
FROM escalation e
INNER JOIN "case" c ON c.id = e.case_id
INNER JOIN conversation conv ON conv.id = c.conversation_id
LEFT JOIN department d ON d.id = e.department_id
LEFT JOIN agent ag ON ag.id = e.assigned_agent_id
WHERE e.status = 'PENDING'
ORDER BY 
    CASE e.priority 
        WHEN 'urgent' THEN 1 
        WHEN 'high' THEN 2 
        WHEN 'normal' THEN 3 
        WHEN 'low' THEN 4 
    END,
    e.created_at ASC;


-- ----------------------------------------------------------------------------
-- 4. HISTORIAL COMPLETO DE MENSAJES DE UNA CONVERSACIÓN (CHAT TIMELINE)
-- Reemplaza '593999999999' por el número de WhatsApp a auditar.
-- ----------------------------------------------------------------------------
SELECT 
    m.created_at AS "Fecha/Hora",
    m.direction AS "Dirección",
    m.author AS "Autor",
    m.type AS "Tipo",
    m.body AS "Mensaje",
    m.external_id AS "ID WhatsApp"
FROM message m
INNER JOIN conversation conv ON conv.id = m.conversation_id
WHERE conv.wa_phone = '593999999999' -- <--- MODIFICAR AQUÍ
ORDER BY m.created_at ASC;


-- ----------------------------------------------------------------------------
-- 5. ESTADO DE AUTOMATIZACIÓN (VER CONVERSACIONES PAUSADAS POR HUMANOS)
-- ----------------------------------------------------------------------------
SELECT 
    c.id AS case_id,
    conv.wa_phone AS telefono,
    aut.enabled AS automatizacion_activa,
    aut.disabled_reason AS motivo_pausa,
    ag.name AS pausado_por_agente,
    aut.changed_at AS fecha_pausa
FROM automation_state aut
INNER JOIN "case" c ON c.id = aut.case_id
INNER JOIN conversation conv ON conv.id = c.conversation_id
LEFT JOIN agent ag ON ag.id = aut.changed_by
WHERE aut.enabled = false
ORDER BY aut.changed_at DESC;
