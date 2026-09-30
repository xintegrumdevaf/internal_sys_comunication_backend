import type {
  MetaTemplatesGatewayPort,
  SubmitTemplateInput,
  SubmitTemplateResult,
  FetchTemplateStatusResult,
  RemoteTemplateItem,
} from "../application/ports/meta-templates-gateway.port";
import type { SystemSettingsService } from "../../settings/application/services/system-settings.service";

/**
 * Gateway de plantillas de WhatsApp dinámico que conmuta entre Meta Cloud API y Zernio
 * según la configuración activa en la base de datos sin requerir redespliegue.
 */
export class DynamicTemplatesGateway implements MetaTemplatesGatewayPort {
  constructor(
    private readonly settingsService: SystemSettingsService,
    private readonly metaGateway: MetaTemplatesGatewayPort,
    private readonly zernioGateway: MetaTemplatesGatewayPort,
  ) {}

  private async getGateway(): Promise<MetaTemplatesGatewayPort> {
    try {
      const settings = await this.settingsService.getChannelSettings();
      if (settings.provider === "zernio") {
        return this.zernioGateway;
      }
      return this.metaGateway;
    } catch {
      return this.metaGateway;
    }
  }

  async submitTemplate(template: SubmitTemplateInput): Promise<SubmitTemplateResult> {
    const gw = await this.getGateway();
    return gw.submitTemplate(template);
  }

  async fetchTemplateStatus(metaTemplateId: string): Promise<FetchTemplateStatusResult> {
    const gw = await this.getGateway();
    return gw.fetchTemplateStatus(metaTemplateId);
  }

  async deleteTemplate(metaTemplateId: string, name: string): Promise<boolean> {
    const gw = await this.getGateway();
    return gw.deleteTemplate(metaTemplateId, name);
  }

  async fetchAllTemplates(): Promise<RemoteTemplateItem[]> {
    const gw = await this.getGateway();
    if (gw.fetchAllTemplates) {
      return gw.fetchAllTemplates();
    }
    return [];
  }
}
