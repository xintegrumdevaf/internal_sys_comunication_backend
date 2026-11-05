-- Migración 0046: Búsqueda eficiente de mensajes históricos con pg_trgm y GIN index
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Índice GIN trigram para búsquedas de subcadenas (ILIKE) ultrarrápidas sobre el cuerpo del mensaje
CREATE INDEX IF NOT EXISTS idx_message_body_trgm ON message USING gin (body gin_trgm_ops);

-- Índice compuesto para optimizar búsqueda y ordenamiento por fecha de mensaje
CREATE INDEX IF NOT EXISTS idx_message_conv_created_desc ON message (conversation_id, created_at DESC);

