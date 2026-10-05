import type { CaseContext } from "../../../domain/contexts/case-context";
import type { HomeRelocationContext } from "../../../domain/contexts/home-relocation.context";
import { bumpWaitingAttempts, resetWaitingAttempts } from "../../../domain/contexts/engine-meta";
import type { WorkflowDefinition, WorkflowStateHandler } from "../workflow-definition";
import type { RagService } from "../../../../ai/application/services/rag.service";

type ValidateClientContractResult = {
  id: string;
  name: string;
  address?: string;
  status?: string;
  ip?: string;
  router?: { sector?: string; olt_name?: string; pon?: string; serial?: string; ip?: string };
};

type ValidateClientOutput = {
  found: boolean;
  contractNumbers: number;
  contracts: ValidateClientContractResult[];
};

function normalizeNationalId(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 13 ? digits : raw.trim();
}

function requireHomeRelocationContext(context: CaseContext): HomeRelocationContext {
  if (context?.workflowType && context.workflowType !== "HOME_RELOCATION") {
    throw new Error(`Contexto invalido para HOME_RELOCATION: workflowType='${context.workflowType}'`);
  }
  return context?.data ?? {};
}

function withContext(data: HomeRelocationContext, base?: CaseContext): CaseContext {
  return {
    workflowType: "HOME_RELOCATION",
    data,
    _engine: base?._engine,
  };
}

