import type { AIProviderPort } from "../ports/ai-provider.port";

export class TranscribeAudioUseCase {
  constructor(private readonly provider: AIProviderPort) {}

  async execute(mediaUrl: string, mimeType: string): Promise<{ transcript: string }> {
    return this.provider.transcribeAudio(mediaUrl, mimeType);
  }
}
