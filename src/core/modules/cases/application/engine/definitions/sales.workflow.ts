import type { CaseContext } from "../../../domain/contexts/case-context";
import type { SalesContext } from "../../../domain/contexts/sales.context";
import { resetWaitingAttempts } from "../../../domain/contexts/engine-meta";
import type { WorkflowDefinition, WorkflowStateHandler } from "../workflow-definition";
import type { RagService } from "../../../../ai/application/services/rag.service";
import type { CoverageService } from "../../../../coverage/application/services/coverage.service";

/**
 * SALES (Flujo comercial unificado con verificación de cobertura KML).
 *
 * Flujo:
 *   COLLECT_PREFERENCE → (si hay coverageService y no es upgrade: GATHER_LOCATION / WAITING_USER_LOCATION)
 *     ├── SI TIENE COBERTURA → QUERY_PLANS → RESPOND_OFFER → ESCALATED a ventas
 *     └── NO TIENE COBERTURA → COMPLETED / NO_COVERAGE (informa amablemente y registra)
 *
 * Si purpose = upgrade → omite verificación de cobertura física y escala a ventas tras oferta.
 */

type KnowledgeOutput = {
  found: boolean;
  answer?: string;
  sources?: string[];
  planId?: string;
  price?: number;
  speed?: string;
  name?: string;
};

function requireSalesContext(context: CaseContext): SalesContext {
  if (context.workflowType !== "SALES" && context.workflowType !== "SALES_PACKAGES") {
    throw new Error(`Contexto invalido para SALES: workflowType='${context.workflowType}'`);
  }
  return context.data;
}

function withContext(data: SalesContext, base?: CaseContext): CaseContext {
  const workflowType = base?.workflowType === "SALES_PACKAGES" ? "SALES_PACKAGES" : "SALES";
  return {
    workflowType,
    data,
    _engine: base?._engine,
  };
}

function resolvePurpose(
  data: SalesContext,
  entities?: Record<string, unknown>,
): "sales" | "plans" | "packages" | "upgrade" {
  if (data.purpose) return data.purpose;
  if (entities?.salesPurpose === "upgrade") return "upgrade";
  if (entities?.salesPurpose === "plans") return "plans";
  return "sales";
}

function mergeSpeed(
  data: SalesContext,
  entities?: Record<string, unknown>,
  text?: string,
): SalesContext {
  const fromEntities =
    typeof entities?.requestedSpeed === "string" ? entities.requestedSpeed.trim() : "";
  if (fromEntities) {
    return { ...data, requestedSpeed: fromEntities };
  }
  if (!data.requestedSpeed && text) {
    const match = text.match(/(\d+)\s*(megas?|mbps|Mbps|MB)/i);
    if (match) {
      return { ...data, requestedSpeed: `${match[1]} Mbps` };
    }
  }
  return data;
}

