-- Migración 0024: Enrutamiento dinámico de casos y responsabilidades por departamento
-- Permite que los departamentos definan qué casos/intenciones atienden y si van con IA o humanos directos

-- 1. Agregar columna description a la tabla department si no existe
ALTER TABLE department ADD COLUMN IF NOT EXISTS description TEXT;

-- 2. Crear tabla department_case_routing
CREATE TABLE IF NOT EXISTS department_case_routing (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  department_id   UUID NOT NULL REFERENCES department(id) ON DELETE CASCADE,
  intent_key      TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL,
  description     TEXT NOT NULL,
  handling_mode   TEXT NOT NULL DEFAULT 'ai_assisted' CHECK (handling_mode IN ('ai_assisted', 'human_direct')),
  workflow_type   TEXT NOT NULL DEFAULT 'GENERAL_INQUIRY',
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dept_case_routing_dept ON department_case_routing(department_id);
CREATE INDEX IF NOT EXISTS idx_dept_case_routing_intent ON department_case_routing(intent_key);

-- 3. Sembrar descripciones predeterminadas en los departamentos existentes
UPDATE department SET description = 'Atención técnica ante cortes de fibra, caídas de señal, lentitud y problemas de routers'
WHERE slug = 'support' AND description IS NULL;

UPDATE department SET description = 'Gestión de facturación, saldos pendientes, estados de cuenta y comprobantes de pago'
WHERE slug = 'billing' AND description IS NULL;

UPDATE department SET description = 'Contratación de nuevos servicios, información de planes, paquetes y promociones comerciales'
WHERE slug = 'sales' AND description IS NULL;

UPDATE department SET description = 'Consultas institucionales, horarios de atención, agencias y cobertura en sectores'
WHERE slug = 'general' AND description IS NULL;

-- 4. Sembrar casos iniciales vinculados a los departamentos existentes
-- Soporte Técnico
INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'support.internet', 'Corte o Caída de Internet', 'Reporte de pérdida total de señal, luz roja en módem (LOS), corte de fibra o internet caído', 'ai_assisted', 'SUPPORT_INTERNET'
FROM department WHERE slug = 'support'
ON CONFLICT (intent_key) DO NOTHING;

INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'support.slow_internet', 'Lentitud o Intermitencia', 'Reporte de lentitud de navegación, desconexiones intermitentes o Wi-Fi inestable', 'ai_assisted', 'SUPPORT_INTERNET'
FROM department WHERE slug = 'support'
ON CONFLICT (intent_key) DO NOTHING;

-- Facturación
INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'billing.balance', 'Consulta de Saldo y Facturas', 'El cliente consulta cuánto debe, fecha límite de pago o valor de su factura', 'ai_assisted', 'BILLING_BALANCE'
FROM department WHERE slug = 'billing'
ON CONFLICT (intent_key) DO NOTHING;

INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'billing.record_payment', 'Reporte de Comprobante de Pago', 'El cliente envía o reporta un comprobante de transferencia o depósito ya realizado', 'ai_assisted', 'BILLING_BALANCE'
FROM department WHERE slug = 'billing'
ON CONFLICT (intent_key) DO NOTHING;

-- Ventas
INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'sales.packages', 'Planes y Precios', 'Preguntas sobre precios, planes de fibra óptica, promociones de velocidad o contratación', 'ai_assisted', 'GENERAL_INQUIRY'
FROM department WHERE slug = 'sales'
ON CONFLICT (intent_key) DO NOTHING;

INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'sales.upgrade', 'Mejora o Cambio de Plan', 'El cliente solicita aumentar la velocidad de su servicio o cambiar a un plan superior', 'ai_assisted', 'GENERAL_INQUIRY'
FROM department WHERE slug = 'sales'
ON CONFLICT (intent_key) DO NOTHING;

-- General
INSERT INTO department_case_routing (department_id, intent_key, label, description, handling_mode, workflow_type)
SELECT id, 'general.inquiry', 'Consultas Generales y Cobertura', 'Preguntas generales de la empresa, horarios de atención, ubicación de agencias o cuentas bancarias', 'ai_assisted', 'GENERAL_INQUIRY'
FROM department WHERE slug = 'general'
ON CONFLICT (intent_key) DO NOTHING;
