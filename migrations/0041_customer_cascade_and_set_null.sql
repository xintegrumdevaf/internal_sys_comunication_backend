-- Migracion 0041: Permitir eliminacion segura de customer desvinculando conversaciones y eliminando contratos en cascada

ALTER TABLE conversation
  DROP CONSTRAINT IF EXISTS conversation_customer_id_fkey,
  ADD CONSTRAINT conversation_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customer(id) ON DELETE SET NULL;

ALTER TABLE contract
  DROP CONSTRAINT IF EXISTS contract_customer_id_fkey,
  ADD CONSTRAINT contract_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customer(id) ON DELETE CASCADE;