function extractLocationFromInput(
  entities?: Record<string, unknown>,
  text?: string,
): { lat?: number; lng?: number; address?: string; locationUrl?: string } {
  let lat: number | undefined;
  let lng: number | undefined;
  let locationUrl: string | undefined;
  let address: string | undefined;

  if (typeof entities?.latitude === "number" && typeof entities?.longitude === "number") {
    lat = entities.latitude;
    lng = entities.longitude;
  } else if (typeof entities?.lat === "number" && typeof entities?.lng === "number") {
    lat = entities.lat;
    lng = entities.lng;
  } else {
    const rawCoords =
      (typeof entities?.coordinates === "string" ? entities.coordinates : undefined) ??
      (typeof entities?.coords === "string" ? entities.coords : undefined) ??
      (typeof entities?.ubicacion === "string" ? entities.ubicacion : undefined);
    if (rawCoords) {
      const coordMatch = rawCoords.match(/([-+]?\d{1,2}\.\d+)\s*,\s*([-+]?\d{1,3}\.\d+)/);
      if (coordMatch?.[1] && coordMatch[2]) {
        lat = Number.parseFloat(coordMatch[1]);
        lng = Number.parseFloat(coordMatch[2]);
      }
    }
  }

  if (typeof entities?.locationUrl === "string") {
    locationUrl = entities.locationUrl.trim();
  } else if (typeof entities?.mapLocation === "string") {
    locationUrl = entities.mapLocation.trim();
  }

  if (typeof entities?.address === "string" && entities.address.trim()) {
    address = entities.address.trim();
  } else if (typeof entities?.direccion === "string" && entities.direccion.trim()) {
    address = entities.direccion.trim();
  } else if (typeof entities?.location === "string" && entities.location.trim()) {
    address = entities.location.trim();
  } else if (typeof entities?.newAddress === "string" && entities.newAddress.trim()) {
    address = entities.newAddress.trim();
  }

  const sector = typeof entities?.sector === "string" ? entities.sector.trim() : "";
  const city = typeof entities?.city === "string" ? entities.city.trim() : "";
  if (address) {
    if (sector && !address.toLowerCase().includes(sector.toLowerCase())) {
      address = `${address} (${sector})`;
    }
    if (city && !address.toLowerCase().includes(city.toLowerCase())) {
      address = `${address}, ${city}`;
    }
  }

  const rawText = typeof text === "string" ? text.trim() : "";
  if (!locationUrl && rawText) {
    const urlMatch = rawText.match(/(https?:\/\/[^\s]+)/i);
    if (urlMatch?.[1]) {
      locationUrl = urlMatch[1];
    }
  }

  if (!lat && !lng && rawText) {
    const coordMatch = rawText.match(/([-+]?\d{1,2}\.\d+)\s*,\s*([-+]?\d{1,3}\.\d+)/);
    if (coordMatch?.[1] && coordMatch[2]) {
      lat = Number.parseFloat(coordMatch[1]);
      lng = Number.parseFloat(coordMatch[2]);
    }
  }

  if (!address && !lat && !lng && !locationUrl && rawText.length >= 4) {
    const isAddressPattern =
      /calle|av\b|av\.|avenida|pasaje|barrio|sector|diagonal|manzana|mz\b|villa|casa|conjunto|redondel|parroquia/i.test(rawText) ||
      /quito|cuenca|chillogallo|pomasqui|calacali|pifo|totoracocha|sinincay|san roque|san sebastian|bellavista|monay|moran|bicentenario|gatazo|trancito/i.test(rawText) ||
      /([a-z0-9\s]+\s+y\s+[a-z0-9\s]+)/i.test(rawText) ||
      /vivo\s+en\s+([a-z0-9\s]+)/i.test(rawText) ||
      /\ben\b\s+(el\s+sector\s+de\s+)?([a-z0-9\s]+)/i.test(rawText);

    const isGenericInquiryOnly =
      /^(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|saludos)?[!.\s]*(quiero|deseo|busco|necesito|info|informaci[oó]n|planes|paquetes|internet|megas|contratar)?[!.\s]*$/i.test(rawText);

    if (isAddressPattern && !isGenericInquiryOnly) {
      address = rawText;
    }
  }

  return { lat, lng, address, locationUrl };
}

