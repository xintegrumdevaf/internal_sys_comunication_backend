-- 0038_split_sales_intents.sql
-- Reemplaza sales.packages por intents específicos de negocio: sales.new_contract y sales.plans.

-- 1. Actualizar el registro existente de sales.packages a sales.new_contract
UPDATE department_case_routing
SET intent_key = 'sales.new_contract',
    label = 'Contratación de Servicio',
    description = 'El cliente manifiesta interés explícito en contratar, instalar o adquirir el servicio nuevo de internet',
    workflow_type = 'SALES',
    updated_at = now()
WHERE intent_key = 'sales.packages';

-- 2. Insertar sales.plans si no existe
INSERT INTO department_case_routing (
    department_id,
    intent_key,
    label,
    description,
    handling_mode,
    workflow_type,
    active,
    created_at,
    updated_at
)
SELECT 
    d.id,
    'sales.plans',
    'Planes y Precios',
    'Preguntas o consultas sobre planes, precios, velocidades, promociones comerciales o tarifas de internet',
    'ai_assisted',
    'SALES',
    true,
    now(),
    now()
FROM department d
WHERE d.slug = 'sales'
ON CONFLICT (intent_key) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    workflow_type = EXCLUDED.workflow_type,
    updated_at = now();

-- 3. Asegurar que sales.upgrade apunte al flujo comercial SALES
UPDATE department_case_routing
SET workflow_type = 'SALES',
    updated_at = now()
WHERE intent_key = 'sales.upgrade';
