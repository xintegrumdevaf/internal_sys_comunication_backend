/**
 * Valoración final y review textual al completar todos los tramos
 * (07_QUALITY_SUPERVISION.md §4.3 / §5).
 */

export type FindingForFinalReview = {
  severity: "low" | "medium" | "high";
  category: string;
  excerpt: string;
  rationale: string;
};

export function averageChunkScore(scores: number[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((a, b) => a + b, 0);
  return Math.round(sum / scores.length);
}

export function cordialityBandLabelEs(score: number): string {
  if (score >= 70) return "cordial";
  if (score >= 40) return "requiere atención";
  return "crítica";
}

const CATEGORY_ES: Record<string, string> = {
  aggression: "Agresividad",
  disrespect: "Falta de respeto",
  neglect: "Abandono / descuido",
  misinformation: "Información incorrecta",
  inefficiency: "Ineficiencia",
  other: "Otro",
};

/**
 * Review final: score total + fallos destacados + síntesis de tramos.
 * Determinista (sin llamada extra a la IA).
 */
export function buildFinalQualityReview(input: {
  cordialityScore: number;
  messagesTotal: number;
  chunkCount: number;
  findings: FindingForFinalReview[];
  chunkSummaries: string[];
  efficiencyNotes: string | null;
}): string {
  const band = cordialityBandLabelEs(input.cordialityScore);
  const high = input.findings.filter((f) => f.severity === "high");
  const medium = input.findings.filter((f) => f.severity === "medium");
  const lines: string[] = [
    `Valoración total: ${input.cordialityScore}/100 (${band}).`,
    `Conversación completa: ${input.messagesTotal} mensaje(s) en ${input.chunkCount} tramo(s).`,
  ];

  if (high.length === 0 && medium.length === 0) {
    lines.push("Sin fallos graves ni medios detectados en los mensajes analizados.");
  } else {
    if (high.length > 0) {
      lines.push("");
      lines.push(`Fallos graves (${high.length}):`);
      for (const f of high.slice(0, 8)) {
        const cat = CATEGORY_ES[f.category] ?? f.category;
        lines.push(`- [${cat}] «${f.excerpt}» — ${f.rationale}`);
      }
    }
    if (medium.length > 0) {
      lines.push("");
      lines.push(`Puntos a mejorar (${medium.length}):`);
      for (const f of medium.slice(0, 6)) {
        const cat = CATEGORY_ES[f.category] ?? f.category;
        lines.push(`- [${cat}] «${f.excerpt}» — ${f.rationale}`);
      }
    }
  }

  if (input.efficiencyNotes?.trim()) {
    lines.push("");
    lines.push(`Eficiencia: ${input.efficiencyNotes.trim()}`);
  }

  const usefulSummaries = input.chunkSummaries.map((s) => s.trim()).filter(Boolean);
  if (usefulSummaries.length > 0) {
    lines.push("");
    lines.push("Síntesis por tramos:");
    usefulSummaries.forEach((s, i) => {
      lines.push(`${i + 1}. ${s}`);
    });
  }

  return lines.join("\n").trim();
}

export function mergeQualityFindings<
  T extends { messageId: string; category: string; severity: string },
>(existing: T[], incoming: T[]): T[] {
  const key = (f: T) => `${f.messageId}:${f.category}`;
  const byKey = new Map<string, T>();
  for (const f of existing) byKey.set(key(f), f);
  for (const f of incoming) {
    const k = key(f);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, f);
      continue;
    }
    // Conservar la severidad más grave.
    const rank = { low: 1, medium: 2, high: 3 } as Record<string, number>;
    if ((rank[f.severity] ?? 0) > (rank[prev.severity] ?? 0)) {
      byKey.set(k, f);
    }
  }
  return [...byKey.values()];
}
