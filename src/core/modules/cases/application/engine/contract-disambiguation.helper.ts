export type DisambiguationContractCandidate = {
  id: string;
  contractCode?: string;
  name?: string;
  address?: string;
  label?: string;
  sector?: string;
  oltName?: string;
  pon?: string;
  serial?: string;
  ip?: string;
};

export type DisambiguationResult<T extends DisambiguationContractCandidate = DisambiguationContractCandidate> = {
  matched?: T;
  index: number;
  matchType: "option" | "contract_code" | "sector" | "label" | "address" | "name" | "none";
  confidence: number;
};

const STOP_WORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "en", "para", "por", "con",
  "que", "es", "mi", "mis", "tu", "su", "sus", "esta", "este", "favor", "gracias", "porfa",
  "servicio", "contrato", "internet", "calle", "avenida", "av", "numero", "lote", "barrio",
  "sector", "opcion", "opciones", "ayuda", "falla", "reporte", "problema", "tengo", "esta",
]);

const BUILDING_KEYWORDS = [
  "oficina",
  "casa",
  "local",
  "departamento",
  "depa",
  "negocio",
  "taller",
  "bodega",
  "quinta",
  "piso 1",
  "piso 2",
  "piso 3",
  "planta baja",
];

export function normalizeDisambiguationString(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Resuelve qué contrato de la lista de pendientes corresponde a la respuesta
 * del usuario (número de opción, ordinal, código de contrato, sector, dirección o nombre).
 */
export function resolveContractDisambiguation<T extends DisambiguationContractCandidate>(params: {
  pending: T[];
  text?: string;
  entities?: Record<string, unknown>;
}): DisambiguationResult<T> {
  const { pending, text, entities } = params;
  if (!pending || pending.length === 0) {
    return { index: -1, matchType: "none", confidence: 0 };
  }

  const rawText = text?.trim() ?? "";
  const normText = normalizeDisambiguationString(rawText);

  // 1. Coincidencia por opción ordinal o índice numérico (1, 2, "el primero", etc.)
  const rawOption = entities?.selectedOption;
  let selectedIndex = -1;
  if (typeof rawOption === "number" && Number.isInteger(rawOption)) {
    selectedIndex = rawOption - 1;
  } else if (typeof rawOption === "string") {
    const parsed = parseInt(rawOption.trim(), 10);
    if (!Number.isNaN(parsed)) selectedIndex = parsed - 1;
  }

  // Si selectedOption vino como un número de contrato grande (> pending.length), verificar si coincide con un ID/código
  if (selectedIndex >= pending.length) {
    const numericStr = String(rawOption).trim();
    const foundById = pending.findIndex(
      (c) => c.id === numericStr || (c.contractCode && c.contractCode === numericStr),
    );
    if (foundById >= 0) {
      return {
        matched: pending[foundById],
        index: foundById,
        matchType: "contract_code",
        confidence: 1.0,
      };
    }
  }

  // 2. Coincidencia por código de contrato o ID explícito (en entities o en el texto libre)
  const entityCode =
    typeof entities?.contractCode === "string"
      ? normalizeDisambiguationString(entities.contractCode)
      : typeof entities?.contractId === "string"
        ? normalizeDisambiguationString(entities.contractId)
        : "";

  if (entityCode) {
    const idx = pending.findIndex(
      (c) =>
        normalizeDisambiguationString(c.id) === entityCode ||
        (c.contractCode && normalizeDisambiguationString(c.contractCode) === entityCode) ||
        normalizeDisambiguationString(c.id).includes(entityCode),
    );
    if (idx >= 0) {
      return {
        matched: pending[idx],
        index: idx,
        matchType: "contract_code",
        confidence: 0.98,
      };
    }
  }

  // Comprobar si el texto menciona explícitamente algún contractCode o ID de la lista
  if (normText.length > 0) {
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]!;
      const normId = normalizeDisambiguationString(c.id);
      const normContractCode = c.contractCode ? normalizeDisambiguationString(c.contractCode) : "";

      // Si el ID tiene al menos 3 dígitos y aparece delimitado por palabras o prefijos
      if (normId.length >= 3) {
        const idRegex = new RegExp(`(?:#|contrato\\s*#?|id\\s*#?)?\\b${normId}\\b`, "i");
        if (idRegex.test(normText)) {
          return {
            matched: c,
            index: i,
            matchType: "contract_code",
            confidence: 1.0,
          };
        }
      }
      if (normContractCode && normContractCode.length >= 3) {
        const codeRegex = new RegExp(`(?:#|contrato\\s*#?|codigo\\s*#?)?\\b${normContractCode}\\b`, "i");
        if (codeRegex.test(normText)) {
          return {
            matched: c,
            index: i,
            matchType: "contract_code",
            confidence: 1.0,
          };
        }
      }
    }
  }

  // 3. Coincidencia por número / opción ordinal textual en normText
  if (selectedIndex < 0 && normText.length > 0) {
    if (
      /\b(?:el\s+|la\s+)?(?:primero|primera|1ro|1ra|primer)\b/i.test(normText) ||
      /\bopci[oó]n\s*#?1\b/i.test(normText)
    ) {
      selectedIndex = 0;
    } else if (
      /\b(?:el\s+|la\s+)?(?:segundo|segunda|2do|2da)\b/i.test(normText) ||
      /\bopci[oó]n\s*#?2\b/i.test(normText)
    ) {
      selectedIndex = 1;
    } else if (
      /\b(?:el\s+|la\s+)?(?:tercero|tercera|3ro|3ra|tercer)\b/i.test(normText) ||
      /\bopci[oó]n\s*#?3\b/i.test(normText)
    ) {
      selectedIndex = 2;
    } else {
      const digitMatch =
        normText.match(/^(?:option_|opci[oó]n\s*#?|el\s+|la\s+|n[uú]mero\s*#?|contrato\s*#?)?\s*([1-9]\d*)(?:[\.\-\:\s]|$|\b)/i) ||
        normText.match(/\bopci[oó]n\s*#?([1-9]\d*)\b/i) ||
        normText.match(/^([1-9]\d*)\b/);
      if (digitMatch && digitMatch[1]) {
        const num = parseInt(digitMatch[1], 10);
        if (num <= pending.length) {
          selectedIndex = num - 1;
        }
      }
    }
  }

  if (selectedIndex >= 0 && selectedIndex < pending.length) {
    return {
      matched: pending[selectedIndex],
      index: selectedIndex,
      matchType: "option",
      confidence: 1.0,
    };
  }

  // 4. Coincidencia por Sector o Ubicación
  const entitySector =
    typeof entities?.sector === "string"
      ? normalizeDisambiguationString(entities.sector)
      : typeof entities?.location === "string"
        ? normalizeDisambiguationString(entities.location)
        : "";

  const sectorMatches: number[] = [];
  pending.forEach((c, idx) => {
    if (!c.sector) return;
    const normSector = normalizeDisambiguationString(c.sector);
    if (normSector.length < 3) return;

    if (entitySector && (normSector.includes(entitySector) || entitySector.includes(normSector))) {
      sectorMatches.push(idx);
    } else if (normText.length >= 3 && normText.includes(normSector)) {
      sectorMatches.push(idx);
    }
  });

  if (sectorMatches.length === 1) {
    const idx = sectorMatches[0]!;
    return {
      matched: pending[idx],
      index: idx,
      matchType: "sector",
      confidence: 0.95,
    };
  }

  // 5. Coincidencia por Etiquetas o Tipo de Inmueble (Casa, Oficina, Local, Depa)
  for (const keyword of BUILDING_KEYWORDS) {
    if (
      normText.includes(keyword) ||
      (typeof entities?.address === "string" && normalizeDisambiguationString(entities.address).includes(keyword))
    ) {
      const labelMatches: number[] = [];
      pending.forEach((c, idx) => {
        const normLabel = c.label ? normalizeDisambiguationString(c.label) : "";
        const normAddr = c.address ? normalizeDisambiguationString(c.address) : "";
        if (normLabel.includes(keyword) || normAddr.includes(keyword)) {
          labelMatches.push(idx);
        }
      });
      if (labelMatches.length === 1) {
        const idx = labelMatches[0]!;
        return {
          matched: pending[idx],
          index: idx,
          matchType: "label",
          confidence: 0.9,
        };
      }
    }
  }

  // 6. Coincidencia por Tokens y Calles de Dirección
  const entityAddr =
    typeof entities?.address === "string" ? normalizeDisambiguationString(entities.address) : "";
  const addressQuery = entityAddr || normText;

  if (addressQuery.length >= 4) {
    const queryTokens = addressQuery
      .split(/[\s,\.\-\/]+/)
      .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));

    if (queryTokens.length > 0) {
      const scores = pending.map((c) => {
        const candidateAddr = normalizeDisambiguationString(
          `${c.address ?? ""} ${c.label ?? ""} ${c.sector ?? ""}`,
        );
        let score = 0;
        for (const token of queryTokens) {
          if (candidateAddr.includes(token)) {
            score += 1;
          }
        }
        if (c.address && c.address.length >= 6) {
          const normCandidateAddr = normalizeDisambiguationString(c.address);
          if (normText.includes(normCandidateAddr) || normCandidateAddr.includes(normText)) {
            score += 3;
          }
        }
        return score;
      });

      const maxScore = Math.max(...scores);
      if (maxScore > 0) {
        const topIndices = scores
          .map((score, idx) => (score === maxScore ? idx : -1))
          .filter((idx) => idx >= 0);
        if (topIndices.length === 1) {
          const idx = topIndices[0]!;
          return {
            matched: pending[idx],
            index: idx,
            matchType: "address",
            confidence: 0.85,
          };
        }
      }
    }
  }

  // 7. Coincidencia por Nombre Completo del Titular
  const entityFullName =
    typeof entities?.fullName === "string"
      ? normalizeDisambiguationString(entities.fullName)
      : "";
  if (entityFullName.length >= 4) {
    const nameMatches = pending
      .map((c, idx) => (c.name && normalizeDisambiguationString(c.name).includes(entityFullName) ? idx : -1))
      .filter((idx) => idx >= 0);
    if (nameMatches.length === 1) {
      const idx = nameMatches[0]!;
      return {
        matched: pending[idx],
        index: idx,
        matchType: "name",
        confidence: 0.85,
      };
    }
  }

  return { index: -1, matchType: "none", confidence: 0 };
}
