-- Migración 0031: Definiciones de variables de negocio y metadatos amigables para plantillas de IA
-- Permite que supervisores y personal de soporte técnico entiendan exactamente qué representa cada variable

ALTER TABLE ai_prompt_templates
  ADD COLUMN IF NOT EXISTS variable_definitions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Actualizar definiciones de variables para interpret_message
UPDATE ai_prompt_templates
SET variable_definitions = '[
  {
    "key": "text",
    "label": "Mensaje actual del cliente",
    "description": "Texto o audio enviado recientemente por el cliente en WhatsApp",
    "placeholder": "Ej: Quiero cancelar el servicio / No tengo internet",
    "example": "quiero cancelar el serivico",
    "required": true
  },
  {
    "key": "recentMessages",
    "label": "Historial reciente de la charla",
    "description": "Mensajes previos intercambiados para que la IA entienda el contexto de la conversación",
    "placeholder": "Ej: Cliente: Buenas tardes | Bot: Hola, ¿en qué te ayudamos?",
    "example": "Es la octava vex que me cortan el servicio de la nada",
    "required": false
  },
  {
    "key": "activeCase",
    "label": "Trámite activo del cliente",
    "description": "Si el cliente ya tiene un caso abierto (ej: Soporte de Internet, Consulta de Factura)",
    "placeholder": "Dejar vacío si el cliente recién inicia la conversación",
    "example": "",
    "required": false
  },
  {
    "key": "pendingQuestion",
    "label": "Pregunta pendiente del bot",
    "description": "Si el bot le acababa de hacer una pregunta concreta (ej: pedir cédula, consultar luces)",
    "placeholder": "Dejar vacío si no había una pregunta pendiente",
    "example": "",
    "required": false
  }
]'::jsonb
WHERE slug = 'interpret_message';

-- Actualizar definiciones para compose_reply
UPDATE ai_prompt_templates
SET variable_definitions = '[
  {
    "key": "clientName",
    "label": "Nombre del cliente",
    "description": "Nombre registrado en el contrato o perfil de WhatsApp",
    "placeholder": "Ej: Juan Pérez",
    "example": "Carlos Mendoza",
    "required": false
  },
  {
    "key": "clientFirstName",
    "label": "Primer nombre",
    "description": "Usado para saludar de forma cercana y cordial",
    "placeholder": "Ej: Carlos",
    "example": "Carlos",
    "required": false
  },
  {
    "key": "workflowType",
    "label": "Tipo de trámite en curso",
    "description": "Área o proceso que está atendiendo al cliente",
    "placeholder": "Ej: SUPPORT_INTERNET, BILLING_BALANCE, GENERAL_INQUIRY",
    "example": "SUPPORT_INTERNET",
    "required": true
  },
  {
    "key": "stepOutcome",
    "label": "Resultado técnico / financiero",
    "description": "Resultado de la prueba técnica en OLT o consulta de saldo en el sistema",
    "placeholder": "Ej: Módem sin señal óptica / Sin valores pendientes",
    "example": "Módem desconectado o sin energía",
    "required": true
  },
  {
    "key": "templateHint",
    "label": "Mensaje base sugerido",
    "description": "Plantilla que la IA debe embellecer con empatía sin cambiar los datos",
    "placeholder": "Ej: Tu servicio se encuentra suspendido por valores pendientes",
    "example": "Revisamos tu módem y detectamos una pérdida de señal óptica.",
    "required": false
  }
]'::jsonb
WHERE slug = 'compose_reply';

-- Actualizar definiciones para refine_tone
UPDATE ai_prompt_templates
SET variable_definitions = '[
  {
    "key": "originalText",
    "label": "Mensaje redactado por el operador",
    "description": "El borrador que el agente de soporte o cobranzas escribió para el cliente",
    "placeholder": "Ej: Ya le mandamos el técnico mañana en la tarde",
    "example": "Ya le mandamos el técnico mañana en la tarde",
    "required": true
  },
  {
    "key": "contextHint",
    "label": "Tono deseado",
    "description": "Estilo de comunicación que se desea aplicar",
    "placeholder": "Ej: Empático y cordial / Formal y técnico / Conciliador",
    "example": "Empático y cordial",
    "required": false
  }
]'::jsonb
WHERE slug = 'refine_tone';
