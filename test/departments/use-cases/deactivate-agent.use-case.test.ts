import { describe, expect, it } from "vitest";
import { DeactivateAgentUseCase } from "../../../src/core/modules/departments/application/use-cases/deactivate-agent.use-case";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import { silentLogger } from "../../support/silent-logger";

function build() {
  const agentRepo = new AgentRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const useCase = new DeactivateAgentUseCase({ agentRepo, auditRepo, logger: silentLogger });
  return { agentRepo, auditRepo, useCase };
}

describe("DeactivateAgentUseCase (docs/spec/06_BACKEND_GAPS.md §1 DELETE /api/agents/:id)", () => {
  it("desactiva (soft-delete) un agente normal y registra audit_event", async () => {
    const { agentRepo, auditRepo, useCase } = build();
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent" });

    const result = await useCase.execute({ agentId: agent.id, actorId: "admin-1" });

    expect(result.active).toBe(false);
    expect(agentRepo.agents.get(agent.id)?.active).toBe(false);
    expect(auditRepo.events).toContainEqual(
      expect.objectContaining({ action: "AGENT_DEACTIVATED", resourceId: agent.id, actorId: "admin-1" }),
    );
  });

  it("es idempotente: desactivar un agente ya inactivo no falla ni duplica audit_event", async () => {
    const { agentRepo, auditRepo, useCase } = build();
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", active: false });

    const result = await useCase.execute({ agentId: agent.id, actorId: "admin-1" });

    expect(result.active).toBe(false);
    expect(auditRepo.events).toHaveLength(0);
  });

  it("no permite desactivar al unico administrador activo del sistema", async () => {
    const { agentRepo, useCase } = build();
    const admin = agentRepo.seed({ name: "Admin", email: "admin@isp.local", role: "admin" });

    await expect(useCase.execute({ agentId: admin.id, actorId: admin.id })).rejects.toMatchObject({
      type: "BUSINESS_ERROR",
    });
  });

  it("permite desactivar a un admin si existe al menos otro admin activo", async () => {
    const { agentRepo, useCase } = build();
    const admin1 = agentRepo.seed({ name: "Admin 1", email: "admin1@isp.local", role: "admin" });
    agentRepo.seed({ name: "Admin 2", email: "admin2@isp.local", role: "admin" });

    const result = await useCase.execute({ agentId: admin1.id, actorId: "admin2-id" });
    expect(result.active).toBe(false);
  });

  it("rechaza un agente inexistente", async () => {
    const { useCase } = build();
    await expect(useCase.execute({ agentId: "no-existe", actorId: "admin-1" })).rejects.toMatchObject({
      type: "NOT_FOUND",
    });
  });
});
