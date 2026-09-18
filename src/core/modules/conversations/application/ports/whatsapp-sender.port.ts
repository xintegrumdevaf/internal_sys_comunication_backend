export type WhatsAppInteractiveButton = {
  id: string;
  title: string;
};

export type WhatsAppInteractiveListSection = {
  title?: string;
  rows: Array<{
    id: string;
    title: string;
    description?: string;
  }>;
};

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
  sendInteractiveButtons?(
    waPhone: string,
    bodyText: string,
    buttons: WhatsAppInteractiveButton[],
    headerText?: string,
    footerText?: string,
  ): Promise<{ externalId: string }>;
  sendInteractiveList?(
    waPhone: string,
    bodyText: string,
    buttonText: string,
    sections: WhatsAppInteractiveListSection[],
    headerText?: string,
    footerText?: string,
  ): Promise<{ externalId: string }>;
  checkMessageStatus?(
    waPhone: string,
    externalId: string,
  ): Promise<{ status: "sent" | "delivered" | "failed"; errorMessage?: string } | null>;
}