export function createHomeRelocationWorkflow(ragService: RagService): WorkflowDefinition {
  const validateClient: WorkflowStateHandler = async ({
    caseId,
    conversationId,
    correlationId,
    context,
    gateway,
    entities,
    identity,
  }) => {
    let data = requireHomeRelocationContext(context);

    // 1. Si el caso ya tiene cliente resuelto, avanzar a recolección de datos
    if (data.client?.nationalId && data.client?.fullName) {
      return { type: "CONTINUE", nextState: "GATHER_RELOCATION_DETAILS", context: withContext(data, context) };
    }

    // 2. Si la conversación ya validó identidad en un caso previo
    if (identity) {
      const reused = await identity.tryGetValidatedIdentity(conversationId);
      if (reused) {
        const nextData: HomeRelocationContext = {
          ...data,
          client: { nationalId: reused.nationalId, fullName: reused.fullName },
          contract: {
            id: reused.contract.id,
            sector: reused.contract.sector,
            routerModel: reused.contract.router,
          },
        };
        return { type: "CONTINUE", nextState: "GATHER_RELOCATION_DETAILS", context: withContext(nextData, context) };
      }
    }

    // 3. Evaluar cédula desde entities o context
    const rawNationalId = typeof entities?.nationalId === "string" ? entities.nationalId.trim() : "";
    const nationalIdFromEntities = normalizeNationalId(rawNationalId);
    if (nationalIdFromEntities) {
      data = {
        ...data,
        client: {
          nationalId: nationalIdFromEntities,
          fullName: data.client?.fullName ?? "",
        },
      };
    }

    const client = data.client;
    if (!client?.nationalId) {
      const waiting = resetWaitingAttempts(withContext(data, context), "WAITING_USER_CLIENT");
      return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context: waiting };
    }

    // 4. Ejecutar validación de cliente
    const result = await gateway.executeAction({
      action: "VALIDATE_CLIENT",
      caseId,
      conversationId,
      correlationId,
      input: { id: client.nationalId },
    });

    const isN8nNotFound =
      !result.success &&
      (result.error.type === "NOT_FOUND" ||
        result.error.message?.toLowerCase().includes("not found") ||
        result.error.message?.toLowerCase().includes("no se encontr"));

    if (isN8nNotFound) {
      const nextData: HomeRelocationContext = {
        ...data,
        client: undefined,
        lastSearchedNationalId: client.nationalId,
        clientNotFound: true,
      };
      const waiting = bumpWaitingAttempts(withContext(nextData, context), ["nationalId"]);
      return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context: waiting };
    }

    if (!result.success) {
      return { type: "ESCALATED", reason: result.error.message, context: withContext(data, context) };
    }

    const output = result.result as ValidateClientOutput;

    if (!output.found || !output.contracts || output.contracts.length === 0) {
      const nextData: HomeRelocationContext = {
        ...data,
        client: undefined,
        lastSearchedNationalId: client.nationalId,
        clientNotFound: true,
      };
      const waiting = bumpWaitingAttempts(withContext(nextData, context), ["nationalId"]);
      return { type: "WAITING_USER", nextState: "WAITING_USER_CLIENT", context: waiting };
    }

    const selectedContract = output.contracts[0];
    const clientFullName = selectedContract?.name || data.client?.fullName || "Cliente Validado";

    const nextData: HomeRelocationContext = {
      ...data,
      clientNotFound: false,
      lastSearchedNationalId: undefined,
      client: {
        nationalId: client.nationalId,
        fullName: clientFullName,
      },
      contract: selectedContract
        ? {
            id: selectedContract.id,
            sector: selectedContract.router?.sector,
            address: selectedContract.address,
            routerModel: undefined,
          }
        : undefined,
    };

    if (identity && selectedContract) {
      await identity.rememberValidatedIdentity({
        conversationId,
        nationalId: client.nationalId,
        fullName: clientFullName,
        contract: {
          contractNumber: selectedContract.id,
          sector: selectedContract.router?.sector,
          address: selectedContract.address,
          oltName: selectedContract.router?.olt_name,
          pon: selectedContract.router?.pon,
          serial: selectedContract.router?.serial,
        },
      });
    }

    return { type: "CONTINUE", nextState: "GATHER_RELOCATION_DETAILS", context: withContext(nextData, context) };
  };

  const gatherRelocationDetails: WorkflowStateHandler = async ({ context, entities, text }) => {
    let data = requireHomeRelocationContext(context);
    const details = data.relocationDetails ?? {};

    // 1. Extraer entidades del mensaje actual si están presentes
    let newAddress =
      (typeof entities?.newAddress === "string" && entities.newAddress.trim()) ||
      (typeof entities?.address === "string" && entities.address.trim()) ||
      (typeof entities?.direccion === "string" && entities.direccion.trim()) ||
      details.newAddress;

    let references =
      (typeof entities?.references === "string" && entities.references.trim()) ||
      (typeof entities?.addressReferences === "string" && entities.addressReferences.trim()) ||
      (typeof entities?.referencias === "string" && entities.referencias.trim()) ||
      details.references;

    let mapLocation =
      (typeof entities?.mapLocation === "string" && entities.mapLocation.trim()) ||
      (typeof entities?.locationUrl === "string" && entities.locationUrl.trim()) ||
      (typeof entities?.coordinates === "string" && entities.coordinates.trim()) ||
      (typeof entities?.ubicacion === "string" && entities.ubicacion.trim()) ||
      details.mapLocation;

    // 2. Si el cliente hizo una pregunta informativa sobre el traslado (ej. costos, tiempos, cobertura)
    let rawQuestion: string | undefined = undefined;
    if (typeof entities?.question === "string" && entities.question.trim().length > 3) {
      rawQuestion = entities.question.trim();
    } else if (
      typeof text === "string" &&
      /costo|precio|cuanto|cuánto|demora|tiempo|requisito|cobertura|pago/i.test(text.trim()) &&
      !/la direccion|mi direccion|calle|av\.|avenida/i.test(text.trim())
    ) {
      rawQuestion = text.trim();
    }

    if (rawQuestion && rawQuestion.length > 5) {
      try {
        const ragResult = await ragService.query(rawQuestion, 4);
        if (ragResult.found && ragResult.answer) {
          data.ragAnswer = ragResult.answer;
        }
      } catch {
        // RAG opcional si falla
      }
    }

    // Fallback inteligente desde el texto crudo SOLO si NO es una consulta informativa / RAG
    const rawText = typeof text === "string" ? text.trim() : "";

    if (!rawQuestion) {
      if (!newAddress && rawText.length >= 5 && /direccion|dirección|calle|av|avenida|caras|barrio|sector|casa|norte|sur|quito|guayaquil/i.test(rawText)) {
        newAddress = rawText;
      }

      if (!references && rawText.length >= 10) {
        if (/frente|junto|cerca|metros|escuela|bazar|lado|diagonal|detras|casa|esquina|referencia/i.test(rawText)) {
          references = rawText;
        } else if (newAddress && newAddress.length >= 25 && /frente|junto|cerca|metros|escuela|bazar|lado|diagonal|detras|casa|esquina|referencia/i.test(newAddress)) {
          references = newAddress;
        }
      }

      if (!mapLocation) {
        const urlMatch = rawText.match(/(https?:\/\/[^\s]+)/i);
        if (urlMatch) {
          mapLocation = urlMatch[1];
        } else if (/mapa|ubicacion|ubicación|coordenadas|gps|pin|maps|google/i.test(rawText)) {
          mapLocation = "Ubicación compartida en chat";
        } else if (newAddress && references && rawText.length >= 35) {
          mapLocation = `Ver dirección: ${newAddress}`;
        }
      }
    }

    const updatedDetails = {
      newAddress: newAddress || undefined,
      references: references || undefined,
      mapLocation: mapLocation || undefined,
    };

    data = {
      ...data,
      relocationDetails: updatedDetails,
    };

    // 3. Verificar si tenemos todos los datos requeridos
    const hasAddress = Boolean(updatedDetails.newAddress && updatedDetails.newAddress.length >= 5);
    const hasReferences = Boolean(updatedDetails.references && updatedDetails.references.length >= 5);
    const hasMapLocation = Boolean(updatedDetails.mapLocation && updatedDetails.mapLocation.length >= 3);

    if (hasAddress && hasReferences && hasMapLocation) {
      return { type: "CONTINUE", nextState: "CREATE_TICKET_AND_ESCALATE", context: withContext(data, context) };
    }

    // 4. Si faltan datos, construir la pregunta adecuada
    const missing: string[] = [];
    if (!hasAddress) missing.push("newAddress");
    if (!hasReferences) missing.push("references");
    if (!hasMapLocation) missing.push("mapLocation");

    const waiting = bumpWaitingAttempts(withContext(data, context), missing);
    return { type: "WAITING_USER", nextState: "GATHER_RELOCATION_DETAILS", context: waiting };
  };

  const createTicketAndEscalate: WorkflowStateHandler = async ({ context }) => {
    const data = requireHomeRelocationContext(context);
    return {
      type: "ESCALATED",
      reason: "Solicitud de traslado de domicilio completada por el cliente. Requiere gestión del área de traslados.",
      context: withContext(data, context),
    };
  };

  return {
    workflowType: "HOME_RELOCATION",
    initialState: "VALIDATE_CLIENT",
    expirationHours: 48,
    states: {
      VALIDATE_CLIENT: validateClient,
      WAITING_USER_CLIENT: validateClient,
      GATHER_RELOCATION_DETAILS: gatherRelocationDetails,
      CREATE_TICKET_AND_ESCALATE: createTicketAndEscalate,
    },
    waitingSteps: {
      WAITING_USER_CLIENT: {
        pendingQuestion:
          "Para procesar tu solicitud de traslado de domicilio, por favor confirma tu número de cédula o RUC.",
        requireAll: ["nationalId"],
        maxAttempts: 3,
      },
      GATHER_RELOCATION_DETAILS: {
        pendingQuestion:
          "Para agendar la visita técnica de traslado de domicilio, por favor indícanos la dirección del nuevo domicilio, dos referencias y la ubicación en el mapa.",
        requireAll: ["newAddress", "references", "mapLocation"],
        maxAttempts: 4,
      },
    },
    replyTemplates: {
      "VALIDATE_CLIENT:WAITING_USER_CLIENT":
        "Para proceder con tu solicitud de traslado de servicio, por favor indícanos el número de cédula o RUC del titular del contrato.",
      "GATHER_RELOCATION_DETAILS:WAITING_USER":
        "¡Excelente, cliente verificado! 🏠 Para continuar con tu traslado de domicilio, necesitamos que nos proporciones la siguiente información:\n\n" +
        "▪️ Dirección del nuevo domicilio\n" +
        "▪️ Dos referencias del nuevo domicilio\n" +
        "▪️ Ubicación del nuevo domicilio en el mapa (link o coordenadas de Google Maps / WhatsApp)",
      "CREATE_TICKET_AND_ESCALATE:ESCALATED":
        "¡Gracias! Hemos recopilado toda la información para tu traslado de domicilio:\n\n" +
        "👤 *Titular:* {{client.fullName}} ({{client.nationalId}})\n" +
        "📍 *Nueva dirección:* {{relocationDetails.newAddress}}\n" +
        "🏡 *Referencias:* {{relocationDetails.references}}\n" +
        "🗺️ *Ubicación:* {{relocationDetails.mapLocation}}\n\n" +
        "Un asesor del departamento de traslados revisará la disponibilidad técnica y se contactará contigo para coordinar la visita. 🚚✨",
    },
  };
}
