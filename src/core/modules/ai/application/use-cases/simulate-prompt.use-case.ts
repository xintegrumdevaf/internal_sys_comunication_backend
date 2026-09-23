import { notFound, validation } from "../../../../../shared/errors/domain-errors";
import type { AIProviderPort } from "../ports/ai-provider.port";
import type { PromptTemplateRepositoryPort } from "../ports/prompt-template.repository.port";

export interface SimulatePromptInput {
  slug: string;
  systemPrompt?: string;
  userTemplate?: string;
  testVariables: Record<string, unknown>;
  modelConfig?: {
    temperature?: number;
    maxTokens?: number;
  };
}

export interface BusinessInterpretation {
  actionBadge: {
    label: string;
    variant: "success" | "info" | "warning" | "destructive" | "secondary";
    description: string;
  };
  intentTitle: string;
  departmentName: string;
  resolutionPath: string;
  confidencePercent: number;
  confidenceBadge: "ALTA" | "MEDIA" | "BAJA";
  summary: string;
  extractedDetails: Array<{ label: string; value: string }>;
}

export interface SimulatePromptResult {
  interpolatedSystem: string;
  interpolatedUser: string;
  rawResponse: string;
  parsedResponse?: unknown;
  businessInterpretation?: BusinessInterpretation;
  isValidJson: boolean;
  durationMs: number;
}

export interface ChatCapableAIProvider {
  chat(
    system: string,
    user: string,
    options?: { temperature?: number; jsonMode?: boolean },
  ): Promise<string>;
}

function isChatCapable(provider: unknown): provider is ChatCapableAIProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    "chat" in provider &&
    typeof (provider as { chat: unknown }).chat === "function"
  );
}

export class SimulatePromptUseCase {
  constructor(
    private readonly promptRepo: PromptTemplateRepositoryPort,
    private readonly aiProvider: AIProviderPort,
  ) {}

  async execute(input: SimulatePromptInput): Promise<SimulatePromptResult> {
    const template = await this.promptRepo.findBySlug(input.slug);
    if (!template) {
      throw notFound(`Plantilla de prompt '${input.slug}' no encontrada`);
    }

    let system = input.systemPrompt;
    let user = input.userTemplate;

    if (!system || !user) {
      const active = await this.promptRepo.getActiveVersion(template.id);
      if (!active) {
        throw validation(
          `La plantilla '${input.slug}' no tiene versión activa ni se suministró contenido para simular`,
        );
      }
      system = system || active.systemPrompt;
      user = user || active.userTemplate;
    }

    const interpolatedSystem = this.interpolate(system, input.testVariables);
    const interpolatedUser = this.interpolate(user, input.testVariables);

    const started = Date.now();

    // Invocamos directamente al proveedor de IA en modo chat con las instrucciones
    let rawResponse = "";
    if (isChatCapable(this.aiProvider)) {
      rawResponse = await this.aiProvider.chat(
        interpolatedSystem,
        interpolatedUser,
        {
          temperature: input.modelConfig?.temperature ?? 0.2,
          jsonMode: true,
        },
      );
    } else {
      rawResponse = JSON.stringify({
        simulated: true,
        message: "Simulación completada en entorno de pruebas",
      });
    }

    const durationMs = Date.now() - started;

    let parsedResponse: unknown = undefined;
    let isValidJson = false;

    try {
      const cleaned = rawResponse
        .replace(/```json\s*/gi, "")
        .replace(/```\s*$/gi, "")
        .trim();
      parsedResponse = JSON.parse(cleaned);
      isValidJson = true;
    } catch {
      isValidJson = false;
    }

    const businessInterpretation =
      isValidJson && parsedResponse && typeof parsedResponse === "object"
        ? this.interpretForBusiness(input.slug, parsedResponse as Record<string, unknown>)
        : undefined;

    return {
      interpolatedSystem,
      interpolatedUser,
      rawResponse,
      parsedResponse,
      businessInterpretation,
      isValidJson,
      durationMs,
    };
  }

