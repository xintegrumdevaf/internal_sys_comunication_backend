import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramAiCopilotAdapter } from "../../src/core/modules/telegram/infrastructure/ai/telegram-ai-copilot.adapter";
import {
  formatGroundTruthFallbackHtml,
  getStartOfDayInTimeZone,
  sanitizeTelegramHtml,
} from "../../src/core/modules/telegram/application/helpers/telegram-formatting.helper";
import type { SystemSettingsService } from "../../src/core/modules/settings/application/services/system-settings.service";
import { silentLogger } from "../support/silent-logger";

describe("TelegramAiCopilotAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeSettingsService = (overrides: Record<string, unknown> = {}): SystemSettingsService =>
    ({
      getAiSettings: vi.fn().mockResolvedValue({
        provider: "ollama",
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "qwen3.5:9b",
        geminiApiKey: "",
        geminiModel: "gemini-2.5-flash",
        aiCallTimeoutMs: 45_000,
        ...overrides,
      }),
    }) as unknown as SystemSettingsService;

  it("envía think=false y keep_alive='24h' a Ollama al clasificar consultas de ventas como METRICS_OVERVIEW", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: '```json\n{"intent": "METRICS_OVERVIEW", "sector": null, "minWaitMinutes": null, "confidence": 0.99}\n```',
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TelegramAiCopilotAdapter({
      settingsService: makeSettingsService(),
      logger: silentLogger,
    });

    const classification = await adapter.classifyQuestion("¿Cuántas ventas tuvimos hoy?");

    expect(classification.intent).toBe("METRICS_OVERVIEW");
    expect(classification.confidence).toBe(0.99);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const parsedBody = JSON.parse(String(init.body));
    expect(parsedBody.think).toBe(false);
    expect(parsedBody.keep_alive).toBe("24h");
    expect(parsedBody.format).toBe("json");
  });

  it("aplica heurística de fallback a METRICS_OVERVIEW si el proveedor falla en consulta de ventas", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TelegramAiCopilotAdapter({
      settingsService: makeSettingsService(),
      logger: silentLogger,
    });

    const classification = await adapter.classifyQuestion("¿Cuántas ventas tuvimos hoy?");
    expect(classification.intent).toBe("METRICS_OVERVIEW");
  });

  it("sanitiza HTML inválido emitido por el LLM para Telegram", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: "<p>**Ventas hoy:** 0 ingresos.</p><ul><li>Ventas & Soporte activos: <code>4</code></li></ul><br><i>Fin del reporte</i>",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TelegramAiCopilotAdapter({
      settingsService: makeSettingsService(),
      logger: silentLogger,
    });

    const reply = await adapter.synthesizeReply({
      question: "¿Cuántas ventas tuvimos hoy?",
      intent: "METRICS_OVERVIEW",
      groundTruth: "- Total casos hoy: 0",
    });

    expect(reply).not.toContain("<p>");
    expect(reply).not.toContain("<br>");
    expect(reply).not.toContain("<ul>");
    expect(reply).toContain("<b>Ventas hoy:</b>");
    expect(reply).toContain("• Ventas &amp; Soporte activos: <code>4</code>");
    expect(reply).toContain("<i>Fin del reporte</i>");
  });

  it("usa formato HTML limpio en el fallback si falla la síntesis con IA", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    const adapter = new TelegramAiCopilotAdapter({
      settingsService: makeSettingsService(),
      logger: silentLogger,
    });

    const reply = await adapter.synthesizeReply({
      question: "¿Cómo venimos hoy?",
      intent: "METRICS_OVERVIEW",
      groundTruth: "=== MÉTRICAS DE HOY ===\n- Total casos hoy: 5",
    });

    expect(reply).toContain("<b>MÉTRICAS DE HOY</b>");
    expect(reply).toContain("• <b>Total casos hoy:</b> <code>5</code>");
  });
});

describe("telegram-formatting.helper", () => {
  it("calcula el inicio del día en zona horaria local aunque UTC ya sea el día siguiente", () => {
    // 2026-11-11T00:35:00Z corresponde a 2026-11-10 19:35:00 en America/Guayaquil (UTC-5)
    const ref = new Date("2026-11-11T00:35:00.000Z");
    const startOfDay = getStartOfDayInTimeZone("America/Guayaquil", ref);

    // Medianoche del 10 de noviembre en Guayaquil es 2026-11-10T05:00:00.000Z
    expect(startOfDay.toISOString()).toBe("2026-11-10T05:00:00.000Z");
  });

  it("sanitizeTelegramHtml preserva enlaces href válidos y escapa ampersands", () => {
    const html = sanitizeTelegramHtml('<a href="https://example.com?a=1&b=2">Ver Panel</a> & más');
    expect(html).toBe('<a href="https://example.com?a=1&amp;b=2">Ver Panel</a> &amp; más');
  });

  it("sanitizeTelegramHtml repara etiquetas desbalanceadas (<b>0%</code>) y escapa < y > sueltos", () => {
    const html = sanitizeTelegramHtml("• IA hoy: <b>0%</code> con espera < 5 y > 1");
    expect(html).toBe("• IA hoy: <b>0%</b> con espera &lt; 5 y &gt; 1");
  });

  it("formatGroundTruthFallbackHtml convierte secciones y bullets planos a HTML seguro", () => {
    const html = formatGroundTruthFallbackHtml("=== OPERACIÓN ===\n- Ventas & Facturación: 3");
    expect(html).toContain("📌 <b>OPERACIÓN</b>");
    expect(html).toContain("• <b>Ventas &amp; Facturación:</b> <code>3</code>");
  });
});
