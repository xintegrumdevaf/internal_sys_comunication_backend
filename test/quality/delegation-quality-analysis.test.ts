import { describe, expect, it } from "vitest";
import { EnqueueQualityReviewService } from "../../src/core/modules/quality/application/services/enqueue-quality-review.service";
import { RunQualityAnalysisUseCase } from "../../src/core/modules/quality/application/use-cases/run-quality-analysis.use-case";
import { QualityReviewRepositoryFake } from "./fakes";
import { CaseRepositoryFake } from "../cases/fakes";
import { MessageRepositoryFake } from "../support/fakes";
import { silentLogger } from "../support/silent-logger";
import type { AIProviderPort, AnalyzeAgentConversationInput, QualityAnalysis } from "../../src/core/modules/ai/application/ports/ai-provider.port";

class MockAIProvider implements Partial<AIProviderPort> {
  receivedInputs: AnalyzeAgentConversationInput[] = [];

  async analyzeAgentConversation(input: AnalyzeAgentConversationInput): Promise<QualityAnalysis> {
    this.receivedInputs.push(input);
    return {
      cordialityScore: 85,
      summary: `Atención precisa de ${input.agentId}`,
      findings: [
        {
          messageId: input.messages[0]!.messageId,
          severity: "low",
          category: "other",
          excerpt: "ejemplo",
          rationale: "Falta leve",
          recommendation: "«Respuesta mejorada»",
        },
      ],
    };
  }
}

describe("Delegated Multi-Agent Quality Supervision", () => {
  it("encola y analiza reviews de calidad separadas por agente en casos transferidos", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const caseRepo = new CaseRepositoryFake();
    const aiProvider = new MockAIProvider();

    const runQualityAnalysis = new RunQualityAnalysisUseCase({
      qualityRepo,
      messageRepo,
      aiProvider: aiProvider as unknown as AIProviderPort,
      logger: silentLogger,
      chunkSize: 40,
    });

    const enqueueService = new EnqueueQualityReviewService({
      qualityRepo,
      messageRepo,
      runQualityAnalysis,
      logger: silentLogger,
      chunkSize: 40,
    });

    const agent1 = "agent-111";
    const agent2 = "agent-222";
    const conversationId = "conv-multi";

    const { case: caseEntity } = await caseRepo.create({
      conversationId,
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-1",
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "DIAGNOSTIC",
      expiresAt: null,
    });

    // Mensajes: Agente 1 atiende primero
    const m1 = messageRepo.seedText(conversationId, "Hola, no tengo servicio", {
      caseId: caseEntity.id,
      author: "customer",
    });
    const m2 = messageRepo.seedText(conversationId, "Espere que reviso", {
      caseId: caseEntity.id,
      author: "agent",
      agentId: agent1,
    });

    // Delegación a Agente 2
    const m3 = messageRepo.seedText(conversationId, "Hola, tomo tu caso de nivel 2", {
      caseId: caseEntity.id,
      author: "agent",
      agentId: agent2,
    });
    const m4 = messageRepo.seedText(conversationId, "Gracias, quedó solucionado!", {
      caseId: caseEntity.id,
      author: "customer",
    });

    // Cierre de caso: se encola auto-review
    await enqueueService.tryAutoEnqueue(caseEntity);

    // Deben existir 2 reviews encoladas (una por agente)
    const reviews = await qualityRepo.list({});
    expect(reviews).toHaveLength(2);

    const review1 = reviews.find((r) => r.agentId === agent1)!;
    const review2 = reviews.find((r) => r.agentId === agent2)!;
    expect(review1).toBeDefined();
    expect(review2).toBeDefined();

    // Ejecutar análisis para Agente 1 (recibe fragmento m1 + m2)
    await runQualityAnalysis.execute(review1.id);
    const input1 = aiProvider.receivedInputs.find((i) => i.agentId === agent1)!;
    expect(input1.messages.map((m) => m.messageId)).toEqual([m1.id, m2.id]);

    // Ejecutar análisis para Agente 2 (recibe fragmento m3 + m4)
    await runQualityAnalysis.execute(review2.id);
    const input2 = aiProvider.receivedInputs.find((i) => i.agentId === agent2)!;
    expect(input2.messages.map((m) => m.messageId)).toEqual([m3.id, m4.id]);
  });
});
