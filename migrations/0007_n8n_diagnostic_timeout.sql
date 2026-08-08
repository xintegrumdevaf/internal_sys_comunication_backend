-- Migracion 0007 (Etapa 4): timeout del microservicio de diagnostico.
-- El proxy n8n y el N8nGatewayHttp de la API usan timeout_ms de esta fila.

UPDATE n8n_workflow_registry SET timeout_ms = 30000, updated_at = NOW()
  WHERE action IN ('DIAGNOSTIC', 'CONTINUE_DIAGNOSTIC');
