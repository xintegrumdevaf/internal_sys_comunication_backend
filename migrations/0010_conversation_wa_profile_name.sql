-- Migracion 0010: nombre de perfil de WhatsApp del cliente.
--
-- Meta SI incluye esto en cada webhook entrante, sin llamada extra a la API:
-- entry[].changes[].value.contacts[].profile.name (docs.developers.facebook.com,
-- "messages webhook reference"). Se guarda en `conversation` (no en `customer`)
-- porque es un dato de AGENDA de WhatsApp, distinto del nombre validado por
-- cedula que ya vive en `customer.full_name` (ese viene de VALIDATE_CLIENT).
--
-- Nota (para no repetir esta pregunta en el futuro): la FOTO de perfil de
-- WhatsApp NO se puede obtener via la API oficial de Meta (Cloud API) por
-- politica de privacidad de WhatsApp — aplica a cualquier negocio con esta
-- API, no es una limitacion de este backend. Solo librerias no oficiales
-- (tipo Baileys, que simulan WhatsApp Web) lo logran, con riesgo real de que
-- Meta banee el numero de negocio. No se implementa por esa razon.

ALTER TABLE conversation ADD COLUMN wa_profile_name TEXT;
