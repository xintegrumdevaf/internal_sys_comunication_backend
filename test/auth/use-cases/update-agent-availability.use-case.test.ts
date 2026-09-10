import { describe, expect, it } from "vitest";
import { UpdateAgentAvailabilityUseCase } from "../../../src/core/modules/auth/application/use-cases/update-agent-availability.use-case";
import { AutoAssignAgentService } from "../../../src/core/modules/escalation/application/services/auto-assign-agent.service";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import { CaseRepositoryFake } from "../../cases/fakes";
import { DepartmentRepositoryFake } from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

describe("UpdateAgentAvailabilityUseCase & Auto-Assign Load Balancer", () => {
  it("permite a un agente cambiar su disponibilidad (autoAssignEnabled) y registra audit_event", async () => {
    const agentRepo = new AgentRepositoryFake();
    const auditRepo = new AuditRepositoryFake();
    const useCase = new UpdateAgentAvailabilityUseCase({ agentRepo, auditRepo, logger: silentLogger });

    const agent = agentRepo.seed({
      name: "Carlos",
      email: "carlos@isp.local",
      autoAssignEnabled: true,
    });

    const updated = await useCase.execute({
      agentId: agent.id,
      autoAssignEnabled: false,
    });

    expect(updated.autoAssignEnabled).toBe(false);
    expect(auditRepo.events).toContainEqual(
      expect.objectContaining({
        action: "AGENT_AVAILABILITY_CHANGED",
        resourceId: agent.id,
        actorId: agent.id,
      }),
    );
  });

  it("al desconectarse (autoAssignEnabled=false), el balanceador omite a ese agente", async () => {
    const agentRepo = new AgentRepositoryFake();
    const caseRepo = new CaseRepositoryFake();
    const departmentRepo = new DepartmentRepositoryFake();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });

    const agentA = agentRepo.seed({
      name: "Agente Disponible",
      email: "a@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      autoAssignEnabled: true,
    });
    const agentB = agentRepo.seed({
      name: "Agente Desconectado",
      email: "b@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      autoAssignEnabled: false, // desconectado
    });

    const balancer = new AutoAssignAgentService({
      agentRepo,
      caseRepo,
      maxActiveCasesPerAgent: 5,
    });

    const picked = await balancer.pickAgentForDepartment(support.id);
    expect(picked?.id).toBe(agentA.id);

    // Ahora agente A se desconecta también
    const useCase = new UpdateAgentAvailabilityUseCase({ agentRepo, logger: silentLogger });
    await useCase.execute({ agentId: agentA.id, autoAssignEnabled: false });

    const pickedWhenAllDisconnected = await balancer.pickAgentForDepartment(support.id);
    expect(pickedWhenAllDisconnected).toBeNull();
  });
});
