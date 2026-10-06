import { describe, it, expect, vi } from "vitest";
import { DynamicEmbeddingProvider } from "../../src/core/modules/ai/infrastructure/dynamic/dynamic-embedding-provider";
import { GeminiEmbeddingAdapter } from "../../src/core/modules/ai/infrastructure/gemini/gemini-embedding.adapter";
import { OllamaEmbeddingAdapter } from "../../src/core/modules/ai/infrastructure/ollama/ollama-embedding.adapter";
import type { EmbeddingProviderPort } from "../../src/core/modules/ai/application/ports/embedding-provider.port";
import type { SystemSettingsService } from "../../src/core/modules/settings/application/services/system-settings.service";
import type { AiProviderSettings } from "../../src/core/modules/settings/domain/system-settings.entity";

describe("DynamicEmbeddingProvider & Model Resolution", () => {
  it("conmuta dinámicamente entre Gemini y Ollama según la configuración activa", async () => {
    let currentSettings: AiProviderSettings = {
      provider: "gemini",
      geminiApiKey: "fake-key",
      geminiModel: "gemini-2.5-flash",
      geminiEmbeddingModel: "text-embedding-004",
      geminiEmbeddingDimension: 768,
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3.5:4b",
      ollamaEmbeddingModel: "qwen3-embedding:4b",
      ollamaEmbeddingDimension: 2560,
      aiCallTimeoutMs: 10000,
      aiQualityTimeoutMs: 60000,
    };

    const mockSettingsService = {
      getAiSettings: vi.fn(async () => currentSettings),
    } as unknown as SystemSettingsService;

    const mockGemini: EmbeddingProviderPort = {
      generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
      getDimension: () => 768,
      getModelName: () => "gemini:text-embedding-004",
    };

    const mockOllama: EmbeddingProviderPort = {
      generateEmbedding: vi.fn(async () => [0.9, 0.8, 0.7]),
      getDimension: () => 2560,
      getModelName: () => "ollama:qwen3-embedding:4b",
    };

    const dynamicProvider = new DynamicEmbeddingProvider(
      mockSettingsService,
      mockGemini,
      mockOllama,
    );

    // 1. Con provider = gemini
    const embGemini = await dynamicProvider.generateEmbedding("Hola mundo");
    expect(embGemini).toEqual([0.1, 0.2, 0.3]);
    expect(mockGemini.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(mockOllama.generateEmbedding).not.toHaveBeenCalled();
    expect(dynamicProvider.getDimension()).toBe(768);
    expect(dynamicProvider.getModelName()).toBe("gemini:text-embedding-004");

    // 2. Conmutar a provider = ollama
    currentSettings = { ...currentSettings, provider: "ollama" };
    const embOllama = await dynamicProvider.generateEmbedding("Hola mundo");
    expect(embOllama).toEqual([0.9, 0.8, 0.7]);
    expect(mockOllama.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(dynamicProvider.getDimension()).toBe(2560);
    expect(dynamicProvider.getModelName()).toBe("ollama:qwen3-embedding:4b");
  });

  it("actualiza dinámicamente el nombre de modelo y dimensiones en los adaptadores", async () => {
    let currentSettings: AiProviderSettings = {
      provider: "gemini",
      geminiApiKey: "initial-gemini-key",
      geminiModel: "gemini-2.5-flash",
      geminiEmbeddingModel: "text-embedding-004",
      geminiEmbeddingDimension: 768,
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3.5:4b",
      ollamaEmbeddingModel: "qwen3-embedding:4b",
      ollamaEmbeddingDimension: 2560,
      aiCallTimeoutMs: 10000,
      aiQualityTimeoutMs: 60000,
    };

    const mockSettingsService = {
      getAiSettings: vi.fn(async () => currentSettings),
    } as unknown as SystemSettingsService;

    // Mock global fetch
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("embedContent")) {
        return {
          ok: true,
          json: async () => ({ embedding: { values: [0.123] } }),
        };
      }
      return {
        ok: true,
        json: async () => ({ embedding: [0.456] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const geminiAdapter = new GeminiEmbeddingAdapter(
      { apiKey: "key", model: "text-embedding-004", dimension: 768 },
      undefined,
      mockSettingsService,
    );

    await geminiAdapter.generateEmbedding("Test query");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("models/text-embedding-004:embedContent"),
      expect.anything(),
    );

    // Cambiar modelo dinámicamente en settings
    currentSettings = {
      ...currentSettings,
      geminiEmbeddingModel: "custom-gemini-embedding",
      geminiEmbeddingDimension: 1024,
    };

    await geminiAdapter.generateEmbedding("Test query 2");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("models/custom-gemini-embedding:embedContent"),
      expect.anything(),
    );
    expect(geminiAdapter.getDimension()).toBe(1024);
    expect(geminiAdapter.getModelName()).toBe("gemini:custom-gemini-embedding");

    vi.unstubAllGlobals();
  });
});
