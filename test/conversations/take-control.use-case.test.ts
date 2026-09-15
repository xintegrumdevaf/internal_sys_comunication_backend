import { describe, it, expect, beforeEach } from "vitest";
import {
  ConversationRepositoryFake,
  DepartmentRepositoryFake,
} from "../support/fakes";
import { TakeControlUseCase } from "../../src/core/modules/conversations/application/use-cases/take-control.use-case";
import { ClaimCaseUseCase } from "../../src/core/modules/escalation/application/use-cases/claim-case.use-case";
import type { Agent } from "../../src/core/modules/departments/domain/agent.entity";
import type { Logger } from "../../src/shared/logging/logger";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

describe("TakeControlUseCase — Auto-creación de caso y reclamo de conversación", () => {
  let conversationRepo: ConversationRepositoryFake;
  let caseRepo: any; // CaseRepositoryFake o mock
  let departmentRepo: DepartmentRepositoryFake;
  let agentRepo: any;
  let escalationRepo: any;
  let auditRepo: any;
  let claimCase: ClaimCaseUseCase;
  let takeControl: TakeControlUseCase;
  let agent: Agent;

  beforeEach(() => {
    conversationRepo = new ConversationRepositoryFake();
    departmentRepo = new DepartmentRepositoryFake();

    const dept = departmentRepo.seed({
      slug: "support",
      name: "Soporte",
    });

    agent = {
      id: "agent-1",
      name: "Jean Operador",
      email: "jean@isp.com",
      role: "agent",
      primaryDepartmentId: dept.id,
      active: true,
      autoAssignEnabled: true,
      mustChangePassword: false,
      createdAt: new Date(),
      passwordHash: null,
    };

    const cases = new Map<string, any>();
    caseRepo = {
      listByConversation: async (convId: string) => {
        return [...cases.values()].filter((c) => c.conversationId === convId);
      },
      findById: async (id: string) => {
        const c = cases.get(id);
        if (!c) return null;
        return {
          case: c,
          workflowInstance: { version: 1, currentState: c.currentState || "HUMAN_DIRECT" },
        };
      },
      create: async (input: any) => {
        const c = {
          id: `case-${Date.now()}`,
          conversationId: input.conversationId,
          workflowType: input.workflowType,
          departmentId: input.departmentId,
          status: "NEW",
          context: input.context,
          version: 1,
          assignedAgentId: null,
        };
        cases.set(c.id, c);
        return {
          case: c,
          workflowInstance: { version: 1, currentState: input.initialState },
        };
      },
      applyTransition: async (t: any) => {
        const c = cases.get(t.caseId);
        if (c) {
          c.status = t.status;
          c.version += 1;
        }
      },
      setAssignedAgent: async (caseId: string, agentId: string) => {
        const c = cases.get(caseId);
        if (c) c.assignedAgentId = agentId;
      },
      setAutomationEnabled: async () => {},
      appendEvent: async () => {},
    };

    agentRepo = {
      findById: async (id: string) => (id === agent.id ? agent : null),
      belongsToDepartment: async () => true,
    };
    escalationRepo = {
      findByCaseId: async () => null,
      resolvePendingByCaseId: async () => {},
    };
    auditRepo = {
      record: async () => {},
    };

    claimCase = new ClaimCaseUseCase({
      caseRepo,
      escalationRepo,
      agentRepo,
      departmentRepo,
      auditRepo,
      logger: silentLogger,
    });

    takeControl = new TakeControlUseCase({
      conversationRepo,
      caseRepo,
      claimCase,
      logger: silentLogger,
      agentRepo,
    });
  });

  it("crea automáticamente un caso GENERAL_INQUIRY en HUMAN_ACTIVE cuando la conversación no tiene caso activo", async () => {
    // Conversación sin activeCaseId (cliente solo dijo 'Hola')
    const conv = conversationRepo.createOpen({
      waPhone: "+593998578468",
      activeCaseId: null,
    });

    const result = await takeControl.execute({
      conversationId: conv.id,
      agentUserId: agent.id,
    });

    expect(result.caseId).toBeDefined();
    expect(result.status).toBe("HUMAN_ACTIVE");
    expect(result.automationEnabled).toBe(false);
    expect(result.assignedAgentId).toBe(agent.id);

    const updatedConv = await conversationRepo.findById(conv.id);
    expect(updatedConv?.activeCaseId).toBe(result.caseId);

    const caseAggr = await caseRepo.findById(result.caseId);
    expect(caseAggr?.case.status).toBe("HUMAN_ACTIVE");
    expect(caseAggr?.case.assignedAgentId).toBe(agent.id);
    expect(caseAggr?.case.departmentId).toBe(agent.primaryDepartmentId);
  });
});