export function createSalesWorkflow(
  ragService?: RagService,
  coverageService?: CoverageService,
  workflowType: "SALES" | "SALES_PACKAGES" = "SALES",
): WorkflowDefinition {
  const collectPreference: WorkflowStateHandler = async ({ context, entities, text }) => {
    let data = requireSalesContext(context);
    data = { ...data, purpose: resolvePurpose(data, entities) };
    data = mergeSpeed(data, entities, text);

    const isUpgrade = data.purpose === "upgrade";

    // Si es consulta de ventas y tenemos CoverageService activo:
    // verificar si ya tenemos cobertura confirmada o si debemos solicitar ubicación
    if (coverageService && !isUpgrade && !data.coverage) {
      const loc = extractLocationFromInput(entities, text);
      const hasAnyLocationInfo = Boolean(loc.lat || loc.lng || loc.locationUrl || (loc.address && loc.address.length >= 4));

      if (hasAnyLocationInfo) {
        const check = coverageService.checkLocation({
          lat: loc.lat,
          lng: loc.lng,
          text: loc.address,
          locationUrl: loc.locationUrl,
        });

        data = {
          ...data,
          address: loc.address,
          mapLocation: loc.locationUrl,
          coordinates: loc.lat && loc.lng ? { lat: loc.lat, lng: loc.lng } : undefined,
          coverage: {
            hasCoverage: check.hasCoverage,
            zoneName: check.zoneName,
            city: check.city,
            matchType: check.matchType,
            addressProvided: loc.address || loc.locationUrl,
            reason: check.reason,
          },
        };

        if (!check.hasCoverage) {
          // Si solo proveyó texto de dirección (sin coordenadas GPS ni link de mapa),
          // el sistema le pide la ubicación GPS exacta: por tanto, mantenemos el caso
          // activo en WAITING_USER_LOCATION en vez de cerrarlo inmediatamente.
          if (!loc.lat && !loc.lng && !loc.locationUrl) {
            const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_LOCATION");
            return { type: "WAITING_USER", nextState: "WAITING_USER_LOCATION", context: waiting };
          }
          return { type: "COMPLETED", nextState: "NO_COVERAGE", context: withContext(data, context) };
        }
      } else {
        // No proporcionó ubicación: solicitarla al usuario
        const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_LOCATION");
        return { type: "WAITING_USER", nextState: "WAITING_USER_LOCATION", context: waiting };
      }
    }

    // Sin velocidad pedida: preguntar si el mensaje era muy breve
    if (!data.requestedSpeed && !isUpgrade && !coverageService) {
      if (entities && Object.keys(entities).length === 0 && text && text.trim().length < 8) {
        const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_SPEED");
        return { type: "WAITING_USER", nextState: "WAITING_USER_SPEED", context: waiting };
      }
    }

    return { type: "CONTINUE", nextState: "QUERY_PLANS", context: withContext(data, context) };
  };

  const waitingLocation: WorkflowStateHandler = async ({ context, entities, text }) => {
    let data = requireSalesContext(context);
    data = { ...data, purpose: resolvePurpose(data, entities) };
    data = mergeSpeed(data, entities, text);

    if (coverageService) {
      const loc = extractLocationFromInput(entities, text);
      const effectiveAddress = loc.address || data.address;
      const effectiveLocationUrl = loc.locationUrl || data.mapLocation;
      const effectiveLat = loc.lat ?? data.coordinates?.lat;
      const effectiveLng = loc.lng ?? data.coordinates?.lng;

      const check = coverageService.checkLocation({
        lat: effectiveLat,
        lng: effectiveLng,
        text: effectiveAddress,
        locationUrl: effectiveLocationUrl,
      });

      data = {
        ...data,
        address: effectiveAddress,
        mapLocation: effectiveLocationUrl,
        coordinates: effectiveLat && effectiveLng ? { lat: effectiveLat, lng: effectiveLng } : undefined,
        coverage: {
          hasCoverage: check.hasCoverage,
          zoneName: check.zoneName,
          city: check.city,
          matchType: check.matchType,
          addressProvided: effectiveAddress || effectiveLocationUrl,
          reason: check.reason,
        },
      };

      if (!check.hasCoverage) {
        if (!effectiveLat && !effectiveLng && !effectiveLocationUrl) {
          const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_LOCATION");
          return { type: "WAITING_USER", nextState: "WAITING_USER_LOCATION", context: waiting };
        }
        return { type: "COMPLETED", nextState: "NO_COVERAGE", context: withContext(data, context) };
      }
    }

    return { type: "CONTINUE", nextState: "QUERY_PLANS", context: withContext(data, context) };
  };

  const waitingSpeed: WorkflowStateHandler = async ({ context, entities, text }) => {
    let data = requireSalesContext(context);
    data = mergeSpeed(data, entities, text);
    data = { ...data, purpose: resolvePurpose(data, entities) };
    return { type: "CONTINUE", nextState: "QUERY_PLANS", context: withContext(data, context) };
  };

  const queryPlansHandler: WorkflowStateHandler = async ({
    caseId,
    conversationId,
    correlationId,
    context,
    gateway,
    text,
  }) => {
    const data = requireSalesContext(context);
    const question = data.requestedSpeed
      ? `¿Qué planes de internet de aproximadamente ${data.requestedSpeed} tienen disponibles?`
      : text?.trim() || "¿Qué planes de internet ofrecen actualmente?";

    let output: KnowledgeOutput;

    if (ragService) {
      const ragRes = await ragService.query(question, 4);
      output = {
        found: ragRes.found,
        answer: ragRes.answer,
        speed: data.requestedSpeed,
      };
    } else {
      const result = await gateway.executeAction({
        action: "QUERY_KNOWLEDGE_BASE",
        caseId,
        conversationId,
        correlationId,
        input: { question },
      });

      if (!result.success) {
        return { type: "ESCALATED", reason: result.error.message, context };
      }

      output = result.result as KnowledgeOutput;
    }

    if (!output.found) {
      return {
        type: "ESCALATED",
        reason: "No se encontró información de planes en la base de conocimiento",
        context,
      };
    }

    const nextData: SalesContext = {
      ...data,
      offer: {
        planId: output.planId ?? "catalog",
        name: output.name,
        price: output.price ?? 0,
        speed: output.speed ?? data.requestedSpeed,
        answer: output.answer,
      },
    };

    return { type: "CONTINUE", nextState: "RESPOND_OFFER", context: withContext(nextData, context) };
  };

  const respondOffer: WorkflowStateHandler = async ({ context }) => {
    const data = requireSalesContext(context);

    // Si tiene cobertura confirmada por CoverageService, derivar inmediatamente a ventas para cierre
    if (data.coverage?.hasCoverage) {
      return {
        type: "ESCALATED",
        reason: `Prospecto con cobertura confirmada en ${data.coverage.zoneName} (${data.coverage.city}) — derivado a especialista de ventas`,
        context,
      };
    }

    if (data.purpose === "upgrade") {
      const waiting = resetWaitingAttempts(context, "WAITING_USER_UPGRADE");
      return { type: "WAITING_USER", nextState: "WAITING_USER_UPGRADE", context: waiting };
    }

    return { type: "COMPLETED", context };
  };

  const waitingUpgrade: WorkflowStateHandler = async ({ context, entities, text }) => {
    const confirmed =
      entities?.confirm === true ||
      entities?.confirm === "yes" ||
      (typeof text === "string" && text.trim().length > 0);

    if (!confirmed) {
      const waiting = resetWaitingAttempts(context, "WAITING_USER_UPGRADE");
      return { type: "WAITING_USER", nextState: "WAITING_USER_UPGRADE", context: waiting };
    }

    return {
      type: "ESCALATED",
      reason: "Cliente quiere cambiar/mejorar su plan — requiere especialista de ventas",
      context,
    };
  };

  return {
    workflowType,
    initialState: "COLLECT_PREFERENCE",
    expirationHours: 24,
    waitingSteps: {
      WAITING_USER_LOCATION: {
        pendingQuestion:
          "¡Con gusto te ayudamos con la contratación y planes de internet! Para verificar la factibilidad y cobertura de fibra óptica en tu zona, por favor indícanos tu dirección o compártenos tu ubicación de WhatsApp 📎.",
        requireAny: ["address", "location", "mapLocation", "coordinates"],
        maxAttempts: 3,
      },
      WAITING_USER_SPEED: {
        pendingQuestion: "¿Qué velocidad o plan te interesa? (por ejemplo 100, 300 o 500 Mbps)",
        requireAny: ["requestedSpeed"],
        maxAttempts: 2,
      },
      WAITING_USER_UPGRADE: {
        pendingQuestion:
          "¿Confirmas que quieres que un especialista de ventas gestione el cambio de plan por ti?",
        requireAny: ["confirm", "answer"],
        maxAttempts: 2,
      },
    },
    replyTemplates: {
      WAITING_USER_LOCATION:
        "¡Con gusto te ayudamos con la contratación y planes de internet! Para verificar la factibilidad y cobertura de fibra óptica en tu zona, por favor indícanos tu dirección o compártenos tu ubicación de WhatsApp 📎.",
      WAITING_USER_SPEED: "¿Qué velocidad o plan te interesa? (por ejemplo 100, 300 o 500 Mbps)",
      WAITING_USER_UPGRADE:
        "¿Confirmas que quieres que un especialista de ventas gestione el cambio de plan por ti?",
      RESPOND_OFFER: "{{offerAnswer}}",
      NO_COVERAGE:
        "Hemos revisado tu ubicación y por el momento no disponemos de cobertura de fibra óptica en ese sector. Registramos tu solicitud para comunicarte apenas nuestra red esté disponible. ¡Muchas gracias por consultarnos!",
      COMPLETED: "{{offerAnswer}}",
      ESCALATED:
        "¡Excelente! Contamos con cobertura en tu zona. Te conectamos de inmediato con un especialista de ventas para que elijas tu plan ideal y coordinen tu instalación. 🚀",
      ACTIVE: "Estamos buscando los planes disponibles. Un momento por favor.",
    },
    states: {
      COLLECT_PREFERENCE: collectPreference,
      WAITING_USER_LOCATION: waitingLocation,
      WAITING_USER_SPEED: waitingSpeed,
      QUERY_PLANS: queryPlansHandler,
      QUERY_PACKAGES: queryPlansHandler, // Alias compatible hacia atrás
      RESPOND_OFFER: respondOffer,
      WAITING_USER_UPGRADE: waitingUpgrade,
      NO_COVERAGE: async ({ context }) => ({ type: "COMPLETED", context }),
    },
  };
}

export function createSalesPackagesWorkflow(
  ragService?: RagService,
  coverageService?: CoverageService,
): WorkflowDefinition {
  return createSalesWorkflow(ragService, coverageService, "SALES_PACKAGES");
}

export const salesWorkflow = createSalesWorkflow();
export const salesPackagesWorkflow = createSalesPackagesWorkflow();
