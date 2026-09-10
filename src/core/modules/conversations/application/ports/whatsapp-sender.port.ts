/**
 * Unico punto por el que la API envia mensajes a WhatsApp (docs/spec/00_OVERVIEW.md
 * regla #2: "n8n nunca llama directamente al canal"). n8n nunca implementa este puerto.
 */
export interface WhatsAppSenderPort {
  sendText(waPhone: string, body: string): Promise<{ externalId: string }>;
  sendTemplate(
    waPhone: string,
    templateName: string,
    languageCode?: string,
    parameters?: string[],
  ): Promise<{ externalId: string }>;
}
