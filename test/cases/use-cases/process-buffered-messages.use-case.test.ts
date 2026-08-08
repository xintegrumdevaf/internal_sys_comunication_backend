import { describe, expect, it } from "vitest";
import { ProcessBufferedMessagesUseCase } from "../../../src/core/modules/cases/application/use-cases/process-buffered-messages.use-case";
import { AdvanceCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { CaseArbitrationService } from "../../../src/core/modules/cases/application/services/case-arbitration.service";
import { DepartmentResolverService } from "../../../src/core/modules/cases/application/services/department-resolver.service";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import type { WorkflowDefinition } from "../../../src/core/modules/cases/application/engine/workflow-definition";
import type { Interpretation, InterpretationPort, InterpretMessageInput } from "../../../src/core/modules/cases/application/ports/interpretation.port";
import { CaseRepositoryFake, N8nGatewayFake, WorkflowExecutionRepositoryFake } from "../fakes";
import { ConversationRepositoryFake, DepartmentRepositoryFake } from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

/** Interpretacion sintetica (docs/spec/05_BUILD_PLAN.md Etapa 2): cola de resultados fijados por el test. */
class QueuedInterpretationProvider implements InterpretationPort {
  private readonly queue: Interpretation[];
  constructor(queue: Interpretation[]) {
    this.queue = [...queue];
  }
  async interpretMessage(_input: InterpretMessageInput): Promise<Interpretation> {
    const next = this.queue.shift();
    if (!next) throw new Error("QueuedInterpretationProvider: cola vacia");
    return next;
  }
}

/** Workflow minimo solo para probar pausa/reanudacion entre dos tipos — la logica real de BILLING_BALANCE llega en la Etapa 8. */
const dummyBillingWorkflow: WorkflowDefinition = {
  workflowType: "BILLING_BALANCE",
  initialState: "COLLECT_INFO",
  expirationHours: 24,
  states: {
    COLLECT_INFO: async ({ context }) => ({ type: "WAITING_USER", nextState: "COLLECT_INFO", context }),
  },
};

function buildScenario() {
  const caseRepo = new CaseRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  departmentRepo.seed({ slug: "support", name: "Soporte tecnico" });
  departmentRepo.seed({ slug: "billing", name: "Facturacion" });

  const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
  const engine = new WorkflowEngine([supportInternetWorkflow, dummyBillingWorkflow]);
  const gateway = new N8nGatewayFake({
    VALIDATE_CLIENT: () => ({
      success: true,
      result: {
        found: true,
        contractNumbers: 1,
        contracts: [{ id: "1", name: "Ana", router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1" } }],
      },
    }),
    CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
    DIAGNOSTIC: () => ({ success: true, result: { status: "WAITING_USER", question: "¿La luz ONU esta roja?" } }),
    CONTINUE_DIAGNOSTIC: () => ({ success: true, result: { status: "COMPLETED", diagnostic: "ONU reiniciada" } }),
  });

  const advanceCase = new AdvanceCaseUseCase({
    caseRepo,
    workflowExecutionRepo,
    conversationRepo,
    engine,
    gateway,
    logger: silentLogger,
  });
  const departmentResolver = new DepartmentResolverService(departmentRepo);
  const arbitrationService = new CaseArbitrationService(caseRepo, silentLogger);

  return { caseRepo, conversationRepo, departmentRepo, engine, gateway, advanceCase, departmentResolver, arbitrationService };
}

describe("ProcessBufferedMessagesUseCase (docs/spec/05_BUILD_PLAN.md Etapa 2)", () => {
  it(
    "crea el caso con el departamento resuelto por la tabla de mapeo, pausa por cambio de tema " +
      "y reanuda preservando el contexto acumulado",
    async () => {
      const { caseRepo, conversationRepo, departmentRepo, engine, advanceCase, departmentResolver, arbitrationService } =
        buildScenario();
      const conversation = conversationRepo.createOpen();

      const interpretationProvider = new QueuedInterpretationProvider([
        { type: "NEW_INTENT", intent: "support.internet", entities: {}, confidence: 0.9 },
        { type: "CHANGE_TOPIC", intent: "billing.balance", entities: {}, confidence: 0.9 },
        { type: "CHANGE_TOPIC", intent: "support.internet", entities: {}, confidence: 0.9 },
      ]);

      const useCase = new ProcessBufferedMessagesUseCase({
        caseRepo,
        conversationRepo,
        departmentResolver,
        arbitrationService,
        interpretationProvider,
        engine,
        advanceCase,
        logger: silentLogger,
      });

      // 1) "No tengo internet" -> crea SUPPORT_INTERNET, encadena hasta WAITING_USER_DIAGNOSTIC.
      await useCase.execute({ conversationId: conversation.id, correlationId: "corr-1", text: "No tengo internet" });

      const supportCases = await caseRepo.listByConversation(conversation.id);
      expect(supportCases).toHaveLength(1);
      const supportCase = supportCases[0]!;
      expect(supportCase.status).toBe("WAITING_USER");
      const supportDepartment = await departmentRepo.findBySlug("support");
      expect(supportCase.departmentId).toBe(supportDepartment?.id);

      let conversationState = await conversationRepo.findById(conversation.id);
      expect(conversationState?.activeCaseId).toBe(supportCase.id);

      // 2) Cambia de tema a facturacion -> pausa el caso de soporte, activa uno de facturacion.
      await useCase.execute({ conversationId: conversation.id, correlationId: "corr-2", text: "¿Cuanto debo?" });

      const supportAfterPause = (await caseRepo.findById(supportCase.id))!.case;
      expect(supportAfterPause.status).toBe("PAUSED");
      // El contexto acumulado (cliente validado, diagnostico pendiente) se conserva intacto al pausar.
      expect(supportAfterPause.context).toEqual(supportCase.context);

      const allCasesAfterStep2 = await caseRepo.listByConversation(conversation.id);
      const billingCase = allCasesAfterStep2.find((c) => c.workflowType === "BILLING_BALANCE");
      expect(billingCase).toBeDefined();
      expect(billingCase!.status).toBe("WAITING_USER");
      const billingDepartment = await departmentRepo.findBySlug("billing");
      expect(billingCase!.departmentId).toBe(billingDepartment?.id);

      conversationState = await conversationRepo.findById(conversation.id);
      expect(conversationState?.activeCaseId).toBe(billingCase!.id);

      // 3) Vuelve a "sigo sin internet" -> retoma el MISMO caso de soporte (no crea uno nuevo),
      //    continua desde WAITING_USER_DIAGNOSTIC y termina completando.
      await useCase.execute({ conversationId: conversation.id, correlationId: "corr-3", text: "Sigo sin internet" });

      const supportCasesAfterResume = (await caseRepo.listByConversation(conversation.id)).filter(
        (c) => c.workflowType === "SUPPORT_INTERNET",
      );
      expect(supportCasesAfterResume).toHaveLength(1); // nunca se creo un segundo caso de soporte
      const resumedSupport = supportCasesAfterResume[0]!;
      expect(resumedSupport.id).toBe(supportCase.id);
      expect(resumedSupport.status).toBe("COMPLETED");
      if (resumedSupport.context.workflowType === "SUPPORT_INTERNET") {
        expect(resumedSupport.context.data.client?.nationalId).toBe("1");
        expect(resumedSupport.context.data.diagnostic?.status).toBe("RESOLVED");
      } else {
        throw new Error("contexto con workflowType inesperado");
      }
    },
  );

  it("una interpretacion UNCLEAR no crea, pausa ni toca ningun caso", async () => {
    const { caseRepo, conversationRepo, advanceCase, departmentResolver, arbitrationService, engine } = buildScenario();
    const conversation = conversationRepo.createOpen();
    const interpretationProvider = new QueuedInterpretationProvider([
      { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0 },
    ]);
    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo,
      conversationRepo,
      departmentResolver,
      arbitrationService,
      interpretationProvider,
      engine,
      advanceCase,
      logger: silentLogger,
    });

    await useCase.execute({ conversationId: conversation.id, correlationId: "corr-1", text: "asdkjaslkd" });

    expect(await caseRepo.listByConversation(conversation.id)).toHaveLength(0);
    const conversationAfter = await conversationRepo.findById(conversation.id);
    expect(conversationAfter?.activeCaseId).toBeNull();
  });
});
