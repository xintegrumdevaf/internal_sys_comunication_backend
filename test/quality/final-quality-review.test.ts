import { describe, expect, it } from "vitest";
import {
  averageChunkScore,
  buildFinalQualityReview,
  mergeQualityFindings,
} from "../../src/core/modules/quality/domain/final-quality-review";

describe("final-quality-review", () => {
  it("promedia scores de tramos", () => {
    expect(averageChunkScore([40, 60, 80])).toBe(60);
    expect(averageChunkScore([])).toBe(0);
  });

  it("fusiona findings sin duplicar messageId+category", () => {
    const merged = mergeQualityFindings(
      [
        {
          messageId: "m1",
          category: "neglect",
          severity: "medium",
          excerpt: "a",
          rationale: "r1",
        },
      ],
      [
        {
          messageId: "m1",
          category: "neglect",
          severity: "high",
          excerpt: "b",
          rationale: "r2",
        },
        {
          messageId: "m2",
          category: "aggression",
          severity: "low",
          excerpt: "c",
          rationale: "r3",
        },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((f) => f.messageId === "m1")?.severity).toBe("high");
  });

  it("arma valoración total remarcando fallos", () => {
    const text = buildFinalQualityReview({
      cordialityScore: 35,
      messagesTotal: 90,
      chunkCount: 3,
      findings: [
        {
          severity: "high",
          category: "neglect",
          excerpt: "mmm no sé",
          rationale: "Abandono de la consulta",
        },
      ],
      chunkSummaries: ["Tramo 1 breve", "Tramo 2 peor"],
      efficiencyNotes: "Muchas vueltas",
    });
    expect(text).toContain("Valoración total: 35/100");
    expect(text).toContain("crítica");
    expect(text).toContain("90 mensaje");
    expect(text).toContain("Fallos graves");
    expect(text).toContain("mmm no sé");
    expect(text).toContain("Síntesis por tramos");
  });
});
