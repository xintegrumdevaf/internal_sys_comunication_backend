import { z } from "zod";
import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AIProviderPort, QualityAnalysis } from "../../../ai/application/ports/ai-provider.port";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";
import {
  averageChunkScore,
  buildFinalQualityReview,
  mergeQualityFindings,
} from "../../domain/final-quality-review";
import type { QualityReviewDetail } from "../ports/quality-review.repository.port";
import type { QualityReviewRepositoryPort } from "../ports/quality-review.repository.port";

const BODY_TRUNCATE = 800;

type ChunkModelRaw = {
  chunkScores: number[];
  chunkSummaries: string[];
  lastChunkFindings?: QualityAnalysis["findings"];
  efficiencyNotes?: string | null;
};

export const qualityAnalysisSchema = z.object({
  cordialityScore: z.number().int().min(0).max(100),
  summary: z.string().min(1),
  efficiencyNotes: z.string().nullable().optional(),
  findings: z
    .array(
      z.object({
        messageId: z.string().min(1),
        severity: z.enum(["low", "medium", "high"]),
        category: z.enum([
          "aggression",
          "disrespect",
          "neglect",
          "misinformation",
          "inefficiency",
          "other",
        ]),
        excerpt: z.string().min(1),
        rationale: z.string().min(1),
      }),
    )
    .default([]),
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readChunkRaw(raw: unknown): ChunkModelRaw {
  if (!raw || typeof raw !== "object") {
    return { chunkScores: [], chunkSummaries: [] };
  }
  const obj = raw as Record<string, unknown>;
  const scores = Array.isArray(obj.chunkScores)
    ? obj.chunkScores.filter((n): n is number => typeof n === "number")
    : [];
  const summaries = Array.isArray(obj.chunkSummaries)
    ? obj.chunkSummaries.filter((s): s is string => typeof s === "string")
    : [];
  return {
    chunkScores: scores,
    chunkSummaries: summaries,
    efficiencyNotes: typeof obj.efficiencyNotes === "string" ? obj.efficiencyNotes : null,
  };
}

/**
 * Ejecuta un tramo de analisis IA (07_QUALITY_SUPERVISION.md §4.3–4.4).
 * Mientras messages_analyzed < messages_total permanece pending y el worker
 * reclama el siguiente tramo. Al completar: valoracion total + review final.
 */
export class RunQualityAnalysisUseCase {
  constructor(
    private readonly deps: {
      qualityRepo: QualityReviewRepositoryPort;
      messageRepo: MessageRepositoryPort;
      aiProvider: AIProviderPort;
      logger: Logger;
      /** Default si la review no trae chunk_size (env QUALITY_ANALYSIS_CHUNK_SIZE). */
      chunkSize?: number;
    },
  ) {}

  async execute(reviewId: string): Promise<QualityReviewDetail | null> {
    const detail = await this.deps.qualityRepo.findById(reviewId);
    if (!detail) {
      this.deps.logger.warn({ reviewId }, "quality_review no encontrada para analizar");
      return null;
    }
    if (detail.review.status !== "pending") {
      return detail;
    }

    const allMessages = await this.deps.messageRepo.listByCaseAuthors(detail.review.caseId, [
      "customer",
      "agent",
    ]);

    const chunkSize = Math.min(
      80,
      Math.max(10, detail.review.chunkSize || this.deps.chunkSize || 40),
    );
    const messagesTotal =
      detail.review.messagesTotal > 0 ? detail.review.messagesTotal : allMessages.length;
    let messagesAnalyzed = detail.review.messagesAnalyzed;

    if (messagesTotal === 0) {
      await this.deps.qualityRepo.markFailed(reviewId, "Sin mensajes customer/agent para analizar");
      return this.deps.qualityRepo.findById(reviewId);
    }

    // Si el caso creció o el contador quedó desfasado, no pasar del total real.
    if (messagesAnalyzed > allMessages.length) {
      messagesAnalyzed = allMessages.length;
    }

    if (messagesAnalyzed >= messagesTotal || messagesAnalyzed >= allMessages.length) {
      // Nada pendiente: cerrar con lo acumulado (edge de reintento).
      return this.finalizeFromExisting(detail, chunkSize, messagesTotal, messagesAnalyzed);
    }

    const chunk = allMessages.slice(messagesAnalyzed, messagesAnalyzed + chunkSize);
    const messageIds = new Set(chunk.map((m) => m.id));

    this.deps.logger.info(
      {
        reviewId,
        messagesTotal,
        messagesAnalyzed,
        chunkSize: chunk.length,
        configuredChunkSize: chunkSize,
      },
      "analizando tramo de calidad",
    );

    const aiInput = {
      correlationId: reviewId,
      conversationId: detail.review.conversationId,
      caseId: detail.review.caseId,
      agentId: detail.review.agentId,
      messages: chunk.map((m) => ({
        messageId: m.id,
        author: m.author as "customer" | "agent",
        body: m.body.length > BODY_TRUNCATE ? `${m.body.slice(0, BODY_TRUNCATE)}…` : m.body,
        createdAt: m.createdAt.toISOString(),
      })),
    };

    let analysis: QualityAnalysis | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await this.deps.aiProvider.analyzeAgentConversation(aiInput);
        const parsed = qualityAnalysisSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`Zod rechazo analisis: ${parsed.error.message}`);
        }
        analysis = {
          cordialityScore: parsed.data.cordialityScore,
          summary: parsed.data.summary,
          efficiencyNotes: parsed.data.efficiencyNotes ?? undefined,
          findings: parsed.data.findings,
        };
        break;
      } catch (error) {
        lastError = error;
        this.deps.logger.warn(
          { reviewId, attempt, err: error instanceof Error ? error.message : String(error) },
          "intento de analisis de calidad fallido",
        );
        if (error instanceof DomainError && error.type === "TIMEOUT") {
          break;
        }
      }
    }

    if (!analysis) {
      const msg =
        lastError instanceof Error ? lastError.message : String(lastError ?? "analisis fallido");
      await this.deps.qualityRepo.markFailed(reviewId, msg);
      this.deps.logger.warn(
        { reviewId, err: msg },
        "quality_review marcada failed tras reintento",
      );
      return this.deps.qualityRepo.findById(reviewId);
    }

    const filteredFindings = analysis.findings.filter(
      (f) => UUID_RE.test(f.messageId) && messageIds.has(f.messageId),
    );
    const discarded = analysis.findings.length - filteredFindings.length;
    if (discarded > 0) {
      this.deps.logger.info(
        { reviewId, discarded },
        "findings con messageId invalido o desconocido descartados",
      );
    }

    const prevRaw = readChunkRaw(detail.review.modelRaw);
    const chunkScores = [...prevRaw.chunkScores, analysis.cordialityScore];
    const chunkSummaries = [...prevRaw.chunkSummaries, analysis.summary];
    const efficiencyNotes =
      analysis.efficiencyNotes?.trim() ||
      detail.review.efficiencyNotes ||
      prevRaw.efficiencyNotes ||
      null;

    const existingForMerge = detail.findings.map((f) => ({
      messageId: f.messageId,
      severity: f.severity,
      category: f.category,
      excerpt: f.excerpt,
      rationale: f.rationale,
    }));
    const mergedFindings = mergeQualityFindings(existingForMerge, filteredFindings);
    const newAnalyzed = messagesAnalyzed + chunk.length;
    const total = Math.max(messagesTotal, allMessages.length);
    const complete = newAnalyzed >= total;
    const provisionalScore = averageChunkScore(chunkScores);

    const modelRaw: ChunkModelRaw & { findings: typeof mergedFindings } = {
      chunkScores,
      chunkSummaries,
      efficiencyNotes,
      findings: mergedFindings,
      lastChunkFindings: filteredFindings,
    };

    if (!complete) {
      const partialSummary = [
        `Progreso: ${newAnalyzed}/${total} mensajes (${chunkScores.length} tramo(s)).`,
        `Score provisional: ${provisionalScore}/100.`,
        analysis.summary,
      ].join(" ");

      return this.deps.qualityRepo.saveChunkProgress(reviewId, {
        messagesTotal: total,
        messagesAnalyzed: newAnalyzed,
        chunkSize,
        provisionalScore,
        efficiencyNotes,
        summary: partialSummary,
        modelRaw,
        findings: mergedFindings,
      });
    }

    const finalScore = provisionalScore;
    const finalSummary = buildFinalQualityReview({
      cordialityScore: finalScore,
      messagesTotal: total,
      chunkCount: chunkScores.length,
      findings: mergedFindings,
      chunkSummaries,
      efficiencyNotes,
    });

    this.deps.logger.info(
      { reviewId, finalScore, messagesTotal: total, chunks: chunkScores.length },
      "valoracion total de calidad lista",
    );

    return this.deps.qualityRepo.markReady(reviewId, {
      cordialityScore: finalScore,
      efficiencyNotes,
      summary: finalSummary,
      modelRaw: {
        ...modelRaw,
        cordialityScore: finalScore,
        summary: finalSummary,
      },
      findings: mergedFindings,
      messagesTotal: total,
      messagesAnalyzed: newAnalyzed,
      chunkSize,
    });
  }

  private async finalizeFromExisting(
    detail: QualityReviewDetail,
    chunkSize: number,
    messagesTotal: number,
    messagesAnalyzed: number,
  ): Promise<QualityReviewDetail> {
    const prevRaw = readChunkRaw(detail.review.modelRaw);
    const findings = detail.findings.map((f) => ({
      messageId: f.messageId,
      severity: f.severity,
      category: f.category,
      excerpt: f.excerpt,
      rationale: f.rationale,
    }));
    const scores =
      prevRaw.chunkScores.length > 0
        ? prevRaw.chunkScores
        : detail.review.cordialityScore !== null
          ? [detail.review.cordialityScore]
          : [0];
    const finalScore = averageChunkScore(scores);
    const efficiencyNotes = detail.review.efficiencyNotes ?? prevRaw.efficiencyNotes ?? null;
    const finalSummary = buildFinalQualityReview({
      cordialityScore: finalScore,
      messagesTotal,
      chunkCount: scores.length,
      findings,
      chunkSummaries: prevRaw.chunkSummaries,
      efficiencyNotes,
    });
    return this.deps.qualityRepo.markReady(detail.review.id, {
      cordialityScore: finalScore,
      efficiencyNotes,
      summary: finalSummary,
      modelRaw: {
        chunkScores: scores,
        chunkSummaries: prevRaw.chunkSummaries,
        efficiencyNotes,
        findings,
        cordialityScore: finalScore,
        summary: finalSummary,
      },
      findings,
      messagesTotal,
      messagesAnalyzed: Math.max(messagesAnalyzed, messagesTotal),
      chunkSize,
    });
  }
}
