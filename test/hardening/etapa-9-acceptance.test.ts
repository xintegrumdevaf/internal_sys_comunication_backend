import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { env } from "../../src/shared/config/env";
import { InboundBufferService } from "../../src/core/modules/ingestion/application/services/inbound-buffer.service";
import { ProcessBufferedMessagesUseCase } from "../../src/core/modules/cases/application/use-cases/process-buffered-messages.use-case";
import { AdvanceCaseUseCase } from "../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { CaseArbitrationService } from "../../src/core/modules/cases/application/services/case-arbitration.service";
import { DepartmentResolverService } from "../../src/core/modules/cases/application/services/department-resolver.service";
import { WorkflowEngine } from "../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import { InstrumentedN8nGateway } from "../../src/core/modules/cases/application/gateway/instrumented-n8n-gateway";
import { N8nGatewayHttp } from "../../src/core/modules/cases/infrastructure/n8n/n8n-gateway.http";
import { N8nWorkflowRegistryCache } from "../../src/core/modules/cases/application/services/n8n-workflow-registry-cache.service";
import { AiInterpretationAdapter } from "../../src/core/modules/cases/infrastructure/ai/ai-interpretation.adapter";
import { ComposeCustomerReplyUseCase } from "../../src/core/modules/ai/application/use-cases/compose-customer-reply.use-case";
import { TranscribeAudioUseCase } from "../../src/core/modules/ai/application/use-cases/transcribe-audio.use-case";
import { ExtractReceiptDataUseCase } from "../../src/core/modules/ai/application/use-cases/extract-receipt-data.use-case";
import { FakeAIProvider } from "../../src/core/modules/ai/infrastructure/fake/fake-ai.provider";
import {
  CaseRepositoryFake,
  N8nGatewayFake,
  N8nWorkflowRegistryRepositoryFake,
  WorkflowExecutionRepositoryFake,
} from "../cases/fakes";
import {
  ConversationRepositoryFake,
  DepartmentRepositoryFake,
  MessageRepositoryFake,
  WhatsAppSenderFake,
} from "../support/fakes";
import { createRecordingLogger } from "../support/recording-logger";
import { silentLogger } from "../support/silent-logger";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Etapa 9 endurecimiento (docs/spec/05_BUILD_PLAN.md)", () => {
  describe("observabilidad: correlationId end-to-end", () => {
    it("propaga el mismo correlationId en process-buffered → interpret → advance → n8n", async () => {
      const recording = createRecordingLogger();
      const caseRepo = new CaseRepositoryFake();
      const conversationRepo = new ConversationRepositoryFake();
      const messageRepo = new MessageRepositoryFake();
      const whatsappSender = new WhatsAppSenderFake();
      const departmentRepo = new DepartmentRepositoryFake();
      departmentRepo.seed({ slug: "support", name: "Soporte tecnico" });
      const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
      const engine = new WorkflowEngine([supportInternetWorkflow]);
      const gateway = new N8nGatewayFake({
        VALIDATE_CLIENT: () => ({
          success: true,
          result: {
            found: true,
            contractNumbers: 1,
            contracts: [
              {
                id: "1",
                name: "Ana",
                router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1" },
              },
            ],
          },
        }),
        CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
        DIAGNOSTIC: () => ({
          success: true,
          result: { status: "WAITING_USER", question: "¿ONU encendida?" },
        }),
      });

      const advanceCase = new AdvanceCaseUseCase({
        caseRepo,
        workflowExecutionRepo,
        conversationRepo,
        engine,
        gateway,
        logger: recording,
      });
      const fakeAi = new FakeAIProvider();
      fakeAi.interpretImpl = async () => ({
        type: "NEW_INTENT",
        intent: "support.internet",
        entities: { nationalId: "1205500216" },
        confidence: 0.95,
      });
      const interpretationProvider = new AiInterpretationAdapter(fakeAi, recording);
      const useCase = new ProcessBufferedMessagesUseCase({
        caseRepo,
        conversationRepo,
        messageRepo,
        whatsappSender,
        departmentResolver: new DepartmentResolverService(departmentRepo),
        arbitrationService: new CaseArbitrationService(caseRepo, recording),
        interpretationProvider,
        engine,
        advanceCase,
        composeReply: new ComposeCustomerReplyUseCase(fakeAi),
        transcribeAudio: new TranscribeAudioUseCase(fakeAi),
        extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
        logger: recording,
      });

      const conversation = conversationRepo.createOpen();
      const correlationId = "corr-etapa9-e2e";
      await useCase.execute({
        conversationId: conversation.id,
        correlationId,
        messages: [messageRepo.seedText(conversation.id, "No tengo internet, cedula 1205500216")],
      });

      const correlated = recording.linesWithCorrelation(correlationId);
      expect(correlated.length).toBeGreaterThanOrEqual(3);
      expect(correlated.some((l) => /interpret/i.test(l.message))).toBe(true);
      expect(
        correlated.some(
          (l) =>
            /n8n/i.test(l.message) ||
            l.meta.action === "VALIDATE_CLIENT" ||
            l.meta.action === "CHECK_BALANCE" ||
            l.meta.action === "DIAGNOSTIC",
        ),
      ).toBe(true);
      expect(gateway.calls.every((c) => c.correlationId === correlationId)).toBe(true);
    });
  });

  describe("carga: rafaga de mensajes", () => {
    const redisClient = new Redis(env.REDIS_URL);
    afterAll(() => {
      redisClient.disconnect();
    });

    it("una rafaga de 8 mensajes en la misma conversacion produce un solo flush", async () => {
      const conversationId = randomUUID();
      const flushes: string[][] = [];
      const buffer = new InboundBufferService(
        redisClient,
        async (_id, messageIds) => {
          flushes.push(messageIds);
        },
        { debounceMs: 120 },
        silentLogger,
      );

      await Promise.all(
        Array.from({ length: 8 }, (_, i) => buffer.push(conversationId, `burst-${i}`)),
      );
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(flushes).toHaveLength(1);
      expect(flushes[0]).toHaveLength(8);
    });

    it("dos conversaciones en paralelo no cruzan sus flushes", async () => {
      const convA = randomUUID();
      const convB = randomUUID();
      const flushes = new Map<string, string[]>();
      const buffer = new InboundBufferService(
        redisClient,
        async (conversationId, messageIds) => {
          flushes.set(conversationId, messageIds);
        },
        { debounceMs: 100 },
        silentLogger,
      );

      await Promise.all([
        buffer.push(convA, "a-1"),
        buffer.push(convA, "a-2"),
        buffer.push(convA, "a-3"),
        buffer.push(convB, "b-1"),
        buffer.push(convB, "b-2"),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(flushes.get(convA)).toEqual(["a-1", "a-2", "a-3"]);
      expect(flushes.get(convB)).toEqual(["b-1", "b-2"]);
    });
  });

  describe("idempotencyKey e2e (Instrumented + Http con reintento)", () => {
    it(
      "reintento retryable reusa la misma key y deja una sola execution COMPLETED",
      async () => {
        let attempts = 0;
        const fetchMock = vi.fn().mockImplementation(async () => {
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse({ error: "temporary" }, 503);
          }
          return jsonResponse({
            success: true,
            result: { hasDebt: false, debt: 0 },
            error: null,
          });
        });
        vi.stubGlobal("fetch", fetchMock);

        const registryRepo = new N8nWorkflowRegistryRepositoryFake();
        registryRepo.seed({
          action: "CHECK_BALANCE",
          url: "http://localhost:5678/webhook/check-balance",
          timeoutMs: 2000,
          maxRetries: 2,
        });
        const http = new N8nGatewayHttp(
          new N8nWorkflowRegistryCache(registryRepo),
          "internal-key",
          silentLogger,
        );
        const executionRepo = new WorkflowExecutionRepositoryFake();
        const instrumented = new InstrumentedN8nGateway(
          http,
          executionRepo,
          "wi-etapa9",
          silentLogger,
        );

        const result = await instrumented.executeAction({
          action: "CHECK_BALANCE",
          caseId: "case-e9",
          conversationId: "conv-e9",
          correlationId: "corr-e9",
          input: { nationalId: "1205500216" },
        });

        expect(result.success).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const keys = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).idempotencyKey);
        expect(keys[0]).toBeTruthy();
        expect(keys[1]).toBe(keys[0]);
        expect(keys.every((k: string) => k === keys[0])).toBe(true);

        const executions = [...executionRepo.executions.values()];
        expect(executions).toHaveLength(1);
        expect(executions[0]!.status).toBe("COMPLETED");
        expect(executions[0]!.idempotencyKey).toBe(keys[0]);

        // Segundo executeAction con el mismo input no vuelve a llamar HTTP.
        await instrumented.executeAction({
          action: "CHECK_BALANCE",
          caseId: "case-e9",
          conversationId: "conv-e9",
          correlationId: "corr-e9",
          input: { nationalId: "1205500216" },
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        vi.unstubAllGlobals();
      },
      10_000,
    );
  });
});
