-- ============================================================================
-- 03_AGENTES_Y_DEPARTAMENTOS.SQL
-- Gestión y consulta de agentes, membresías de departamentos y clientes/contratos.
-- Compatible con DBeaver, pgAdmin, TablePlus, DataGrip, psql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. LISTAR AGENTES CON SUS DEPARTAMENTOS ASIGNADOS
-- Muestra el departamento primario y todos los departamentos secundarios (N:M).
-- ----------------------------------------------------------------------------
SELECT 
    a.id AS agente_id,
    a.name AS nombre_agente,
    a.email,
    a.is_global_admin AS es_admin,
    a.auto_assign_enabled AS auto_asignacion,
    a.active AS activo,
    dep_prim.name AS departamento_primario,
    COALESCE(string_agg(dep_sec.name, ', '), 'Ninguno') AS todos_los_departamentos
FROM agent a
LEFT JOIN department dep_prim ON dep_prim.id = a.primary_department_id
LEFT JOIN agent_membership am ON am.agent_id = a.id
LEFT JOIN department dep_sec ON dep_sec.id = am.department_id
GROUP BY a.id, a.name, a.email, a.is_global_admin, a.auto_assign_enabled, a.active, dep_prim.name
ORDER BY a.name ASC;


-- ----------------------------------------------------------------------------
-- 2. LISTAR DEPARTAMENTOS Y CARGA DE TRABAJO ACTUAL
-- ----------------------------------------------------------------------------
SELECT 
    d.id AS departamento_id,
    d.slug,
    d.name AS departamento,
    d.active AS activo,
    COUNT(DISTINCT am.agent_id) AS total_agentes_asignados,
    COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('ACTIVE', 'WAITING_USER', 'ESCALATED')) AS casos_en_curso
FROM department d
LEFT JOIN agent_membership am ON am.department_id = d.id
LEFT JOIN "case" c ON c.department_id = d.id
GROUP BY d.id, d.slug, d.name, d.active
ORDER BY d.name;


-- ----------------------------------------------------------------------------
-- 3. ASIGNAR UN AGENTE A UN DEPARTAMENTO (TABLA PUENTE AGENT_MEMBERSHIP)
-- ----------------------------------------------------------------------------
-- Reemplazar los UUIDs correspondientes:
/*
INSERT INTO agent_membership (agent_id, department_id)
VALUES (
    'UUID-DEL-AGENTE',
    'UUID-DEL-DEPARTAMENTO'
)
ON CONFLICT (agent_id, department_id) DO NOTHING;
*/


-- ----------------------------------------------------------------------------
-- 4. CONSULTA DE CLIENTES Y SUS CONTRATOS TÉCNICOS
-- Datos utilizados por el workflow de diagnóstico (MikroTik / OLT).
-- ----------------------------------------------------------------------------
SELECT 
    cust.id AS cliente_id,
    cust.national_id AS cedula,
    cust.full_name AS cliente,
    cust.wa_phone AS telefono,
    con.contract_number AS numero_contrato,
    con.sector,
    con.olt_name,
    con.pon,
    con.serial AS serial_onu,
    con.router_model,
    con.status AS estado_contrato
FROM customer cust
INNER JOIN contract con ON con.customer_id = cust.id
ORDER BY cust.full_name, con.contract_number;