  private interpolate(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g, (match, key) => {
      if (key in vars) {
        const val = vars[key];
        if (val === undefined || val === null) return "";
        if (typeof val === "object") return JSON.stringify(val);
        return String(val);
      }
      return match;
    });
  }

  private interpretForBusiness(
    slug: string,
    parsed: Record<string, unknown>,
  ): BusinessInterpretation | undefined {
    if (slug === "interpret_message") {
      const rawType = String(parsed.type || "UNCLEAR");
      const rawIntent = String(parsed.intent || "unknown");
      const rawConfidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.85;
      const entities = (parsed.entities && typeof parsed.entities === "object"
        ? (parsed.entities as Record<string, unknown>)
        : {}) as Record<string, unknown>;

      // 1. Tipo de acción
      const typeMap: Record<
        string,
        { label: string; variant: BusinessInterpretation["actionBadge"]["variant"]; description: string }
      > = {
        NEW_INTENT: {
          label: "Nueva Solicitud / Trámite",
          variant: "success",
          description: "El cliente inicia un tema o consulta nueva sin relación con un caso previo.",
        },
        CONTINUE: {
          label: "Seguimiento de Conversación",
          variant: "info",
          description: "El cliente responde dando seguimiento directo al caso o trámite que tiene en curso.",
        },
        ANSWER: {
          label: "Respuesta con Datos",
          variant: "info",
          description: "El cliente entrega el dato que el bot le pidió (ej: cédula, color de luces del módem, opción).",
        },
        CONFIRM: {
          label: "Confirmación (Sí)",
          variant: "success",
          description: "El cliente acepta o confirma una propuesta del sistema.",
        },
        DENY: {
          label: "Negación (No)",
          variant: "warning",
          description: "El cliente rechaza una consulta o dice que no.",
        },
        CANCEL: {
          label: "Cancelación o Despedida",
          variant: "secondary",
          description: "El cliente pide no continuar o se despide agradeciendo.",
        },
        REQUEST_HUMAN: {
          label: "Asesor Humano Solicitado",
          variant: "destructive",
          description: "El cliente pide expresamente ser atendido por una persona real.",
        },
        CHANGE_TOPIC: {
          label: "Cambio de Asunto",
          variant: "warning",
          description: "El cliente tenía un caso abierto pero consultó algo completamente distinto.",
        },
        UNCLEAR: {
          label: "Sin Certeza / Ambiguo",
          variant: "secondary",
          description: "Mensaje aislado o saludo sin información suficiente para clasificar.",
        },
      };

      const actionBadge = typeMap[rawType] || {
        label: rawType,
        variant: "secondary",
        description: "Tipo de interacción detectada.",
      };

      // 2. Intención y destino de negocio
      const intentCatalog: Record<
        string,
        {
          title: string;
          department: string;
          resolutionPath: string;
          summary: string;
        }
      > = {
        "support.service_cancellation": {
          title: "Cancelación / Baja Definitiva de Servicio",
          department: "Soporte Técnico / Retención",
          resolutionPath: "🚨 Derivación Directa a Asesor Humano (Sin bot)",
          summary:
            "El cliente desea dar de baja su servicio o rescindir el contrato. El sistema NO ejecutará diagnósticos técnicos en el módem; asignará inmediatamente un operador humano para retención y trámite de baja.",
        },
        "support.equipment_return": {
          title: "Devolución o Retiro de Equipos / Módem",
          department: "Soporte Técnico / Operaciones",
          resolutionPath: "🚨 Derivación Directa a Asesor Humano",
          summary:
            "El cliente solicita entregar el módem o coordinar su retiro técnico. Se deriva directamente a un asesor de operaciones.",
        },
        "billing.dispute": {
          title: "Reclamo por Cobro o Factura Indebida",
          department: "Facturación y Cobranzas",
          resolutionPath: "🚨 Derivación Directa a Asesor de Facturación",
          summary:
            "El cliente reclama inconformidad con su factura o un cobro no reconocido. Se escala de inmediato a un humano.",
        },
        "general.complaint": {
          title: "Queja Formal por Atención o Servicio",
          department: "Atención al Cliente / Supervisión",
          resolutionPath: "🚨 Derivación Directa a Supervisor / Humano",
          summary:
            "El cliente expresa una queja grave por mala atención o demoras. Se escala directamente a un supervisor.",
        },
        "support.internet": {
          title: "Falla o Corte de Conexión de Internet",
          department: "Soporte Técnico",
          resolutionPath: "🤖 Bot Automatizado (Pedirá cédula y medirá potencia en OLT/Mikrotik)",
          summary:
            "El cliente reporta caída, lentitud o corte de internet. El bot automatizado solicitará su cédula e inspeccionará la señal óptica del módem.",
        },
        "billing.balance": {
          title: "Consulta de Saldo o Factura a Pagar",
          department: "Facturación",
          resolutionPath: "🤖 Bot de Facturación (Consulta saldos en tiempo real)",
          summary:
            "El cliente desea saber cuánto debe pagar o cuándo vence su pensión. El bot consultará y enviará los montos de inmediato.",
        },
        "billing.record_payment": {
          title: "Reporte de Pago con Comprobante",
          department: "Facturación",
          resolutionPath: "🤖 Bot de Registro de Pago (Extraerá comprobante y registrará depósito)",
          summary:
            "El cliente envía el comprobante o referencia de pago bancario ya efectuado.",
        },
        "sales.packages": {
          title: "Consulta de Planes y Precios de Internet",
          department: "Ventas / Comercial",
          resolutionPath: "📚 Asistente de Base de Conocimiento (RAG Comercial)",
          summary:
            "El cliente solicita velocidades, promociones o planes de fibra óptica para su hogar o empresa.",
        },
        "sales.upgrade": {
          title: "Contratación o Aumento de Plan (Upgrade)",
          department: "Ventas",
          resolutionPath: "🤖 RAG Comercial + Opción de pasar a Ejecutivo de Ventas",
          summary:
            "El cliente solicita contratar servicio nuevo o subir de velocidad de internet.",
        },
        "general.inquiry": {
          title: "Información General de la Empresa",
          department: "Atención al Cliente",
          resolutionPath: "📚 Asistente de Base de Conocimiento (RAG Global)",
          summary:
            "Pregunta sobre horarios, oficinas, cobertura por ciudades o cuentas bancarias para transferencias.",
        },
      };

      const intentInfo = intentCatalog[rawIntent] || {
        title: rawIntent === "unknown" ? "Consulta no clasificada" : rawIntent,
        department: "General / Triage",
        resolutionPath: "Enrutamiento general",
        summary: `Clasificado bajo la categoría '${rawIntent}'.`,
      };

      // 3. Nivel de confianza
      const confidencePercent = Math.round(rawConfidence * 100);
      const confidenceBadge: BusinessInterpretation["confidenceBadge"] =
        confidencePercent >= 85 ? "ALTA" : confidencePercent >= 60 ? "MEDIA" : "BAJA";

      // 4. Entidades extraídas a lenguaje entendible
      const extractedDetails: Array<{ label: string; value: string }> = [];
      for (const [k, v] of Object.entries(entities)) {
        if (v === undefined || v === null || v === "") continue;
        const entityLabelMap: Record<string, string> = {
          action: "Acción requerida",
          nationalId: "Número de cédula",
          selectedOption: "Opción de contrato",
          address: "Dirección / Sector",
          question: "Pregunta formulada",
          speed: "Velocidad solicitada",
          location: "Ciudad o sector",
        };
        extractedDetails.push({
          label: entityLabelMap[k] || k,
          value: typeof v === "object" ? JSON.stringify(v) : String(v),
        });
      }

      return {
        actionBadge,
        intentTitle: intentInfo.title,
        departmentName: intentInfo.department,
        resolutionPath: intentInfo.resolutionPath,
        confidencePercent,
        confidenceBadge,
        summary: intentInfo.summary,
        extractedDetails,
      };
    }

    return undefined;
  }
}
