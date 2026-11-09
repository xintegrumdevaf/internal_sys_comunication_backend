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
  matchType: "option" | "contract_code" | "sector" | "label" | "address" | "name" | "coincidence" | "none";
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
  "oficna",
  "casa",
  "casita",
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
 * Distancia de Levenshtein entre dos cadenas para detectar erratas y variaciones de caracteres.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = new Array<number>(b.length + 1);
  let currRow = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prevRow[j] = j;

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1]! + 1,
        prevRow[j]! + 1,
        prevRow[j - 1]! + cost,
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[b.length]!;
}

/**
 * Coeficiente de Dice sobre bigramas de caracteres.
 * Captura similitud morfológica y transposiciones de letras sin requerir orden rígido.
 */
export function diceBigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const bgA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bgA.set(bg, (bgA.get(bg) ?? 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bgA.get(bg);
    if (count && count > 0) {
      intersection++;
      bgA.set(bg, count - 1);
    }
  }

  const total = a.length - 1 + (b.length - 1);
  return total > 0 ? (2 * intersection) / total : 0;
}

/**
 * Coincidencia de caracteres combinada entre dos términos (0.0 a 1.0).
 */
export function calculateCharacterSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const levSim = 1 - levenshteinDistance(a, b) / maxLen;
  const diceSim = diceBigramSimilarity(a, b);
  return Math.max(levSim, diceSim);
}

/**
 * Resuelve qué contrato de la lista de pendientes corresponde a la respuesta
 * del usuario analizando coincidencia de caracteres y similitud semántica.
 * No realiza búsquedas rígidas tipo base de datos, sino que pondera coincidencia
 * de sectores, direcciones, inmuebles, códigos y opciones.
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

  // 4. Análisis de coincidencia de caracteres sobre tokens significativos
  const candidateScores = pending.map((c, idx) => {
    let score = 0;
    let bestReason: DisambiguationResult["matchType"] = "none";

    const textTokens = normText
      .split(/[\s,\.\-\/]+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

    const entityTokens = [
      typeof entities?.address === "string" ? entities.address : "",
      typeof entities?.sector === "string" ? entities.sector : "",
      typeof entities?.location === "string" ? entities.location : "",
    ]
      .join(" ")
      .split(/[\s,\.\-\/]+/)
      .map((t) => normalizeDisambiguationString(t))
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

    const userTokens = Array.from(new Set([...textTokens, ...entityTokens]));

    // A. Coincidencia por Sector (con tolerancia a erratas mediante calculateCharacterSimilarity)
    if (c.sector) {
      const normSector = normalizeDisambiguationString(c.sector);
      const entitySector = typeof entities?.sector === "string" ? normalizeDisambiguationString(entities.sector) : "";
      if (entitySector) {
        const sim = calculateCharacterSimilarity(entitySector, normSector);
        if (sim >= 0.70) {
          score += 12 * sim;
          bestReason = "sector";
        }
      }
      for (const token of userTokens) {
        const sim = calculateCharacterSimilarity(token, normSector);
        if (sim >= 0.75) {
          score += 10 * sim;
          bestReason = "sector";
        }
      }
      if (normText.length >= 3 && normText.includes(normSector)) {
        score += 8;
        bestReason = "sector";
      }
    }

    // B. Coincidencia por Etiquetas y Tipo de Inmueble (Casa, Oficina, Local, Depa)
    const normLabel = c.label ? normalizeDisambiguationString(c.label) : "";
    const normAddr = c.address ? normalizeDisambiguationString(c.address) : "";

    for (const keyword of BUILDING_KEYWORDS) {
      const mentionsKeyword = normText.includes(keyword) || (typeof entities?.address === "string" && normalizeDisambiguationString(entities.address).includes(keyword));
      if (mentionsKeyword) {
        // Tolerancia morfológica: casita -> casa, oficna -> oficina
        const isHouse = keyword.startsWith("cas") && (normLabel.includes("casa") || normAddr.includes("casa"));
        const isOffice = keyword.startsWith("ofi") && (normLabel.includes("oficina") || normAddr.includes("oficina"));
        const isLocal = keyword.startsWith("loc") && (normLabel.includes("local") || normAddr.includes("local"));
        const isDepa = (keyword.includes("depa") || keyword.includes("departamento")) && (normLabel.includes("dep") || normAddr.includes("dep"));

        if (isHouse || isOffice || isLocal || isDepa || normLabel.includes(keyword) || normAddr.includes(keyword)) {
          score += 8;
          if (bestReason === "none") bestReason = "label";
        }
      }
    }

    // C. Coincidencia por Tokens y Calles de Dirección
    const addrTokens = (c.address ?? "")
      .split(/[\s,\.\-\/]+/)
      .map((t) => normalizeDisambiguationString(t))
      .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));

    for (const uToken of userTokens) {
      for (const aToken of addrTokens) {
        const sim = calculateCharacterSimilarity(uToken, aToken);
        if (sim >= 0.75) {
          score += 8 * sim;
          if (bestReason === "none") bestReason = "address";
        }
      }
    }

    // Frase continua en la dirección
    if (c.address && c.address.length >= 6) {
      const normCandidateAddr = normalizeDisambiguationString(c.address);
      if (normText.includes(normCandidateAddr) || normCandidateAddr.includes(normText)) {
        score += 8;
        if (bestReason === "none") bestReason = "address";
      }
    }

    // D. Coincidencia por Nombre
    const entityFullName = typeof entities?.fullName === "string" ? normalizeDisambiguationString(entities.fullName) : "";
    if (c.name && entityFullName.length >= 4) {
      const sim = calculateCharacterSimilarity(entityFullName, normalizeDisambiguationString(c.name));
      if (sim >= 0.8) {
        score += 6 * sim;
        if (bestReason === "none") bestReason = "name";
      }
    }

    return { index: idx, score, bestReason };
  });

  const maxScore = Math.max(...candidateScores.map((s) => s.score));
  if (maxScore >= 5.0) {
    const topScorers = candidateScores.filter((s) => s.score === maxScore);
    if (topScorers.length === 1) {
      const winner = topScorers[0]!;
      const secondScore = Math.max(
        0,
        ...candidateScores.filter((s) => s.index !== winner.index).map((s) => s.score),
      );
      // Para salir de confusiones: el ganador debe superar con margen al segundo lugar
      if (winner.score - secondScore >= 2.0 || secondScore === 0) {
        return {
          matched: pending[winner.index],
          index: winner.index,
          matchType: winner.bestReason !== "none" ? winner.bestReason : "coincidence",
          confidence: Math.min(0.95, 0.75 + (winner.score / 20) * 0.2),
        };
      }
    }
  }

  return { index: -1, matchType: "none", confidence: 0 };
}
