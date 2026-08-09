/**
 * Smoke manual: interpret (Ollama real) + advance §13 para los WaitingSteps
 * de SUPPORT_INTERNET. No envía WhatsApp.
 *
 * Uso: npx tsx scripts/smoke-waiting-steps.ts
 */
import { env } from "../src/shared/config/env";
import { OllamaAdapter } from "../src/core/modules/ai/infrastructure/ollama/ollama-adapter";
import { InterpretMessageUseCase } from "../src/core/modules/ai/application/use-cases/interpret-message.use-case";
import { AdvanceCaseUseCase } from "../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { WorkflowEngine } from "../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import { CaseRepositoryFake, N8nGatewayFake, WorkflowExecutionRepositoryFake } from "../test/cases/fakes";
import { ConversationRepositoryFake } from "../test/support/fakes";
import { silentLogger } from "../test/support/silent-logger";

async function main() {
  console.log("AI:", env.AI_PROVIDER, env.OLLAMA_MODEL, "timeout", env.AI_CALL_TIMEOUT_MS);

  const ai = new OllamaAdapter(
    {
      baseUrl: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL,
      timeoutMs: env.AI_CALL_TIMEOUT_MS,
    },
    silentLogger,
  );
  const interpret = new InterpretMessageUseCase(ai, silentLogger);

  // 1) nationalId solo digitos (determinista, sin LLM)
  const cedula = await interpret.execute({
    correlationId: "smoke-1",
    conversationId: "conv-smoke",
    messageId: "m1",
    text: "16272728",
    conversationSnapshot: {
      activeCase: {
        workflowType: "SUPPORT_INTERNET",
        pendingQuestion: "¿podrías confirmar tu número de cédula?",
        requireAll: ["nationalId"],
      },
    },
  });
  console.log("cedula →", JSON.stringify(cedula));
  if (cedula.type !== "ANSWER" || cedula.entities.nationalId !== "16272728") {
    throw new Error("FALLA: cédula no extrajo nationalId");
  }

  // 2) desambiguar address (LLM)
  const addr = await interpret.execute({
    correlationId: "smoke-2",
    conversationId: "conv-smoke",
    messageId: "m2",
    text: "vivo en la Av. Amazonas",
    conversationSnapshot: {
      activeCase: {
        workflowType: "SUPPORT_INTERNET",
        pendingQuestion:
          "Encontré más de un contrato a tu nombre, ¿me confirmas tu dirección o el nombre completo del titular?",
        requireAny: ["address", "fullName"],
      },
    },
  });
  console.log("disambiguate →", JSON.stringify(addr));
  if (addr.type !== "ANSWER" || (!addr.entities.address && !addr.entities.fullName)) {
    throw new Error("FALLA: desambiguación sin address/fullName");
  }

  // 3) diagnóstico answer (LLM)
  const diag = await interpret.execute({
    correlationId: "smoke-3",
    conversationId: "conv-smoke",
    messageId: "m3",
    text: "sí, ya reinicié el router",
    conversationSnapshot: {
      activeCase: {
        workflowType: "SUPPORT_INTERNET",
        pendingQuestion: "¿Ya reiniciaste el router?",
        requireAll: ["answer"],
      },
    },
  });
  console.log("diagnostic →", JSON.stringify(diag));
  if (diag.type !== "ANSWER") {
    throw new Error("FALLA: diagnóstico no fue ANSWER");
  }
  // El motor normaliza answer no-string al texto del usuario; aquí solo
  // exigimos que no haya caído a UNCLEAR.

  // 4) motor: NEW → pide cédula → cédula → DIAGNOSTIC WAITING
  const caseRepo = new CaseRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const conversation = conversationRepo.createOpen();
  const gateway = new N8nGatewayFake({
    VALIDATE_CLIENT: () => ({
      success: true,
      result: {
        found: true,
        contractNumbers: 1,
        contracts: [
          {
            id: "16272728",
            name: "Ana",
            router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1" },
          },
        ],
      },
    }),
    CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
    DIAGNOSTIC: () => ({
      success: true,
      result: { status: "WAITING_USER", question: "¿La luz ONU está roja?" },
    }),
    CONTINUE_DIAGNOSTIC: () => ({
      success: true,
      result: { status: "COMPLETED", diagnostic: "ONU_OK" },
    }),
  });
  const advance = new AdvanceCaseUseCase({
    caseRepo,
    workflowExecutionRepo: new WorkflowExecutionRepositoryFake(),
    conversationRepo,
    engine: new WorkflowEngine([supportInternetWorkflow]),
    gateway,
    logger: silentLogger,
  });

  const { case: created } = await caseRepo.create({
    conversationId: conversation.id,
    workflowType: "SUPPORT_INTERNET",
    departmentId: null,
    context: { workflowType: "SUPPORT_INTERNET", data: {} },
    initialState: "VALIDATE_CLIENT",
    expiresAt: null,
  });

  const a1 = await advance.execute({ caseId: created.id, correlationId: "s-a1" });
  console.log("advance1", a1.outcome.type, a1.outcome.type === "WAITING_USER" ? a1.outcome.nextState : "");

  const a2 = await advance.execute({
    caseId: created.id,
    correlationId: "s-a2",
    text: "16272728",
    entities: { nationalId: "16272728" },
  });
  console.log("advance2", a2.outcome.type, a2.outcome.type === "WAITING_USER" ? a2.outcome.nextState : "");

  const a3 = await advance.execute({
    caseId: created.id,
    correlationId: "s-a3",
    text: "sí, está roja",
    entities: { answer: "sí, está roja" },
  });
  console.log("advance3", a3.outcome.type, a3.case.status);

  if (a3.case.status !== "COMPLETED") {
    throw new Error(`FALLA: esperado COMPLETED, got ${a3.case.status}`);
  }

  console.log("OK smoke WaitingSteps §13");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
