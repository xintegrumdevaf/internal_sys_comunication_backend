-- Migración 0030: Intenciones críticas adicionales para atención humana directa
-- Evita que solicitudes de baja, devolución de equipos o quejas de cobro caigan erróneamente en diagnóstico de internet

INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'billing.dispute', 'Reclamo o Inconformidad de Factura', 'El cliente no reconoce el cobro, reclama cobro indebido o desacuerdo con el saldo pendiente', 'human_direct', 'BILLING_BALANCE'
FROM department WHERE slug = 'billing'
ON CONFLICT (intent_key) DO NOTHING;

INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'support.equipment_return', 'Retiro o Devolución de Equipos', 'El cliente solicita o exige el retiro de equipos o la devolución de la ONU/módem tras corte', 'human_direct', 'SUPPORT_INTERNET'
FROM department WHERE slug = 'support'
ON CONFLICT (intent_key) DO NOTHING;

INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'support.service_cancellation', 'Baja o Cancelación de Servicio', 'El cliente solicita cancelar el servicio o dar de baja el contrato definitivamente', 'human_direct', 'GENERAL_INQUIRY'
FROM department WHERE slug = 'support'
ON CONFLICT (intent_key) DO NOTHING;

INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'general.complaint', 'Reclamo Formal o Queja', 'El cliente expresa descontento grave, quejas del servicio o disconformidad general', 'human_direct', 'GENERAL_INQUIRY'
FROM department WHERE slug = 'general'
ON CONFLICT (intent_key) DO NOTHING;
