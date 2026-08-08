import type { AIProviderPort, ReceiptData } from "../ports/ai-provider.port";

export class ExtractReceiptDataUseCase {
  constructor(private readonly provider: AIProviderPort) {}

  async execute(mediaUrl: string, mimeType: string): Promise<ReceiptData> {
    return this.provider.extractReceiptData(mediaUrl, mimeType);
  }
}
