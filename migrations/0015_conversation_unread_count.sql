-- Migración para añadir contador persistente de mensajes no leídos
ALTER TABLE conversation ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0;
