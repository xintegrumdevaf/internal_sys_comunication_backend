import type {
  WhatsAppSenderPort,
  WhatsAppInteractiveButton,
  WhatsAppInteractiveListSection,
} from "../application/ports/whatsapp-sender.port";
import type { SystemSettingsService } from "../../settings/application/services/system-settings.service";

/**
 * Sender de WhatsApp dinámico que conmuta entre Meta Cloud API nativo y Zernio
 * según la configuración activa en la base de datos sin requerir redespliegue.
 */
export class DynamicWhatsAppSender implements WhatsAppSenderPort {
  constructor(
    private readonly settingsService: SystemSettingsService,
    private readonly metaSender: WhatsAppSenderPort,
    private readonly zernioSender: WhatsAppSenderPort,
  ) {}

  private async getSender(): Promise<WhatsAppSenderPort> {
    try {
      const settings = await this.settingsService.getChannelSettings();
      if (settings.provider === "zernio") {
        return this.zernioSender;
      }
      return this.metaSender;
    } catch {
      return this.metaSender;
    }
  }

  async sendText(waPhone: string, body: string): Promise<{ externalId: string }> {
    const sender = await this.getSender();
    return sender.sendText(waPhone, body);
  }

  async sendTemplate(
    waPhone: string,
    templateName: string,
    languageCode?: string,
    parameters?: string[],
  ): Promise<{ externalId: string }> {
    const sender = await this.getSender();
    return sender.sendTemplate(waPhone, templateName, languageCode, parameters);
  }

  async sendInteractiveButtons(
    waPhone: string,
    bodyText: string,
    buttons: WhatsAppInteractiveButton[],
    headerText?: string,
    footerText?: string,
  ): Promise<{ externalId: string }> {
    const sender = await this.getSender();
    if (sender.sendInteractiveButtons) {
      return sender.sendInteractiveButtons(waPhone, bodyText, buttons, headerText, footerText);
    }
    return sender.sendText(waPhone, bodyText);
  }

  async sendInteractiveList(
    waPhone: string,
    bodyText: string,
    buttonText: string,
    sections: WhatsAppInteractiveListSection[],
    headerText?: string,
    footerText?: string,
  ): Promise<{ externalId: string }> {
    const sender = await this.getSender();
    if (sender.sendInteractiveList) {
      return sender.sendInteractiveList(waPhone, bodyText, buttonText, sections, headerText, footerText);
    }
    return sender.sendText(waPhone, bodyText);
  }

  async checkMessageStatus(
    waPhone: string,
    externalId: string,
  ): Promise<{ status: "sent" | "delivered" | "failed"; errorMessage?: string } | null> {
    const sender = await this.getSender();
    if (sender.checkMessageStatus) {
      return sender.checkMessageStatus(waPhone, externalId);
    }
    return null;
  }
}
