-- 0037_rename_sales_workflow_routing.sql
-- Actualiza el enrutamiento de casos comerciales para que usen el flujo especializado SALES en lugar del genérico GENERAL_INQUIRY o SALES_PACKAGES.

UPDATE department_case_routing
SET workflow_type = 'SALES',
    updated_at = now()
WHERE intent_key IN ('sales.packages', 'sales.upgrade');
